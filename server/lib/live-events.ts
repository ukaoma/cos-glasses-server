/**
 * 7.0.1 live state: the hub behind `GET /api/events` (docs/live-events-contract.md).
 *
 * Miles, 2026-11-07: Control Web feels out of date. The pet shows what was running at the last fetch, not now. This hub
 * keeps a small live model of the server's OWN session state (which sessions are open, working, waiting, idle or
 * ended, when the turn started, replies, questions, queued messages) and hands every open page a frame when it moves.
 *
 * WHAT FEEDS IT. Nothing new polls the Mac on its own:
 * - PUSHED: the hook signal store (`sources.subscribe`). A hook event marks the model dirty and a flush runs within
 *   LIVE_FLUSH_MS, so a prompt, a permission prompt, a Stop or a SessionEnd reaches the page in well under a second.
 * - A BOUNDED DIFF TICK every LIVE_TICK_MS, ONLY WHILE A STREAM IS OPEN, for the sources with no change signal: the
 *   Claude registry files, the permission broker's in-memory list, the queue files, and the clock itself (an open turn
 *   whose engine goes quiet past the activity cap stops being `working` with no event at all). With no stream open the
 *   tick does not run and nothing is read.
 * - The reply counter is the one thing that runs with no stream open: a Map increment per Stop, so `replies` means
 *   "turns ended since this server started", not "since somebody opened a page".
 *
 * PRIVACY. A frame carries ids, states, counts and times. Never a title, prompt, reply, tool, file name, path, cwd or
 * model. `projectSession` builds every session frame from an allowlist of fields, so a source that grows a text field
 * cannot leak it here.
 *
 * BOUNDED EVERYWHERE. The ring holds LIVE_EVENTS_RING_SIZE frames. The route caps streams and drops a client whose
 * unsent bytes pass a ceiling. The model is capped at LIVE_MAX_SESSIONS sessions. A source that throws marks itself
 * degraded and keeps the last good value; it never empties the model (an empty read is not "nothing is running").
 */

export type LiveProvider = 'claude' | 'codex' | 'cursor'
export type LiveState = 'working' | 'waiting' | 'idle' | 'ended'

/** The wire shape of one session. Every field is an id, a state, a count or a time. */
export interface LiveSession {
  provider: LiveProvider
  sessionId: string
  state: LiveState
  startedAt: number | null
  turnStartedAt: number | null
  updatedAt: number | null
  replies: number
  questions: number
  queued: number
  source: 'hook' | 'registry'
  failed?: true
}

/** What a session source reports per tick, before the hub adds replies, questions and queued. */
export interface LiveSessionReading {
  provider: LiveProvider
  sessionId: string
  state: LiveState
  startedAt: number | null
  turnStartedAt: number | null
  updatedAt: number | null
  source: 'hook' | 'registry'
  failed?: boolean
}

export interface LiveCountRow { provider: LiveProvider; sessionId: string; count: number }
export interface LiveQuestionReading { provider: LiveProvider; sessionId: string; kind: 'question' | 'approval' }
export interface LiveQueueReading { provider: LiveProvider; sessionId: string; count: number }

export interface LiveQuestions { total: number; approvals: number; bySession: LiveCountRow[] }
export interface LiveQueue { total: number; bySession: LiveCountRow[] }
export interface LiveDegraded { registry: boolean; questions: boolean; queue: boolean }

interface FrameBase { seq: number; epoch: number; at: number }
export type LiveFrame =
  | (FrameBase & { kind: 'snapshot'; sessions: LiveSession[]; questions: LiveQuestions; queue: LiveQueue; degraded: LiveDegraded })
  | (FrameBase & { kind: 'session'; change: 'added' | 'updated'; session: LiveSession })
  | (FrameBase & { kind: 'session.removed'; provider: LiveProvider; sessionId: string })
  | (FrameBase & { kind: 'questions' } & LiveQuestions)
  | (FrameBase & { kind: 'queue' } & LiveQueue)
  | (FrameBase & { kind: 'heartbeat' })
  | (FrameBase & { kind: 'resume'; replayed: number })

/** A frame the ring remembers and a resume replays: every state frame, never heartbeat, snapshot or resume. */
export type LiveStateFrame = Extract<LiveFrame, { kind: 'session' | 'session.removed' | 'questions' | 'queue' }>

