// 6.78.0 Messages steer (plan v3.1 P4): everything about steering a running Claude answer that
// can be decided without a process, a file or the network. The bridge holds thin wiring only;
// the coordinator owns the journal. Imports nothing that reaches a provider, so tests and the
// Pi Durable canaries load it directly.
//
// THE PROTOCOL (probed on Claude Code 2.1.302, pi_durable_build/probes). With
// `-p --input-format stream-json --replay-user-messages`, the prompt is one stream-json user
// line and stdin stays open. A later user line at the DEFAULT priority (never "now") folds into
// the running turn at the next tool boundary: the CLI replays it (`type: user`, its own uuid,
// `isReplay: true`), and the turn's one `result` lists every folded line in
// `user_message_uuids`. A line that arrives after the turn's last step starts a second turn,
// which ends in a second result. The run is finished only when the results cover every line
// written; the CLI exits about 300 ms after stdin closes.
//
// WHAT THIS MODULE DECIDES:
//   encodeUserLine        one stdin line
//   composeFirstContent   the first prompt plus steers that arrived before it was written
//                         (pending ones, and ones carried from an interrupted generation)
//   SteerPort             one per job, created before the runner starts: a pending buffer the
//                         first line drains, then direct writes, then closed (too late)
//   SteerTracker          sent and covered uuids; what a result means (finish, wait, steering off)
//   steerCutoffMs         how close to a deadline a steer is refused as too late
//   resolveRunModel       the model a run will use, exactly as model-router resolves it
import { DEFAULT_MODEL, isCodexModel, isCursorModel, isOllamaModel, normalizeModelPreference, type ModelPreference } from '../../shared/model-preference.js'

/** Quiet after a result that left a steer uncovered, before stdin is closed (plan P4). */
export const STEER_SETTLE_MS = 20_000
/** After a steer-mode run is finalized, a child that has not exited by now is terminated. */
export const STEER_REAPER_MS = 15_000
const CUTOFF_FLOOR_MS = 10_000
const CUTOFF_FRACTION = 0.2

/**
 * 6.78.0 (P7 S7): the clock every steer cut-off is measured on, the bridge's wall clock and the
 * coordinator's deadline alike. Monotonic, like the timers that actually end the run
 * (setTimeout runs on libuv's monotonic clock), so a Mac that slept does not make a steer read
 * too late against a timer that did not advance. `Date.now()` jumps across a sleep.
 */
export function steerClock(): number {
  return performance.now()
}

/** A steer arriving with less than this left on the wall clock or the deadline is too late. */
export function steerCutoffMs(wallMaxMs: number): number {
  return Math.max(CUTOFF_FLOOR_MS, Math.round(CUTOFF_FRACTION * Math.max(0, wallMaxMs)))
}

/** One stdin line of `--input-format stream-json`: a user message with its own uuid. */
export function encodeUserLine(uuid: string, content: string): string {
  return `${JSON.stringify({ type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content } })}\n`
}

/**
 * The first prompt, with the steers that are already known when it is written. Never part of
 * `request.query` or the fingerprint (Resume and rollback hash the request): composed here, at
 * execution time only. Pending steers (sent before the run started) and steers carried from an
 * earlier generation read alike.
 */
export function composeFirstContent(prompt: string, steers: ReadonlyArray<{ text: string }>): string {
  const lines = steers.map(steer => steer.text.trim()).filter(Boolean)
  if (lines.length === 0) return prompt
  return `${prompt}\n\nThe user added this while the answer was being prepared:\n${lines.map(line => `- ${line}`).join('\n')}`
}

export interface PendingSteer {
  steerId: string
  text: string
  /** The generation it was first sent to, when it is carried into a later one. */
  carriedFrom?: number
}

/** What the port tells its owner (the coordinator journals each). */
export interface SteerPortEvents {
  /** Composed into the first line (pending before the start, or carried). */
  onIncluded?: (steers: PendingSteer[]) => void
  /** The CLI replayed the line: it has it. */
  onDelivered?: (steerId: string) => void
  /** A result covered it: the answer includes it. */
  onFolded?: (steerIds: string[]) => void
  /** The first result covered the prompt while a steer was still uncovered: the answer so far. */
  onCheckpoint?: (text: string) => void
}

export type SteerOffer = 'pending' | 'written' | 'closed' | 'duplicate'

/**
 * One per job, on the coordinator's ActiveRun BEFORE the runner starts, so no steer can fall
 * between "accepted" and a sink that does not exist yet.
 *
 *   before the first line: `offer` buffers; the bridge drains the buffer into the first line
 *   after `open(sink)`:    `offer` writes a line at once (the sink must say it is writable)
 *   after `close()`:       `offer` is refused, and the caller journals too_late
 */
export class SteerPort {
  readonly events: SteerPortEvents
  private readonly pending: PendingSteer[] = []
  private readonly known = new Set<string>()
  private sink: ((line: string, steerId: string) => boolean) | null = null
  private composed: PendingSteer[] = []
  private closed = false
  private wallDeadlineAt: number | null = null
  private wallMaxMs: number | null = null
  /** Every steer uuid written to stdin, in order (the tracker's `sent`, less the prompt). */
  readonly written: string[] = []

  constructor(events: SteerPortEvents = {}) {
    this.events = events
  }

  get isClosed(): boolean { return this.closed }
  get isOpen(): boolean { return this.sink !== null && !this.closed }

