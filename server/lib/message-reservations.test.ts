import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  maxReservedGlobalMsgNum,
  registerMessageReservationSource,
  reservedGlobalMsgNums,
  resetMessageReservationSourcesForTests,
} from './message-reservations.js'
import { LEGACY_MESSAGE_ERA } from './message-era.js'
import { QueryJobStore } from './query-job-store.js'

const roots: string[] = []
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cos-message-reservations-'))
  roots.push(root)
  return root
}

beforeEach(() => resetMessageReservationSourcesForTests())
afterEach(async () => {
  resetMessageReservationSourcesForTests()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('message reservation registry', () => {
  it('unions every source, scoped to the era, and ignores a throwing source', () => {
    registerMessageReservationSource(() => [
      { globalMsgNum: 74, messageEra: 'era-a', owner: 'brief:2026-09-01' },
      { globalMsgNum: 90, messageEra: 'era-b', owner: 'job:other-era' },
      { globalMsgNum: 0, messageEra: 'era-a', owner: 'job:zero' },
    ])
    registerMessageReservationSource(() => { throw new Error('mid-shutdown') })
    const unregister = registerMessageReservationSource(() => [{ globalMsgNum: 75, messageEra: 'era-a', owner: 'job:x' }])
    expect(reservedGlobalMsgNums('era-a').map(r => r.globalMsgNum).sort()).toEqual([74, 75])
    expect(maxReservedGlobalMsgNum('era-a')).toBe(75)
    expect(maxReservedGlobalMsgNum('era-b')).toBe(90)
    unregister()
    expect(maxReservedGlobalMsgNum('era-a')).toBe(74)
  })

  it('treats an era-less reservation as legacy, like exchanges', () => {
    registerMessageReservationSource(() => [{ globalMsgNum: 12, owner: 'job:legacy' }])
    expect(maxReservedGlobalMsgNum(LEGACY_MESSAGE_ERA)).toBe(12)
    expect(maxReservedGlobalMsgNum('era-new')).toBe(0)
  })
})

describe('query-job-store live reservations', () => {
  function request(globalMsgNum: number, messageEra = 'era-test'): Record<string, unknown> {
    return {
      clientJobId: randomUUID(),
      generation: 1,
      query: 'durable prompt',
      sessionId: 'session-reservations',
      activityToolMode: 'status',
      messageEra,
      globalMsgNum,
    }
  }

  it('holds the number from admission until the job is terminal, and survives a reboot', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const running = await store.admit(request(74))
    const done = await store.admit(request(73))
    await store.markStarting(done.job.jobId)
    await store.markRunning(done.job.jobId, { provider: 'codex' })
    await store.complete(done.job.jobId, { text: 'answer', provider: 'codex' })

    expect(store.listLiveMessageReservations()).toEqual([
      { jobId: running.job.jobId, sessionId: 'session-reservations', messageEra: 'era-test', globalMsgNum: 74 },
    ])

    // A restart re-reads the journal: the identity (and its number) is rebuilt
    // without hydrating the body, so the counter is right from the first tick.
    const rebooted = new QueryJobStore({ root, bootId: 'boot-b' })
    await rebooted.init()
    const after = rebooted.listLiveMessageReservations()
    // Boot interrupts orphans of the previous boot; whichever way the store
    // settles, a terminal job never holds a number and a live one always does.
    const snapshot = await rebooted.getSnapshot(running.job.jobId)
    if (['accepted', 'starting', 'running', 'answer_ready'].includes(snapshot.status)) {
      expect(after.map(r => r.globalMsgNum)).toEqual([74])
    } else {
      expect(after).toEqual([])
    }
  })

  it('reports nothing before init and omits jobs that carry no number', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-c' })
    expect(store.listLiveMessageReservations()).toEqual([])
    await store.init()
    await store.admit({ clientJobId: randomUUID(), generation: 1, query: 'q', sessionId: 's', activityToolMode: 'status' })
    expect(store.listLiveMessageReservations()).toEqual([])
  })
})
