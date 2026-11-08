import { makeSchema, Schema, SessionIdSymbol, State } from '@livestore/livestore'

import * as eventsDefs from './events.ts'

const items = State.SQLite.table({
  name: 'items',
  columns: {
    id: State.SQLite.integer({ primaryKey: true }),
    label: State.SQLite.text({ nullable: false }),
  },
})

export type Item = typeof items.Type
export type Items = Item[]

const uiState = State.SQLite.clientDocument({
  name: 'uiState',
  schema: Schema.Struct({ selected: Schema.NullOr(Schema.Finite) }),
  default: {
    id: SessionIdSymbol,
    value: { selected: null },
  },
})

export type UiState = typeof uiState.Value

export const events = {
  ...eventsDefs,
  uiStateSet: uiState.set,
}

export const tables = { items, uiState }

const materializers = State.SQLite.materializers(events, {
  'v1.ThousandItemsCreated': (thousandItems) => [items.delete(), ...thousandItems.map((item) => items.insert(item))],
  'v1.TenThousandItemsCreated': (tenThousandItems) => [
    items.delete(),
    ...tenThousandItems.map((item) => items.insert(item)),
  ],
  'v1.ThousandItemsAppended': (thousandItems) => thousandItems.map((item) => items.insert(item)),
  'v1.ItemDeleted': ({ id }) => items.delete().where({ id }),
  'v1.EveryTenthItemUpdated': () => ({
    // Rank the current rows so deletions and non-contiguous ids preserve every-tenth-row behavior.
    sql: `UPDATE items SET label = label || ' !!!'
      WHERE id IN (
        SELECT id FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS position FROM items)
        WHERE position % 10 = 1
      )`,
    bindValues: [],
    writeTables: new Set([items.sqliteDef.name]),
  }),
  'v1.AllItemsDeleted': () => items.delete(),
})

const state = State.SQLite.makeState({ tables, materializers })

export const schema = makeSchema({ events, state })

export type AppSchema = typeof schema
