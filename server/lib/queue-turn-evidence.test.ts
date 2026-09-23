// 6.53.3 (review A1): a desk cancel must not be undone by a held turn.
//
// THE SCENARIO, as the review traced it. Claude at the desk is inside a long tool with a
// follow-up parked behind it. The person cancels from the lens: a halt marker, which stops
// the run only at its NEXT tool call. The transcript stays untouched while the tool runs,
// so after 30 s occupancy calls the holder idle and attachable. Until 6.53.2 `turnOpen`
// dropped the hooks' open-turn evidence because it was older than the cancel, and after the
// two-minute hold the next sweep delivered the parked turn live into the run the person had
// just stopped (whose UserPromptSubmit then deleted the marker: the cancel was lost).
//
// Driven through the REAL drain pass (`drainThread`) over the REAL queue store, with the
// real cancel memory and hold; only the session's own facts (hooks, registry, transcript)
// are scripted, because they are what the scenario is about.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { drainThread, type ThreadTurnQueueDeps } from '../routes/thread-turn-queue.js'
import { readQueue, writeQueue } from './thread-turn-queue-store.js'
import type { QueuedThreadTurn } from './thread-turn-queue.js'
import { CANCEL_QUEUE_HOLD_MS, __resetThreadCancelsForTests, cancelHoldUntil, noteThreadCancelled, threadCancel } from './session-cancel.js'
import { makeQueueTurnEvidence, type TurnEvidenceSignal, type TurnEvidenceVerdict } from './queue-turn-evidence.js'
import { OPEN_TURN_CEILING_MS } from './session-state-derive.js'

const T0 = 1_790_000_000_000

interface Scene {
  signal: TurnEvidenceSignal | undefined
  verdict: TurnEvidenceVerdict | null
  mtime: number | null
  deskEndedAt: number | null
  clock: number
}

function setup() {
  const threadId = randomUUID()
  const scene: Scene = {
    // The run started at T0 and entered a long Bash at T0 + 5 s; the hooks saw both.
    signal: { turnOpen: true, lastEvent: 'PreToolUse', lastEventAt: T0 + 5_000, turnStartedAt: T0, stopAt: null, subagentsOpen: 0 },
    // The tail ends in that tool's unanswered tool_use.
    verdict: { ended: false, reason: 'tool_pending' },
    mtime: T0 + 5_000,
    // The registry says busy: no end.
    deskEndedAt: null,
    clock: T0 + 5_000,
  }
  const evidence = makeQueueTurnEvidence({
    signalFor: () => scene.signal,
    registryIdleAfterStop: () => null,
    deskEndedAt: () => scene.deskEndedAt,
    transcriptMtimeMs: () => scene.mtime,
    transcriptVerdict: () => scene.verdict,
    threadCancel: (provider, id) => threadCancel(provider, id),
    openTurnCeilingMs: OPEN_TURN_CEILING_MS,
    now: () => scene.clock,
  })
  const delivered: string[] = []
  const deps: ThreadTurnQueueDeps = {
    // The idle-holder relaxation: 30 s of transcript silence makes the desk attachable.
    occupancy: () => ({ attachable: true, reason: null }),
    turnEnded: evidence.turnEnded,
    turnOpen: evidence.turnOpen,
    activity: () => (scene.mtime !== null && scene.clock - scene.mtime >= 30_000 ? 'idle' : 'working'),
    deliver: async (turn: QueuedThreadTurn) => { delivered.push(turn.clientTurnId); return { ok: true } },
    cancelHoldUntil: (provider, id) => cancelHoldUntil(provider, id),
    now: () => scene.clock,
  }
  const turn: QueuedThreadTurn = {
    clientTurnId: `qt-${threadId.slice(0, 8)}`,
    cosSessionId: 'cos/chat:42',
    provider: 'claude',
    threadId,
    prompt: 'and then run the migration',
    queuedAt: T0 + 10_000,
    attempts: 0,
    status: 'waiting',
  }
  writeQueue('claude', threadId, [turn])
  return { threadId, scene, evidence, deps, delivered }
}

beforeEach(() => __resetThreadCancelsForTests())
afterEach(() => __resetThreadCancelsForTests())

