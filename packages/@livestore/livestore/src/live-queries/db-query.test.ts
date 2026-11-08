import * as otel from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { assert, expect } from 'vitest'

import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect, ReadonlyRecord, Schema, SchemaGetter } from '@livestore/utils/effect'

import * as RG from '../reactive.ts'
import { StoreInternalsSymbol } from '../store/store-types.ts'
import { events, makeTodoMvc, type Todo, tables } from '../utils/tests/fixture.ts'
import { getAllSimplifiedRootSpans, getSimplifiedRootSpan } from '../utils/tests/otel.ts'
import { computed } from './computed.ts'
import { queryDb } from './db-query.ts'

/*
TODO write tests for:

- sql queries without and with `map` (incl. callback and schemas)
- optional and explicit `queriedTables` argument
*/

Vitest.describe('dynamic dependencies', () => {
  Vitest.live('registers new SQL tables and drops abandoned tables', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const internals = store[StoreInternalsSymbol]
      const useApp = internals.reactivityGraph.makeRef(false, { label: 'useApp' })
      const schema = Schema.Array(Schema.Struct({ count: Schema.Number }))
      const query$ = queryDb(
        (get) => ({
          query: get(useApp) ? 'select count(*) as count from app' : 'select count(*) as count from todos',
          schema,
        }),
        { label: 'dynamic table count' },
      )
      const emissions: ReadonlyArray<{ readonly count: number }>[] = []
      const queryInstances: { runs: number }[] = []
      const unsubscribe = store.subscribe(query$, (result) => emissions.push(result), {
        onSubscribe: (query) => {
          queryInstances.push(query)
        },
      })

      expect(emissions).toEqual([[{ count: 0 }]])

      internals.reactivityGraph.setRef(useApp, true)

      expect(emissions).toEqual([[{ count: 0 }]])
      expect(queryInstances[0]!.runs).toBe(2)

      internals.sqliteDbWrapper.cachedExecute(`insert into app (id, value) values ('a', '{}')`, undefined, {
        writeTables: new Set(['app']),
      })
      const appRef = internals.tableRefs.app
      if (appRef === undefined) throw new Error('Missing app table ref')
      internals.reactivityGraph.setRef(appRef, null)

      expect(emissions).toEqual([[{ count: 0 }], [{ count: 1 }]])
      expect(queryInstances[0]!.runs).toBe(3)

      store.commit(events.todoCreated({ id: 't1', text: 'buy milk', completed: false }))

      expect(queryInstances[0]!.runs).toBe(3)
      expect(emissions).toHaveLength(2)

      unsubscribe()
    }).pipe(Effect.scoped),
  )
})

Vitest.describe('result equivalence', () => {
  Vitest.live('checks same-table writes but notifies only for changed query results', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      store.commit(
        events.todoCreated({ id: 'a', text: 'a', completed: false }),
        events.todoCreated({ id: 'b', text: 'b', completed: false }),
      )
      const query$ = queryDb(tables.todos.where({ id: 'b' }), { label: 'todo b' })
      const emissions: ReadonlyArray<Todo>[] = []
      const queryInstances: { runs: number; results$: { previousResult: unknown } }[] = []
      const unsubscribe = store.subscribe(query$, (result) => emissions.push(result), {
        onSubscribe: (query) => {
          queryInstances.push(query)
        },
      })
      const firstResult = emissions[0]

      store.commit(events.todoCompleted({ id: 'a' }))

      expect(queryInstances[0]!.runs).toBe(2)
      expect(queryInstances[0]!.results$.previousResult).toBe(firstResult)
      expect(emissions).toHaveLength(1)

      store.commit(events.todoCompleted({ id: 'b' }))

      expect(queryInstances[0]!.runs).toBe(3)
      expect(emissions).toHaveLength(2)
      expect(emissions[1]).not.toBe(firstResult)
      expect(emissions[1]).toEqual([{ id: 'b', text: 'b', completed: true }])

      unsubscribe()
    }).pipe(Effect.scoped),
  )

  Vitest.live('preserves skipInitialRun while cutting off equivalent results', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      store.commit(
        events.todoCreated({ id: 'a', text: 'a', completed: false }),
        events.todoCreated({ id: 'b', text: 'b', completed: false }),
      )
      const query$ = queryDb(tables.todos.where({ id: 'b' }), { label: 'todo b skip initial' })
      const emissions: ReadonlyArray<Todo>[] = []
      const queryInstances: { runs: number }[] = []
      const unsubscribe = store.subscribe(query$, (result) => emissions.push(result), {
        skipInitialRun: true,
        onSubscribe: (query) => {
          queryInstances.push(query)
        },
      })

      expect(emissions).toHaveLength(0)

      store.commit(events.todoCompleted({ id: 'a' }))

      expect(queryInstances[0]!.runs).toBe(2)
      expect(emissions).toHaveLength(0)

      store.commit(events.todoCompleted({ id: 'b' }))

      expect(queryInstances[0]!.runs).toBe(3)
      expect(emissions).toHaveLength(1)
      expect(emissions[0]).toEqual([{ id: 'b', text: 'b', completed: true }])

      unsubscribe()
    }).pipe(Effect.scoped),
  )
})

