import { expect, it } from 'vitest'

import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { StoreInternalsSymbol, StoreRegistry } from '@livestore/livestore'
import { Effect } from '@livestore/utils/effect'

import { events, schema, tables } from '../test-app/src/schema.ts'

it('updates every tenth remaining row for sparse ids, deletions and repeated events', async () => {
  const registry = new StoreRegistry()
  try {
    const store = await registry.getOrLoadPromise({
      schema,
      storeId: 'sparse-perf-materializer',
      adapter: makeInMemoryAdapter(),
    })
    store.commit(
      events.thousandItemsCreated(Array.from({ length: 1000 }, (_, index) => ({ id: index * 2 + 5, label: 'row' }))),
    )
    store.commit(events.itemDeleted({ id: 5 }), events.itemDeleted({ id: 47 }))

    const db = store[StoreInternalsSymbol].sqliteDbWrapper
    const rawDb = store[StoreInternalsSymbol].clientSession.sqliteDb
    rawDb.execute('CREATE TABLE update_audit (itemId INTEGER)')
    rawDb.execute(`CREATE TRIGGER item_update AFTER UPDATE ON items
    BEGIN INSERT INTO update_audit VALUES (NEW.id); END`)
    const before = store.query(tables.items.orderBy('id', 'asc'))

    store.commit(events.everyTenthItemUpdated(), events.everyTenthItemUpdated())

    expect(store.query(tables.items.orderBy('id', 'asc'))).toEqual(
      before.map((row, index) => ({ ...row, label: index % 10 === 0 ? `${row.label} !!! !!!` : row.label })),
    )
    expect(db.select<{ count: number }>('SELECT COUNT(*) AS count FROM update_audit')).toEqual([{ count: 200 }])
  } finally {
    await registry.dispose()
  }
})

it('rolls back the set-based update when a row trigger rejects it', async () => {
  const registry = new StoreRegistry()
  try {
    const store = await registry.getOrLoadPromise({
      schema,
      storeId: 'rollback-perf-materializer',
      adapter: makeInMemoryAdapter(),
    })
    store.commit(
      events.thousandItemsCreated(Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, label: 'row' }))),
    )
    const rawDb = store[StoreInternalsSymbol].clientSession.sqliteDb
    rawDb.execute(`CREATE TRIGGER reject_update BEFORE UPDATE ON items WHEN NEW.id = 501
    BEGIN SELECT RAISE(ABORT, 'rejected update'); END`)
    const before = rawDb.select('SELECT * FROM items ORDER BY id')
    const journalBefore = rawDb.select('SELECT * FROM __livestore_materialization_journal ORDER BY rowid')

    const outcome = await Effect.runPromise(
      store[StoreInternalsSymbol].syncProcessor.commit([events.everyTenthItemUpdated()]).pipe(Effect.exit),
    )

    expect(outcome._tag).toBe('Failure')
    expect(rawDb.select('SELECT * FROM items ORDER BY id')).toEqual(before)
    expect(rawDb.select('SELECT * FROM __livestore_materialization_journal ORDER BY rowid')).toEqual(journalBefore)
  } finally {
    await registry.dispose()
  }
})
