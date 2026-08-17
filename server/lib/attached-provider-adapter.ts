// The attached execution path: append ONE turn to a real desktop agent thread.
//
// This is the module that actually writes into a human being's live-history
// conversation. Everything else in this feature decides whether we are allowed
// to; this is the part that does it. So the bias here is absolute: every
// unknown, every throw, every value we cannot positively establish resolves to
// refusing the turn. A refused turn costs the user one Fork. A wrong turn puts
// words into a conversation they own.
//
// WHY THIS IS A SEPARATE MODULE AND NOT AN OPTION ON THE BRIDGES.
// `claude-bridge.ts` and `codex-bridge.ts` are the ordinary COS path and must
// stay byte-for-byte identical — plan 4.2 forbids the attached path from
// inheriting COS history formatting, COS system-prompt construction, pre-warm
// adoption, engine-session mapping, or provider fallback, and an `if
// (attached)` branch inside a 1000-line bridge is a promise, not a guarantee.
// A separate file makes the bypass structural and makes rollback one file.
// Nothing here imports either bridge.
//
// WHAT IS SENT: the prompt bytes, on stdin, unmodified. Nothing else. No system
// prompt, no history prefix, no capability preamble, no attachment block. A
// test asserts the stdin bytes equal the prompt exactly, because "bypasses COS
// formatting" is only true if the wire says so.
//
// THE ORDERING PROBLEM, WHICH IS THE WHOLE POINT OF THIS FILE (plan 4.4).
// When we spawn `claude --resume <targetId>`, that child registers ITSELF in
// `~/.claude/sessions/<pid>.json` carrying the SAME sessionId we are targeting.
// From the next occupancy scan's point of view our own child is a live foreign
// owner of the thread, and the thread becomes permanently unattachable — the
// second turn on any thread refuses forever, and it looks exactly like a
// detector bug. The ownership ledger is the only thing that tells the two
// apart, so the record must be in place before anything can look:
//
//     preflight -> spawn -> processStartMs(pid) -> recordSpawn(pid, start)
//
// with NO await anywhere in that chain. `processStartMs` is synchronous
// (execFileSync) precisely so this can hold. A single `await` inserted between
// spawn and record lets a queued microtask observe the child as foreign, and
// `records the child before any queued microtask can observe the ledger` is the
// test that catches it.
//
// AND THE START TIME MUST BE MEASURED, NOT ASSUMED. `recordSpawn` takes
// `processStartMs(child.pid)`, never `Date.now()`. Measured n=14 on 2026-08-15:
// the probe agrees with the kernel reading exactly (0ms), while `Date.now()` at
// the spawn call is off by 2-992ms because the kernel value is truncated to the
// second. `PROC_START_TOLERANCE_MS` is 1500, so `Date.now()` leaves ~508ms of
// headroom, and a `claude` spawn under load eats it. When it does, every
// COS-spawned owner reads as a foreign desktop process and self-identification
// silently stops working.
//
// DELIVERY STATE IS NOT THE SAME QUESTION AS SUCCESS (plan 4.6 item 4).
// "Did it fail?" and "might the turn have landed anyway?" are independent, and
// conflating them produces the worst UX in the feature: either every missing
// CLI shows the scary "your thread may contain this turn" warning until the
// user learns to ignore it, or a turn that really did land is reported as a
// clean failure and gets replayed. So the boundary is drawn at one provable
// event — the first byte we hand to the child's stdin:
//
//   not_attempted  no child process was ever created
//   aborted        a child existed, we terminated it, no prompt byte was written
//   ambiguous      we called write(); we cannot prove the provider did not act
//   delivered      clean exit 0 AND the provider echoed our exact target id
//
// Only the first two are provably safe to report as a clean failure.
// `attachedDeliveryAmbiguous` makes that mapping total, and treats any state it
// does not recognise as ambiguous, so adding a state later cannot silently open
// the replay path.
//
// FOUR THINGS THAT LOOK SAFE AND ARE NOT:
//
//  1. "the provider returned an id, so it appended to our thread." Only if it
//     is OUR id and it is the ONLY one. A provider that forks emits a different
//     id; a provider that forks and also mentions the old one emits two. Both
//     are failures. Matching "any observed id" would pass the second case.
//  2. "scan stdout for the target UUID." A model can echo a UUID in prose. Ids
//     are read from KNOWN TOP-LEVEL FIELDS of parsed JSON lines only. Assistant
//     text lives inside a string field and can never be mistaken for one.
//  3. "`codex` on PATH is the codex binary." On this machine it is a stale
//     shim naming `/Applications/Codex.app`, which no longer exists; the real
//     binary is inside ChatGPT.app. And a GUI/launchd-spawned server has no
//     login PATH at all, so bare-name spawning is a coin flip. Resolution
//     always produces a verified absolute path or refuses.
//  4. "release the ledger entry when the child exits cleanly." Every path must
//     release — timeout, throw, kill, mismatch. A leaked entry outlives the
//     process and lets a RECYCLED pid inherit our self-ownership claim, which
//     is the one input that can turn a live foreign owner into `attachable`.

import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { spawn as nodeSpawn } from 'node:child_process'

import { isValidNativeThreadId } from './native-thread-id.js'
import { isBindableProvider, type BindableProvider } from './agent-session-binding-store.js'
import { recordCosSpawn, releaseCosSpawn } from './agent-session-ownership-store.js'
import { processStartMs as realProcessStartMs } from './occupancy-probes.js'
import { getCodexTrustMode } from './codex-run-ledger.js'

/** Providers with a certified attached path. Cursor is Fork-only (plan 2.5). */
export type AttachedProvider = BindableProvider

/**
 * Protocol 1 ships text-only read-only continuation (plan 4.7). The type has
 * one member on purpose: `agent` is not "not implemented yet", it is a value
 * this module must refuse until Control gates it per binding.
 */
