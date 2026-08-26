// Fork: create a NEW native provider thread carrying an existing thread's
// history, and leave the ORIGINAL byte-identical.
//
// WHY THIS FILE EXISTS. The server refuses to continue a native thread in
// seventeen separate places, and every one of those refusals ends with the same
// four words: "Fork it instead." Until this module there was nothing behind that
// sentence — no route, no handler, no code path. Every refusal was pointing at a
// door that did not exist. This is the door.
//
// THERE IS NO OCCUPANCY GATE HERE, DELIBERATELY, AND THAT IS THE WHOLE POINT.
// `attached-provider-adapter.ts` re-checks occupancy immediately before it
// spawns, because it is about to APPEND to a conversation a human being may have
// open on their desktop. Fork appends to nothing. It reads the source thread and
// writes a new one, so a live desktop owner is not a hazard to be avoided — it is
// the ordinary case, and the reason the user was routed here. A fork that refused
// because the source is busy would refuse exactly when it is needed and leave the
// user with no path at all. So: no occupancy probe, no owner scan, no preflight
// verdict. Nothing in this file may grow one.
//
// WHAT WAS MEASURED, NOT ASSUMED (both providers, live, 2026-08-16).
//
//   claude -p --output-format stream-json --verbose --resume <id> --fork-session
//     exit 0. Source transcript sha256 UNCHANGED, 7440 bytes before and after.
//     A new transcript appeared (9448 bytes: the source's history plus the new
//     turn). stdout carried EXACTLY ONE distinct id, `session_id` on every event,
//     and it was the NEW one. The source id was never printed.
//
//   codex exec --sandbox read-only --cd <cwd> fork --json --skip-git-repo-check <id> -
//     exit 0. Source rollout sha256 UNCHANGED, 48632 bytes before and after.
//     stdout carried EXACTLY ONE distinct id, on `thread.started` as `thread_id`,
//     and it was the NEW one.
//
// Both of those runs are what makes the exactly-one-id rule below a measurement
// rather than a hopeful default: neither provider echoes the source id, so
// "more than one id" really does mean we cannot tell what happened.
//
// THE SINGLE MOST IMPORTANT ASSERTION IN THIS MODULE is that the returned id
// DIFFERS from the source id. If a provider hands back the id we asked it to fork
// FROM, then whatever just happened was not a fork — it was an append into the
// user's real conversation, performed by the code path we offer as the safe
// alternative to appending. That is a terminal failure, never a success. It is the
// exact mirror of the adapter's id-EQUALITY check: that module demands the ids
// match, this one demands they differ, and both refuse on anything else.
//
// NEVER COMPARE IDS BY PREFIX. Measured on the codex canary above: the source and
// its fork were `01a00ab4-7350-74a3-…` and `01a00ab4-b9fd-7680-…`. Codex mints
// UUIDv7, so two ids created seconds apart SHARE THEIR ENTIRE FIRST BLOCK. A
// `startsWith` or an eight-character display-form comparison would have read that
// fork as a write into the source, or — flip the branch — read a write into the
// source as a fork. Comparison is full-string equality, and `isValidNativeThreadId`
// is what stands between this rule and a truncated id that cannot express it.
//
// PROMPT GOES ON STDIN FOR BOTH PROVIDERS. argv is world-readable through `ps` and
// the prompt is the user's private text; the adapter established this and fork does
// not get to relax it. Codex documents `-` as "read the prompt from stdin" on
// `exec fork` and the canary above used it, so the argv form is not needed. Note
// that the codex CLI reads stdin whether or not a prompt argument is present, so
// stdin must always be ENDED — an unclosed pipe hangs the child until the timeout.
//
// WHAT THIS MODULE REFUSES TO IMPORT: the bridges, the occupancy detector, the
// binding registry. It resolves a binary, spawns one child, reads ids off stdout,
// and reports. Everything else is the caller's.

import { isAbsolute } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

import { isValidNativeThreadId } from './native-thread-id.js'
import { isForkableProvider, type ForkableProvider } from './agent-session-binding-store.js'
import { recordCosSpawn, releaseCosSpawn } from './agent-session-ownership-store.js'
import { processStartMs as realProcessStartMs } from './occupancy-probes.js'
import {
  DEFAULT_ATTACHED_TIMEOUT_MS,
  FORCE_SETTLE_MS,
  KILL_GRACE_MS,
  MAX_ATTACHED_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
  MAX_STDOUT_SCAN_BYTES,
  buildAttachedEnv,
  classifyStderr,
  extractNativeIdsFromLine,
  isAttachedPermissionPolicy,
  resolveProviderBinary,
  type AttachedChildProcess,
  type AttachedSpawnRequest,
  type AttachedStderrClass,
  type BinaryResolution,
} from './attached-provider-adapter.js'
import { findBannedPermissionArg } from './banned-permission-args.js'