  /** A steer to apply. Idempotent by id. */
  offer(steer: PendingSteer): SteerOffer {
    if (this.known.has(steer.steerId)) return 'duplicate'
    if (this.closed) return 'closed'
    this.known.add(steer.steerId)
    if (!this.sink) {
      this.pending.push(steer)
      return 'pending'
    }
    if (!this.sink(encodeUserLine(steer.steerId, steer.text), steer.steerId)) {
      this.closed = true
      this.sink = null
      return 'closed'
    }
    this.written.push(steer.steerId)
    return 'written'
  }

  /** The bridge, composing the first line: every pending steer, in order, once. They are
   * reported `onIncluded` when the line is actually written (`open`). */
  drainForCompose(): PendingSteer[] {
    this.composed = this.pending.splice(0)
    return [...this.composed]
  }

  /**
   * The first line is written: later steers go straight to stdin. Steers offered after the
   * compose and before this call are written now, in order. Returns the ones written here.
   */
  open(sink: (line: string, steerId: string) => boolean, timing: { startedAt: number; wallMaxMs: number }): string[] {
    if (this.closed) return []
    this.wallMaxMs = timing.wallMaxMs
    this.wallDeadlineAt = timing.startedAt + timing.wallMaxMs
    const composed = this.composed.splice(0)
    if (composed.length > 0) this.events.onIncluded?.(composed)
    this.sink = sink
    const late = this.pending.splice(0)
    const out: string[] = []
    for (const steer of late) {
      if (!sink(encodeUserLine(steer.steerId, steer.text), steer.steerId)) {
        this.closed = true
        this.sink = null
        break
      }
      this.written.push(steer.steerId)
      out.push(steer.steerId)
    }
    return out
  }

  /** Steers that were offered and never written (they read not_applied when the run ends). */
  unwritten(): PendingSteer[] {
    return [...this.composed, ...this.pending]
  }

  /** No more writes: the run is finishing or finished. */
  close(): void {
    this.closed = true
    this.sink = null
  }

  /** Time left on the bridge's wall clock, or null before the first line. */
  wallRemainingMs(now: number): number | null {
    return this.wallDeadlineAt === null ? null : this.wallDeadlineAt - now
  }

  wallMax(): number | null {
    return this.wallMaxMs
  }
}

export type ResultVerdict =
  /** Every line written is covered: finish now with the whole answer. */
  | { action: 'finish'; folded: string[] }
  /** Some line is not covered yet: keep stdin open and wait (settle timer). */
  | { action: 'wait'; folded: string[]; checkpoint: boolean }
  /** The CLI did not say which lines a result covers: steering is off for this job, finish now. */
  | { action: 'finish_steering_off'; folded: string[] }

/**
 * Sent and covered uuids for one run. The prompt's uuid is sent first; each steer written is
 * sent after it. A replay echo marks a steer delivered; a result adds its `user_message_uuids`
 * to `covered`.
 */
export class SteerTracker {
  private readonly sent: string[]
  private readonly covered = new Set<string>()
  private readonly delivered = new Set<string>()
  private promptCovered = false

  constructor(readonly promptUuid: string) {
    this.sent = [promptUuid]
  }

  noteWritten(uuid: string): void {
    if (!this.sent.includes(uuid)) this.sent.push(uuid)
  }

  /** A `type: user` stream event. Returns a steer id the first time the CLI replays it. */
  onUserEvent(event: { uuid?: unknown; isReplay?: unknown }): string | null {
    const uuid = typeof event.uuid === 'string' ? event.uuid : null
    if (!uuid || uuid === this.promptUuid || !this.sent.includes(uuid) || this.delivered.has(uuid)) return null
    if (event.isReplay !== true) return null
    this.delivered.add(uuid)
    return uuid
  }

  /** A successful `result`. Errors are decided by the bridge before this is called. */
  onResult(event: { user_message_uuids?: unknown }): ResultVerdict {
    const uuids = event.user_message_uuids
    if (!Array.isArray(uuids)) {
      return { action: 'finish_steering_off', folded: [] }
    }
    const folded: string[] = []
    for (const uuid of uuids) {
      if (typeof uuid !== 'string' || this.covered.has(uuid)) continue
      this.covered.add(uuid)
      if (uuid !== this.promptUuid && this.sent.includes(uuid)) folded.push(uuid)
    }
    if (this.sent.every(uuid => this.covered.has(uuid))) return { action: 'finish', folded }
    const firstCover = !this.promptCovered && this.covered.has(this.promptUuid)
    if (firstCover) this.promptCovered = true
    return { action: 'wait', folded, checkpoint: firstCover }
  }

  /** Steers written and not covered (they will read not_applied when the run ends). */
  uncovered(): string[] {
    return this.sent.filter(uuid => uuid !== this.promptUuid && !this.covered.has(uuid))
  }
}

export type QueryProvider = 'claude' | 'codex' | 'cursor' | 'ollama'

/**
 * The model a run will use, EXACTLY as model-router.ts resolves it (a test pins the two):
 * the request's model, else the session's, else COS_G2_DEFAULT_MODEL, else the default.
 */
export function resolveRunModel(model: unknown, sessionModel: ModelPreference | null | undefined, envDefault: unknown): ModelPreference {
  return normalizeModelPreference(model) ?? sessionModel ?? normalizeModelPreference(envDefault) ?? DEFAULT_MODEL
}

/** The provider of a resolved model, with model-router's fall-through: anything else is Claude. */
export function providerOfModel(model: ModelPreference): QueryProvider {
  if (isOllamaModel(model)) return 'ollama'
  if (isCursorModel(model)) return 'cursor'
  return isCodexModel(model) ? 'codex' : 'claude'
}