export interface LiveSources {
  /** The open sessions right now. Throwing (or `degraded`) keeps the previous model. */
  sessions(now: number): Promise<{ sessions: LiveSessionReading[]; degraded: boolean }>
  /** The broker's pending items; null when it cannot be read. */
  questions(now: number): LiveQuestionReading[] | null
  /** Waiting follow-ups per thread; null when they cannot be read. */
  queue(now: number): LiveQueueReading[] | null
  /** Hook pushes. `ended` is a turn end (Stop or StopFailure) from the tab itself, never a COS child. */
  subscribe(listener: (change: { sessionId: string; turnEnded: boolean }) => void): () => void
}

export const LIVE_TICK_MS = 2_000
export const LIVE_FLUSH_MS = 150
export const LIVE_EVENTS_RING_SIZE = 512
export const LIVE_ACTIVITY_MIN_MS = 5_000
export const LIVE_ENDED_LINGER_MS = 10 * 60_000
export const LIVE_MAX_SESSIONS = 200

export interface LiveHubOptions {
  sources: LiveSources
  now?: () => number
  tickMs?: number
  flushMs?: number
  ringSize?: number
  activityMinMs?: number
  endedLingerMs?: number
  epoch?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (line: string) => void
}

export type LiveListener = (frame: LiveFrame) => void

function keyOf(provider: string, sessionId: string): string {
  return `${provider}:${sessionId.toLowerCase()}`
}

const PROVIDERS = new Set<LiveProvider>(['claude', 'codex', 'cursor'])
const STATES = new Set<LiveState>(['working', 'waiting', 'idle', 'ended'])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function msOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
}

/**
 * The ONLY way a session reaches the wire: an allowlist of fields, each coerced to its type. An id that is not a
 * plain token (a path, a title someone put in an id slot) is refused rather than sent.
 */
export function projectSession(reading: LiveSessionReading, extra: { replies: number; questions: number; queued: number }): LiveSession | null {
  if (!PROVIDERS.has(reading.provider)) return null
  const sessionId = String(reading.sessionId ?? '').toLowerCase()
  if (!SAFE_ID.test(sessionId)) return null
  const state: LiveState = STATES.has(reading.state) ? reading.state : 'idle'
  const out: LiveSession = {
    provider: reading.provider,
    sessionId,
    state,
    startedAt: msOrNull(reading.startedAt),
    // A turn clock only while a turn is in progress, so a client can never tick an idle session.
    turnStartedAt: state === 'working' || state === 'waiting' ? msOrNull(reading.turnStartedAt) : null,
    updatedAt: msOrNull(reading.updatedAt),
    replies: Math.max(0, Math.trunc(extra.replies) || 0),
    questions: Math.max(0, Math.trunc(extra.questions) || 0),
    queued: Math.max(0, Math.trunc(extra.queued) || 0),
    source: reading.source === 'hook' ? 'hook' : 'registry',
  }
  if (reading.failed === true && state === 'idle') out.failed = true
  return out
}

/** Every field but `updatedAt`: a change here is sent at once; an `updatedAt`-only change is coalesced. */
function materialStamp(s: LiveSession): string {
  return `${s.state}|${s.startedAt ?? ''}|${s.turnStartedAt ?? ''}|${s.replies}|${s.questions}|${s.queued}|${s.source}|${s.failed ? 1 : 0}`
}

function sortRows(rows: LiveCountRow[]): LiveCountRow[] {
  return rows.sort((a, b) => keyOf(a.provider, a.sessionId).localeCompare(keyOf(b.provider, b.sessionId)))
}

function countsStamp(rows: LiveCountRow[]): string {
  return rows.map(r => `${keyOf(r.provider, r.sessionId)}=${r.count}`).join(',')
}

/**
 * The parsed resume cursor: `<epoch>.<seq>`, both plain integers. Anything else is null and the caller snapshots.
 */
export function parseLiveCursor(raw: unknown): { epoch: number; seq: number } | null {
  if (typeof raw !== 'string') return null
  const m = /^(\d{1,16})\.(\d{1,12})$/.exec(raw.trim())
  if (!m) return null
  return { epoch: Number(m[1]), seq: Number(m[2]) }
}

export class LiveEventsHub {
  readonly epoch: number
  private readonly sources: LiveSources
  private readonly now: () => number
  private readonly tickMs: number
  private readonly flushMs: number
  private readonly ringSize: number
  private readonly activityMinMs: number
  private readonly endedLingerMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly log: (line: string) => void