describe('a desk cancel is not undone by a held turn (6.53.3, review A1)', () => {
  it('desk_run: after the hold, a run still inside its tool keeps the parked turn waiting', async () => {
    const { threadId, scene, evidence, deps, delivered } = setup()
    const cancelAt = T0 + 60_000
    noteThreadCancelled('claude', threadId, cancelAt, 'desk_run')

    // Inside the hold: held, whatever else is true.
    scene.clock = cancelAt + 1_000
    expect((await drainThread('claude', threadId, deps)).held).toBe(1)

    // Past the hold, the tool still running, the transcript untouched for minutes.
    scene.clock = cancelAt + CANCEL_QUEUE_HOLD_MS + 20_000
    expect(evidence.turnOpen('claude', threadId)).toBe(true)
    expect(evidence.turnEnded('claude', threadId)).toBe(false)
    const pass = await drainThread('claude', threadId, deps)
    expect(pass).toEqual({ delivered: 0, held: 1, retired: 0 })
    expect(delivered).toEqual([])
    expect(readQueue('claude', threadId, scene.clock)[0]).toMatchObject({ status: 'waiting', attempts: 0 })

    // With the hooks off the transcript's dangling tool_use is the same evidence.
    scene.signal = undefined
    expect(evidence.turnOpen('claude', threadId)).toBe(true)
    expect((await drainThread('claude', threadId, deps)).delivered).toBe(0)
  })

  it('desk_run: the desk\'s own end after the cancel (the halt took) releases it; a new prompt after that holds again', async () => {
    const { threadId, scene, evidence, deps, delivered } = setup()
    const cancelAt = T0 + 60_000
    noteThreadCancelled('claude', threadId, cancelAt, 'desk_run')
    scene.clock = cancelAt + CANCEL_QUEUE_HOLD_MS + 20_000

    // An end from BEFORE the cancel is not this run's.
    scene.deskEndedAt = cancelAt - 1
    expect(evidence.turnOpen('claude', threadId)).toBe(true)

    // The next tool call was denied; the registry flipped idle a second after the cancel.
    scene.deskEndedAt = cancelAt + 1_000
    expect(evidence.turnOpen('claude', threadId)).toBe(false)
    expect(evidence.turnEnded('claude', threadId)).toBe(true)

    // A prompt typed at the desk after that end is a live turn again.
    scene.signal = { ...scene.signal!, turnStartedAt: cancelAt + 5_000, lastEventAt: cancelAt + 5_000 }
    expect(evidence.turnOpen('claude', threadId)).toBe(true)
    expect((await drainThread('claude', threadId, deps)).delivered).toBe(0)

    scene.signal = { ...scene.signal!, turnStartedAt: T0, lastEventAt: T0 + 5_000 }
    expect((await drainThread('claude', threadId, deps)).delivered).toBe(1)
    expect(delivered).toHaveLength(1)
  })

  it('cos_turn: a killed COS child\'s silence still ends its turn (6.53.0 R1 unchanged)', async () => {
    const { threadId, scene, evidence, deps, delivered } = setup()
    const cancelAt = T0 + 60_000
    noteThreadCancelled('claude', threadId, cancelAt, 'cos_turn')
    scene.clock = cancelAt + CANCEL_QUEUE_HOLD_MS + 20_000
    expect(evidence.turnOpen('claude', threadId)).toBe(false)
    expect(evidence.turnEnded('claude', threadId)).toBe(true)
    expect((await drainThread('claude', threadId, deps)).delivered).toBe(1)
    expect(delivered).toHaveLength(1)
    // Anything the thread writes after the cancel is live evidence again.
    const fresh = setup()
    noteThreadCancelled('claude', fresh.threadId, cancelAt, 'cos_turn')
    fresh.scene.clock = cancelAt + CANCEL_QUEUE_HOLD_MS + 20_000
    fresh.scene.signal = { ...fresh.scene.signal!, lastEventAt: cancelAt + 10 }
    expect(fresh.evidence.turnOpen('claude', fresh.threadId)).toBe(true)
  })

  it('Codex: a cancel with no target named concludes nothing from silence either', () => {
    const { threadId, scene, evidence } = setup()
    const cancelAt = T0 + 60_000
    noteThreadCancelled('codex', threadId, cancelAt)
    scene.signal = undefined
    scene.clock = cancelAt + CANCEL_QUEUE_HOLD_MS + 20_000
    expect(evidence.turnOpen('codex', threadId)).toBe(true)
    expect(evidence.turnEnded('codex', threadId)).toBe(false)
    noteThreadCancelled('codex', threadId, cancelAt, 'cos_turn')
    expect(evidence.turnOpen('codex', threadId)).toBe(false)
    expect(evidence.turnEnded('codex', threadId)).toBe(true)
  })

  it('no cancel on record: the 6.48.1 rules, unchanged', () => {
    const { threadId, scene, evidence } = setup()
    scene.clock = T0 + 10 * 60_000
    expect(evidence.turnOpen('claude', threadId)).toBe(true)
    expect(evidence.turnEnded('claude', threadId)).toBe(false)
    // Past the ceiling nothing is evidence any more.
    scene.clock = T0 + 5_000 + OPEN_TURN_CEILING_MS + 1
    expect(evidence.turnOpen('claude', threadId)).toBe(false)
    // An unsupported provider is never open or ended here; a throwing read refuses on doubt.
    expect(evidence.turnOpen('cursor', threadId)).toBe(false)
    const throwing = makeQueueTurnEvidence({
      signalFor: () => { throw new Error('EIO') },
      registryIdleAfterStop: () => null,
      deskEndedAt: () => null,
      transcriptMtimeMs: () => null,
      transcriptVerdict: () => null,
      threadCancel: () => null,
      openTurnCeilingMs: OPEN_TURN_CEILING_MS,
      now: () => T0,
    })
    expect(throwing.turnOpen('claude', threadId)).toBe(false)
    expect(throwing.turnEnded('claude', threadId)).toBe(false)
  })
})