/**
 * Providers that can be forked. A strict subset of the attached set.
 *
 * Cursor can Continue (ask-mode resume) and cannot Fork: Agent CLI has no
 * `--fork-session` equivalent, and advertising Fork on Cursor would 404 the
 * only remaining write path for that row if Continue were also hidden.
 */
export type ForkProvider = ForkableProvider

/** Same one-member policy as the attached path. An omitted policy is refused. */
export type ForkPermissionPolicy = 'read_only'

/** Terminal reason on failure. Never carries prompt, transcript or provider text. */
export type ForkFailure =
  | 'invalid_provider'
  | 'invalid_thread_id'
  | 'invalid_prompt'
  | 'invalid_cwd'
  | 'invalid_timeout'
  | 'unsupported_policy'
  | 'binary_not_found'
  | 'spawn_failed'
  | 'ownership_record_failed'
  | 'child_stdio_unavailable'
  | 'timeout'
  | 'provider_exit_nonzero'
  | 'no_native_id_returned'
  /** The provider handed back the id we asked it to fork FROM. See the header. */
  | 'fork_returned_source_id'
  | 'ambiguous_native_id'
  /** The source thread changed while we forked it. The one unforgivable outcome. */
  | 'source_thread_mutated'
  | 'fork_internal_error'

/**
 * How much of a new thread may exist on the user's Mac as a result of this call.
 *
 * This is NOT the adapter's delivery state and must not be read as one. Delivery
 * asks "might we have written into their conversation?", which for a fork is
 * answered by `sourceIntegrity`. This asks a much smaller question: "is there a
 * thread out there we created and cannot name?" — an orphan, which costs disk and
 * confusion but harms nothing.
 *
 *   none      no child process was ever created, or it was killed pre-prompt
 *   possible  a child ran; a forked thread may exist whose id we never observed
 *   created   we observed exactly one new id and it is reported below
 */
export type ForkState = 'none' | 'possible' | 'created'

/**
 * Whether the source thread was proved untouched.
 *
 *   verified_unchanged  a watermark was read before and after, and they match
 *   unverified          no watermark was available at one or both ends
 *   mutated             both were read and they DIFFER — terminal
 *
 * `unverified` is a deliberate, named exception to this feature's "every unknown
 * refuses" rule, and it is the only one in this file. The rule exists to stop an
 * unproven assumption authorizing a WRITE into someone's conversation. Fork
 * performs no such write by construction, so the watermark is corroboration, not
 * a precondition — and making it a precondition would mean an unreadable
 * transcript disables the fallback at the exact moment the primary path has
 * already refused, leaving the user nothing. So a missing watermark degrades to a
 * REPORTED `unverified`, never to a fabricated `verified_unchanged`. Positive
 * evidence of mutation is still terminal.
 */
export type SourceIntegrity = 'verified_unchanged' | 'unverified' | 'mutated'

export interface ForkSuccess {
  ok: true
  provider: ForkProvider
  sourceNativeThreadId: string
  /** The forked thread. Guaranteed !== `sourceNativeThreadId`. Bind to this. */
  newNativeThreadId: string
  forkState: 'created'
  sourceIntegrity: 'verified_unchanged' | 'unverified'
  reason: null
  exitCode: number
  durationMs: number
}

export interface ForkFailureResult {
  ok: false
  provider: ForkProvider | null
  sourceNativeThreadId: string | null
  /**
   * The forked thread, when we saw exactly one usable id before failing.
   *
   * Present on failure so an orphan can be found and cleaned up rather than
   * silently accumulating. Server-side only — the route projects an opaque
   * reference, never this.
   */
  newNativeThreadId: string | null
  forkState: ForkState
  sourceIntegrity: SourceIntegrity
  reason: ForkFailure
  /** Bounded, self-authored discriminator. Enum-like strings only. */
  detail: string | null
  exitCode: number | null
  stderrClass: AttachedStderrClass
  durationMs: number
}

export type ForkResult = ForkSuccess | ForkFailureResult

/**
 * Might this call have left a thread behind that nobody can name?
 *
 * Written as "possible unless proven otherwise" rather than an equality test, so a
 * `ForkState` added later defaults to "warn the user" instead of "say nothing".
 */