export type AttachedPermissionPolicy = 'read_only'

export function isAttachedPermissionPolicy(value: unknown): value is AttachedPermissionPolicy {
  return value === 'read_only'
}

/**
 * Flags that must never reach a provider that is about to write into someone's
 * real conversation (plan 4.7: no always-approve, bypass-permissions,
 * danger-full-access, force, or yolo behavior).
 *
 * Exported so the assertion can be made against the argv that is actually
 * spawned rather than against the source that builds it.
 */
export const BANNED_PERMISSION_ARGS: readonly string[] = [
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--full-auto',
  '--yolo',
  '--force',
  'danger-full-access',
  'bypassPermissions',
  'acceptEdits',
]

/** Terminal reason on failure. Never carries prompt or transcript text. */
export type AttachedTurnFailure =
  | 'invalid_provider'
  | 'invalid_thread_id'
  | 'invalid_prompt'
  | 'invalid_cwd'
  | 'invalid_timeout'
  | 'unsupported_policy'
  | 'native_owner_appeared'
  | 'preflight_failed'
  | 'binary_not_found'
  | 'spawn_failed'
  | 'ownership_record_failed'
  | 'child_stdio_unavailable'
  | 'timeout'
  | 'provider_exit_nonzero'
  | 'no_native_id_returned'
  | 'native_id_mismatch'
  | 'adapter_internal_error'

/** See the header. The boundary is the first byte handed to the child's stdin. */
export type AttachedDeliveryState = 'not_attempted' | 'aborted' | 'ambiguous' | 'delivered'

/**
 * Bounded classification of a provider's stderr.
 *
 * The raw text never leaves this module: a provider is free to echo the prompt
 * back in an error message, and an error string is exactly the value that ends
 * up in a log, a journal row, and a support paste. These literals come from
 * this file, so no provider output can travel inside one.
 */
export type AttachedStderrClass =
  | 'none'
  | 'auth'
  | 'thread_not_found'
  | 'permission'
  | 'rate_limit'
  | 'unclassified'

export interface AttachedTurnSuccess {
  ok: true
  provider: AttachedProvider
  nativeThreadId: string
  /** The id the provider echoed. Equal to `nativeThreadId` by construction. */
  returnedNativeId: string
  delivery: 'delivered'
  reason: null
  exitCode: number
  durationMs: number
}

export interface AttachedTurnFailureResult {
  ok: false
  provider: AttachedProvider | null
  nativeThreadId: string | null
  /** Null when the provider never echoed a usable id. */
  returnedNativeId: string | null
  delivery: AttachedDeliveryState
  reason: AttachedTurnFailure
  /**
   * A bounded, self-authored discriminator. Enum-like strings and identifiers
   * only — never provider output, never prompt text.
   */
  detail: string | null
  exitCode: number | null
  stderrClass: AttachedStderrClass
  durationMs: number
}

export type AttachedTurnResult = AttachedTurnSuccess | AttachedTurnFailureResult

/**
 * Whether a caller must treat the turn as possibly-landed (plan 4.6 item 1:
 * `deliveryAmbiguous: true` alongside `status: 'failed'`).
 *
 * Written as "ambiguous unless proven otherwise" rather than an equality test,
 * so a delivery state added later defaults to fenced instead of replayable.
 */
