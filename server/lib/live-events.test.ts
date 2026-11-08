import { describe, expect, it } from 'vitest'
import {
  LiveEventsHub,
  parseLiveCursor,
  projectSession,
  type LiveFrame,
  type LiveQuestionReading,
  type LiveQueueReading,
  type LiveSessionReading,
  type LiveSources,
} from './live-events.js'

/** A hub over hand-fed sources with a manual clock and manual timers, so every test is deterministic. */
function rig(initial: LiveSessionReading[] = []) {
  let now = 1_000_000
  let sessions = initial
  let questions: LiveQuestionReading[] | null = []
  let queue: LiveQueueReading[] | null = []
  let sessionsThrow = false
  let sessionReads = 0
  let push: ((c: { sessionId: string; turnEnded: boolean }) => void) | null = null
  const timers: Array<{ fn: () => void; at: number; id: number }> = []
  let nextId = 1
  const sources: LiveSources = {
    async sessions() {
      sessionReads++
      if (sessionsThrow) throw new Error('registry unreadable')
      return { sessions, degraded: false }
    },
    questions: () => questions,
    queue: () => queue,
    subscribe(listener) { push = listener; return () => { push = null } },
  }
  const hub = new LiveEventsHub({
    sources,
    now: () => now,
    epoch: 777,
    ringSize: 8,
    activityMinMs: 5_000,
    endedLingerMs: 60_000,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ fn, at: now + ms, id }); return id },
    clearTimer: h => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1) },
    log: () => {},
  })
  const frames: LiveFrame[] = []
  return {
    hub, frames,
    listener: (f: LiveFrame) => { frames.push(f) },
    set sessions(v: LiveSessionReading[]) { sessions = v },
    set questions(v: LiveQuestionReading[] | null) { questions = v },
    set queue(v: LiveQueueReading[] | null) { queue = v },
    set sessionsThrow(v: boolean) { sessionsThrow = v },
    get sessionReads() { return sessionReads },
    get timerCount() { return timers.length },
    push(c: { sessionId: string; turnEnded: boolean }) { push?.(c) },
    advance(ms: number) { now += ms },
    get now() { return now },
    async runTimers() {
      const due = timers.filter(t => t.at <= now)
      for (const t of due) { timers.splice(timers.indexOf(t), 1); t.fn() }
      // Let the fired timer's own refresh finish; never start one here, or a test could pass with no timer at all.
      await new Promise(r => setTimeout(r, 5))
    },
  }
}

const s = (id: string, state: LiveSessionReading['state'], extra: Partial<LiveSessionReading> = {}): LiveSessionReading => ({
  provider: 'claude', sessionId: id, state, startedAt: 500_000, turnStartedAt: state === 'working' ? 900_000 : null, updatedAt: 900_000, source: 'hook', ...extra,
})