export function forkOrphanPossible(result: ForkResult): boolean {
  if (result.ok) return false
  return result.forkState !== 'none'
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

/**
 * `claude -p --resume <id> --fork-session`, read-only, prompt on stdin.
 *
 * `--fork-session` is documented by the installed CLI as "When resuming, create a
 * new session ID" and is only meaningful alongside `--resume`. The fork keeps a
 * read-only stance — a fork runs a real model turn against a workspace the user
 * did not explicitly hand us — but that stance is now `--permission-mode plan`
 * plus an empty `--allowedTools` only. The third layer this used to carry,
 * `--tools ''`, is GONE: on the current CLI an empty --tools on a fork-resume
 * triggers a spurious context compaction (`too_few_groups`) followed by a
 * synthetic 400 "Prompt is too long" with zero input tokens — every claude fork
 * failed as orphan_possible while the transcript copy sat there complete.
 * Isolated by single-flag bisection on 2026-08-26: plan-only completed,
 * allowedTools-only completed, `--tools ''` alone reproduced the failure. (The
 * attached path dropped all three layers on 2026-08-16 by explicit decision;
 * the fork deliberately keeps the two that still work.)
 *
 * `stream-json` requires `--verbose`; without it the CLI refuses and we would never
 * see the id we are required to verify.
 */
export function buildClaudeForkArgs(nativeThreadId: string): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--resume', nativeThreadId,
    '--fork-session',
    '--permission-mode', 'plan',
    '--allowedTools', '',
  ]
}

/**
 * `codex exec -s read-only -C <cwd> fork --json --skip-git-repo-check <id> -`.
 *
 * Verified against codex-cli 0.148.0-alpha.9 on 2026-08-16:
 * `codex exec fork [OPTIONS] <SESSION_ID> [PROMPT]`. `--sandbox` and `--cd` are
 * options of `exec` and must precede the `fork` subcommand; `--json` and
 * `--skip-git-repo-check` belong to `fork`; and NOTHING may follow the positionals.
 * The trailing `-` is the documented stdin form, which keeps the prompt out of argv.
 *
 * `--ephemeral` is deliberately absent: a fork that is not written to disk is not a
 * thread the user can go back to, which is the entire deliverable.
 */
export function buildCodexForkArgs(nativeThreadId: string, cwd: string): string[] {
  return [
    'exec',
    '--sandbox', 'read-only',
    '--cd', cwd,
    'fork',
    '--json',
    '--skip-git-repo-check',
    nativeThreadId,
    '-',
  ]
}

/**
 * Build the argv, and REFUSE to hand back one carrying a banned permission flag.
 *
 * The predicate is IMPORTED from banned-permission-args, not re-listed here. Two copies of a
 * ban list in two modules is precisely the drift `native-thread-id.ts` was created
 * to end: the occupancy detector and the binding store each had their own idea of
 * what a thread id was, and a truncated id walked through the gap. A fork spawns a
 * model against the user's workspace, so it needs the same list the attached path
 * has — and needs it to keep being the same list after someone edits one of them.
 */
function buildForkArgs(provider: ForkProvider, nativeThreadId: string, cwd: string): string[] {
  const args = provider === 'claude'
    ? buildClaudeForkArgs(nativeThreadId)
    : buildCodexForkArgs(nativeThreadId, cwd)
  const banned = findBannedPermissionArg(args)
  if (banned !== null) {
    // The flag name only. Never the argv, which carries the thread id and the cwd.
    throw new Error(`fork argv carries a banned permission flag: ${banned}`)
  }
  return args
}

// ---------------------------------------------------------------------------
// The id rule
// ---------------------------------------------------------------------------

export type ForkIdVerdict =
  | { ok: true; newNativeThreadId: string }
  | {
      ok: false
      reason: 'no_native_id_returned' | 'fork_returned_source_id' | 'ambiguous_native_id'
      /** The single id we saw, when there was exactly one. Null otherwise. */
      observed: string | null
    }

/**
 * Which thread did the provider actually create?
 *
 * Four outcomes, three of them refusals:
 *
 *  0 ids   `no_native_id_returned`. Exit 0 with no evidence is not a fork. We were
 *          required to prove a new thread exists and name it; nothing is not proof.
 *  >1 ids  `ambiguous_native_id`. Both canaries printed exactly one id, so more
 *          than one means this build no longer understands the provider's output —
 *          and binding a COS chat to the WRONG one of two candidate threads is a
 *          worse outcome than asking the user to try again. Never guess by
 *          "the one that isn't the source": a second id can just as easily be a
 *          field this build misread as an id at all.
 *  = source  `fork_returned_source_id`. The header explains why this is the most
 *          important branch in the file. Not a degraded success, not a warning:
 *          a fork that returns the source id is an append, and an append is the
 *          thing fork exists to avoid.
 *  else    the fork, named.
 *
 * Full-string equality. See the header on why a prefix comparison is catastrophic
 * against codex's UUIDv7 ids.
 */
