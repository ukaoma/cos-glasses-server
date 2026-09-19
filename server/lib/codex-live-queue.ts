// Continue into a Codex thread the Codex app already has open, through Codex's own queue.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS (6.51.0)
// ---------------------------------------------------------------------------
// The attached path spawns `codex exec resume <id> -`. When ChatGPT.app (Codex Desktop)
// has the thread open, its app-server holds the thread's writer lock for as long as the
// thread is LOADED, idle included, and the child dies in about 0.2 s with "thread
// <id> already has an active writer" -- AFTER the adapter has written the prompt to its
// stdin, so the turn lands as `ambiguous` and fences the thread until an operator
// releases it. Production has two such fences on record (August, provider_exit_nonzero,
// exit 1, ~0.7 s). So for a thread the Codex app holds, today's Continue cannot work.
//
// Codex ships the fix itself. `codex queue --thread <id> --message <text>` inserts a row
// into `$CODEX_HOME/queue_1.sqlite`, and every app-server watches that database for writes
// from OTHER processes (`PRAGMA data_version` plus the `queued_thread_revisions` table).
// Canary, 2026-09-19, scratch CODEX_HOME, codex-cli 0.155.0-alpha.9.2, holder =
// `codex app-server` over stdio exactly as ChatGPT.app runs it:
//
//   holder mid-turn     queued in 0.05 s; the holder started it 10 ms after the running
//                       turn's `task_complete`, as an ordinary user turn
//   holder idle         the holder picked it up and started it 7.35 s later
//   no holder           the row waits in the queue until something opens the thread;
//                       no daemon is started
//   writer lock         held by the holder the whole time the thread is loaded, idle too
//   exec resume, held   exits 1 in 0.2 s: "already has an active writer"
//   --message=-h        queued the literal text "-h" (the `=` form is flag-safe)
//   --message -         queued a literal "-": the CLI does NOT read stdin
//   unknown thread      exit 1, "failed to queue session message: ... no rollout found",
//                       and nothing queued
//
// So this is the Codex counterpart of the Claude peer inbox (`session-peer-inbox.ts`),
// and a better one: the message is a real user turn in the app's own queue, visible and
// editable there, and delivered by the engine at exactly the end of the running turn.
//
// ---------------------------------------------------------------------------
// THE ONE CONCESSION: THE PROMPT RIDES IN ARGV
// ---------------------------------------------------------------------------
// The attached adapter keeps prompts off argv. `codex queue` has no stdin form (measured
// above), and the alternative -- a second `codex app-server` on the user's CODEX_HOME to
// send `thread/queue/add` over JSON-RPC -- starts a whole engine that can run automations
// and memory jobs on its own. The CLI lives about 50 ms, is spawned without a shell, and
// macOS shows a process's arguments only to its own user. The prompt never reaches a log
// line here: only lengths, reasons and the queued id do.
//
// ---------------------------------------------------------------------------
// WHAT COUNTS AS DELIVERED
// ---------------------------------------------------------------------------
// Exit 0 AND the CLI's confirmation line naming OUR thread id. That line is printed from
// the insert's own RETURNING row, so it is positive evidence the row exists. Anything
// else that might have inserted -- exit 0 without the line, a timeout, a kill, a nonzero
// exit we cannot place -- is `unverified`, and the route HOLDS rather than retrying,
// because a retried queue write puts the same sentence into the thread twice.

import { isValidNativeThreadId } from './native-thread-id.js'

export type CodexLiveReason =
  /** The row is in the holder's queue. */
  | 'delivered'
  /** `COS_CODEX_LIVE_QUEUE=0`. Nothing sent. */
  | 'disabled'
  /** Not a Codex turn, or not a thread the app holds. Nothing sent; the spawn path is right. */
  | 'no_holder'
  | 'invalid_request'
  /** No usable `codex` binary. Nothing sent. */
  | 'binary_not_found'
  /** The CLI never started. Nothing sent. */
  | 'spawn_failed'
  /** The CLI said it queued nothing ("failed to queue session message"). */
  | 'refused'
  /** Something may be queued. Hold; never retry, never spawn over it. */
  | 'unverified'

export interface CodexLiveResult {
  ok: boolean
  reason: CodexLiveReason
  verifiedBy: 'codex-queue' | null
  /** Codex's own id for the queued submission, when delivered. */
  queuedId: string | null
  elapsedMs: number
  /** Always null: the holder is the app-server, not a process this module talks to. */
  pid: null
}

export interface CodexQueueRun {
  /** Null when the process was killed or never started. */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Set when the process could not be started at all. */
  spawnError: string | null
}

export interface CodexLiveDeps {
  /** An absolute, verified `codex` path, or null. */
  resolveBinary: () => string | null
  /** Run the CLI without a shell. MUST resolve, never reject. */
  run: (binary: string, args: readonly string[], timeoutMs: number) => Promise<CodexQueueRun>
  now: () => number
  log?: (level: 'info' | 'warn', event: string, detail: Record<string, unknown>) => void
}

export interface CodexLiveRequest {
  provider: string
  sessionId: string
  prompt: string
  /** The flag read at the call site, so this module never reads the environment. */
  enabled: boolean
  /**
   * The route's own occupancy verdict: a live process that is not ours holds this
   * thread's writer lock. Without a holder the queue row would wait until somebody opens
   * the thread, which is not a Continue; the spawn path is the right answer there.
   */
  foreignHolder: boolean
  timeoutMs?: number
}