Vitest.describe('decoded result cache', () => {
  const makeCountingSchema = (onDecode: () => void) => {
    const rows = Schema.Array(tables.todos.rowSchema)
    const decodedRows = Schema.Array(
      Schema.Struct({ id: Schema.String, text: Schema.String, completed: Schema.Boolean }),
    )
    return rows.pipe(
      Schema.decodeTo(decodedRows, {
        decode: SchemaGetter.transform((value) => {
          onDecode()
          return value
        }),
        encode: SchemaGetter.transform((value) => value),
      }),
    )
  }

  Vitest.live('reuses decoded and mapped results for the same raw result', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      store.commit(events.todoCreated({ id: 'b', text: 'b', completed: false }))
      const internals = store[StoreInternalsSymbol]
      const version = internals.reactivityGraph.makeRef(0)
      const sql = `select * from todos where id = 'b'`
      let decodeCalls = 0
      let mapCalls = 0
      const schema = makeCountingSchema(() => decodeCalls++)
      const query$ = queryDb(
        (get) => {
          get(version)
          return { query: sql, schema }
        },
        {
          map: (rows) => {
            mapCalls++
            return rows
          },
        },
      )
      const emissions: ReadonlyArray<Todo>[] = []
      const queryInstances: { runs: number; results$: { previousResult: unknown } }[] = []
      const unsubscribe = store.subscribe(query$, (result) => emissions.push(result), {
        onSubscribe: (query) => {
          queryInstances.push(query)
        },
      })
      const firstResult = emissions[0]
      const firstRawResult = internals.sqliteDbWrapper.cachedSelect(sql)

      expect(decodeCalls).toBe(1)
      expect(mapCalls).toBe(1)

      internals.reactivityGraph.setRef(version, 1)
      internals.reactivityGraph.setRef(version, 2)

      expect(queryInstances[0]!.runs).toBe(3)
      expect(internals.sqliteDbWrapper.cachedSelect(sql)).toBe(firstRawResult)
      expect(decodeCalls).toBe(1)
      expect(mapCalls).toBe(1)
      expect(queryInstances[0]!.results$.previousResult).toBe(firstResult)
      expect(emissions).toHaveLength(1)

      store.commit(events.todoCompleted({ id: 'b' }))

      expect(internals.sqliteDbWrapper.cachedSelect(sql)).not.toBe(firstRawResult)
      expect(decodeCalls).toBe(2)
      expect(mapCalls).toBe(2)
      expect(emissions).toEqual([[{ id: 'b', text: 'b', completed: false }], [{ id: 'b', text: 'b', completed: true }]])

      unsubscribe()
    }).pipe(Effect.scoped),
  )

  Vitest.live('does not reuse results across raw input or schema changes', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      store.commit(
        events.todoCreated({ id: 'a', text: 'a', completed: false }),
        events.todoCreated({ id: 'b', text: 'b', completed: false }),
      )
      const internals = store[StoreInternalsSymbol]
      const useB = internals.reactivityGraph.makeRef(false)
      const useAlternateSchema = internals.reactivityGraph.makeRef(false)
      let decodeCallsA = 0
      let decodeCallsB = 0
      let mapCalls = 0
      const schemaA = makeCountingSchema(() => decodeCallsA++)
      const schemaB = makeCountingSchema(() => decodeCallsB++)
      const query$ = queryDb(
        (get) => ({
          query: get(useB) ? `select * from todos where id = 'b'` : `select * from todos where id = 'a'`,
          schema: get(useAlternateSchema) ? schemaB : schemaA,
        }),
        {
          map: (rows) => {
            mapCalls++
            return rows
          },
        },
      )
      const queryInstances: { runs: number }[] = []
      const unsubscribe = store.subscribe(query$, () => {}, {
        onSubscribe: (query) => {
          queryInstances.push(query)
        },
      })

      internals.reactivityGraph.setRef(useB, true)
      expect(decodeCallsA).toBe(2)
      expect(mapCalls).toBe(2)

      internals.reactivityGraph.setRef(useAlternateSchema, true)
      expect(decodeCallsB).toBe(1)
      expect(mapCalls).toBe(3)

      internals.reactivityGraph.setRef(useB, false)
      expect(decodeCallsB).toBe(2)
      expect(mapCalls).toBe(4)

      internals.reactivityGraph.setRef(useAlternateSchema, false)
      expect(decodeCallsA).toBe(3)
      expect(mapCalls).toBe(5)
      expect(queryInstances[0]!.runs).toBe(5)

      unsubscribe()
    }).pipe(Effect.scoped),
  )

  Vitest.live('recomputes decoded results after rollback and changeset invalidation', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      store.commit(events.todoCreated({ id: 'b', text: 'b', completed: false }))
      const internals = store[StoreInternalsSymbol]
      const db = internals.sqliteDbWrapper
      const version = internals.reactivityGraph.makeRef(0)
      const sql = `select * from todos where id = 'b'`
      let decodeCalls = 0
      const schema = makeCountingSchema(() => decodeCalls++)
      const query$ = queryDb((get) => {
        get(version)
        return { query: sql, schema }
      })
      const queryInstances: { runs: number; results$: { previousResult: unknown } }[] = []
      const unsubscribe = store.subscribe(query$, () => {}, {
        onSubscribe: (query) => {
          queryInstances.push(query)
        },
      })
      const todosRef = internals.tableRefs.todos
      if (todosRef === undefined) throw new Error('Missing todos table ref')
      const firstRawResult = db.cachedSelect(sql)

      db.execute('SAVEPOINT decoded_cache_test')
      db.execute(`UPDATE todos SET completed = 1 WHERE id = 'b'`)
      db.execute('ROLLBACK TO SAVEPOINT decoded_cache_test')
      db.execute('RELEASE SAVEPOINT decoded_cache_test')
      internals.reactivityGraph.setRef(todosRef, null)

      expect(queryInstances[0]!.runs).toBe(2)
      expect(db.cachedSelect(sql)).not.toBe(firstRawResult)
      expect(decodeCalls).toBe(2)
      expect(queryInstances[0]!.results$.previousResult).toEqual([{ id: 'b', text: 'b', completed: false }])

      const rawBeforeChangeset = db.cachedSelect(sql)
      const { changeset } = db.withChangeset(() => db.execute(`UPDATE todos SET completed = 1 WHERE id = 'b'`))
      expect(changeset).not.toBeNull()
      db.makeChangeset(changeset!).invert().apply()
      internals.reactivityGraph.setRef(todosRef, null)

      expect(queryInstances[0]!.runs).toBe(3)
      expect(db.cachedSelect(sql)).not.toBe(rawBeforeChangeset)
      expect(decodeCalls).toBe(3)
      expect(queryInstances[0]!.results$.previousResult).toEqual([{ id: 'b', text: 'b', completed: false }])

      unsubscribe()
    }).pipe(Effect.scoped),
  )
})