  private seq = 0
  private readonly ring: LiveStateFrame[] = []
  private readonly listeners = new Set<LiveListener>()
  /** The model as last sent. */
  private readonly sessions = new Map<string, LiveSession>()
  private readonly lastSentAt = new Map<string, number>()
  /** Sessions that left the open set: kept as `ended` until this time, then removed. */
  private readonly endedUntil = new Map<string, number>()
  /** Removed after their linger while a source still reports them ended: not re-added until they open again. */
  private readonly retired = new Set<string>()
  private readonly replies = new Map<string, number>()
  private questions: LiveQuestions = { total: 0, approvals: 0, bySession: [] }
  private queue: LiveQueue = { total: 0, bySession: [] }
  private degraded: LiveDegraded = { registry: false, questions: false, queue: false }
  private lastReadings: LiveSessionReading[] = []

  private tickHandle: unknown = null
  private flushHandle: unknown = null
  private unsubscribe: (() => void) | null = null
  private running: Promise<void> | null = null
  private rerun = false
  private primed = false

  constructor(options: LiveHubOptions) {
    this.sources = options.sources
    this.now = options.now ?? (() => Date.now())
    this.tickMs = options.tickMs ?? LIVE_TICK_MS
    this.flushMs = options.flushMs ?? LIVE_FLUSH_MS
    this.ringSize = Math.max(1, options.ringSize ?? LIVE_EVENTS_RING_SIZE)
    this.activityMinMs = options.activityMinMs ?? LIVE_ACTIVITY_MIN_MS
    this.endedLingerMs = options.endedLingerMs ?? LIVE_ENDED_LINGER_MS
    this.epoch = options.epoch ?? this.now()
    this.setTimer = options.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t })
    this.clearTimer = options.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.log = options.log ?? (line => console.log(line))
    // The reply counter listens always (one Map increment per turn end); everything else waits for a stream.
    this.unsubscribe = this.sources.subscribe(change => this.onPush(change))
  }

  get newestSeq(): number { return this.seq }
  get streamCount(): number { return this.listeners.size }

  /** Ring bounds for a resume decision; null when empty. */
  ringBounds(): { oldest: number; newest: number } | null {
    if (this.ring.length === 0) return null
    return { oldest: this.ring[0]!.seq, newest: this.ring[this.ring.length - 1]!.seq }
  }

  /**
   * The frames after `cursor`, or null when the hub cannot honour it (another epoch, older than the ring, from the
   * future): the caller then sends a snapshot. An empty array means "you are current".
   */
  replayAfter(cursor: { epoch: number; seq: number } | null): LiveStateFrame[] | null {
    if (!cursor || cursor.epoch !== this.epoch) return null
    if (cursor.seq > this.seq) return null
    if (cursor.seq === this.seq) return []
    const bounds = this.ringBounds()
    if (!bounds || bounds.oldest > cursor.seq + 1) return null
    return this.ring.filter(f => f.seq > cursor.seq)
  }

  snapshotFrame(): LiveFrame {
    return {
      kind: 'snapshot', seq: this.seq, epoch: this.epoch, at: this.now(),
      sessions: [...this.sessions.values()].map(s => ({ ...s })),
      questions: { ...this.questions, bySession: this.questions.bySession.map(r => ({ ...r })) },
      queue: { ...this.queue, bySession: this.queue.bySession.map(r => ({ ...r })) },
      degraded: { ...this.degraded },
    }
  }

  heartbeatFrame(): LiveFrame {
    return { kind: 'heartbeat', seq: this.seq, epoch: this.epoch, at: this.now() }
  }

  resumeFrame(replayed: number): LiveFrame {
    return { kind: 'resume', seq: this.seq, epoch: this.epoch, at: this.now(), replayed }
  }

  /**
   * Join a stream. The first one starts the tick and primes the model (awaited, so the snapshot a fresh page gets is
   * a real reading rather than an empty model). The returned detach stops the tick with the last stream.
   */
  async attach(listener: LiveListener): Promise<() => void> {
    this.listeners.add(listener)
    if (!this.primed) {
      await this.refresh()
      this.primed = true
    }
    this.scheduleTick()
    let attached = true
    return () => {
      if (!attached) return
      attached = false
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stopTicking()
    }
  }

  /** Read every source once and emit what changed. Concurrent calls share one run, plus one follow-up. */
  refresh(): Promise<void> {
    if (this.running) { this.rerun = true; return this.running }
    this.running = (async () => {
      try {
        do {
          this.rerun = false
          await this.readOnce()
        } while (this.rerun)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  dispose(): void {
    this.stopTicking()
    if (this.flushHandle !== null) { this.clearTimer(this.flushHandle); this.flushHandle = null }
    this.unsubscribe?.()
    this.unsubscribe = null
    this.listeners.clear()
  }

  private onPush(change: { sessionId: string; turnEnded: boolean }): void {
    if (change.turnEnded) {
      const id = String(change.sessionId ?? '').toLowerCase()
      if (id) {
        this.replies.set(id, (this.replies.get(id) ?? 0) + 1)
        // Bounded: a long-lived server sees many sessions; the oldest counters go first.
        if (this.replies.size > 4 * LIVE_MAX_SESSIONS) {
          const first = this.replies.keys().next().value
          if (first !== undefined) this.replies.delete(first)
        }
      }
    }
    if (this.listeners.size === 0) return
    if (this.flushHandle !== null) return
    this.flushHandle = this.setTimer(() => {
      this.flushHandle = null
      void this.refresh().catch(() => { /* readOnce never throws; belt and braces */ })
    }, this.flushMs)
  }

  private scheduleTick(): void {
    if (this.tickHandle !== null || this.listeners.size === 0) return
    this.tickHandle = this.setTimer(() => {
      this.tickHandle = null
      void this.refresh().finally(() => this.scheduleTick())
    }, this.tickMs)
  }

  private stopTicking(): void {
    if (this.tickHandle !== null) { this.clearTimer(this.tickHandle); this.tickHandle = null }
    if (this.flushHandle !== null) { this.clearTimer(this.flushHandle); this.flushHandle = null }
    // A model nobody watches goes stale; the next stream re-primes it, and the diff against the old model still
    // produces the right frames for anyone resuming across the gap.
    this.primed = false
  }

  private emit(frame: LiveStateFrame): void {
    this.ring.push(frame)
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize)
    for (const listener of this.listeners) {
      try { listener(frame) } catch (error) {
        this.log(`[live-events] listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private nextBase(): FrameBase {
    return { seq: ++this.seq, epoch: this.epoch, at: this.now() }
  }

  private async readOnce(): Promise<void> {
    const now = this.now()

    let readings = this.lastReadings
    try {
      const read = await this.sources.sessions(now)
      if (read.degraded) this.degraded = { ...this.degraded, registry: true }
      else this.degraded = { ...this.degraded, registry: false }
      // A degraded read still carries whatever it did see; it is merged over the last good list, never replacing
      // it with less (a quiet registry read is not "nothing is running").
      readings = read.degraded ? mergeReadings(this.lastReadings, read.sessions) : read.sessions
      this.lastReadings = readings
    } catch (error) {
      this.degraded = { ...this.degraded, registry: true }
      this.log(`[live-events] session read failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    let questionRows: LiveQuestionReading[] | null = null
    try { questionRows = this.sources.questions(now) } catch { questionRows = null }
    let queueRows: LiveQueueReading[] | null = null
    try { queueRows = this.sources.queue(now) } catch { queueRows = null }

    // Questions and queue: a null read keeps the last value and flags it.
    if (questionRows === null) this.degraded = { ...this.degraded, questions: true }
    else {
      this.degraded = { ...this.degraded, questions: false }
      const per = new Map<string, LiveCountRow>()
      let approvals = 0
      for (const q of questionRows) {
        if (!PROVIDERS.has(q.provider)) continue
        const id = String(q.sessionId ?? '').toLowerCase()
        if (!SAFE_ID.test(id)) continue
        if (q.kind === 'approval') approvals++
        const k = keyOf(q.provider, id)
        const row = per.get(k) ?? { provider: q.provider, sessionId: id, count: 0 }
        row.count++
        per.set(k, row)
      }
      const next: LiveQuestions = { total: [...per.values()].reduce((n, r) => n + r.count, 0), approvals, bySession: sortRows([...per.values()]) }
      if (next.total !== this.questions.total || next.approvals !== this.questions.approvals || countsStamp(next.bySession) !== countsStamp(this.questions.bySession)) {
        this.questions = next
        this.emit({ ...this.nextBase(), kind: 'questions', total: next.total, approvals: next.approvals, bySession: next.bySession.map(r => ({ ...r })) })
      }
    }
    if (queueRows === null) this.degraded = { ...this.degraded, queue: true }
    else {
      this.degraded = { ...this.degraded, queue: false }
      const per = new Map<string, LiveCountRow>()
      for (const q of queueRows) {
        if (!PROVIDERS.has(q.provider) || !(q.count > 0)) continue
        const id = String(q.sessionId ?? '').toLowerCase()
        if (!SAFE_ID.test(id)) continue
        const k = keyOf(q.provider, id)
        const row = per.get(k) ?? { provider: q.provider, sessionId: id, count: 0 }
        row.count += Math.trunc(q.count)
        per.set(k, row)
      }
      const next: LiveQueue = { total: [...per.values()].reduce((n, r) => n + r.count, 0), bySession: sortRows([...per.values()]) }
      if (next.total !== this.queue.total || countsStamp(next.bySession) !== countsStamp(this.queue.bySession)) {
        this.queue = next
        this.emit({ ...this.nextBase(), kind: 'queue', total: next.total, bySession: next.bySession.map(r => ({ ...r })) })
      }
    }

    // Sessions.
    const questionsFor = (provider: LiveProvider, id: string): number => countFor(this.questions.bySession, provider, id)
    const queuedFor = (provider: LiveProvider, id: string): number => countFor(this.queue.bySession, provider, id)
    const seen = new Set<string>()
    const nextModel = new Map<string, LiveSession>()
    for (const reading of readings.slice(0, LIVE_MAX_SESSIONS)) {
      const id = String(reading.sessionId ?? '').toLowerCase()
      const projected = projectSession(reading, {
        replies: this.replies.get(id) ?? 0,
        questions: questionsFor(reading.provider, id),
        queued: queuedFor(reading.provider, id),
      })
      if (!projected) continue
      const k = keyOf(projected.provider, projected.sessionId)
      if (seen.has(k)) continue
      seen.add(k)
      if (projected.state === 'ended' && this.retired.has(k)) continue
      if (projected.state !== 'ended') this.retired.delete(k)
      nextModel.set(k, projected)
      if (projected.state === 'ended') {
        if (!this.endedUntil.has(k)) this.endedUntil.set(k, now + this.endedLingerMs)
      } else {
        this.endedUntil.delete(k)
      }
    }
    // A session that left the open set without saying it ended is ended now; it lingers, then goes.
    for (const [k, prev] of this.sessions) {
      if (nextModel.has(k)) continue
      if (!this.endedUntil.has(k)) this.endedUntil.set(k, now + this.endedLingerMs)
      nextModel.set(k, { ...prev, state: 'ended', turnStartedAt: null, questions: questionsFor(prev.provider, prev.sessionId), queued: queuedFor(prev.provider, prev.sessionId), replies: this.replies.get(prev.sessionId) ?? prev.replies })
    }
    for (const [k, until] of this.endedUntil) {
      if (now < until) continue
      this.endedUntil.delete(k)
      nextModel.delete(k)
      this.retired.add(k)
      if (this.retired.size > 4 * LIVE_MAX_SESSIONS) {
        const first = this.retired.values().next().value
        if (first !== undefined) this.retired.delete(first)
      }
    }

    for (const [k, prev] of this.sessions) {
      if (nextModel.has(k)) continue
      this.sessions.delete(k)
      this.lastSentAt.delete(k)
      this.emit({ ...this.nextBase(), kind: 'session.removed', provider: prev.provider, sessionId: prev.sessionId })
    }
    for (const [k, next] of nextModel) {
      const prev = this.sessions.get(k)
      if (!prev) {
        if (this.sessions.size >= LIVE_MAX_SESSIONS) continue
        this.sessions.set(k, next)
        this.lastSentAt.set(k, now)
        this.emit({ ...this.nextBase(), kind: 'session', change: 'added', session: { ...next } })
        continue
      }
      const material = materialStamp(prev) !== materialStamp(next)
      const touched = prev.updatedAt !== next.updatedAt
      if (!material && !touched) continue
      if (!material && now - (this.lastSentAt.get(k) ?? 0) < this.activityMinMs) continue
      this.sessions.set(k, next)
      this.lastSentAt.set(k, now)
      this.emit({ ...this.nextBase(), kind: 'session', change: 'updated', session: { ...next } })
    }
  }
}

function countFor(rows: LiveCountRow[], provider: LiveProvider, id: string): number {
  const exact = rows.find(r => r.provider === provider && r.sessionId === id)
  if (exact) return exact.count
  // The broker and the queue can key a Claude tab by its 8-character registry id; join on the prefix when it is
  // unambiguous, the same rule as queuedWaitingForSession.
  const short = id.slice(0, 8)
  const prefixed = rows.filter(r => r.provider === provider && (r.sessionId.startsWith(short) || short.startsWith(r.sessionId)) && (r.sessionId.length === 8 || id.length === 8))
  return prefixed.length === 1 ? prefixed[0]!.count : 0
}

function mergeReadings(prev: LiveSessionReading[], next: LiveSessionReading[]): LiveSessionReading[] {
  const byKey = new Map(prev.map(r => [keyOf(r.provider, r.sessionId), r]))
  for (const r of next) byKey.set(keyOf(r.provider, r.sessionId), r)
  return [...byKey.values()]
}
