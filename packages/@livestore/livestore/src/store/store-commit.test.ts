import { expect } from 'vitest'

import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { provideOtel } from '@livestore/common'
import { createStore, Events, makeSchema, State, StoreInternalsSymbol } from '@livestore/livestore'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect, Exit, Schema } from '@livestore/utils/effect'

import { events, makeTodoMvc, tables } from '../utils/tests/fixture.ts'

Vitest.describe('Store commit API', () => {
  Vitest.live('should materialize events returned by the commit callback', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const firstTodo = { id: '1', text: 'Make coffee', completed: false }
      const secondTodo = { id: '2', text: 'Buy groceries', completed: false }

      // Regression for https://github.com/livestorejs/livestore/issues/1611.
      store.commit(() => {
        expect(store.query(tables.todos)).toEqual([])
        return [events.todoCreated(firstTodo), events.todoCreated(secondTodo)]
      })

      expect(store.query(tables.todos.orderBy('id', 'asc'))).toEqual([firstTodo, secondTodo])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should materialize a single callback event', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const todo = { id: '1', text: 'Make coffee', completed: false }
      const batch = [events.todoCreated(todo)] as const

      store.commit(() => batch)

      expect(store.query(tables.todos)).toEqual([todo])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should accept an empty callback', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()

      store.commit(() => [])

      expect(store.query(tables.todos)).toEqual([])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should apply no events when the callback throws', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const todo = { id: '1', text: 'Make coffee', completed: false }
      const error = new Error('Callback failed')

      expect(() =>
        store.commit(() => {
          throw error
        }),
      ).toThrow(error)

      expect(store.query(tables.todos)).toEqual([])
      store.commit(events.todoCreated(todo))
      expect(store.query(tables.todos)).toEqual([todo])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should commit multiple returned event types in order', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const todo = { id: '1', text: 'Make coffee', completed: false }

      store.commit(() => [events.todoCreated(todo), events.todoCompleted({ id: todo.id })])

      expect(store.query(tables.todos)).toEqual([{ ...todo, completed: true }])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should preserve direct batch order and batch table refreshes', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const firstTodo = { id: '1', text: 'Make coffee', completed: false }
      const secondTodo = { id: '2', text: 'Buy groceries', completed: false }
      const snapshots: Array<Array<typeof firstTodo>> = []
      const unsubscribe = store.subscribe(tables.todos.orderBy('id', 'asc'), (todos) => {
        snapshots.push([...todos])
      })

      store.commit(
        events.todoCreated(firstTodo),
        events.todoCreated(secondTodo),
        events.todoCompleted({ id: firstTodo.id }),
      )

      expect(snapshots).toEqual([[], [{ ...firstTodo, completed: true }, secondTodo]])
      unsubscribe()
    }).pipe(Effect.scoped),
  )

  for (const options of [{}, { label: 'Create todo' }]) {
    Vitest.live(`should accept callback options ${JSON.stringify(options)}`, () =>
      Effect.gen(function* () {
        const store = yield* makeTodoMvc()
        const todo = { id: '1', text: 'Make coffee', completed: false }

        store.commit(options, () => [events.todoCreated(todo)])

        expect(store.query(tables.todos)).toEqual([todo])
      }).pipe(Effect.scoped),
    )
  }

  Vitest.live('should reject callback values that are not event arrays', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()

      expect(() => Reflect.apply(store.commit, store, [() => undefined])).toThrow(
        'store.commit callback must synchronously return an array of events',
      )
      expect(() => Reflect.apply(store.commit, store, [() => Promise.resolve([])])).toThrow(
        'store.commit callback must synchronously return an array of events',
      )

      expect(store.query(tables.todos)).toEqual([])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should reject non-array and asynchronous callbacks at the type level', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()

      // Keep invalid calls uninvoked so TypeScript checks the public overloads without executing them.
      const assertRejectedCallbackTypes = () => {
        // @ts-expect-error Commit callbacks must return an event array.
        store.commit(() => {})
        // @ts-expect-error Commit callbacks do not receive an event emitter.
        store.commit((emit: () => void) => {
          emit()
          return []
        })
        // @ts-expect-error Commit callbacks must be synchronous.
        store.commit(async () => [])
      }

      expect(assertRejectedCallbackTypes).toBeTypeOf('function')
    }).pipe(Effect.scoped),
  )

  Vitest.live('should still accept direct events with options and no events', () =>
    Effect.gen(function* () {
      const store = yield* makeTodoMvc()
      const todo = { id: '1', text: 'Make coffee', completed: false }

      store.commit()
      store.commit({ label: 'Empty commit' })
      store.commit({ label: 'Create and complete' }, events.todoCreated(todo), events.todoCompleted({ id: todo.id }))

      expect(store.query(tables.todos)).toEqual([{ ...todo, completed: true }])
    }).pipe(Effect.scoped),
  )
})

