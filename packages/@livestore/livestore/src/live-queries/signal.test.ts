import { expect } from 'vitest'

import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect } from '@livestore/utils/effect'

import { makeTodoMvc } from '../utils/tests/fixture.ts'
import { computed } from './computed.ts'
import { signal } from './signal.ts'

Vitest.describe('signal', () => {
  Vitest.live('should be able to create a signal', () =>
    Effect.gen(function* () {
      const num$ = signal(0, { label: 'num$' })

      const duplicated$ = computed((get) => get(num$) * 2, { label: 'duplicated$' })

      const store = yield* makeTodoMvc({})

      expect(store.query(duplicated$)).toBe(0)

      store.setSignal(num$, 1)

      expect(store.query(duplicated$)).toBe(2)
    }),
  )

  Vitest.live('does not recompute or notify for deeply equivalent writes', () =>
    Effect.gen(function* () {
      const filter$ = signal({ text: 'all' })
      const result$ = computed((get) => ({ text: get(filter$).text }), { label: 'result$' })
      const store = yield* makeTodoMvc({})
      const observed: { text: string }[] = []
      const queryInstances: { runs: number }[] = []
      const unsubscribe = store.subscribe(result$, (result) => observed.push(result), {
        onSubscribe: (query) => {
          queryInstances.push(query)
        },
      })
      const firstResult = observed[0]

      store.setSignal(filter$, { text: 'all' })

      expect(queryInstances[0]!.runs).toBe(1)
      expect(observed).toHaveLength(1)
      expect(observed[0]).toBe(firstResult)

      store.setSignal(filter$, { text: 'active' })

      expect(queryInstances[0]!.runs).toBe(2)
      expect(observed).toHaveLength(2)
      expect(observed[1]).not.toBe(firstResult)
      expect(observed[1]).toEqual({ text: 'active' })

      unsubscribe()
    }),
  )

  Vitest.live('counter example', () =>
    Effect.gen(function* () {
      const count$ = signal(0, { label: 'count$' })

      const store = yield* makeTodoMvc({})

      const increment = () => store.setSignal(count$, (prev) => prev + 1)

      increment()
      increment()

      expect(store.query(count$)).toBe(2)
    }),
  )
})