Vitest.describe('structural sharing', () => {
  Vitest.live('reuses unchanged mapped rows on real table updates', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      store.commit(
        events.todoCreated({ id: 'a', text: 'a', completed: false }),
        events.todoCreated({ id: 'b', text: 'b', completed: false }),
        events.todoCreated({ id: 'c', text: 'c', completed: false }),
      )
      let mapCalls = 0
      const query$ = queryDb(
        {
          query: 'select * from todos order by id',
          schema: Schema.Array(tables.todos.rowSchema),
        },
        {
          map: (rows) => {
            mapCalls++
            return rows.map((row) => ({ ...row }))
          },
        },
      )
      const emissions: ReadonlyArray<Todo>[] = []
      const unsubscribe = store.subscribe(query$, (result) => emissions.push(result))
      const first = emissions[0]!

      store.commit(events.todoCompleted({ id: 'b' }))

      const next = emissions[1]!
      expect(mapCalls).toBe(2)
      expect(next).not.toBe(first)
      expect(next[0]).toBe(first[0])
      expect(next[1]).not.toBe(first[1])
      expect(next[2]).toBe(first[2])
      expect(next[1]).toEqual({ id: 'b', text: 'b', completed: true })
      expect(next.filter((row, index) => row !== first[index])).toHaveLength(1)

      unsubscribe()
    }).pipe(Effect.scoped),
  )

  Vitest.live('uses positional sharing without changing order or length', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      store.commit(
        events.todoCreated({ id: 'a', text: 'a', completed: false }),
        events.todoCreated({ id: 'b', text: 'b', completed: false }),
        events.todoCreated({ id: 'c', text: 'c', completed: false }),
      )
      const internals = store[StoreInternalsSymbol]
      const descending = internals.reactivityGraph.makeRef(false)
      const query$ = queryDb((get) => ({
        query: `select * from todos order by id ${get(descending) ? 'desc' : 'asc'}`,
        schema: Schema.Array(tables.todos.rowSchema),
      }))
      const emissions: ReadonlyArray<Todo>[] = []
      const unsubscribe = store.subscribe(query$, (result) => emissions.push(result))
      const todosRef = internals.tableRefs.todos
      if (todosRef === undefined) throw new Error('Missing todos table ref')

      internals.reactivityGraph.setRef(descending, true)

      const reordered = emissions[1]!
      expect(reordered.map((row) => row.id)).toEqual(['c', 'b', 'a'])
      expect(reordered[0]).not.toBe(emissions[0]![2])

      internals.sqliteDbWrapper.execute(`DELETE FROM todos WHERE id = 'b'`)
      internals.reactivityGraph.setRef(todosRef, null)

      const deleted = emissions[2]!
      expect(deleted.map((row) => row.id)).toEqual(['c', 'a'])
      expect(deleted).toHaveLength(2)
      expect(deleted[0]).toBe(reordered[0])

      internals.sqliteDbWrapper.execute(`INSERT INTO todos VALUES ('d', 'd', 0)`)
      internals.reactivityGraph.setRef(todosRef, null)

      const inserted = emissions[3]!
      expect(inserted.map((row) => row.id)).toEqual(['d', 'c', 'a'])
      expect(inserted).toHaveLength(3)

      unsubscribe()
    }).pipe(Effect.scoped),
  )

  Vitest.live('keeps the last successful result when map throws and supports frozen arrays', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      store.commit(
        events.todoCreated({ id: 'a', text: 'a', completed: false }),
        events.todoCreated({ id: 'b', text: 'b', completed: false }),
      )
      const internals = store[StoreInternalsSymbol]
      let mapCalls = 0
      let shouldThrow = false
      const query$ = queryDb(
        {
          query: 'select * from todos order by id',
          schema: Schema.Array(tables.todos.rowSchema),
        },
        {
          map: (rows) => {
            mapCalls++
            if (shouldThrow) throw new Error('map failed')
            return Object.freeze(rows.map((row) => Object.freeze({ ...row })))
          },
        },
      )
      const emissions: ReadonlyArray<Todo>[] = []
      const queryInstances: { results$: { previousResult: unknown } }[] = []
      const unsubscribe = store.subscribe(query$, (result) => emissions.push(result), {
        onSubscribe: (query) => {
          queryInstances.push(query)
        },
      })
      const first = emissions[0]!
      const todosRef = internals.tableRefs.todos
      if (todosRef === undefined) throw new Error('Missing todos table ref')

      internals.sqliteDbWrapper.execute(`INSERT INTO todos VALUES ('c', 'c', 0)`)
      shouldThrow = true
      expect(() => internals.reactivityGraph.setRef(todosRef, null)).toThrow('map failed')
      expect(queryInstances[0]!.results$.previousResult).toBe(first)

      shouldThrow = false
      internals.reactivityGraph.setRef(todosRef, null)

      const recovered = queryInstances[0]!.results$.previousResult as ReadonlyArray<Todo>
      expect(mapCalls).toBe(3)
      expect(recovered.map((row) => row.id)).toEqual(['a', 'b', 'c'])
      expect(recovered[0]).toBe(first[0])
      expect(recovered[1]).toBe(first[1])
      expect(Object.isFrozen(recovered)).toBe(false)

      unsubscribe()
    }).pipe(Effect.scoped),
  )
})