export function selectForkedId(
  observed: readonly string[],
  sourceNativeThreadId: string,
): ForkIdVerdict {
  // A non-array is a wiring bug, and a wiring bug resolves to the refusal that
  // says "we cannot tell", not to the one that says "nothing happened".
  if (!Array.isArray(observed)) return { ok: false, reason: 'ambiguous_native_id', observed: null }

  const distinct: string[] = []
  for (const value of observed) {
    // Re-validated at the point of USE rather than trusted from the scanner. This
    // id becomes a spawn argument and a lock key downstream.
    if (isValidNativeThreadId(value) && !distinct.includes(value)) distinct.push(value)
  }

  if (distinct.length === 0) return { ok: false, reason: 'no_native_id_returned', observed: null }
  if (distinct.length > 1) return { ok: false, reason: 'ambiguous_native_id', observed: null }

  const only = distinct[0]!
  if (!isValidNativeThreadId(sourceNativeThreadId)) {
    // Cannot run the comparison that makes a fork safe, so there is no verdict to
    // give. Reached only through a caller that skipped validation.
    return { ok: false, reason: 'ambiguous_native_id', observed: only }
  }
  if (only === sourceNativeThreadId) {
    return { ok: false, reason: 'fork_returned_source_id', observed: only }
  }
  return { ok: true, newNativeThreadId: only }
}

// ---------------------------------------------------------------------------
// Injected surface
// ---------------------------------------------------------------------------

/**
 * Every dependency is REQUIRED except the two marked optional.
 *
 * Same reasoning as the adapter: a default is how a fail-open ships. An omitted
 * ownership ledger that silently no-ops leaves our own child looking like a
 * foreign desktop owner of the SOURCE thread forever, which would make the source
 * permanently un-continuable — a fork that quietly breaks Continue for the thread
 * it was forked from.
 */
export interface ForkDeps {
  /** Epoch ms. */
  now: () => number
  resolveBinary: (provider: ForkProvider) => BinaryResolution
  spawn: (request: AttachedSpawnRequest) => AttachedChildProcess
  /** MUST be the measured kernel start, never `Date.now()`. */
  processStartMs: (pid: number) => number | null
  recordSpawn: (pid: number, startMs: number) => string
  releaseSpawn: (pid: number) => unknown
  /**
   * Terminate the child. Injected rather than defaulted so a unit test can never
   * reach `process.kill(-pid)` with a fabricated pid and signal a real process
   * group on the developer's machine.
   */
  terminate: (child: AttachedChildProcess, signal: NodeJS.Signals) => void
  /**
   * Bounded, non-identifying watermark of the SOURCE thread, or null.
   *
   * Wire it to `nativeHead`. Read once before the spawn and once after the child
   * settles; a difference is terminal. Optional because a null at either end is
   * already handled as `unverified` — but leaving it unwired means this module can
   * never prove the property that makes fork safe to offer, so production should
   * always supply it.
   */
  sourceWatermark?: (provider: ForkProvider, nativeThreadId: string) => string | null
  /**
   * Argv builder. Optional, defaults to the real one.
   *
   * Exists ONLY so a test can hand back an argv carrying a banned permission flag
   * and prove the fork is refused with zero spawns. Production never sets it.
   */
  buildArgs?: (provider: ForkProvider, nativeThreadId: string, cwd: string) => string[]
}