Vitest.describe('Store bulk materialization', () => {
  Vitest.live('should chunk large adjacent inserts and preserve per-row trigger behavior', () =>
    Effect.gen(function* () {
      const store = yield* makeBulkStore()
      const db = store[StoreInternalsSymbol].sqliteDbWrapper
      let itemInserts = 0
      let journalWrites = 0
      let changesets = 0
      const cachedExecute = db.cachedExecute.bind(db)
      db.cachedExecute = (sql, bindValues, options) => {
        if (sql.startsWith("INSERT INTO 'items'")) itemInserts++
        if (sql.includes('__livestore_materialization_journal')) journalWrites++
        return cachedExecute(sql, bindValues, options)
      }
      const withChangeset = db.withChangeset.bind(db)
      db.withChangeset = (callback) => {
        changesets++
        return withChangeset(callback)
      }
      const rawDb = store[StoreInternalsSymbol].clientSession.sqliteDb
      rawDb.execute('CREATE TABLE insert_audit (itemId INTEGER)')
      rawDb.execute(`
        CREATE TRIGGER items_insert_audit AFTER INSERT ON items
        BEGIN INSERT INTO insert_audit VALUES (NEW.id); END;
      `)
      const rows = Array.from({ length: 2000 }, (_, id) => ({ id, label: `item-${id}` }))

      store.commit({ skipRefresh: true }, bulkItemsCreated(rows))

      expect(itemInserts).toBe(5)
      expect(changesets).toBe(1)
      expect(journalWrites).toBe(2)
      expect(db.select<{ count: number }>('SELECT COUNT(*) AS count FROM items')[0]?.count).toBe(2000)
      const audit = db.select<{ itemId: number }>('SELECT itemId FROM insert_audit ORDER BY rowid')
      expect(audit).toHaveLength(2000)
      expect(audit[0]?.itemId).toBe(0)
      expect(audit.at(-1)?.itemId).toBe(1999)
    }).pipe(Effect.scoped),
  )

  Vitest.live('should leave small insert batches unmodified', () =>
    Effect.gen(function* () {
      const store = yield* makeBulkStore()
      const db = store[StoreInternalsSymbol].sqliteDbWrapper
      let itemInserts = 0
      const cachedExecute = db.cachedExecute.bind(db)
      db.cachedExecute = (sql, bindValues, options) => {
        if (sql.startsWith("INSERT INTO 'items'")) itemInserts++
        return cachedExecute(sql, bindValues, options)
      }
      const rows = Array.from({ length: 1000 }, (_, id) => ({ id, label: `item-${id}` }))

      store.commit({ skipRefresh: true }, bulkItemsCreated(rows))

      expect(itemInserts).toBe(1000)
      expect(db.select<{ count: number }>('SELECT COUNT(*) AS count FROM items')[0]?.count).toBe(1000)
    }).pipe(Effect.scoped),
  )

  Vitest.live('should roll back the whole event when a batched row violates a constraint', () =>
    Effect.gen(function* () {
      const store = yield* makeBulkStore()
      const rows = Array.from({ length: 2000 }, (_, id) => ({ id, label: `item-${id}` }))
      rows[1000] = { id: 0, label: 'duplicate' }

      const exit = yield* store[StoreInternalsSymbol].syncProcessor.commit([bulkItemsCreated(rows)]).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)

      const db = store[StoreInternalsSymbol].clientSession.sqliteDb
      expect(db.select('SELECT * FROM items')).toEqual([])
      expect(db.select('SELECT * FROM __livestore_materialization_journal')).toEqual([])
    }).pipe(Effect.scoped),
  )

  Vitest.live('should not combine inserts across events', () =>
    Effect.gen(function* () {
      const store = yield* makeBulkStore()
      const db = store[StoreInternalsSymbol].sqliteDbWrapper
      let itemInserts = 0
      let changesets = 0
      const cachedExecute = db.cachedExecute.bind(db)
      db.cachedExecute = (sql, bindValues, options) => {
        if (sql.startsWith("INSERT INTO 'items'")) itemInserts++
        return cachedExecute(sql, bindValues, options)
      }
      const withChangeset = db.withChangeset.bind(db)
      db.withChangeset = (callback) => {
        changesets++
        return withChangeset(callback)
      }

      store.commit(bulkItemsCreated([{ id: 1, label: 'first' }]))
      store.commit(bulkItemsCreated([{ id: 2, label: 'second' }]))

      expect(itemInserts).toBe(2)
      expect(changesets).toBe(2)
      expect(db.select('SELECT id FROM items ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }])
    }).pipe(Effect.scoped),
  )
})

const bulkItems = State.SQLite.table({
  name: 'items',
  columns: { id: State.SQLite.integer({ primaryKey: true }), label: State.SQLite.text() },
})
const bulkItemsCreated = Events.synced({
  name: 'bulk.items.created',
  schema: Schema.Array(Schema.Struct({ id: Schema.Finite, label: Schema.String })),
})
const bulkEvents = { bulkItemsCreated }
const bulkSchema = makeSchema({
  events: bulkEvents,
  state: State.SQLite.makeState({
    tables: { bulkItems },
    materializers: State.SQLite.materializers(bulkEvents, {
      [bulkItemsCreated.name]: (rows) => rows.map((row) => bulkItems.insert(row)),
    }),
  }),
})
const makeBulkStore = () =>
  createStore({ schema: bulkSchema, storeId: 'bulk-materialization', adapter: makeInMemoryAdapter() }).pipe(
    provideOtel({}),
  )
