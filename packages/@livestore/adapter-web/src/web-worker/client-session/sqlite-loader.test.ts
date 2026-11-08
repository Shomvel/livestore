import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'

const { loadWasm } = vi.hoisted(() => ({ loadWasm: vi.fn<typeof loadSqlite3Wasm>() }))

vi.mock('@livestore/sqlite-wasm/load-wasm', () => ({ loadSqlite3Wasm: loadWasm }))

let sqlite3: Awaited<ReturnType<typeof loadSqlite3Wasm>>

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('@livestore/sqlite-wasm/load-wasm')>(
    '@livestore/sqlite-wasm/load-wasm',
  )
  sqlite3 = await actual.loadSqlite3Wasm()
})

beforeEach(() => {
  vi.resetModules()
  loadWasm.mockReset().mockResolvedValue(sqlite3)
  vi.stubEnv('SSR', false)
  vi.stubGlobal('window', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const importLoader = () => import('./sqlite-loader.ts')

describe('client-session SQLite initialization', () => {
  it('loads lazily on the server and shares initialization across concurrent stores', async () => {
    const { loadSqlite3 } = await importLoader()
    expect(loadWasm).not.toHaveBeenCalled()

    const first = loadSqlite3()
    expect(loadSqlite3()).toBe(first)
    expect(await first).toBe(sqlite3)
    expect(loadSqlite3()).toBe(first)
    expect(loadWasm).toHaveBeenCalledTimes(1)
  })

  it('shares a server initialization failure and retries on the next request', async () => {
    const failure = new Error('WASM unavailable')
    loadWasm.mockRejectedValueOnce(failure)
    const { loadSqlite3 } = await importLoader()
    const first = loadSqlite3()
    expect(loadSqlite3()).toBe(first)
    await expect(first).rejects.toBe(failure)

    const retry = loadSqlite3()
    expect(retry).not.toBe(first)
    expect(await retry).toBe(sqlite3)
    expect(loadWasm).toHaveBeenCalledTimes(2)
  })

  it('preloads in the browser and reuses that initialization for stores', async () => {
    vi.stubGlobal('window', {})
    const { loadSqlite3 } = await importLoader()
    expect(loadWasm).toHaveBeenCalledTimes(1)
    expect(await loadSqlite3()).toBe(sqlite3)
    expect(loadWasm).toHaveBeenCalledTimes(1)
  })

  it('retries a failed browser preload when a store later requests SQLite', async () => {
    vi.stubGlobal('window', {})
    loadWasm.mockRejectedValueOnce(new Error('preload failed'))
    const { loadSqlite3 } = await importLoader()
    // Let the eagerly started rejection settle before the first store asks for SQLite.
    await Promise.resolve()
    expect(loadWasm).toHaveBeenCalledTimes(1)
    expect(await loadSqlite3()).toBe(sqlite3)
    expect(loadWasm).toHaveBeenCalledTimes(2)
  })
})