describe('LiveEventsHub', () => {
  it('numbers every state frame with a strictly increasing seq; heartbeat and resume repeat the newest', async () => {
    const r = rig([s('aaaaaaaa-1', 'idle')])
    await r.hub.attach(r.listener)
    r.sessions = [s('aaaaaaaa-1', 'working'), s('bbbbbbbb-2', 'idle')]
    r.questions = [{ provider: 'claude', sessionId: 'aaaaaaaa-1', kind: 'question' }]
    await r.hub.refresh()
    r.sessions = [s('aaaaaaaa-1', 'idle')]
    await r.hub.refresh()
    const seqs = r.frames.map(f => f.seq)
    expect(seqs.length).toBeGreaterThanOrEqual(5)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1)
    const newest = r.hub.newestSeq
    expect(r.hub.heartbeatFrame().seq).toBe(newest)
    expect(r.hub.resumeFrame(0).seq).toBe(newest)
    expect(r.hub.newestSeq).toBe(newest)
  })

  it('replays exactly the frames after a cursor it still holds, and nothing when current', async () => {
    const r = rig([s('aaaaaaaa-1', 'idle')])
    await r.hub.attach(r.listener)
    const cursor = { epoch: 777, seq: r.hub.newestSeq }
    r.sessions = [s('aaaaaaaa-1', 'working')]
    await r.hub.refresh()
    r.sessions = [s('aaaaaaaa-1', 'waiting')]
    await r.hub.refresh()
    const replay = r.hub.replayAfter(cursor)!
    expect(replay.map(f => f.seq)).toEqual([cursor.seq + 1, cursor.seq + 2])
    expect(replay.map(f => f.kind === 'session' ? f.session.state : null)).toEqual(['working', 'waiting'])
    expect(r.hub.replayAfter({ epoch: 777, seq: r.hub.newestSeq })).toEqual([])
  })

  it('refuses a cursor it cannot honour (older than the ring, another epoch, from the future, malformed) so the caller snapshots', async () => {
    const r = rig([])
    await r.hub.attach(r.listener)
    for (let i = 0; i < 12; i++) {
      r.sessions = [s(`cccccccc-${i}`, 'idle')]
      await r.hub.refresh()
    }
    const bounds = r.hub.ringBounds()!
    expect(bounds.newest - bounds.oldest + 1).toBe(8)
    expect(r.hub.replayAfter({ epoch: 777, seq: bounds.oldest - 2 })).toBeNull()
    expect(r.hub.replayAfter({ epoch: 777, seq: bounds.oldest - 1 })).not.toBeNull()
    expect(r.hub.replayAfter({ epoch: 778, seq: bounds.newest - 1 })).toBeNull()
    expect(r.hub.replayAfter({ epoch: 777, seq: bounds.newest + 1 })).toBeNull()
    expect(r.hub.replayAfter(parseLiveCursor('not-a-cursor'))).toBeNull()
    expect(parseLiveCursor('777.12')).toEqual({ epoch: 777, seq: 12 })
    expect(parseLiveCursor('12')).toBeNull()
  })

  it('reads nothing and runs no timer while no stream is open, and stops when the last one leaves', async () => {
    const r = rig([s('aaaaaaaa-1', 'idle')])
    r.push({ sessionId: 'aaaaaaaa-1', turnEnded: false })
    expect(r.timerCount).toBe(0)
    expect(r.sessionReads).toBe(0)
    const detach = await r.hub.attach(r.listener)
    expect(r.sessionReads).toBe(1)
    expect(r.timerCount).toBe(1)
    detach()
    expect(r.timerCount).toBe(0)
    r.push({ sessionId: 'aaaaaaaa-1', turnEnded: false })
    expect(r.timerCount).toBe(0)
  })

  it('a hook push flushes the change without waiting for the tick', async () => {
    const r = rig([s('aaaaaaaa-1', 'idle')])
    await r.hub.attach(r.listener)
    r.sessions = [s('aaaaaaaa-1', 'working')]
    r.push({ sessionId: 'aaaaaaaa-1', turnEnded: false })
    r.advance(149)
    await r.runTimers()
    expect(r.frames.at(-1)!.kind === 'session' && (r.frames.at(-1) as { session: { state: string } }).session.state).toBe('idle')
    r.advance(1)
    await r.runTimers()
    const last = r.frames.at(-1)!
    expect(last.kind === 'session' && last.session.state).toBe('working')
  })

  it('counts replies from turn ends even with no stream open, and carries them on the session', async () => {
    const r = rig([s('aaaaaaaa-1', 'idle')])
    r.push({ sessionId: 'AAAAAAAA-1', turnEnded: true })
    r.push({ sessionId: 'aaaaaaaa-1', turnEnded: true })
    r.push({ sessionId: 'aaaaaaaa-1', turnEnded: false })
    await r.hub.attach(r.listener)
    const snap = r.hub.snapshotFrame()
    expect(snap.kind === 'snapshot' && snap.sessions[0]!.replies).toBe(2)
  })

  it('sends a material change at once but coalesces updatedAt-only changes to one per activity window', async () => {
    const r = rig([s('aaaaaaaa-1', 'working', { updatedAt: 1 })])
    await r.hub.attach(r.listener)
    const before = r.frames.length
    r.sessions = [s('aaaaaaaa-1', 'working', { updatedAt: 2 })]
    r.advance(1_000)
    await r.hub.refresh()
    expect(r.frames.length).toBe(before)
    r.advance(5_000)
    r.sessions = [s('aaaaaaaa-1', 'working', { updatedAt: 3 })]
    await r.hub.refresh()
    expect(r.frames.length).toBe(before + 1)
    r.sessions = [s('aaaaaaaa-1', 'waiting', { updatedAt: 3 })]
    await r.hub.refresh()
    expect(r.frames.length).toBe(before + 2)
  })

  it('a session that leaves the open set reads ended, lingers, is removed, and does not come back while still ended', async () => {
    const r = rig([s('aaaaaaaa-1', 'working')])
    await r.hub.attach(r.listener)
    r.sessions = []
    await r.hub.refresh()
    const ended = r.frames.at(-1)!
    expect(ended.kind === 'session' && ended.session.state).toBe('ended')
    expect(ended.kind === 'session' && ended.session.turnStartedAt).toBeNull()
    r.advance(60_001)
    await r.hub.refresh()
    const removed = r.frames.at(-1)!
    expect(removed.kind).toBe('session.removed')
    // A source that still reports it ended must not flap it back in.
    r.sessions = [s('aaaaaaaa-1', 'ended')]
    const count = r.frames.length
    await r.hub.refresh()
    expect(r.frames.length).toBe(count)
    // Opening again brings it back.
    r.sessions = [s('aaaaaaaa-1', 'working')]
    await r.hub.refresh()
    const back = r.frames.at(-1)!
    expect(back.kind === 'session' && back.change).toBe('added')
  })

  it('a failed session read keeps the last model and flags the source degraded, never empties it', async () => {
    const r = rig([s('aaaaaaaa-1', 'working')])
    await r.hub.attach(r.listener)
    r.sessionsThrow = true
    const count = r.frames.length
    await r.hub.refresh()
    expect(r.frames.length).toBe(count)
    const snap = r.hub.snapshotFrame()
    expect(snap.kind === 'snapshot' && snap.sessions.map(x => x.state)).toEqual(['working'])
    expect(snap.kind === 'snapshot' && snap.degraded.registry).toBe(true)
  })

  it('questions and queue frames carry totals and per-session counts; a null read keeps the last value', async () => {
    const r = rig([s('aaaaaaaa-1', 'waiting')])
    await r.hub.attach(r.listener)
    r.questions = [{ provider: 'claude', sessionId: 'aaaaaaaa-1', kind: 'approval' }, { provider: 'claude', sessionId: 'aaaaaaaa-1', kind: 'question' }]
    r.queue = [{ provider: 'claude', sessionId: 'aaaaaaaa-1', count: 2 }]
    await r.hub.refresh()
    const q = r.frames.find(f => f.kind === 'questions')!
    expect(q.kind === 'questions' && [q.total, q.approvals, q.bySession[0]!.count]).toEqual([2, 1, 2])
    const qu = r.frames.find(f => f.kind === 'queue')!
    expect(qu.kind === 'queue' && qu.total).toBe(2)
    const sess = r.frames.filter(f => f.kind === 'session').at(-1)!
    expect(sess.kind === 'session' && [sess.session.questions, sess.session.queued]).toEqual([2, 2])
    r.questions = null
    const count = r.frames.length
    await r.hub.refresh()
    expect(r.frames.length).toBe(count)
    const snap = r.hub.snapshotFrame()
    expect(snap.kind === 'snapshot' && [snap.questions.total, snap.degraded.questions]).toEqual([2, true])
  })
})

