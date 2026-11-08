import type { CfTypes } from '@livestore/common-cf'
import { EventSequenceNumber, LiveStoreEvent } from '@livestore/common/schema'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Deferred, Duration, Effect, Exit, Fiber, Option, Semaphore } from '@livestore/utils/effect'

import { MAX_WS_MESSAGE_BYTES } from '../../common/constants.ts'
import { SyncMessage } from '../../common/mod.ts'
import type { Env } from '../shared.ts'
import * as DoCtx from './layer.ts'
import { makePush, runSerializedPushAdmission } from './push.ts'

Vitest.describe('sync-cf push admission', () => {
  Vitest.live('publishes an admitted push before honoring interruption', () =>
    Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(1)
      const persisted = yield* Deferred.make<void>()
      const allowBroadcast = yield* Deferred.make<void>()
      const broadcasted = yield* Deferred.make<void>()

      const admissionFiber = yield* runSerializedPushAdmission(
        semaphore,
        Effect.gen(function* () {
          yield* Deferred.succeed(persisted, undefined)
          yield* Deferred.await(allowBroadcast)
          yield* Deferred.succeed(broadcasted, undefined)
        }),
      ).pipe(Effect.forkChild)

      // Reproduce cancellation after persistence but before the pull broadcast handoff.
      yield* Deferred.await(persisted)
      const interruptStarted = yield* Deferred.make<void>()
      const interruptFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(interruptStarted, undefined)
        yield* Fiber.interrupt(admissionFiber)
      }).pipe(Effect.forkChild)
      yield* Deferred.await(interruptStarted)
      yield* Effect.yieldNow

      yield* Deferred.succeed(allowBroadcast, undefined)
      yield* Deferred.await(broadcasted).pipe(Effect.timeout(Duration.seconds(1)))
      yield* Fiber.join(interruptFiber)

      Vitest.expect(yield* Deferred.isDone(broadcasted)).toBe(true)
    }),
  )

  Vitest.live('avoids repeated pull response encoding when no subscriber exists', () =>
    Effect.gen(function* () {
      const harness = makePushHarness(false)
      let canonicalizations = 0
      const batch = makeEvents(() => canonicalizations++)

      yield* harness.push(batch)

      Vitest.expect(canonicalizations).toBe(batch.length)
      Vitest.expect(harness.appended).toEqual([batch])
      Vitest.expect(harness.head.current).toBe(2)
      Vitest.expect(harness.sent).toEqual([])
    }),
  )

  Vitest.live('preserves oversize response errors without subscribers', () =>
    Effect.gen(function* () {
      const harness = makePushHarness(false)
      const batch = [
        LiveStoreEvent.Global.Encoded.make({
          seqNum: EventSequenceNumber.Global.make(1),
          parentSeqNum: EventSequenceNumber.Global.make(0),
          name: 'todoCreated',
          args: { text: 'x'.repeat(MAX_WS_MESSAGE_BYTES) },
          clientId: 'client',
          sessionId: 'session',
        }),
      ]

      const exit = yield* harness.push(batch).pipe(Effect.exit)

      Vitest.expect(Exit.isFailure(exit)).toBe(true)
      Vitest.expect(harness.appended).toEqual([batch])
      Vitest.expect(harness.head.current).toBe(1)
      Vitest.expect(harness.sent).toEqual([])
    }),
  )

  Vitest.live('publishes ordered pull responses when a subscriber exists', () =>
    Effect.gen(function* () {
      const harness = makePushHarness(true)
      let canonicalizations = 0
      const batch = makeEvents(() => canonicalizations++)

      yield* harness.push(batch)

      Vitest.expect(canonicalizations).toBeGreaterThan(0)
      Vitest.expect(harness.appended).toEqual([batch])
      Vitest.expect(harness.head.current).toBe(2)
      Vitest.expect(harness.sent).toHaveLength(1)
      const frame = JSON.parse(harness.sent[0]!)
      Vitest.expect(frame._tag).toBe('Chunk')
      Vitest.expect(frame.values).toHaveLength(1)
      Vitest.expect(frame.values[0].batch.map((item: any) => item.eventEncoded.seqNum)).toEqual([1, 2])
      Vitest.expect(frame.values[0].batch.map((item: any) => item.metadata.value.createdAt)).toEqual([
        Vitest.expect.any(String),
        Vitest.expect.any(String),
      ])
    }),
  )

  Vitest.live('publishes consistent responses to every WebSocket subscriber', () =>
    Effect.gen(function* () {
      const harness = makePushHarness(2)
      const batch = makeEvents(() => undefined)

      yield* harness.push(batch)

      Vitest.expect(harness.sent).toHaveLength(2)
      const frames = harness.sent.map((message) => JSON.parse(message))
      Vitest.expect(frames.map((frame) => frame.requestId)).toEqual([1, 2])
      Vitest.expect(frames[0]!.values[0]).toEqual(frames[1]!.values[0])
      Vitest.expect(harness.pullResponses).toHaveLength(1)
      const response = harness.pullResponses[0]!
      Vitest.expect(response.batch.map((item) => item.eventEncoded.seqNum)).toEqual([1, 2])
      Vitest.expect(
        response.batch.map((item) => (item.metadata._tag === 'Some' ? item.metadata.value.createdAt : undefined)),
      ).toEqual(frames[0]!.values[0].batch.map((item: any) => item.metadata.value.createdAt))
    }),
  )
})

