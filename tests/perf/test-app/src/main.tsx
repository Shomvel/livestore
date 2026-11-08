import React, { StrictMode, Suspense, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { StoreRegistry } from '@livestore/livestore'
import { StoreRegistryProvider } from '@livestore/react'

import { allItems$, uiState$ } from './queries.ts'
import { events, type Item, type Items } from './schema.ts'
import { useAppStore } from './store.ts'

const A = [
  'pretty',
  'large',
  'big',
  'small',
  'tall',
  'short',
  'long',
  'handsome',
  'plain',
  'quaint',
  'clean',
  'elegant',
  'easy',
  'angry',
  'crazy',
  'helpful',
  'mushy',
  'odd',
  'unsightly',
  'adorable',
  'important',
  'inexpensive',
  'cheap',
  'expensive',
  'fancy',
]
const C = ['red', 'yellow', 'blue', 'green', 'pink', 'brown', 'purple', 'brown', 'white', 'black', 'orange']
const N = [
  'table',
  'chair',
  'house',
  'bbq',
  'desk',
  'car',
  'pony',
  'cookie',
  'sandwich',
  'burger',
  'pizza',
  'mouse',
  'keyboard',
]

const random = (max: number) => Math.round(Math.random() * 1000) % max

const selectedRowStyle = { backgroundColor: 'lightblue' } as const
const defaultRowStyle = { backgroundColor: 'white' } as const
const suspenseFallback = <p>Loading...</p>

let nextId = 1
const generateRandomItems = (count: number): Items => {
  const items: Items = Array.from({ length: count })
  for (let i = 0; i < count; i++) {
    items[i] = {
      id: nextId++,
      label: `${A[random(A.length)]} ${C[random(C.length)]} ${N[random(N.length)]}`,
    }
  }
  return items
}

const RemoveIcon = <span>X</span>

const ItemRow = React.memo(({ item, isSelected }: { item: Item; isSelected: boolean }) => (
  <tr style={isSelected === true ? selectedRowStyle : defaultRowStyle}>
    <td>{item.id}</td>
    <td>
      <button type="button" id={`select-${item.id}`} data-action="select" data-item-id={item.id}>
        {item.label}
      </button>
    </td>
    <td>
      <button type="button" id={`remove-${item.id}`} data-action="remove" data-item-id={item.id}>
        {RemoveIcon}
      </button>
    </td>
    <td />
  </tr>
))

const ItemRowList = React.memo(() => {
  const store = useAppStore()
  const items = store.useQuery(allItems$)
  const { selected } = store.useQuery(uiState$)

  // One selection subscription feeds memoized rows; only rows with a changed boolean prop render.
  // A newly populated list mounts as one placement instead of scanning every pending row sibling.
  return (
    <React.Fragment key={items.length === 0 ? 'empty' : 'populated'}>
      {items.map((item) => (
        <ItemRow key={item.id} item={item} isSelected={selected === item.id} />
      ))}
    </React.Fragment>
  )
})

const Button = React.memo(
  ({ id, onClick, children }: { id: string; onClick: () => void; children: React.ReactNode }) => (
    <button type="button" id={id} onClick={onClick}>
      {children}
    </button>
  ),
)

const Main = () => {
  const store = useAppStore()

  const handleCreate1k = React.useCallback(() => {
    // We commit a single event instead of one per item to better represent user intention. The user didn't press a button 1000 times for each item; they pressed it once to create 1000 items.
    // We need to include the items in the event payload rather than generating them in the materializer. Otherwise, the materializer wouldn't be deterministic.
    store.commit(events.thousandItemsCreated(generateRandomItems(1000)))
  }, [store])
  const handleCreate10k = React.useCallback(() => {
    store.commit(events.tenThousandItemsCreated(generateRandomItems(10_000)))
  }, [store])
  const handleAppend1k = React.useCallback(() => {
    store.commit(events.thousandItemsAppended(generateRandomItems(1000)))
  }, [store])
  const handleUpdateEvery10th = React.useCallback(() => {
    store.commit(events.everyTenthItemUpdated())
  }, [store])
  const handleClear = React.useCallback(() => {
    store.commit(events.allItemsDeleted())
  }, [store])
  // Delegate row clicks so rows need no callback hooks or wrapper button components.
  const handleRowClick = React.useCallback(
    (event: React.MouseEvent<HTMLTableSectionElement>) => {
      if (event.target instanceof Element === false) return
      const button = event.target.closest<HTMLButtonElement>('button[data-action][data-item-id]')
      if (button === null || event.currentTarget.contains(button) === false) return

      const id = Number(button.dataset.itemId)
      if (Number.isFinite(id) === false) return
      if (button.dataset.action === 'select') {
        store.commit(events.uiStateSet({ selected: id }))
      } else if (button.dataset.action === 'remove') {
        store.commit(events.itemDeleted({ id }))
      }
    },
    [store],
  )

  return (
    <div>
      <div>
        <h1>React + LiveStore</h1>
        <div>
          <Button id="create1k" onClick={handleCreate1k}>
            Create 1,000 items
          </Button>
          <Button id="create10k" onClick={handleCreate10k}>
            Create 10,000 items
          </Button>
          <Button id="append1k" onClick={handleAppend1k}>
            Append 1,000 items
          </Button>
          <Button id="updateEvery10th" onClick={handleUpdateEvery10th}>
            Update every 10th items
          </Button>
          <Button id="clear" onClick={handleClear}>
            Clear
          </Button>
        </div>
      </div>
      <table>
        <tbody onClick={handleRowClick}>
          <ItemRowList />
        </tbody>
      </table>
    </div>
  )
}

const App = () => {
  const [storeRegistry] = useState(() => new StoreRegistry())

  return (
    <Suspense fallback={suspenseFallback}>
      <StoreRegistryProvider storeRegistry={storeRegistry}>
        <Main />
      </StoreRegistryProvider>
    </Suspense>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