export function attachedDeliveryAmbiguous(result: AttachedTurnResult): boolean {
  if (result.ok) return false
  return result.delivery !== 'not_attempted' && result.delivery !== 'aborted'
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

export type BinaryResolutionFailure = 'env_override_unusable' | 'not_found'

export type BinaryResolution =
  | { ok: true; path: string; source: 'env' | 'absolute' | 'path' }
  | { ok: false; binary: string; detail: BinaryResolutionFailure }

/**
 * Path prefixes that can never be a usable provider binary.
 *
 * `codex` resolved through PATH (or a shell alias) points at
 * `/Applications/Codex.app/Contents/Resources/codex` on this machine, and that
 * app no longer exists. Today the shim is dangling, so an existence check
 * already rejects it — but a reinstalled or partially-removed Codex.app puts a
 * real, executable file back on that path, and then only this list stands
 * between an attached turn and a binary that cannot serve it.
 */
export const STALE_SHIM_PREFIXES: readonly string[] = ['/Applications/Codex.app/']

export function isKnownStaleShimPath(
  candidate: string,
  prefixes: readonly string[] = STALE_SHIM_PREFIXES,
): boolean {
  // A non-array argument falls back to the known list rather than to "exclude
  // nothing" — the classic version of this bug is `list.some(isKnownStaleShimPath)`,
  // where `.some` passes the INDEX as the second argument and every exclusion
  // silently disappears.
  const list = Array.isArray(prefixes) ? prefixes : STALE_SHIM_PREFIXES
  return list.some(prefix => typeof prefix === 'string' && prefix.length > 0 && candidate.startsWith(prefix))
}

function isUsableExecutable(
  candidate: string,
  excludePrefixes: readonly string[] = STALE_SHIM_PREFIXES,
): boolean {
  try {
    if (!isAbsolute(candidate) || candidate.includes('\0')) return false
    if (isKnownStaleShimPath(candidate, excludePrefixes)) return false
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface BinarySpec {
  name: string
  envKeys: readonly string[]
  /** Tried in order, BEFORE any PATH scan. */
  absolutes: readonly string[]
  /**
   * Paths that must never be selected, from any source. Defaults to
   * `STALE_SHIM_PREFIXES`.
   *
   * On the spec rather than hardcoded because the exclusion is the only guard
   * standing between resolution and a known-bad binary, and a guard whose input
   * cannot be constructed is a guard nobody can prove works: the real prefix
   * lives under `/Applications`, which no fixture can write to.
   */
  excludePrefixes?: readonly string[]
}

/**
 * Where each provider's binary is looked for, in precedence order.
 *
 * Exported as data rather than kept private so the precedence itself is
 * testable: on a machine where a stale shim sits on PATH, "ChatGPT.app is tried
 * before PATH" is the property that decides whether an attached Codex turn
 * launches the real binary or a dangling one.
 */
export function providerBinarySpec(provider: AttachedProvider): BinarySpec {
  const home = (() => {
    try {
      return homedir()
    } catch {
      return ''
    }
  })()
  if (provider === 'claude') {
    return {
      name: 'claude',
      envKeys: ['COS_ATTACHED_CLAUDE_BIN', 'COS_CLAUDE_BIN'],
      absolutes: [
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        home ? join(home, '.local', 'bin', 'claude') : '',
      ].filter(Boolean),
    }
  }
  return {
    name: 'codex',
    envKeys: ['COS_ATTACHED_CODEX_BIN', 'COS_CODEX_BIN'],
    absolutes: [
      // Verified 2026-08-15: codex-cli 0.148.0-alpha.9 lives here, and there is
      // no `codex` on PATH at all on this machine.
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      home ? join(home, '.codex', 'bin', 'codex') : '',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ].filter(Boolean),
  }
}

/**
 * Resolve a provider binary to a verified absolute path, or refuse.
 *
 * Never returns a bare name. A bare name is a silent PATH lookup, and the two
 * environments this server runs in disagree about PATH: a login shell finds the
 * CLI, a Finder- or launchd-spawned process gets a minimal PATH and does not
 * (hit twice in COS Control). The PATH scan below is done by us, entry by
 * entry, and still yields an absolute path we have stat'ed — so a failure names
 * the missing binary instead of surfacing as ENOENT from inside a spawn.
 *
 * An unusable env override REFUSES rather than falling through to the
 * candidates: an operator who set it wrongly needs to be told, not overridden.
 */
export function resolveProviderBinary(
  provider: AttachedProvider,
  env: NodeJS.ProcessEnv = process.env,
): BinaryResolution {
  return resolveBinaryFromSpec(providerBinarySpec(provider), env)
}

/**
 * The resolution algorithm itself, separated from the provider tables.
 *
 * Not a testing seam bolted on: on any developer machine at least one real
 * absolute candidate exists, so the PATH-scan and not-found branches of
 * `resolveProviderBinary` are unreachable from a test and would ship
 * unexercised — which is exactly how a launchd-only failure hides. Driving the
 * REAL algorithm with a fixture spec exercises them for real.
 */
export function resolveBinaryFromSpec(spec: BinarySpec, env: NodeJS.ProcessEnv): BinaryResolution {
  const excluded = spec.excludePrefixes ?? STALE_SHIM_PREFIXES

  for (const key of spec.envKeys) {
    const raw = env[key]
    if (typeof raw !== 'string' || raw.trim().length === 0) continue
    const candidate = raw.trim()
    if (!isUsableExecutable(candidate, excluded)) {
      return { ok: false, binary: spec.name, detail: 'env_override_unusable' }
    }
    return { ok: true, path: candidate, source: 'env' }
  }

  for (const candidate of spec.absolutes) {
    if (isUsableExecutable(candidate, excluded)) return { ok: true, path: candidate, source: 'absolute' }
  }

  const pathValue = typeof env.PATH === 'string' ? env.PATH : ''
  for (const dir of pathValue.split(delimiter)) {
    // A relative PATH entry resolves against the server's cwd, which is not a
    // location we control. Skipped rather than resolved.
    //
    // Redundant with the `isAbsolute` inside `isUsableExecutable` — verified by
    // mutation: removing EITHER one alone changes no outcome, and only removing
    // BOTH lets a relative entry through. Kept because two independent guards
    // on "never resolve against the server cwd" is the correct amount for a
    // path that ends up as a spawned executable.
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, spec.name)
    if (isUsableExecutable(candidate, excluded)) return { ok: true, path: candidate, source: 'path' }
  }

  return { ok: false, binary: spec.name, detail: 'not_found' }
}

// ---------------------------------------------------------------------------
// Injected surface
// ---------------------------------------------------------------------------

export interface AttachedChildStream {
  on(event: 'data' | 'error', listener: (chunk: any) => void): unknown
}

export interface AttachedChildStdin {
  write(chunk: string, cb?: (error?: Error | null) => void): boolean
  end(): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * The minimum of `ChildProcess` this module uses. Narrow on purpose: a test
 * double should not have to fake a whole ChildProcess, and a narrow surface is
 * a list of exactly what the adapter is allowed to touch.
 */
export interface AttachedChildProcess {
  pid?: number
  stdin: AttachedChildStdin | null
  stdout: AttachedChildStream | null
  stderr: AttachedChildStream | null
  on(event: 'error' | 'close' | 'exit', listener: (...args: any[]) => void): unknown
}

export interface AttachedSpawnRequest {
  binaryPath: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/** Result of the final occupancy re-check (plan 4.3 step 6). */
export interface AttachedPreflightVerdict {
  attachable: boolean
  reason: string | null
}

/**
 * Every dependency is REQUIRED and none has a default.
 *
 * A default is how a fail-open ships: an omitted ownership ledger that silently
 * no-ops leaves our own child looking foreign forever, and an omitted preflight
 * that defaults to "go ahead" removes the last barrier before we write into a
 * live thread. Making them required turns each omission into a compile error.
 */
export interface AttachedTurnDeps {
  /** Epoch ms. */
  now: () => number
  /**
   * The final occupancy re-check, run synchronously immediately before spawn.
   *
   * Synchronous on purpose: awaiting it would reopen the window it exists to
   * close, and a promise is not a verdict — a returned thenable is refused
   * rather than awaited, because `(await p).attachable` is a check this module
   * would not have performed.
   */
  preflight: () => AttachedPreflightVerdict
  resolveBinary: (provider: AttachedProvider) => BinaryResolution
  spawn: (request: AttachedSpawnRequest) => AttachedChildProcess
  /** MUST be the measured kernel start. See the header. */
  processStartMs: (pid: number) => number | null
  recordSpawn: (pid: number, startMs: number) => string
  releaseSpawn: (pid: number) => unknown
  /**
   * Terminate the child. Injected rather than defaulted so a unit test can
   * never reach `process.kill(-pid)` with a fabricated pid and signal a real
   * process group on the developer's machine.
   */
  terminate: (child: AttachedChildProcess, signal: NodeJS.Signals) => void
  /**
   * Argv builder. Optional, defaults to the real one.
   *
   * Exists ONLY so a test can hand back an argv carrying a banned permission flag
   * and prove the turn is refused with zero spawns. Production never sets it.
   */
  buildArgs?: (provider: AttachedProvider, nativeThreadId: string, cwd: string) => string[]
  /**
   * A PASSIVE reader of the child's stdout. Optional; omitted changes nothing.
   *
   * The turn already spawns with `--output-format stream-json --verbose`, and this
   * module reads that stream for exactly one thing: proving the returned session id
   * matches the target. Everything else is discarded. This hook is how the live view
   * gets a copy without that scan being touched.
   *
   * IT IS AN OBSERVER AND IS TREATED AS ONE. Registered as a SECOND `data` listener,
   * AFTER the scanner, so the scanner runs first on every chunk. It shares no state
   * with the scanner, it cannot influence any outcome, and a throw from it is caught
   * and dropped rather than reaching `emit()` where it would starve the listener that
   * matters. When absent, no second listener is registered at all, which is byte for
   * byte the behaviour every existing caller and test already has.
   *
   * DELIBERATELY NOT A TRANSFORM. It returns nothing, so there is no shape in which a
   * future edit can let it modify what the scan sees.
   */
  observeStdout?: (chunk: string) => void
}

export interface AttachedTurnRequest {
  provider: unknown
  nativeThreadId: unknown
  prompt: unknown
  cwd: unknown
  policy: unknown
  deps: AttachedTurnDeps
  /** Wall-clock budget for the provider run. Omitted uses the default. */
  timeoutMs?: number
}

/**
 * Default provider budget.
 *
 * Matches the coordinator's 21-minute `providerTimeoutMs`, so an attached turn
 * cannot outlive the job that owns it and strand the native target reservation.
 */
export const DEFAULT_ATTACHED_TIMEOUT_MS = 21 * 60_000

/** Anything longer would outlive the reservation lifecycle it runs inside. */
export const MAX_ATTACHED_TIMEOUT_MS = 30 * 60_000

/** SIGTERM first; this is how long the child gets before SIGKILL. */
export const KILL_GRACE_MS = 2_000

/**
 * Last-resort settle after SIGKILL.
 *
 * A child that survives SIGKILL is not reachable by any means available here,
 * and blocking forever would wedge the coordinator and, through it, a COS
 * Control drain. Settling releases the ledger entry while a process may still
 * live, which makes our own child read as foreign on the next scan — Fork-only,
 * the safe direction.
 */
export const FORCE_SETTLE_MS = 2_000

/**
 * Prompt ceiling. Generous — this is a guard against a pathological or
 * corrupted value reaching a pipe, not a product limit.
 */
export const MAX_PROMPT_CHARS = 200_000

/** Stop scanning stdout for ids past this. Nothing is retained either way. */
export const MAX_STDOUT_SCAN_BYTES = 4 * 1024 * 1024

/** Stderr is classified, never stored. This bounds the classification input. */
const MAX_STDERR_CLASSIFY_CHARS = 4_096

/**
 * Environment keys stripped from the child.
 *
 * `CLAUDECODE` matches the ordinary bridges: without stripping it, a spawned
 * `claude` believes it is nested. `COS_API_TOKEN` is ours and the child has no
 * use for it; an attached run drives a model inside someone's real thread, and
 * the token should not be one prompt away from being readable.
 *
 * Deliberately does NOT strip provider credentials (ANTHROPIC_*, OPENAI_*):
 * those are how the CLI authenticates, and removing them would break the run.
 */
const STRIPPED_ENV_KEYS: readonly string[] = ['CLAUDECODE', 'COS_API_TOKEN']

// ---------------------------------------------------------------------------
// Argv construction
// ---------------------------------------------------------------------------

/**
 * Claude: `claude -p --resume <id>`, prompt on stdin.
 *
 * The prompt is NOT an argv element. argv is world-readable through `ps`, and
 * the prompt is the user's private text; stdin also matches what both ordinary
 * bridges already do.
 *
 * THE TURN INHERITS THE SESSION'S OWN PERMISSIONS (Miles, 2026-08-16, explicit).
 *
 * This used to force two independent read-only layers: `--permission-mode plan`
 * plus an empty `--tools`/`--allowedTools` pair. The result was a Continue that
 * could talk into a thread and do nothing in it -- his first real continued turn
 * came back reporting that every tool was disabled, which is not "like being at
 * the desk". Both layers are gone; a resumed turn now runs as that session
 * ordinarily would.
 *
 * What that means plainly: a prompt spoken into a pair of glasses can run tools
 * on this Mac with nobody at the keyboard. That is the intent, not an oversight.
 * The protections that remain, and that must not be quietly removed with it:
 *
 *   1. `COS_THREAD_ATTACH_ENABLED` still gates the whole surface, and off means
 *      the write routes are never registered.
 *   2. `findBannedPermissionArg` still runs at the spawn boundary and still
 *      rejects the actual bypasses -- `--dangerously-skip-permissions`, `--yolo`,
 *      `danger-full-access` and the rest. Dropping a lockdown is not the same as
 *      adding a bypass, and the bypass ban is unchanged.
 *   3. The menu cursor rests on a row that cannot act, so a false-positive ring
 *      tap cannot reach Continue (`defaultSessionThreadActionIndex`).
 *   4. Delivery is still gated on a fresh occupancy probe, the epoch floor, the
 *      per-target claim and the head watermark.
 */
export function buildClaudeAttachedArgs(nativeThreadId: string): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    // stream-json requires --verbose; without it the CLI refuses and we would
    // never observe the session id we are required to verify.
    '--verbose',
    '--resume', nativeThreadId,
  ]
}

/**
 * Codex: `codex exec -s read-only -C <cwd> resume --json <id> -`.
 *
 * Verified against codex-cli 0.148.0-alpha.9 on 2026-08-15:
 * `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`. `--sandbox` and `--cd`
 * are options of `exec` and must precede the `resume` subcommand; `--json` and
 * `--skip-git-repo-check` belong to `resume`; and NOTHING may follow the
 * positionals. The trailing `-` is the documented "read the prompt from stdin"
 * form, which keeps the prompt out of argv.
 *
 * `--ephemeral` is deliberately absent: the whole point is that the turn
 * persists into the user's rollout.
 */
export function buildCodexAttachedArgs(nativeThreadId: string, cwd: string): string[] {
  return [
    'exec',
    // The posture ordinary Codex runs use on this host, not a stricter one
    // invented here. `COS_CODEX_SANDBOX=workspace-write` opts in; absent stays
    // read-only, so this is never MORE permissive than the rest of the server.
    '--sandbox', getCodexTrustMode(),
    '--cd', cwd,
    'resume',
    '--json',
    '--skip-git-repo-check',
    nativeThreadId,
    '-',
  ]
}

/**
 * Is this argv free of every flag plan 4.7 bans?
 *
 * Substring, not equality: a banned token can arrive attached to its value
 * (`--permission-mode=bypassPermissions`, `--sandbox danger-full-access`), and an
 * equality check would wave those through while looking correct.
 */
export function findBannedPermissionArg(args: readonly string[]): string | null {
  for (const arg of args) {
    const value = String(arg)
    for (const banned of BANNED_PERMISSION_ARGS) {
      if (value.includes(banned)) return banned
    }
  }
  return null
}

/**
 * Build the argv, and REFUSE to hand back one carrying a banned flag.
 *
 * `BANNED_PERMISSION_ARGS` existed, was exported, was asserted in a test — and
 * had no runtime consumer at all, so a test was the only thing standing between
 * plan 4.7 and an always-approve flag reaching a provider that is about to write
 * into a real human's conversation. A test protects the argv this build happens
 * to produce; it cannot protect the argv a future edit produces.
 *
 * Enforced HERE because it is the one point both providers pass through, so a new
 * provider inherits the check rather than needing to remember it. Throws rather
 * than returning a sentinel: there is no safe degraded argv, and the caller's
 * outer catch already maps a throw to a terminal refusal before any spawn.
 */
function buildArgs(provider: AttachedProvider, nativeThreadId: string, cwd: string): string[] {
  const args = provider === 'claude'
    ? buildClaudeAttachedArgs(nativeThreadId)
    : buildCodexAttachedArgs(nativeThreadId, cwd)
  const banned = findBannedPermissionArg(args)
  if (banned !== null) {
    // The flag name only. Never the argv, which carries the thread id and cwd.
    throw new Error(`attached argv carries a banned permission flag: ${banned}`)
  }
  return args
}

export function buildAttachedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of STRIPPED_ENV_KEYS) delete env[key]
  return env
}