export interface ForkRequest {
  provider: unknown
  nativeThreadId: unknown
  prompt: unknown
  cwd: unknown
  policy: unknown
  deps: ForkDeps
  /** Wall-clock budget for the provider run. Omitted uses the attached default. */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function fail(
  reason: ForkFailure,
  forkState: ForkState,
  over: Partial<ForkFailureResult> = {},
): ForkFailureResult {
  return {
    ok: false,
    provider: null,
    sourceNativeThreadId: null,
    newNativeThreadId: null,
    forkState,
    sourceIntegrity: 'unverified',
    reason,
    detail: null,
    exitCode: null,
    stderrClass: 'none',
    durationMs: 0,
    ...over,
  }
}

function readDuration(deps: ForkDeps, startedAt: number): number {
  try {
    const now = deps.now()
    if (!Number.isFinite(now)) return 0
    const delta = now - startedAt
    return Number.isFinite(delta) && delta >= 0 ? delta : 0
  } catch {
    return 0
  }
}

function safeTerminate(deps: ForkDeps, child: AttachedChildProcess, signal: NodeJS.Signals): void {
  try {
    deps.terminate(child, signal)
  } catch {
    // A kill that fails changes nothing a caller can act on, and must never
    // replace the terminal result being assembled around it.
  }
}

function safeRelease(deps: ForkDeps, pid: number): void {
  try {
    deps.releaseSpawn(pid)
  } catch {
    // Same reasoning: a throwing release must not mask the fork's outcome.
  }
}

/** Read the source watermark, or null. Never throws. */
function readWatermark(deps: ForkDeps, provider: ForkProvider, threadId: string): string | null {
  const read = deps.sourceWatermark
  if (typeof read !== 'function') return null
  try {
    const value = read(provider, threadId)
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * Compare two watermark readings.
 *
 * A null at EITHER end is `unverified`, never `verified_unchanged`: "I could not
 * read it twice" is not "it did not change", and this feature has a documented
 * history of exactly that substitution.
 */
export function compareWatermarks(before: string | null, after: string | null): SourceIntegrity {
  if (before === null || after === null) return 'unverified'
  return before === after ? 'verified_unchanged' : 'mutated'
}

/**
 * Fork a native provider thread.
 *
 * Resolves; never rejects. A caller that must wrap this in try/catch to stay safe
 * is a caller that will one day forget, and the catch-all branch would be the one
 * place in the flow with no defined `forkState`.
 */
export async function forkThread(request: ForkRequest): Promise<ForkResult> {
  const deps = request?.deps
  if (!deps || typeof deps !== 'object') {
    return fail('fork_internal_error', 'none', { detail: 'deps_missing' })
  }
  for (const key of ['now', 'resolveBinary', 'spawn', 'processStartMs', 'recordSpawn', 'releaseSpawn', 'terminate'] as const) {
    if (typeof (deps as any)[key] !== 'function') {
      return fail('fork_internal_error', 'none', { detail: `dep_missing:${key}` })
    }
  }

  let startedAt = 0
  try {
    const t0 = deps.now()
    startedAt = Number.isFinite(t0) ? t0 : 0
  } catch {
    return fail('fork_internal_error', 'none', { detail: 'clock_failed' })
  }

  try {
    return await run(request, deps, startedAt)
  } catch {
    // Anything unforeseen resolves to a refusal, not a throw. `possible` rather
    // than `none`: a throw from an unknown point cannot prove no child ran, and
    // over-warning about an orphan costs a sentence while under-warning loses one.
    return fail('fork_internal_error', 'possible', {
      detail: 'unhandled',
      durationMs: readDuration(deps, startedAt),
    })
  }
}

async function run(request: ForkRequest, deps: ForkDeps, startedAt: number): Promise<ForkResult> {
  const duration = () => readDuration(deps, startedAt)

  // --- 1. Validate ------------------------------------------------------------
  if (!isForkableProvider(request.provider)) {
    return fail('invalid_provider', 'none', { durationMs: duration() })
  }
  const provider: ForkProvider = request.provider

  if (!isValidNativeThreadId(request.nativeThreadId)) {
    return fail('invalid_thread_id', 'none', { provider, durationMs: duration() })
  }
  const sourceNativeThreadId: string = request.nativeThreadId

  const base = { provider, sourceNativeThreadId }

  if (!isAttachedPermissionPolicy(request.policy)) {
    // Includes `undefined`. An omitted policy is not a request for the safest one;
    // it is a caller that has not decided.
    return fail('unsupported_policy', 'none', { ...base, durationMs: duration() })
  }

  if (typeof request.prompt !== 'string' || request.prompt.length === 0) {
    return fail('invalid_prompt', 'none', { ...base, detail: 'empty', durationMs: duration() })
  }
  if (request.prompt.length > MAX_PROMPT_CHARS) {
    return fail('invalid_prompt', 'none', { ...base, detail: 'too_long', durationMs: duration() })
  }
  const prompt: string = request.prompt

  if (typeof request.cwd !== 'string' || request.cwd.length === 0
    || !isAbsolute(request.cwd) || request.cwd.includes('\0')) {
    // A relative cwd resolves against the SERVER's working directory, so the
    // provider would fork into the wrong project while looking correct.
    return fail('invalid_cwd', 'none', { ...base, durationMs: duration() })
  }
  const cwd: string = request.cwd

  let timeoutMs = DEFAULT_ATTACHED_TIMEOUT_MS
  if (request.timeoutMs !== undefined) {
    if (typeof request.timeoutMs !== 'number' || !Number.isFinite(request.timeoutMs)
      || request.timeoutMs <= 0 || request.timeoutMs > MAX_ATTACHED_TIMEOUT_MS) {
      return fail('invalid_timeout', 'none', { ...base, durationMs: duration() })
    }
    timeoutMs = request.timeoutMs
  }

  // --- 2. Resolve the binary --------------------------------------------------
  // Imported resolution, so the stale-shim rejection is the SAME rule the attached
  // path uses. `codex` on PATH here names /Applications/Codex.app, which no longer
  // exists; a reinstall would put a real executable back on that dead path.
  let resolution: BinaryResolution
  try {
    resolution = deps.resolveBinary(provider)
  } catch {
    return fail('binary_not_found', 'none', {
      ...base, detail: `${provider}:resolver_failed`, durationMs: duration(),
    })
  }
  if (!resolution || typeof resolution !== 'object' || resolution.ok !== true) {
    const detail = resolution && typeof resolution === 'object' && resolution.ok === false
      ? `${resolution.binary}:${resolution.detail}`
      : `${provider}:unresolved`
    return fail('binary_not_found', 'none', { ...base, detail, durationMs: duration() })
  }
  if (typeof resolution.path !== 'string' || !isAbsolute(resolution.path)) {
    return fail('binary_not_found', 'none', {
      ...base, detail: `${provider}:not_absolute`, durationMs: duration(),
    })
  }
  const binaryPath = resolution.path

  // --- 3. Baseline for the property that makes fork safe ----------------------
  // Read BEFORE the spawn. A watermark taken afterwards proves nothing.
  const watermarkBefore = readWatermark(deps, provider, sourceNativeThreadId)

  // --- 4. Spawn ---------------------------------------------------------------
  let args: string[]
  try {
    args = (deps.buildArgs ?? buildForkArgs)(provider, sourceNativeThreadId, cwd)
  } catch {
    return fail('unsupported_policy', 'none', { ...base, detail: 'argv_build_failed', durationMs: duration() })
  }
  // Enforced against the argv that is about to be spawned, not against the source
  // that builds it, and after the injectable seam so a test can actually reach it.
  const bannedArg = findBannedPermissionArg(args)
  if (bannedArg !== null) {
    return fail('unsupported_policy', 'none', { ...base, detail: `banned_arg:${bannedArg}`, durationMs: duration() })
  }

  let child: AttachedChildProcess
  try {
    child = deps.spawn({ binaryPath, args, cwd, env: buildAttachedEnv() })
  } catch {
    // Includes ENOENT. No process exists, so no thread can have been created.
    return fail('spawn_failed', 'none', { ...base, detail: 'threw', durationMs: duration() })
  }
  if (!child || typeof child !== 'object' || typeof child.on !== 'function') {
    return fail('spawn_failed', 'none', { ...base, detail: 'no_child', durationMs: duration() })
  }

  const pid = child.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    // Node leaves `pid` undefined when the spawn itself failed. If a process does
    // exist behind an unusable pid we cannot record it, release it, or kill it on
    // timeout — so refuse rather than run blind.
    safeTerminate(deps, child, 'SIGKILL')
    return fail('spawn_failed', 'possible', { ...base, detail: 'no_pid', durationMs: duration() })
  }

  // --- 5. Claim the child, synchronously, before anything can observe it ------
  //
  // NO `await` between the spawn above and the record below, exactly as in the
  // attached adapter. `claude --resume <id> --fork-session` still RESUMES before it
  // forks, so while it runs there is a live process on this machine associated with
  // the SOURCE thread. Unless the ownership ledger already holds it, the next
  // occupancy scan reads our own child as a foreign desktop owner and the source
  // thread becomes permanently un-continuable — a fork that silently disables
  // Continue for the thread it forked from. `processStartMs` is synchronous
  // (execFileSync) precisely so this chain can hold with no await in it.
  let claimed = false
  let claimDetail = 'unknown'
  try {
    const startMs = deps.processStartMs(pid)
    if (typeof startMs === 'number' && Number.isFinite(startMs) && startMs > 0) {
      const outcome = deps.recordSpawn(pid, startMs)
      claimed = outcome === 'recorded'
      claimDetail = typeof outcome === 'string' ? outcome : 'non_string_outcome'
    } else {
      claimDetail = 'start_unavailable'
    }
  } catch {
    claimed = false
    claimDetail = 'threw'
  }

  if (!claimed) {
    safeTerminate(deps, child, 'SIGKILL')
    safeRelease(deps, pid)
    return fail('ownership_record_failed', 'none', {
      ...base, detail: claimDetail, durationMs: duration(),
    })
  }

  let outcome: ForkResult
  try {
    outcome = await driveChild({ child, deps, provider, sourceNativeThreadId, prompt, timeoutMs, startedAt })
  } finally {
    // EVERY path: success, mismatch, non-zero exit, timeout, throw. A leaked entry
    // outlives the process and lets a RECYCLED pid inherit our self-ownership
    // claim, which is the one input that can turn a live foreign owner into
    // `attachable`.
    safeRelease(deps, pid)
  }

  // --- 6. Did the source move? ------------------------------------------------
  const watermarkAfter = readWatermark(deps, provider, sourceNativeThreadId)
  const integrity = compareWatermarks(watermarkBefore, watermarkAfter)

  if (integrity === 'mutated') {
    // Positive evidence that the thing fork promises not to do, happened. It
    // outranks whatever else the run reported, and a success becomes a failure:
    // the caller must not present this as a clean fork, and the user needs to open
    // the original and look. The prior reason is preserved in `detail` so the
    // diagnosis is not lost.
    const priorReason = outcome.ok ? 'ok' : outcome.reason
    return {
      ok: false,
      provider,
      sourceNativeThreadId,
      newNativeThreadId: outcome.newNativeThreadId,
      forkState: outcome.forkState,
      sourceIntegrity: 'mutated',
      reason: 'source_thread_mutated',
      detail: `after:${priorReason}`,
      exitCode: outcome.exitCode,
      stderrClass: outcome.ok ? 'none' : outcome.stderrClass,
      durationMs: outcome.durationMs,
    }
  }

  if (outcome.ok) return { ...outcome, sourceIntegrity: integrity === 'verified_unchanged' ? 'verified_unchanged' : 'unverified' }
  return { ...outcome, sourceIntegrity: integrity }
}

interface DriveInput {
  child: AttachedChildProcess
  deps: ForkDeps
  provider: ForkProvider
  sourceNativeThreadId: string
  prompt: string
  timeoutMs: number
  startedAt: number
}

function driveChild(input: DriveInput): Promise<ForkResult> {
  const { child, deps, provider, sourceNativeThreadId, prompt, timeoutMs, startedAt } = input

  return new Promise<ForkResult>((resolve) => {
    const observedIds: string[] = []
    let stdoutTail = ''
    let scannedBytes = 0
    let stderrSample = ''
    let forkState: ForkState = 'none'
    let exitCode: number | null = null
    let settled = false
    let timedOut = false
    let spawnErrored = false

    let deadline: ReturnType<typeof setTimeout> | null = null
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    let forceTimer: ReturnType<typeof setTimeout> | null = null

    const clearTimers = () => {
      if (deadline) { clearTimeout(deadline); deadline = null }
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null }
      if (forceTimer) { clearTimeout(forceTimer); forceTimer = null }
    }

    const duration = () => readDuration(deps, startedAt)

    const settle = (result: ForkResult) => {
      if (settled) return
      settled = true
      clearTimers()
      resolve(result)
    }

    const settleFailure = (reason: ForkFailure, over: Partial<ForkFailureResult> = {}) => {
      settle(fail(reason, forkState, {
        provider,
        sourceNativeThreadId,
        exitCode,
        stderrClass: classifyStderr(stderrSample),
        durationMs: duration(),
        ...over,
      }))
    }

    const consumeStdout = (chunk: any) => {
      try {
        if (scannedBytes >= MAX_STDOUT_SCAN_BYTES) return
        const text = typeof chunk === 'string' ? chunk : String(chunk)
        scannedBytes += text.length
        stdoutTail += text
        const lines = stdoutTail.split('\n')
        stdoutTail = lines.pop() ?? ''
        // Bound the carry-over so a provider emitting one enormous line cannot grow
        // this without limit.
        if (stdoutTail.length > 1_000_000) stdoutTail = ''
        for (const line of lines) {
          for (const id of extractNativeIdsFromLine(line)) {
            if (!observedIds.includes(id)) observedIds.push(id)
          }
        }
        // Deliberately nothing else: no text, no tool calls, no transcript. This
        // module cannot leak what it never held.
      } catch {
        // Losing id evidence ends as a refusal, which is the safe direction.
      }
    }

    const consumeStderr = (chunk: any) => {
      try {
        if (stderrSample.length >= 4_096) return
        const text = typeof chunk === 'string' ? chunk : String(chunk)
        stderrSample = (stderrSample + text).slice(0, 4_096)
      } catch {
        /* classification degrades to 'unclassified'; nothing else depends on it */
      }
    }

    const finishTerminal = () => {
      // Drain whatever sat in the trailing partial line before judging. A provider
      // that never emits a final newline would otherwise have its only id thrown
      // away, turning a good fork into `no_native_id_returned`.
      if (stdoutTail.length > 0) {
        for (const id of extractNativeIdsFromLine(stdoutTail)) {
          if (!observedIds.includes(id)) observedIds.push(id)
        }
        stdoutTail = ''
      }

      if (timedOut) return settleFailure('timeout')
      if (spawnErrored) return settleFailure('spawn_failed', { detail: 'child_error' })
      if (exitCode !== 0) return settleFailure('provider_exit_nonzero')

      const verdict = selectForkedId(observedIds, sourceNativeThreadId)
      if (!verdict.ok) {
        return settleFailure(verdict.reason, {
          // Carried so an orphan created by an ambiguous run can still be found.
          // NOT carried for `fork_returned_source_id`: that id is the SOURCE, and
          // reporting the user's own live thread in a field named "new" is exactly
          // the confusion that gets something bound to it.
          newNativeThreadId: verdict.reason === 'fork_returned_source_id' ? null : verdict.observed,
          detail: verdict.reason === 'fork_returned_source_id' ? 'append_not_fork' : null,
        })
      }

      if (forkState !== 'possible') {
        // Exit 0 with a usable new id but no prompt ever written is incoherent.
        return settleFailure('fork_internal_error', { detail: 'no_prompt_written' })
      }

      settle({
        ok: true,
        provider,
        sourceNativeThreadId,
        newNativeThreadId: verdict.newNativeThreadId,
        forkState: 'created',
        // Overwritten by the caller once the after-watermark is read. Never
        // upgraded here — this function has no second reading to compare.
        sourceIntegrity: 'unverified',
        reason: null,
        exitCode: 0,
        durationMs: duration(),
      })
    }

    // --- wire the child ------------------------------------------------------
    try {
      child.stdout?.on('data', consumeStdout)
      child.stderr?.on('data', consumeStderr)
      child.stdout?.on('error', () => { /* stream errors surface via close/exit */ })
      child.stderr?.on('error', () => { /* ditto */ })

      child.on('error', () => {
        spawnErrored = true
        finishTerminal()
      })
      child.on('exit', (code: number | null) => {
        if (typeof code === 'number') exitCode = code
      })
      child.on('close', (code: number | null) => {
        if (typeof code === 'number') exitCode = code
        finishTerminal()
      })
    } catch {
      safeTerminate(deps, child, 'SIGKILL')
      return settleFailure('fork_internal_error', { detail: 'wire_failed' })
    }

    // --- bounded budget ------------------------------------------------------
    deadline = setTimeout(() => {
      timedOut = true
      safeTerminate(deps, child, 'SIGTERM')
      graceTimer = setTimeout(() => {
        safeTerminate(deps, child, 'SIGKILL')
        forceTimer = setTimeout(() => {
          // A child that survived SIGKILL cannot be reached from here, and blocking
          // forever would wedge the caller and any COS Control drain behind it.
          settleFailure('timeout', { detail: 'unreaped' })
        }, FORCE_SETTLE_MS)
      }, KILL_GRACE_MS)
    }, timeoutMs)

    // --- hand over the prompt ------------------------------------------------
    const stdin = child.stdin
    if (!stdin || typeof stdin.write !== 'function' || typeof stdin.end !== 'function' || !child.stdout) {
      // No way to send the prompt, or no way to observe the id we must verify.
      safeTerminate(deps, child, 'SIGKILL')
      return settleFailure('child_stdio_unavailable', {
        detail: stdin ? 'stdout_missing' : 'stdin_missing',
      })
    }

    try {
      stdin.on('error', () => { /* reported through close/exit; never fatal here */ })
    } catch {
      /* an stdin that cannot take a listener still gets the write attempt below */
    }

    try {
      // From here a fork may exist even if we never learn its id.
      forkState = 'possible'
      stdin.write(prompt)
      // ALWAYS ended. The codex CLI reads stdin regardless of whether a prompt
      // argument was supplied, so an unclosed pipe leaves the child waiting for EOF
      // until the timeout kills it — which reads as a provider hang.
      stdin.end()
    } catch {
      safeTerminate(deps, child, 'SIGKILL')
      return settleFailure('child_stdio_unavailable', { detail: 'write_failed' })
    }
  })
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/**
 * The real dependency set.
 *
 * `sourceWatermark` has no default and should always be supplied by the caller —
 * it needs `nativeHead`'s dependency shape, which belongs to the route, and a
 * default here would be a placeholder that reports `unverified` forever while
 * looking wired.
 */
export function realForkDeps(
  sourceWatermark?: (provider: ForkProvider, nativeThreadId: string) => string | null,
): ForkDeps {
  return {
    now: () => Date.now(),
    resolveBinary: provider => resolveProviderBinary(provider),
    spawn: request => nodeSpawn(request.binaryPath, [...request.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: request.cwd,
      env: request.env,
      // Group leader, so the whole provider tree can be signalled on timeout.
      detached: true,
    }) as unknown as AttachedChildProcess,
    processStartMs: pid => realProcessStartMs(pid),
    recordSpawn: (pid, startMs) => recordCosSpawn(pid, startMs),
    releaseSpawn: pid => releaseCosSpawn(pid),
    terminate: (child, signal) => {
      const pid = child.pid
      if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
        try {
          // Negative pid = process group, reachable because we spawned detached.
          process.kill(-pid, signal)
          return
        } catch {
          /* fall through to the direct signal */
        }
      }
      try {
        ;(child as any).kill?.(signal)
      } catch {
        /* nothing further is available */
      }
    },
    ...(sourceWatermark ? { sourceWatermark } : {}),
  }
}