describe('projectSession (privacy allowlist)', () => {
  it('sends only ids, states, counts and times, whatever the reading carries', () => {
    const reading = {
      ...s('aaaaaaaa-1', 'working'),
      title: 'Fix the payroll export', prompt: 'secret words', cwd: '/Users/me/project', transcriptPath: '/Users/me/.claude/x.jsonl', model: 'opus', lastReply: 'done',
    } as unknown as LiveSessionReading
    const out = projectSession(reading, { replies: 1, questions: 0, queued: 0 })!
    expect(Object.keys(out).sort()).toEqual(['provider', 'queued', 'questions', 'replies', 'sessionId', 'source', 'startedAt', 'state', 'turnStartedAt', 'updatedAt'].sort())
    const wire = JSON.stringify(out)
    for (const word of ['payroll', 'secret', '/Users', 'opus', 'done']) expect(wire).not.toContain(word)
  })

  it('refuses an id that is not a plain token (a path or words in the id slot)', () => {
    expect(projectSession(s('/Users/me/secret', 'idle'), { replies: 0, questions: 0, queued: 0 })).toBeNull()
    expect(projectSession(s('fix the bug', 'idle'), { replies: 0, questions: 0, queued: 0 })).toBeNull()
    expect(projectSession({ ...s('aaaaaaaa', 'idle'), provider: 'gemini' as never }, { replies: 0, questions: 0, queued: 0 })).toBeNull()
  })

  it('carries a turn clock only while a turn is in progress, and failed only on idle', () => {
    expect(projectSession(s('aaaaaaaa', 'idle', { turnStartedAt: 5, failed: true }), { replies: 0, questions: 0, queued: 0 })).toMatchObject({ turnStartedAt: null, failed: true })
    expect(projectSession(s('aaaaaaaa', 'waiting', { turnStartedAt: 5 }), { replies: 0, questions: 0, queued: 0 })).toMatchObject({ turnStartedAt: 5 })
    expect(projectSession(s('aaaaaaaa', 'working', { failed: true }), { replies: 0, questions: 0, queued: 0 })!.failed).toBeUndefined()
  })
})

describe('LiveEventsHub startedAt', () => {
  it('keeps a session\'s startedAt while it is in the model, so a registry-to-hook source change is not a frame', async () => {
    const r = rig([s('aaaaaaaa-1', 'working', { startedAt: 100, source: 'registry' })])
    await r.hub.attach(r.listener)
    const count = r.frames.length
    r.sessions = [s('aaaaaaaa-1', 'working', { startedAt: 200, source: 'registry' })]
    await r.hub.refresh()
    expect(r.frames.length).toBe(count)
    const snap = r.hub.snapshotFrame()
    expect(snap.kind === 'snapshot' && snap.sessions[0]!.startedAt).toBe(100)
  })
})