Vitest.describe('otel', () => {
  const mapAttributes = (attributes: otel.Attributes) => {
    return ReadonlyRecord.map(attributes, (val, key) => {
      if (key === 'code.stacktrace') {
        return '<STACKTRACE>'
      }
      // Savepoint ids are process-local counters, not part of the query tracing contract.
      if (key === 'sql.query' && typeof val === 'string') {
        return val.replace(/livestore_savepoint_\d+/g, 'livestore_savepoint_<id>')
      }
      return val
    })
  }

  const makeQuery = Effect.gen(function* () {
    const exporter = new InMemorySpanExporter()

    RG.__resetIds()

    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })

    const otelTracer = provider.getTracer('test')

    const span = otelTracer.startSpan('test-root')
    const otelContext = otel.trace.setSpan(otel.context.active(), span)

    const store = yield* makeTodoMvc({ otelTracer, otelContext })

    return {
      store,
      otelTracer,
      exporter,
      span,
      provider,
    }
  })

  Vitest.live('otel', () =>
    Effect.gen(function* () {
      const { store, exporter, span, provider } = yield* makeQuery

      const query$ = queryDb({
        query: `select * from todos`,
        schema: Schema.Array(tables.todos.rowSchema),
        queriedTables: new Set(['todos']),
      })
      expect(store.query(query$)).toMatchInlineSnapshot('[]')

      store.commit(events.todoCreated({ id: 't1', text: 'buy milk', completed: false }))

      expect(store.query(query$)).toMatchInlineSnapshot(`
      [
        {
          "completed": false,
          "id": "t1",
          "text": "buy milk",
        },
      ]
    `)

      span.end()

      return { exporter, provider }
    }).pipe(
      Effect.scoped,
      Effect.tap(({ exporter, provider }) =>
        Effect.promise(async () => {
          await provider.forceFlush()
          expect(getSimplifiedRootSpan(exporter, 'createStore', mapAttributes)).toMatchSnapshot()
          expect(getAllSimplifiedRootSpans(exporter, 'LiveStore:commit', mapAttributes)).toMatchSnapshot()
          await provider.shutdown()
        }),
      ),
    ),
  )

  Vitest.live('with thunks', () =>
    Effect.gen(function* () {
      const { store, exporter, span, provider } = yield* makeQuery

      const defaultTodo = { id: '', text: '', completed: false }

      const filter = computed(() => `where completed = 0`, { label: 'where-filter' })
      const query$ = queryDb(
        (get) => ({
          query: `select * from todos ${get(filter)}`,
          schema: Schema.Array(tables.todos.rowSchema).pipe(Schema.headOrElse(() => defaultTodo)),
        }),
        { label: 'all todos' },
      )

      expect(store[StoreInternalsSymbol].reactivityGraph.getSnapshot({ includeResults: true })).toMatchSnapshot()

      expect(store.query(query$)).toMatchInlineSnapshot(`
      {
        "completed": false,
        "id": "",
        "text": "",
      }
    `)

      expect(store[StoreInternalsSymbol].reactivityGraph.getSnapshot({ includeResults: true })).toMatchSnapshot()

      store.commit(events.todoCreated({ id: 't1', text: 'buy milk', completed: false }))

      expect(store[StoreInternalsSymbol].reactivityGraph.getSnapshot({ includeResults: true })).toMatchSnapshot()

      expect(store.query(query$)).toMatchInlineSnapshot(`
      {
        "completed": false,
        "id": "t1",
        "text": "buy milk",
      }
    `)

      expect(store[StoreInternalsSymbol].reactivityGraph.getSnapshot({ includeResults: true })).toMatchSnapshot()

      span.end()

      return { exporter, provider }
    }).pipe(
      Effect.scoped,
      Effect.tap(({ exporter, provider }) =>
        Effect.promise(async () => {
          await provider.forceFlush()
          expect(getSimplifiedRootSpan(exporter, 'createStore', mapAttributes)).toMatchSnapshot()
          expect(getAllSimplifiedRootSpans(exporter, 'LiveStore:commit', mapAttributes)).toMatchSnapshot()
          await provider.shutdown()
        }),
      ),
    ),
  )

  Vitest.live('with thunks with query builder and without labels', () =>
    Effect.gen(function* () {
      const { store, exporter, span, provider } = yield* makeQuery

      const defaultTodo = { id: '', text: '', completed: false }

      const filter = computed(() => ({ completed: false }))
      const query$ = queryDb((get) =>
        tables.todos.where(get(filter)).first({ behaviour: 'fallback', fallback: () => defaultTodo }),
      )

      expect(store.query(query$)).toMatchInlineSnapshot(`
      {
        "completed": false,
        "id": "",
        "text": "",
      }
    `)

      store.commit(events.todoCreated({ id: 't1', text: 'buy milk', completed: false }))

      expect(store.query(query$)).toMatchInlineSnapshot(`
      {
        "completed": false,
        "id": "t1",
        "text": "buy milk",
      }
    `)

      span.end()

      return { exporter, provider }
    }).pipe(
      Effect.scoped,
      Effect.tap(({ exporter, provider }) =>
        Effect.promise(async () => {
          await provider.forceFlush()
          expect(getSimplifiedRootSpan(exporter, 'createStore', mapAttributes)).toMatchSnapshot()
          expect(getAllSimplifiedRootSpans(exporter, 'LiveStore:commit', mapAttributes)).toMatchSnapshot()
          await provider.shutdown()
        }),
      ),
    ),
  )

  Vitest.live('QueryBuilder subscription - basic functionality', () =>
    Effect.gen(function* () {
      const { store, exporter, span, provider } = yield* makeQuery

      const callbackResults: any[] = []
      const defaultTodo = { id: '', text: '', completed: false }

      const queryBuilder = tables.todos
        .where({ completed: false })
        .first({ behaviour: 'fallback', fallback: () => defaultTodo })

      const unsubscribe = store.subscribe(queryBuilder, (result) => {
        callbackResults.push(result)
      })

      expect(callbackResults).toHaveLength(1)
      expect(callbackResults[0]).toMatchObject(defaultTodo)

      store.commit(events.todoCreated({ id: 't1', text: 'buy milk', completed: false }))

      expect(callbackResults).toHaveLength(2)
      expect(callbackResults[1]).toMatchObject({
        id: 't1',
        text: 'buy milk',
        completed: false,
      })

      unsubscribe()
      span.end()

      return { exporter, provider }
    }).pipe(
      Effect.scoped,
      Effect.tap(({ exporter, provider }) =>
        Effect.promise(async () => {
          await provider.forceFlush()
          expect(getSimplifiedRootSpan(exporter, 'createStore', mapAttributes)).toMatchSnapshot()
          expect(getAllSimplifiedRootSpans(exporter, 'LiveStore:commit', mapAttributes)).toMatchSnapshot()
          await provider.shutdown()
        }),
      ),
    ),
  )

  Vitest.live('QueryBuilder subscription - skipInitialRun', () =>
    Effect.gen(function* () {
      const { store, exporter, span, provider } = yield* makeQuery

      const callbackResults: Todo[] = []
      const defaultTodo: Todo = { id: '', text: '', completed: false }

      const queryBuilder = tables.todos
        .where({ completed: false })
        .first({ behaviour: 'fallback', fallback: () => defaultTodo })

      const unsubscribe = store.subscribe(
        queryBuilder,
        (result) => {
          callbackResults.push(result)
        },
        { skipInitialRun: true },
      )

      expect(callbackResults).toHaveLength(0)

      store.commit(events.todoCreated({ id: 't-skip', text: 'skip initial', completed: false }))

      expect(callbackResults).toHaveLength(1)
      expect(callbackResults[0]).toMatchObject({
        id: 't-skip',
        text: 'skip initial',
        completed: false,
      })

      unsubscribe()
      span.end()

      return { exporter, provider }
    }).pipe(
      Effect.scoped,
      Effect.tap(({ exporter, provider }) =>
        Effect.promise(async () => {
          await provider.forceFlush()
          expect(getSimplifiedRootSpan(exporter, 'createStore', mapAttributes)).toMatchSnapshot()
          expect(getAllSimplifiedRootSpans(exporter, 'LiveStore:commit', mapAttributes)).toMatchSnapshot()
          await provider.shutdown()
        }),
      ),
    ),
  )

  Vitest.live('QueryBuilder subscription - unsubscribe functionality', () =>
    Effect.gen(function* () {
      const { store, exporter, span, provider } = yield* makeQuery

      const callbackResults1: any[] = []
      const callbackResults2: any[] = []
      const defaultTodo = { id: '', text: '', completed: false }

      const queryBuilder = tables.todos
        .where({ completed: false })
        .first({ behaviour: 'fallback', fallback: () => defaultTodo })

      const unsubscribe1 = store.subscribe(queryBuilder, (result) => {
        callbackResults1.push(result)
      })

      const unsubscribe2 = store.subscribe(queryBuilder, (result) => {
        callbackResults2.push(result)
      })

      expect(callbackResults1).toHaveLength(1)
      expect(callbackResults2).toHaveLength(1)

      store.commit(events.todoCreated({ id: 't3', text: 'read book', completed: false }))

      expect(callbackResults1).toHaveLength(2)
      expect(callbackResults2).toHaveLength(2)

      unsubscribe1()

      store.commit(events.todoCreated({ id: 't4', text: 'cook dinner', completed: false }))

      expect(callbackResults1).toHaveLength(2)
      expect(callbackResults2).toHaveLength(2)

      unsubscribe2()
      span.end()

      return { exporter, provider }
    }).pipe(
      Effect.scoped,
      Effect.tap(({ exporter, provider }) =>
        Effect.promise(async () => {
          await provider.forceFlush()
          expect(getSimplifiedRootSpan(exporter, 'createStore', mapAttributes)).toMatchSnapshot()
          expect(getAllSimplifiedRootSpans(exporter, 'LiveStore:commit', mapAttributes)).toMatchSnapshot()
          await provider.shutdown()
        }),
      ),
    ),
  )

  Vitest.live('QueryBuilder subscription - async iterator', () =>
    Effect.gen(function* () {
      const { store, exporter, span, provider } = yield* makeQuery

      const defaultTodo: Todo = { id: '', text: '', completed: false }

      const queryBuilder = tables.todos
        .where({ completed: false })
        .first({ behaviour: 'fallback', fallback: () => defaultTodo })

      yield* Effect.promise(async () => {
        const iterator = store.subscribe(queryBuilder)[Symbol.asyncIterator]()

        const initial = await iterator.next()
        expect(initial.done).toBe(false)
        expect(initial.value).toMatchObject(defaultTodo)

        store.commit(events.todoCreated({ id: 't-async', text: 'write tests', completed: false }))

        const update = await iterator.next()
        expect(update.done).toBe(false)
        expect(update.value).toMatchObject({
          id: 't-async',
          text: 'write tests',
          completed: false,
        })

        const doneResult = await iterator.return?.()
        assert(doneResult)
        expect(doneResult.done).toBe(true)
      })

      span.end()

      return { exporter, provider }
    }).pipe(
      Effect.scoped,
      Effect.tap(({ exporter, provider }) =>
        Effect.promise(async () => {
          await provider.forceFlush()
          expect(getSimplifiedRootSpan(exporter, 'createStore', mapAttributes)).toMatchSnapshot()
          expect(getAllSimplifiedRootSpans(exporter, 'LiveStore:commit', mapAttributes)).toMatchSnapshot()
          await provider.shutdown()
        }),
      ),
    ),
  )

  Vitest.live('QueryBuilder subscription - async iterator with skipInitialRun', () =>
    Effect.gen(function* () {
      const { store, exporter, span, provider } = yield* makeQuery

      const defaultTodo: Todo = { id: '', text: '', completed: false }

      const queryBuilder = tables.todos
        .where({ completed: false })
        .first({ behaviour: 'fallback', fallback: () => defaultTodo })

      yield* Effect.promise(async () => {
        const iterator = store.subscribe(queryBuilder, { skipInitialRun: true })[Symbol.asyncIterator]()

        const pending = Symbol('pending')
        const nextPromise = iterator.next()
        const raceResult = await Promise.race([nextPromise, Promise.resolve(pending)])
        expect(raceResult).toBe(pending)

        store.commit(events.todoCreated({ id: 't-async-skip', text: 'write tests later', completed: false }))

        const update = await nextPromise
        expect(update.done).toBe(false)
        expect(update.value).toMatchObject({
          id: 't-async-skip',
          text: 'write tests later',
          completed: false,
        })

        const doneResult = await iterator.return?.()
        assert(doneResult)
        expect(doneResult.done).toBe(true)
      })

      span.end()

      return { exporter, provider }
    }).pipe(
      Effect.scoped,
      Effect.tap(({ exporter, provider }) =>
        Effect.promise(async () => {
          await provider.forceFlush()
          expect(getSimplifiedRootSpan(exporter, 'createStore', mapAttributes)).toMatchSnapshot()
          expect(getAllSimplifiedRootSpans(exporter, 'LiveStore:commit', mapAttributes)).toMatchSnapshot()
          await provider.shutdown()
        }),
      ),
    ),
  )

  Vitest.live('QueryBuilder subscription - direct table subscription', () =>
    Effect.gen(function* () {
      const { store, exporter, span, provider } = yield* makeQuery

      const callbackResults: any[] = []

      const unsubscribe = store.subscribe(tables.todos, (result) => {
        callbackResults.push(result)
      })

      expect(callbackResults).toHaveLength(1)
      expect(callbackResults[0]).toEqual([])

      store.commit(events.todoCreated({ id: 't5', text: 'clean house', completed: true }))

      expect(callbackResults).toHaveLength(2)
      expect(callbackResults[1]).toHaveLength(1)
      expect(callbackResults[1][0]).toMatchObject({
        id: 't5',
        text: 'clean house',
        completed: true,
      })

      unsubscribe()
      span.end()

      return { exporter, provider }
    }).pipe(
      Effect.scoped,
      Effect.tap(({ exporter, provider }) =>
        Effect.promise(async () => {
          await provider.forceFlush()
          expect(getSimplifiedRootSpan(exporter, 'createStore', mapAttributes)).toMatchSnapshot()
          expect(getAllSimplifiedRootSpans(exporter, 'LiveStore:commit', mapAttributes)).toMatchSnapshot()
          await provider.shutdown()
        }),
      ),
    ),
  )
})
