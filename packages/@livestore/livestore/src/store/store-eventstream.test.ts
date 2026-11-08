import { expect } from 'vitest'

import { makeInMemoryAdapter } from '@livestore/adapter-web'
import type { MockSyncBackend } from '@livestore/common'
import { type Adapter, ClientSessionLeaderThreadProxy, makeMockSyncBackend, type UnknownError } from '@livestore/common'
import { EventSequenceNumber, LiveStoreEvent, type LiveStoreSchema, makeSchema } from '@livestore/common/schema'
import { EventFactory } from '@livestore/common/testing'
import type { ShutdownDeferred, Store } from '@livestore/livestore'
import { createStore, makeShutdownDeferred, StoreInternalsSymbol } from '@livestore/livestore'
import { omitUndefineds } from '@livestore/utils'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import {
  type OtelTracer,
  type Scope,
  Context,
  Deferred,
  Effect,
  FetchHttpClient,
  Layer,
  Queue,
  References,
  Stream,
} from '@livestore/utils/effect'
import { nanoid } from '@livestore/utils/nanoid'
import { PlatformNode } from '@livestore/utils/node'

import { events, schema, state, tables } from '../utils/tests/fixture.ts'

const withTestCtx = Vitest.makeWithTestCtx({
  makeLayer: () =>
    Layer.mergeAll(
      TestContextLive,
      PlatformNode.NodeFileSystem.layer,
      FetchHttpClient.layer,
      Layer.succeed(References.MinimumLogLevel, 'Debug'),
    ),
})

/**
 * The purpose of this test is a store integration test for event streaming.
 * Main test covering event streaming logic itself is located in:
 * tests/package-common/src/leader-thread/stream-events.test.ts
 */
Vitest.describe('Store events API', () => {
  Vitest.live('should resume when reconnected to sync backend', (test) =>
    Effect.gen(function* () {
      const { makeStore, mockSyncBackend } = yield* TestContext
      const store = yield* makeStore()
      yield* mockSyncBackend.connect

      const eventFactory = EventFactory.makeFactory(events)({
        client: EventFactory.clientIdentity('other-client', 'static-session-id'),
      })

      // Queue is used in order to allow analyzing the stream in stages
      const eventsQueue = yield* Queue.unbounded<LiveStoreEvent.Client.ForSchema<typeof schema>>()

      yield* store.eventsStream().pipe(
        Stream.tap((event) => Queue.offer(eventsQueue, event)),
        Stream.runDrain,
        Effect.forkScoped,
      )

      store.commit(eventFactory.todoCreated.next({ id: '1', text: 't1', completed: false }))
      const initialEvent = yield* Queue.take(eventsQueue)
      expect(initialEvent.name).toEqual('todo.created')
      expect(initialEvent.args).toMatchObject({ id: '1' })

      yield* mockSyncBackend.disconnect
      store.commit(eventFactory.todoCreated.next({ id: '2', text: 't2', completed: false }))
      const maybeWhileDisconnected = yield* Queue.take(eventsQueue).pipe(Effect.timeout('250 millis'), Effect.option)
      expect(maybeWhileDisconnected._tag).toEqual('None')

      yield* mockSyncBackend.connect
      const resumedEvent = yield* Queue.take(eventsQueue)
      expect(resumedEvent.name).toEqual('todo.created')
      expect(resumedEvent.args).toMatchObject({ id: '2' })
    }).pipe(withTestCtx(test)),
  )
})

Vitest.describe('Store event materialization', () => {
  Vitest.live('should preserve unknown event fallback semantics', (test) =>
    Effect.gen(function* () {
      const unknownEvents: Array<{ eventName: string; reason: string }> = []
      const schemaWithUnknownCallback = makeSchema({
        events,
        state,
        unknownEventHandling: {
          strategy: 'callback',
          onUnknownEvent: (context, error) => {
            unknownEvents.push({ eventName: context.event.name, reason: error.reason })
          },
        },
      })
      const { store, deliver } = yield* makeControlledStore(schemaWithUnknownCallback)
      const unknownEvent = LiveStoreEvent.Client.Encoded.make({
        name: 'todo.future',
        args: { id: 'future', text: 'future', completed: false },
        seqNum: EventSequenceNumber.Client.Composite.make({ global: 1, client: 0 }),
        parentSeqNum: EventSequenceNumber.Client.ROOT,
        clientId: 'future-client',
        sessionId: 'future-session',
      })

      yield* deliver([unknownEvent])

      expect(unknownEvents).toEqual([{ eventName: 'todo.future', reason: 'event-definition-missing' }])
      expect(store.query(tables.todos)).toEqual([])
      expect((yield* store[StoreInternalsSymbol].syncProcessor.syncState).localHead).toEqual(unknownEvent.seqNum)
    }).pipe(withTestCtx(test)),
  )

  Vitest.live('should replay pending events in order after a rebase', (test) =>
    Effect.gen(function* () {
      const { store, deliver, releasePush } = yield* makeControlledStore(schema)
      const localTodo = { id: 'local', text: 'local', completed: false }
      const remoteTodo = { id: 'remote', text: 'remote', completed: false }
      store.commit(events.todoCreated(localTodo), events.todoCompleted({ id: localTodo.id }))
      const remoteEvent = LiveStoreEvent.Client.Encoded.make({
        name: events.todoCreated.name,
        args: remoteTodo,
        seqNum: EventSequenceNumber.Client.Composite.make({ global: 1, client: 0 }),
        parentSeqNum: EventSequenceNumber.Client.ROOT,
        clientId: 'remote-client',
        sessionId: 'remote-session',
      })

      yield* deliver([remoteEvent])

      expect(store.query(tables.todos.orderBy('id', 'asc'))).toEqual([{ ...localTodo, completed: true }, remoteTodo])
      const pending = (yield* store[StoreInternalsSymbol].syncProcessor.syncState).pending
      expect(pending.map((event) => event.name)).toEqual([events.todoCreated.name, events.todoCompleted.name])
      expect(pending.map((event) => event.seqNum.global)).toEqual([2, 3])
      yield* releasePush
    }).pipe(withTestCtx(test)),
  )
})