// ---------------------------------------------------------------------------
// Output reading
// ---------------------------------------------------------------------------

/**
 * Ids observed on one NDJSON line, read from known top-level fields only.
 *
 * Never a regex over raw text. A model can print a UUID in its answer, and a
 * scan that cannot tell an id field from prose would either invent a mismatch
 * or — far worse — accept an echoed target id from a run that actually forked.
 * Assistant text always arrives inside a string field, so field-scoped reading
 * makes that collision unrepresentable.
 */
export function extractNativeIdsFromLine(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return []
  let event: any
  try {
    event = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return []

  const found: string[] = []
  const consider = (value: unknown) => {
    if (isValidNativeThreadId(value) && !found.includes(value)) found.push(value)
  }

  consider(event.session_id)
  consider(event.sessionId)
  consider(event.thread_id)
  consider(event.threadId)

  const type = typeof event.type === 'string' ? event.type.toLowerCase() : ''
  // `id` is only an identity claim on a thread/session lifecycle event. On any
  // other event it names an item, a tool call, or a message.
  if (/^(thread|session)[.\-_]/.test(type)) consider(event.id)

  for (const container of [event.thread, event.session]) {
    if (container && typeof container === 'object' && !Array.isArray(container)) {
      consider((container as any).id)
      consider((container as any).thread_id)
      consider((container as any).session_id)
    }
  }

  return found
}

export function classifyStderr(text: string): AttachedStderrClass {
  const sample = text.slice(0, MAX_STDERR_CLASSIFY_CHARS).toLowerCase()
  if (sample.trim().length === 0) return 'none'
  if (/no conversation found|session not found|thread not found|no such (session|thread)|not found/.test(sample)) {
    return 'thread_not_found'
  }
  if (/unauthor|forbidden|not logged in|sign in|login|auth|credential|token expired/.test(sample)) return 'auth'
  if (/rate limit|too many requests|quota|overloaded/.test(sample)) return 'rate_limit'
  if (/permission|denied|read-only|sandbox|operation not permitted|eacces/.test(sample)) return 'permission'
  return 'unclassified'
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

function fail(
  reason: AttachedTurnFailure,
  delivery: AttachedDeliveryState,
  over: Partial<AttachedTurnFailureResult> = {},
): AttachedTurnFailureResult {
  return {
    ok: false,
    provider: null,
    nativeThreadId: null,
    returnedNativeId: null,
    delivery,
    reason,
    detail: null,
    exitCode: null,
    stderrClass: 'none',
    durationMs: 0,
    ...over,
  }
}

function readDuration(deps: AttachedTurnDeps, startedAt: number): number {
  try {
    const now = deps.now()
    if (!Number.isFinite(now)) return 0
    const delta = now - startedAt
    return Number.isFinite(delta) && delta >= 0 ? delta : 0
  } catch {
    return 0
  }
}

/**
 * Append one turn to an existing native provider thread.
 *
 * Resolves; never rejects. A caller that has to wrap this in try/catch to stay
 * safe is a caller that will one day forget, and the catch-all branch would be
 * the one place with no defined delivery state.
 */
export async function deliverAttachedTurn(request: AttachedTurnRequest): Promise<AttachedTurnResult> {
  const deps = request.deps
  // A malformed deps object is a wiring bug, and a wiring bug must not reach a
  // spawn. Checked before anything else because the failure path below needs
  // `deps.now` to exist.
  if (!deps || typeof deps !== 'object') {
    return fail('adapter_internal_error', 'not_attempted', { detail: 'deps_missing' })
  }
  for (const key of ['now', 'preflight', 'resolveBinary', 'spawn', 'processStartMs', 'recordSpawn', 'releaseSpawn', 'terminate'] as const) {
    if (typeof (deps as any)[key] !== 'function') {
      return { ...fail('adapter_internal_error', 'not_attempted', { detail: `dep_missing:${key}` }) }
    }
  }

  let startedAt = 0
  try {
    const t0 = deps.now()
    startedAt = Number.isFinite(t0) ? t0 : 0
  } catch {
    return fail('adapter_internal_error', 'not_attempted', { detail: 'clock_failed' })
  }

  try {
    return await run(request, deps, startedAt)
  } catch (error: any) {
    // Anything unforeseen resolves to a refusal, not a throw. `not_attempted`
    // is only correct here because every path that can have written a prompt
    // byte has its own try/catch and returns its own ambiguous result.
    return fail('adapter_internal_error', 'not_attempted', {
      detail: 'unhandled',
      durationMs: readDuration(deps, startedAt),
    })
  }
}

async function run(
  request: AttachedTurnRequest,
  deps: AttachedTurnDeps,
  startedAt: number,
): Promise<AttachedTurnResult> {
  const duration = () => readDuration(deps, startedAt)

  // --- 1. Validate the request ------------------------------------------------
  if (!isBindableProvider(request.provider)) {
    return fail('invalid_provider', 'not_attempted', { durationMs: duration() })
  }
  const provider: AttachedProvider = request.provider

  if (!isValidNativeThreadId(request.nativeThreadId)) {
    return fail('invalid_thread_id', 'not_attempted', { provider, durationMs: duration() })
  }
  const nativeThreadId: string = request.nativeThreadId

  const base = { provider, nativeThreadId, durationMs: 0 }

  if (!isAttachedPermissionPolicy(request.policy)) {
    // Includes `undefined`. An omitted policy is not a request for the safest
    // one; it is a caller that has not decided, and this module will not decide
    // for it while agent mode is a flag away.
    return fail('unsupported_policy', 'not_attempted', { ...base, durationMs: duration() })
  }

  if (typeof request.prompt !== 'string' || request.prompt.length === 0) {
    return fail('invalid_prompt', 'not_attempted', { ...base, detail: 'empty', durationMs: duration() })
  }
  if (request.prompt.length > MAX_PROMPT_CHARS) {
    return fail('invalid_prompt', 'not_attempted', { ...base, detail: 'too_long', durationMs: duration() })
  }
  const prompt: string = request.prompt

  if (typeof request.cwd !== 'string' || request.cwd.length === 0 || !isAbsolute(request.cwd) || request.cwd.includes('\0')) {
    // A relative cwd resolves against the SERVER's working directory, so the
    // provider would run against the wrong workspace while looking correct.
    return fail('invalid_cwd', 'not_attempted', { ...base, durationMs: duration() })
  }
  const cwd: string = request.cwd

  let timeoutMs = DEFAULT_ATTACHED_TIMEOUT_MS
  if (request.timeoutMs !== undefined) {
    if (typeof request.timeoutMs !== 'number' || !Number.isFinite(request.timeoutMs)
      || request.timeoutMs <= 0 || request.timeoutMs > MAX_ATTACHED_TIMEOUT_MS) {
      return fail('invalid_timeout', 'not_attempted', { ...base, durationMs: duration() })
    }
    timeoutMs = request.timeoutMs
  }

  // --- 2. Resolve the binary --------------------------------------------------
  let resolution: BinaryResolution
  try {
    resolution = deps.resolveBinary(provider)
  } catch {
    return fail('binary_not_found', 'not_attempted', {
      ...base, detail: `${provider}:resolver_failed`, durationMs: duration(),
    })
  }
  if (!resolution || typeof resolution !== 'object' || resolution.ok !== true) {
    const detail = resolution && typeof resolution === 'object' && resolution.ok === false
      ? `${resolution.binary}:${resolution.detail}`
      : `${provider}:unresolved`
    // No fallback to the other provider, and no bare-name spawn. Plan 4.2 bans
    // the silent downgrade by name; the only correct move is to stop.
    return fail('binary_not_found', 'not_attempted', { ...base, detail, durationMs: duration() })
  }
  if (typeof resolution.path !== 'string' || !isAbsolute(resolution.path)) {
    return fail('binary_not_found', 'not_attempted', {
      ...base, detail: `${provider}:not_absolute`, durationMs: duration(),
    })
  }
  const binaryPath = resolution.path

  // --- 3. Final occupancy re-check, immediately before spawn (plan 4.3 §6) ----
  let verdict: AttachedPreflightVerdict
  try {
    verdict = deps.preflight()
  } catch {
    return fail('preflight_failed', 'not_attempted', { ...base, detail: 'threw', durationMs: duration() })
  }
  if (!verdict || typeof verdict !== 'object' || typeof (verdict as any).then === 'function') {
    // A thenable is not a verdict. Awaiting one here would reopen the very
    // window this check closes, so it is refused instead.
    return fail('preflight_failed', 'not_attempted', { ...base, detail: 'malformed', durationMs: duration() })
  }
  if (verdict.attachable !== true) {
    const reasonText = typeof verdict.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(verdict.reason)
      ? verdict.reason
      : 'unspecified'
    return fail('native_owner_appeared', 'not_attempted', { ...base, detail: reasonText, durationMs: duration() })
  }

  // --- 4. Spawn ---------------------------------------------------------------
  // Built through an injectable seam so the banned-flag check below is reachable
  // by a test. Without the seam no test could make the builders emit a banned
  // flag, the check was unreachable, and a mutation deleting it passed — which is
  // how `BANNED_PERMISSION_ARGS` came to be exported, asserted, and enforced
  // nowhere.
  let args: string[]
  try {
    args = (deps.buildArgs ?? buildArgs)(provider, nativeThreadId, cwd)
  } catch {
    return fail('unsupported_policy', 'not_attempted', { ...base, detail: 'argv_build_failed', durationMs: duration() })
  }
  // Plan 4.7, enforced against the argv that is about to be spawned rather than
  // against the source that builds it. No safe degraded argv exists, so this is a
  // terminal refusal before any process is created.
  const bannedArg = findBannedPermissionArg(args)
  if (bannedArg !== null) {
    return fail('unsupported_policy', 'not_attempted', { ...base, detail: `banned_arg:${bannedArg}`, durationMs: duration() })
  }
  let child: AttachedChildProcess
  try {
    child = deps.spawn({ binaryPath, args, cwd, env: buildAttachedEnv() })
  } catch {
    // Includes ENOENT. No process exists, so no turn can have landed.
    return fail('spawn_failed', 'not_attempted', { ...base, detail: 'threw', durationMs: duration() })
  }
  if (!child || typeof child !== 'object' || typeof child.on !== 'function') {
    return fail('spawn_failed', 'not_attempted', { ...base, detail: 'no_child', durationMs: duration() })
  }

  const pid = child.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    // Node leaves `pid` undefined when the spawn itself failed. If a process
    // does exist behind an unusable pid we cannot record it, cannot release it,
    // and cannot kill it on timeout — so refuse rather than run blind.
    safeTerminate(deps, child, 'SIGKILL')
    return fail('spawn_failed', 'not_attempted', { ...base, detail: 'no_pid', durationMs: duration() })
  }

  // --- 5. Claim the child, synchronously, before anything can observe it ------
  // NO `await` between the spawn above and the record below. See the header.
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
    // An unclaimed child is a live process that the occupancy detector will
    // read as a foreign desktop owner of this exact thread — permanently, if it
    // outlives us. Kill it before a single prompt byte is written, so the turn
    // is provably not delivered, and release defensively in case the record
    // partially landed.
    safeTerminate(deps, child, 'SIGKILL')
    safeRelease(deps, pid)
    return fail('ownership_record_failed', 'aborted', {
      ...base, detail: claimDetail, durationMs: duration(),
    })
  }

  try {
    return await driveChild({ child, pid, deps, provider, nativeThreadId, prompt, timeoutMs, startedAt })
  } finally {
    // Every path: success, mismatch, non-zero exit, timeout, throw. A leaked
    // entry lets a recycled pid inherit our self-ownership claim.
    safeRelease(deps, pid)
  }
}