const makeEvents = (onCanonicalize: () => void) =>
  [1, 2].map((seqNum) => {
    const args = { id: `todo-${seqNum}`, text: 'event payload' }
    return LiveStoreEvent.Global.Encoded.make({
      seqNum: EventSequenceNumber.Global.make(seqNum),
      parentSeqNum: EventSequenceNumber.Global.make(seqNum - 1),
      name: 'todoCreated',
      args: {
        ...args,
        toJSON: () => {
          onCanonicalize()
          return args
        },
      },
      clientId: 'client',
      sessionId: 'session',
    })
  })

const makePushHarness = (subscribed: boolean | number) => {
  const subscriberCount = typeof subscribed === 'number' ? subscribed : subscribed ? 1 : 0
  const sent: string[] = []
  const appended: Array<ReadonlyArray<LiveStoreEvent.Global.Encoded>> = []
  const pullResponses: SyncMessage.PullResponse[] = []
  const head = { current: EventSequenceNumber.Global.make(0) }
  const connections = Array.from({ length: subscriberCount }, (_, index) => ({
    deserializeAttachment: () => JSON.stringify({ storeId: 'test', pullRequestIds: [index + 1] }),
    send: (message: string) => sent.push(message),
  }))
  const ctx = {
    blockConcurrencyWhile: (callback: () => unknown) => callback(),
    getWebSockets: () => connections,
    storage: { kv: { list: () => [] } },
  } as unknown as CfTypes.DurableObjectState
  const service: DoCtx.Service = {
    storeId: 'test',
    backendId: 'backend',
    currentHeadRef: head,
    updateCurrentHead: (currentHead) => {
      head.current = currentHead
    },
    pushSemaphore: Semaphore.makeUnsafe(1),
    storage: {
      dbName: 'eventlog_test',
      getEvents: () => Effect.die(new Error('not used')),
      appendEvents: (batch) =>
        Effect.sync(() => {
          appended.push(batch)
        }),
      resetStore: Effect.void,
    },
    doOptions: {
      onPullRes: (response: any) =>
        Effect.sync(() => {
          pullResponses.push(response)
        }),
    },
    env: {} as Env,
    ctx,
  }
  const push = (batch: ReadonlyArray<LiveStoreEvent.Global.Encoded>) =>
    makePush({
      payload: undefined,
      headers: undefined,
      options: service.doOptions,
      storeId: 'test',
      ctx,
      env: {} as Env,
    })({
      batch,
      backendId: Option.none(),
    }).pipe(Effect.provideService(DoCtx.DoCtx, service))
  return { push, appended, head, sent, pullResponses }
}