class TestContext extends Context.Service<
  TestContext,
  {
    makeStore: (args?: {
      boot?: (store: Store) => void
      schema?: LiveStoreSchema
      testing?: {
        overrides?: {
          clientSession?: {
            leaderThreadProxy?: (
              original: ClientSessionLeaderThreadProxy.ClientSessionLeaderThreadProxy,
            ) => Partial<ClientSessionLeaderThreadProxy.ClientSessionLeaderThreadProxy>
          }
        }
      }
    }) => Effect.Effect<Store, UnknownError, Scope.Scope | OtelTracer.OtelTracer>
    mockSyncBackend: MockSyncBackend
    shutdownDeferred: ShutdownDeferred
  }
>()('TestContext') {}

const TestContextLive = Layer.effect(
  TestContext,
  Effect.gen(function* () {
    const mockSyncBackend = yield* makeMockSyncBackend()
    const shutdownDeferred = yield* makeShutdownDeferred

    const makeStore: typeof TestContext.Service.makeStore = (args) => {
      const baseAdapter = makeInMemoryAdapter({
        sync: { backend: () => mockSyncBackend.makeSyncBackend, onSyncError: 'shutdown' },
      })
      const leaderThreadProxy = args?.testing?.overrides?.clientSession?.leaderThreadProxy
      const adapter: Adapter =
        leaderThreadProxy === undefined
          ? baseAdapter
          : (adapterArgs) =>
              baseAdapter(adapterArgs).pipe(
                Effect.map((session) => ({
                  ...session,
                  leaderThread: ClientSessionLeaderThreadProxy.of(session.leaderThread, {
                    overrides: leaderThreadProxy,
                  }),
                })),
              )
      return createStore({
        schema: args?.schema ?? (schema as LiveStoreSchema),
        adapter,
        storeId: nanoid(),
        shutdownDeferred,
        ...omitUndefineds({ boot: args?.boot }),
      })
    }

    return { makeStore, mockSyncBackend, shutdownDeferred }
  }),
)

type PullRequest = {
  item: typeof ClientSessionLeaderThreadProxy.PullItem.Type
  completed: Deferred.Deferred<void>
}

const makeControlledStore = (storeSchema: LiveStoreSchema) =>
  Effect.gen(function* () {
    const { makeStore } = yield* TestContext
    const pulls = yield* Queue.unbounded<PullRequest>()
    const pushGate = yield* Deferred.make<void>()
    let previous: Deferred.Deferred<void> | undefined
    const store = yield* makeStore({
      schema: storeSchema,
      testing: {
        overrides: {
          clientSession: {
            leaderThreadProxy: (proxy) => ({
              events: {
                ...proxy.events,
                push: () => Deferred.await(pushGate),
                pull: () =>
                  Stream.fromEffect(
                    Effect.gen(function* () {
                      if (previous !== undefined) yield* Deferred.succeed(previous, undefined)
                      const next = yield* Queue.take(pulls)
                      previous = next.completed
                      return next.item
                    }),
                  ).pipe(Stream.forever),
              },
            }),
          },
        },
      },
    })
    const deliver = Effect.fn(function* (newEvents: ReadonlyArray<LiveStoreEvent.Client.Encoded>) {
      const completed = yield* Deferred.make<void>()
      yield* Queue.offer(pulls, {
        item: ClientSessionLeaderThreadProxy.PullItem.make({
          payload: { _tag: 'upstream-advance', newEvents },
          globalHead: newEvents.at(-1)?.seqNum ?? EventSequenceNumber.Client.ROOT,
          materializerHashes: [],
        }),
        completed,
      })
      yield* Deferred.await(completed)
    })
    return { store, deliver, releasePush: Deferred.succeed(pushGate, undefined) }
  })