/** Measured 50-70 ms. The ceiling sits inside the phone's 10 s turn budget with room for the gate. */
export const CODEX_QUEUE_TIMEOUT_MS = 5_000

/** Codex 0.155's confirmation line, printed from the insert's RETURNING row. */
const CONFIRMATION = /^Queued message (\S+) for thread (\S+)\.\s*$/m

/** The CLI's own "nothing was queued" prefix (the add failed before or at the insert). */
const NOTHING_QUEUED = /failed to queue session message/i

/**
 * The argv, in the `--flag=value` form on purpose: clap reads `--message -h` as a flag
 * and `--message=-h` as text (measured). The thread id is validated by the caller, and
 * this refuses anything that is not a native thread id anyway, because it is about to
 * become a process argument.
 */
export function buildCodexQueueArgs(threadId: string, prompt: string): string[] {
  if (!isValidNativeThreadId(threadId)) throw new Error('buildCodexQueueArgs: invalid thread id')
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.includes('\0')) {
    throw new Error('buildCodexQueueArgs: unusable prompt')
  }
  return ['queue', `--thread=${threadId}`, `--message=${prompt}`]
}

/** Codex's queued-submission id when the line names OUR thread, else null. */
export function parseCodexQueueConfirmation(stdout: string, threadId: string): string | null {
  const match = CONFIRMATION.exec(typeof stdout === 'string' ? stdout : '')
  if (!match) return null
  return match[2]!.toLowerCase() === threadId.toLowerCase() ? match[1]! : null
}

/**
 * One CLI run to a verdict. Pure, and total: every shape lands on a reason, and every
 * shape that could have inserted a row without saying so lands on `unverified`.
 */
export function classifyCodexQueueRun(run: CodexQueueRun, threadId: string): { reason: CodexLiveReason; queuedId: string | null } {
  if (run.spawnError !== null) return { reason: 'spawn_failed', queuedId: null }
  if (run.timedOut || run.code === null) return { reason: 'unverified', queuedId: null }
  if (run.code === 0) {
    const queuedId = parseCodexQueueConfirmation(run.stdout, threadId)
    return queuedId ? { reason: 'delivered', queuedId } : { reason: 'unverified', queuedId: null }
  }
  return NOTHING_QUEUED.test(run.stderr) ? { reason: 'refused', queuedId: null } : { reason: 'unverified', queuedId: null }
}

/** Put the turn into the Codex app's own queue for this thread, and say honestly what happened. */
export async function deliverOverCodexQueue(request: CodexLiveRequest, deps: CodexLiveDeps): Promise<CodexLiveResult> {
  const started = deps.now()
  const done = (reason: CodexLiveReason, queuedId: string | null = null): CodexLiveResult => ({
    ok: reason === 'delivered',
    reason,
    verifiedBy: reason === 'delivered' ? 'codex-queue' : null,
    queuedId,
    elapsedMs: Math.max(0, deps.now() - started),
    pid: null,
  })
  if (!request.enabled) return done('disabled')
  if (request.provider !== 'codex' || request.foreignHolder !== true) return done('no_holder')
  let args: string[]
  try {
    args = buildCodexQueueArgs(request.sessionId, request.prompt)
  } catch {
    return done('invalid_request')
  }
  let binary: string | null
  try {
    binary = deps.resolveBinary()
  } catch {
    binary = null
  }
  if (!binary) return done('binary_not_found')

  let run: CodexQueueRun
  try {
    run = await deps.run(binary, args, request.timeoutMs ?? CODEX_QUEUE_TIMEOUT_MS)
  } catch (error) {
    // `run` must not reject; if it does we cannot say whether the CLI got as far as the
    // insert, so this is the ambiguous answer, never the "nothing sent" one.
    deps.log?.('warn', 'codex-live-queue', { outcome: 'run_threw', detail: error instanceof Error ? error.message.slice(0, 120) : 'unknown' })
    return done('unverified')
  }
  const verdict = classifyCodexQueueRun(run, request.sessionId)
  deps.log?.(verdict.reason === 'delivered' ? 'info' : 'warn', 'codex-live-queue', {
    outcome: verdict.reason,
    code: run.code,
    timedOut: run.timedOut,
    promptChars: request.prompt.length,
    queuedId: verdict.queuedId,
    // The CLI's own first stderr line names the failure; it cannot carry the prompt,
    // which only ever travels in argv. Bounded anyway.
    stderr: verdict.reason === 'delivered' ? undefined : run.stderr.split('\n').find(l => l.trim().length > 0)?.slice(0, 160),
  })
  return done(verdict.reason, verdict.queuedId)
}

/**
 * `COS_CODEX_LIVE_QUEUE`. ON unless set to `0`.
 *
 * Default-on, unlike `COS_CONTINUE_LIVE`, because the path it replaces cannot work: for a
 * thread the Codex app holds, the spawn fails every time and leaves a fence. Only a
 * thread with a foreign writer ever reaches this module, so a thread nobody holds keeps
 * the 6.50 path exactly.
 */
export function codexLiveQueueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_CODEX_LIVE_QUEUE !== '0'
}
