import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import type { FullConfig, Suite, TestCase, TestResult } from '@playwright/test/reporter'
import { afterEach, describe, expect, it, vi } from 'vitest'

import MeasurementsReporter, { collectGitInfo } from './measurements-reporter.ts'

const temporaryDirectories: string[] = []

const makeTemporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'livestore-measurements-reporter-'))
  temporaryDirectories.push(directory)
  return directory
}

const makeConfig = (rootDir: string): FullConfig =>
  ({
    rootDir,
    version: '1.64.1',
    projects: [{ outputDir: path.join(rootDir, 'test-results') }],
  }) as unknown as FullConfig

const makeTest = (title: string, annotations: { type: string; description: string }[]): TestCase =>
  ({
    title,
    annotations,
    parent: {
      parent: { title: 'Latency' },
      titlePath: () => ['', 'chromium', 'latency.test.ts', 'Latency', 'Run 1/15', title],
    },
  }) as unknown as TestCase

const makeSuite = (tests: TestCase[]): Suite => ({ allTests: () => tests }) as unknown as Suite

const passedResult = { status: 'passed' } as TestResult

const measurementAnnotations = (value: number, browserVersion?: string) => [
  { type: 'measurement unit', description: 'ms' },
  { type: 'measurement', description: value.toString() },
  ...(browserVersion === undefined ? [] : [{ type: 'browser version', description: browserVersion }]),
]

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('MeasurementsReporter JSON report', () => {
  it('writes raw measurements and summaries without changing console reporting', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rootDir = makeTemporaryDirectory()
    const values = [10, 20, 30, 40]
    const title = 'for creating 1,000 items'
    const tests = values.map((value) => makeTest(title, measurementAnnotations(value, '140.0.0.0')))
    const reporter = new MeasurementsReporter()

    reporter.onBegin(makeConfig(rootDir), makeSuite(tests))
    for (const test of tests) reporter.onTestEnd(test, passedResult)
    await reporter.onEnd()

    const outputPath = path.join(rootDir, 'test-results', 'measurements.json')
    const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    expect(report).toMatchObject({
      schemaVersion: 1,
      createdAt: expect.any(String),
      versions: {
        node: process.version,
        playwright: '1.64.1',
        chromium: '140.0.0.0',
      },
      git: { commit: null, dirty: null },
      tests: [
        {
          testSuiteTitle: 'Latency',
          testSuiteTitlePath: 'chromium > latency.test.ts > Latency',
          testTitle: title,
          testName: `Latency ${title}`,
          unit: 'ms',
          measurements: values,
          summary: { median: 20, iqr: 20, min: 10, max: 40 },
        },
      ],
    })
    expect(report.system).toEqual({
      os: {
        type: os.type(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
      },
      cpus: {
        model: os.cpus()[0]?.model,
        count: os.cpus().length,
        speed: os.cpus()[0]?.speed,
      },
      memory: { total: os.totalmem(), free: expect.any(Number) },
    })
    expect(report).not.toHaveProperty('env')

    const consoleOutput = consoleLog.mock.calls.flat().join('\n')
    expect(consoleOutput).toContain('System Information')
    expect(consoleOutput).toContain('Median')
    expect(consoleOutput).toContain('IQR')
  })

  it('uses null summaries and browser version when no measurement is available', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const rootDir = makeTemporaryDirectory()
    const test = makeTest('failed test', [{ type: 'measurement unit', description: 'bytes' }])
    const reporter = new MeasurementsReporter()

    reporter.onBegin(makeConfig(rootDir), makeSuite([test]))
    reporter.onTestEnd(test, passedResult)
    await reporter.onEnd()

    const report = JSON.parse(fs.readFileSync(path.join(rootDir, 'test-results', 'measurements.json'), 'utf8'))
    expect(report.versions.chromium).toBeNull()
    expect(report.tests).toEqual([
      expect.objectContaining({
        unit: 'bytes',
        measurements: [],
        summary: { median: null, iqr: null, min: null, max: null },
      }),
    ])
  })
})

describe('collectGitInfo', () => {
  it.each([
    { status: '', dirty: false },
    { status: ' M tests/perf/tests/measurements-reporter.ts', dirty: true },
  ])('reports commit and dirty=$dirty', ({ status, dirty }) => {
    const commands: string[][] = []
    const info = collectGitInfo('/repo', (_cwd, args) => {
      commands.push([...args])
      return args[0] === 'rev-parse' ? 'abc123' : status
    })

    expect(info).toEqual({ commit: 'abc123', dirty })
    expect(commands).toEqual([
      ['rev-parse', 'HEAD'],
      ['status', '--porcelain'],
    ])
  })

  it('uses null when git information is unavailable', () => {
    expect(collectGitInfo('/repo', () => null)).toEqual({ commit: null, dirty: null })
  })
})