function safeTerminate(deps: AttachedTurnDeps, child: AttachedChildProcess, signal: NodeJS.Signals): void {
  try {
    deps.terminate(child, signal)
  } catch {
    // A kill that fails changes nothing a caller can act on, and must never
    // replace the terminal result being assembled around it.
  }
}

function safeRelease(deps: AttachedTurnDeps, pid: number): void {
  try {
    deps.releaseSpawn(pid)
  } catch {
    // Same reasoning: a throwing release must not mask the turn's outcome.
  }
}

interface DriveInput {
  child: AttachedChildProcess
  pid: number
  deps: AttachedTurnDeps
  provider: AttachedProvider
  nativeThreadId: string
  prompt: string
  timeoutMs: number
  startedAt: number
}

function driveChild(input: DriveInput): Promise<AttachedTurnResult> {
  const { child, deps, provider, nativeThreadId, prompt, timeoutMs, startedAt } = input

  return new Promise<AttachedTurnResult>((resolve) => {
    /** Distinct ids seen. More than one means a fork happened; see the header. */
    const observedIds: string[] = []
    let stdoutTail = ''
    let scannedBytes = 0
    let stderrSample = ''
    let delivery: AttachedDeliveryState = 'not_attempted'
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

    const settle = (result: AttachedTurnResult) => {
      if (settled) return
      settled = true
      clearTimers()
      resolve(result)
    }

    const settleFailure = (
      reason: AttachedTurnFailure,
      over: Partial<AttachedTurnFailureResult> = {},
    ) => {
      settle(fail(reason, delivery, {
        provider,
        nativeThreadId,
        returnedNativeId: observedIds.length === 1 ? observedIds[0]! : null,
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
        // Keep only the trailing partial line; everything before it is complete.
        stdoutTail = lines.pop() ?? ''
        // Bound the carry-over so a provider emitting one enormous line cannot
        // grow this without limit.
        if (stdoutTail.length > 1_000_000) stdoutTail = ''
        for (const line of lines) {
          for (const id of extractNativeIdsFromLine(line)) {
            if (!observedIds.includes(id)) observedIds.push(id)
          }
        }
        // Deliberately nothing else: no text, no tool calls, no transcript. The
        // adapter cannot leak what it never held.
      } catch {
        // A malformed chunk costs us id evidence, which ends as
        // `no_native_id_returned` — a refusal, which is the safe direction.
      }
    }

    const consumeStderr = (chunk: any) => {
      try {
        if (stderrSample.length >= MAX_STDERR_CLASSIFY_CHARS) return
        const text = typeof chunk === 'string' ? chunk : String(chunk)
        stderrSample = (stderrSample + text).slice(0, MAX_STDERR_CLASSIFY_CHARS)
      } catch {
        /* classification degrades to 'unclassified'; nothing else depends on it */
      }
    }

    const finishTerminal = () => {
      // Drain whatever sat in the trailing partial line before judging.
      if (stdoutTail.length > 0) {
        for (const id of extractNativeIdsFromLine(stdoutTail)) {
          if (!observedIds.includes(id)) observedIds.push(id)
        }
        stdoutTail = ''
      }

      if (timedOut) return settleFailure('timeout')
      if (spawnErrored) return settleFailure('spawn_failed', { detail: 'child_error' })

      if (exitCode !== 0) {
        return settleFailure('provider_exit_nonzero')
      }
      if (observedIds.length === 0) {
        // Exit 0 with no id is not a success. We were required to prove the
        // turn landed on the target, and no evidence is not proof.
        return settleFailure('no_native_id_returned')
      }
      if (observedIds.length > 1 || observedIds[0] !== nativeThreadId) {
        // Either a different thread, or ours plus another — a fork emits both.
        return settleFailure('native_id_mismatch', {
          returnedNativeId: observedIds.length === 1 ? observedIds[0]! : null,
          detail: observedIds.length > 1 ? 'multiple_ids' : 'different_id',
        })
      }
      if (delivery !== 'ambiguous') {
        // Exit 0 with a matching id but no prompt ever written is incoherent;
        // refuse rather than report a turn we did not send.
        return settleFailure('adapter_internal_error', { detail: 'no_delivery_attempt' })
      }

      settle({
        ok: true,
        provider,
        nativeThreadId,
        returnedNativeId: nativeThreadId,
        delivery: 'delivered',
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
        // Delivery stays whatever it was: `not_attempted` if this fired before
        // the write (ENOENT), `ambiguous` if after.
        finishTerminal()
      })
      child.on('exit', (code: number | null) => {
        if (typeof code === 'number') exitCode = code
        else if (exitCode === null) exitCode = null
      })
      child.on('close', (code: number | null) => {
        if (typeof code === 'number') exitCode = code
        finishTerminal()
      })
    } catch {
      safeTerminate(deps, child, 'SIGKILL')
      return settleFailure('adapter_internal_error', { detail: 'wire_failed' })
    }

    // --- the passive tee, wired LAST and in its own try ------------------------
    // Its own try/catch, outside the block above, is the point: a stdout that refuses
    // a second listener must cost the OBSERVER, not the turn. Inside that block the
    // same throw would hit `wire_failed` and refuse a delivery for the sake of a view.
    try {
      const observe = deps.observeStdout
      if (typeof observe === 'function' && child.stdout) {
        child.stdout.on('data', (chunk: any) => {
          try {
            observe(typeof chunk === 'string' ? chunk : String(chunk))
          } catch {
            // Never rethrown. A throw here propagates out of `emit()` and would stop
            // every later listener on this stream.
          }
        })
      }
    } catch {
      /* the turn proceeds unobserved, which is the correct direction */
    }

    // --- bounded budget ------------------------------------------------------
    deadline = setTimeout(() => {
      timedOut = true
      safeTerminate(deps, child, 'SIGTERM')
      graceTimer = setTimeout(() => {
        safeTerminate(deps, child, 'SIGKILL')
        forceTimer = setTimeout(() => {
          // A child that survived SIGKILL cannot be reached from here, and
          // blocking forever would wedge the coordinator and any Control drain
          // behind it.
          settleFailure('timeout', { detail: 'unreaped' })
        }, FORCE_SETTLE_MS)
      }, KILL_GRACE_MS)
    }, timeoutMs)

    // --- deliver the prompt --------------------------------------------------
    const stdin = child.stdin
    if (!stdin || typeof stdin.write !== 'function' || typeof stdin.end !== 'function' || !child.stdout) {
      // No way to send the prompt, or no way to observe the id we must verify.
      // Nothing was written, so this is a provable abort.
      safeTerminate(deps, child, 'SIGKILL')
      delivery = 'aborted'
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
      // THE BOUNDARY. From this call on, we cannot prove the provider did not
      // act on the prompt, so every non-success outcome is ambiguous.
      delivery = 'ambiguous'
      stdin.write(prompt)
      stdin.end()
    } catch {
      // A synchronous throw means the pipe rejected the write, but not that no
      // byte was queued. Fail closed: stay ambiguous.
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
 * `preflight` has no default and never will: the occupancy re-check needs the
 * binding's provider and thread id plus live probes, all of which belong to the
 * coordinator. A default here would be a placeholder that says "attachable",
 * which is the one answer this module must never invent.
 */
export function realAttachedTurnDeps(preflight: () => AttachedPreflightVerdict): AttachedTurnDeps {
  return {
    now: () => Date.now(),
    preflight,
    resolveBinary: provider => resolveProviderBinary(provider),
    spawn: request => nodeSpawn(request.binaryPath, [...request.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: request.cwd,
      env: request.env,
      // Group leader, so the whole provider tree can be signalled on timeout —
      // matching what both ordinary bridges do.
      detached: true,
    }) as unknown as AttachedChildProcess,
    processStartMs: pid => realProcessStartMs(pid),
    recordSpawn: (pid, startMs) => recordCosSpawn(pid, startMs),
    releaseSpawn: pid => releaseCosSpawn(pid),
    terminate: (child, signal) => {
      const pid = child.pid
      if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
        try {
          // Negative pid = process group, reachable because we spawned
          // detached. Kills the CLI's own children too.
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
  }
}
