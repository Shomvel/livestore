import * as otel from '@opentelemetry/api'
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { expect, vi } from 'vitest'

import { makeNoopTracer } from '@livestore/utils'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect } from '@livestore/utils/effect'

import { StoreInternalsSymbol } from './store/store-types.ts'
import { makeTodoMvc } from './utils/tests/fixture.ts'

Vitest.describe('SqliteDbWrapper', () => {
  Vitest.live('invalidates cached reads after changeset and savepoint rollback', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc({})
      const db = store[StoreInternalsSymbol].sqliteDbWrapper
      db.execute('CREATE TABLE rollback_cache_test (id INTEGER PRIMARY KEY, value INTEGER)')
      db.execute('INSERT INTO rollback_cache_test VALUES (1, 1)')
      const read = () => db.select<{ value: number }>('SELECT value FROM rollback_cache_test')[0]!.value
      const { changeset } = db.withChangeset(() => db.execute('UPDATE rollback_cache_test SET value = 2'))
      expect(read()).toBe(2)
      expect(changeset).not.toBeNull()
      db.makeChangeset(changeset!).invert().apply()
      expect(read()).toBe(1)
      db.execute('SAVEPOINT cache_test')
      db.execute('UPDATE rollback_cache_test SET value = 3')
      expect(read()).toBe(3)
      db.execute('ROLLBACK TO SAVEPOINT cache_test')
      db.execute('RELEASE SAVEPOINT cache_test')
      expect(read()).toBe(1)
    }),
  )

  Vitest.live('works with the OpenTelemetry API no-op tracer', (_test) =>
    Effect.gen(function* () {
      const otelTracer = otel.trace.getTracer('sqlite-wrapper-noop-test')
      const probeSpan = otelTracer.startSpan('verify-noop-tracer')
      expect(probeSpan.isRecording()).toBe(false)
      probeSpan.end()

      // Store creation exercises the configureSQLite execute path.
      const store = yield* makeTodoMvc({ otelTracer })
      const sqliteDbWrapper = store[StoreInternalsSymbol].sqliteDbWrapper
      const { durationMs } = sqliteDbWrapper.cachedExecute('CREATE TABLE noop_timing_test (id INTEGER)', undefined, {
        hasNoEffects: true,
      })

      expect(sqliteDbWrapper.select('SELECT 1 AS value')).toEqual([{ value: 1 }])
      expect(sqliteDbWrapper.debugInfo.queryFrameCount).toBeGreaterThan(0)
      expect(sqliteDbWrapper.debugInfo.queryFrameDuration).toBeGreaterThanOrEqual(0)
      expect(durationMs).toBeGreaterThanOrEqual(0)
    }),
  )

  Vitest.live('preserves real OpenTelemetry span, context, error, and async semantics', () =>
    Effect.gen(function* () {
      const spans: ReadableSpan[] = []
      const processor: SpanProcessor = {
        onStart: () => {},
        onEnd: (span) => spans.push(span),
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      }
      const provider = new BasicTracerProvider({ spanProcessors: [processor] })
      const otelTracer = provider.getTracer('sqlite-wrapper-real-test')
      const store = yield* makeTodoMvc({ otelTracer })
      const db = store[StoreInternalsSymbol].sqliteDbWrapper
      const parent = otelTracer.startSpan('test-parent')
      const context = otel.trace.setSpan(otel.ROOT_CONTEXT, parent)
      spans.length = 0
      const startActiveSpan = vi.spyOn(otelTracer, 'startActiveSpan')

      const syncResult = db['withSpan'](true, 'real-sync', {}, context, (span) => {
        expect(span.isRecording()).toBe(true)
        span.end()
        return 42
      })
      expect(syncResult).toBe(42)

      db.cachedExecute('CREATE TABLE real_tracer_test (id INTEGER)', undefined, {
        hasNoEffects: true,
        otelContext: context,
      })

      const asyncResult = db['withSpan'](true, 'real-async', {}, context, async (span) => {
        await Promise.resolve()
        span.end()
        return 'async-result'
      })
      expect(yield* Effect.promise(() => asyncResult)).toBe('async-result')

      const cause = new Error('real-span-error')
      expect(() =>
        db['withSpan'](true, 'real-throw', {}, context, (span) => {
          try {
            throw cause
          } finally {
            span.end()
          }
        }),
      ).toThrow(cause)
      expect(() => db.cachedExecute('INVALID SQL', undefined, { otelContext: context })).toThrow()
      expect(startActiveSpan).toHaveBeenCalledTimes(5)

      parent.end()
      const syncSpan = spans.find((span) => span.name === 'real-sync')
      const throwSpan = spans.find((span) => span.attributes['sql.query'] === 'INVALID SQL')
      expect(syncSpan?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
      expect(throwSpan?.events.some((event) => event.name === 'exception')).toBe(true)
      expect(spans.some((span) => span.name === 'livestore.in-memory-db:execute')).toBe(true)
      yield* Effect.promise(() => provider.shutdown())
    }),
  )

  Vitest.live('runs callbacks directly for the explicit repository NoopTracer', () =>
    Effect.gen(function* () {
      const otelTracer = makeNoopTracer()
      const store = yield* makeTodoMvc({ otelTracer })
      const db = store[StoreInternalsSymbol].sqliteDbWrapper
      const startActiveSpan = vi.spyOn(otelTracer, 'startActiveSpan')
      let callbackCount = 0

      const syncResult = db['withSpan'](true, 'noop-sync', {}, otel.ROOT_CONTEXT, (span) => {
        callbackCount++
        span.end()
        return 42
      })
      expect(syncResult).toBe(42)

      db.cachedExecute('CREATE TABLE repository_noop_tracer_test (id INTEGER)', undefined, { hasNoEffects: true })

      const asyncResult = db['withSpan'](true, 'noop-async', {}, otel.ROOT_CONTEXT, async (span) => {
        await Promise.resolve()
        span.end()
        return 'async-result'
      })
      expect(yield* Effect.promise(() => asyncResult)).toBe('async-result')

      const cause = new Error('noop-span-error')
      expect(() =>
        db['withSpan'](true, 'noop-throw', {}, otel.ROOT_CONTEXT, (span) => {
          callbackCount++
          try {
            throw cause
          } finally {
            span.end()
          }
        }),
      ).toThrow(cause)
      expect(() => db.cachedExecute('INVALID SQL')).toThrow()
      expect(callbackCount).toBe(2)
      expect(startActiveSpan).toHaveBeenCalledTimes(0)
    }),
  )

  Vitest.describe('getTablesUsed', () => {
    const getTablesUsed = (query: string) =>
      Effect.gen(function* () {
        const store = yield* makeTodoMvc({})
        return store[StoreInternalsSymbol].sqliteDbWrapper.getTablesUsed(query)
      })

    Vitest.live('should return the correct tables used', (_test) =>
      Effect.gen(function* () {
        const tablesUsed = yield* getTablesUsed('select * from todos')
        expect(tablesUsed).toEqual(new Set(['todos']))
      }),
    )

    Vitest.live('should handle DELETE FROM statement without WHERE clause', (_test) =>
      Effect.gen(function* () {
        const tablesUsed = yield* getTablesUsed('DELETE FROM todos')
        expect(tablesUsed).toEqual(new Set(['todos']))
      }),
    )

    Vitest.live('should handle INSERT with ON CONFLICT clause', (_test) =>
      Effect.gen(function* () {
        const tablesUsed = yield* getTablesUsed(
          'INSERT INTO todos (id, text, completed) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = ?',
        )
        expect(tablesUsed).toEqual(new Set(['todos']))
      }),
    )
  })
})
