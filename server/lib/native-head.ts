// Has the desktop thread changed since we last looked?
//
// Plan 4.3, the native-head watermark. One question, three answers: a bounded
// opaque revision token, or null meaning UNKNOWN. There is no third value and
// there is deliberately no "probably unchanged" — a caller that needs a
// watermark comparison and gets null must REFUSE the delivery. Refusing costs
// one Fork; guessing corrupts a real human conversation.
//
// ============================================================================
// WHAT THIS DETECTS, STATED HONESTLY: COMPLETED TURNS ONLY.
// ============================================================================
// A desktop turn that is currently GENERATING has written nothing to the
// transcript yet, so no tail-derived token can see it. The 2.2 canary showed
// exactly that — the file grew only after completion. This watermark therefore
// cannot fence a user typing into the desktop app at the same moment, and it
// must never be described as if it could.
//
// That gap is why the feature is gated on no-live-owner (plan 4.3 option B,
// `thread-occupancy.ts`) rather than on this token. The watermark's job is the
// narrower one of making a COMPLETED divergence visible between COS turns. It
// is a second, weaker barrier behind the occupancy gate, not a substitute for
// it, and it closes no race on its own.
//
// ============================================================================
// MESSAGE-BEARING ROWS ONLY. This is the load-bearing rule.
// ============================================================================
// A resumed CLI writes session and mode rows to the transcript AT SPAWN, before
// any prompt byte reaches stdin (plan 4.3, observed in the 2.2 canary whose
// final row was `type: "mode"` with a null uuid). So a run that aborts before
// delivery still advances a NAIVE byte- or line-derived head. The next attempt
// then reports `native_thread_changed` while its own journal says the delivery
// was aborted — a spurious change that contradicts its own abort record, and
// one the user cannot distinguish from a real desktop turn.
//
// The filter below therefore counts only rows that actually carry a message,
// and the row taxonomy is measured, not assumed. Counts from this machine on
// 2026-08-16, over the six largest real Claude transcripts and the four most
// recent Codex rollouts (schema keys and type labels only — no content read):
//
//   Claude, rows WITH a `message` object:    user 17,814   assistant 34,948
//   Claude, rows WITHOUT one:                queue-operation, attachment,
//                                            last-prompt, custom-title, mode,
//                                            system, frame-link  (20,653 rows)
//   Claude, message rows missing `uuid`:     0
//   Claude, `isMeta: true`:                  190, all on `user` rows
//
//   Codex top-level types:  session_meta, event_msg, response_item,
//                           world_state, turn_context, compacted,
//                           inter_agent_communication_metadata
//   Codex message payloads: response_item/message role=user|assistant|developer,
//                           response_item/agent_message,
//                           event_msg/user_message, event_msg/agent_message
//
// Two exclusions inside that set are deliberate and are the whole point:
//
//   Claude `isMeta: true` user rows. These are injected context, not something
//   the user typed, and a resumed CLI can write them at spawn. Excluding them
//   cannot hide a completed desktop turn, because every completed turn also
//   emits assistant message rows.
//
//   Codex `response_item/message` with `role: "developer"`. That is the
//   instruction block injected when a thread is opened or resumed — the exact
//   Codex analogue of Claude's spawn-time mode row. 37 of the 120 message rows
//   sampled were developer rows.
//
// ============================================================================
// FAIL CLOSED. Every branch below resolves an unknown to null.
// ============================================================================
// Unsupported provider, malformed id, missing directory, unreadable directory,
// absent transcript, TWO candidate transcripts, a short read, a corrupt row, a
// transcript with no message rows at all, a throwing dependency: all null. The
// only path that returns a token is one where a single transcript was located
// and fully understood.
//
// PATH DERIVATION IS REUSED, NOT REINVENTED. `agentSessionRoots()` and
// `idFromCodexFilename()` come from agent-session-store.ts, which is the module
// that already knows a Claude session id does not encode its project slug — the
// slug is the cwd, so the only way to find `<id>.jsonl` is to scan every folder
// under `~/.claude/projects`. Reusing those roots also guarantees this module
// reads the very file discovery listed.
//
// `findAgentSessionFile()` itself is deliberately NOT called, for three reasons
// that all point the same way: it prefix-matches (`id.startsWith(needle)`), so
// a wrong-but-similar file can win; it returns the FIRST match in directory
// order, so two candidates resolve silently instead of ambiguously; and its
// `dirents()` helper swallows readdir errors into `[]`, which turns an
// unreadable directory into "not found". Each is a fail-open for a watermark.
//
// KNOWN LIMIT OF A WHITELIST CLASSIFIER. Because only the row shapes measured
// above count, a FUTURE provider version that carries a message under a new
// `type` would be invisible here — the head would sit still through a real
// desktop turn, which is the fail-open direction. Counting everything instead
// is not an option, because that is the spurious-advance defect this filter
// exists for. The mitigation is the one Phase 0 already mandates: re-run the
// schema census per provider, per version, as part of certification, and treat
// an unrecognised row taxonomy as a reason to withhold the provider flag.
//
// TWO GUARDS ARE DELIBERATELY UNCOVERED, established by mutation on 2026-08-16
// (24 of 26 mutations caught; these are the two survivors, reported rather than
// quietly dropped):
//
//   The short-read refusal in `readTail`. `readSync` fills a regular file, so
//   reaching it needs a concurrent truncation race that a unit test cannot
//   stage. Defensive, unreachable from the suite, kept.
//
//   The provider salt in the digest. The two classifiers are disjoint on `type`
//   — no row satisfies both — so no fixture can make one thread produce the
//   same identity list under both providers, and removing the salt changes no
//   observable output. Defense-in-depth against a future classifier that
//   overlaps, not a live invariant.
//
// KNOWN DIVERGENCE, worth naming rather than hiding. `agentSessionRoots()`
// honours `COS_AGENT_SESSIONS_HOME`, while the occupancy detector's
// `claudeSessionsDir()` honours `COS_CLAUDE_SESSIONS_DIR` then
// `CLAUDE_CONFIG_DIR`. On an install that sets only `CLAUDE_CONFIG_DIR`, this
// module looks in `~/.claude/projects`, finds nothing, and returns null — the
// thread becomes Fork-only. That is the safe direction, but it is a real
// capability gap and the two precedences should be reconciled repo-wide.

import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { agentSessionRoots, idFromCodexFilename } from './agent-session-store.js'
import { cursorTranscriptPath } from './cursor-agent-store.js'
import { isValidNativeThreadId } from './native-thread-id.js'

/** Providers with a certified transcript shape. Anything else has no watermark. */
export type NativeHeadProvider = 'claude' | 'codex' | 'cursor'

/**
 * Token prefix. Bumping it forces every stored head to compare as CHANGED,
 * which surfaces a refusal rather than a silent mis-comparison across versions.
 */
export const NATIVE_HEAD_VERSION = 'nh1'

/** `nh1:` + 128 bits of SHA-256. Fixed length for every input, by construction. */
export const NATIVE_HEAD_TOKEN_RE = /^nh1:[0-9a-f]{32}$/

/**
 * Bytes read from the END of a transcript.
 *
 * MEASURED, not guessed. Across the eight largest real Claude transcripts on
 * this machine (23 MB to 121 MB), the distance from EOF back to the third-most-
 * recent message-bearing row was 13 KB, 58 KB, 83 KB, 295 KB, 302 KB, 321 KB,
 * 345 KB and 637 KB. A 512 KiB window would have failed on the last of those.
 * 2 MiB clears the measured worst case by 3x.
 */
export const TAIL_WINDOW_BYTES = 2 * 1024 * 1024

/**
 * Per-provider tail windows, MEASURED on this machine 2026-08-16 over every thread
 * touched in the last 30 days. The single 2 MiB constant above was derived from
 * Claude transcripts only and was wrong for BOTH providers.
 *
 *   claude  n=1262  EOF-to-3rd-most-recent-message-row max 3.63 MiB  (1 null at 2 MiB)
 *   codex   n=167   p90 0.75 MiB, max 46.90 MiB                      (14 nulls at 2 MiB)
 *
 * Codex rollouts reach 13.6 GB, so the window is what keeps this bounded; it is not
 * an attempt to read the file. Undersizing fails CLOSED — the head reads null, the
 * caller reports native_head_unavailable, and the thread degrades to Fork-only — so
 * the old value cost availability, never safety. A backwards chunked read to a hard
 * cap would beat a fixed window and is the right eventual shape.
 */
export const TAIL_WINDOW_BYTES_BY_PROVIDER: Record<NativeHeadProvider, number> = {
  claude: 8 * 1024 * 1024,
  codex: 64 * 1024 * 1024,
  cursor: 8 * 1024 * 1024,
}

/**
 * How many trailing message-bearing rows the token is derived from.
 *
 * Not 1, because a single row's identity is thinner than it looks. Not 20,
 * because every extra row is another chance for the window to slide past it and
 * report a false change. Three rows of real transcript is already far more
 * entropy than a 128-bit digest can hold.
 */
export const HEAD_ROW_COUNT = 3

/** Ceilings that keep a pathological tree from turning attach into a directory walk. */
export const MAX_CLAUDE_PROJECT_DIRS = 2048
export const MAX_CODEX_DIR_ENTRIES = 512
export const MAX_CODEX_FILES_SCANNED = 20_000

export interface NativeHeadDirs {
  /** `<COS_AGENT_SESSIONS_HOME|~>/.claude/projects` */
  claudeProjectsDir: string
  /** `<COS_AGENT_SESSIONS_HOME|~>/.codex/sessions` */
  codexSessionsDir: string
  /** `<COS_AGENT_SESSIONS_HOME|~>/.cursor/projects` */
  cursorProjectsDir: string
}

export interface TailRead {
  /** UTF-8 decoding of the window. */
  text: string
  /**
   * True when the window does NOT start at byte 0, so its first line is a
   * fragment of a row rather than a row.
   *
   * The probe decides this from the SAME fstat it reads with. Deriving it from
   * a separate size call would race an append and mislabel a real fragment as a
   * whole row.
   */
  truncated: boolean
}

export interface NativeHeadDeps {
  dirs: NativeHeadDirs
  /** Does this directory exist? False also covers "cannot tell". */
  dirExists: (path: string) => boolean
  /** Entry names only. MUST THROW on an unreadable directory, never return []. */
  readDir: (path: string) => string[]
  /** Is this a readable regular file? */
  fileExists: (path: string) => boolean
  /** Last `maxBytes` of a file. Null means UNREADABLE or SHORT, never "empty". */
  readTail: (path: string, maxBytes: number) => TailRead | null
  /**
   * Window size, injectable ONLY so a test can prove the truncation branch.
   *
   * With the production 2 MiB value, any fixture small enough to write quickly
   * is read whole, so the truncated path would never execute and a test could
   * not tell windowing from no windowing. Same reasoning, and the same hazard,
   * as `agentSessionLines`' injectable head/tail sizes.
   */
  tailWindowBytes?: number
}

/**
 * Result of comparing two heads.
 *
 * Three values, not a boolean, because null is not "same" and is not "changed".
 * A boolean would force every caller to invent its own meaning for the unknown
 * case, and the cheap invention — treat null as false — is the fail-open this
 * whole module exists to prevent.
 */
export type NativeHeadComparison = 'same' | 'changed' | 'unknown'

export function isNativeHeadToken(value: unknown): value is string {
  return typeof value === 'string' && NATIVE_HEAD_TOKEN_RE.test(value)
}

/**
 * Did the desktop thread change between these two observations?
 *
 * `unknown` for null on either side, and equally for any value that is not a
 * well-formed token: an unrecognised input is an unknown, never a match.
 */
export function headsDiffer(a: string | null, b: string | null): NativeHeadComparison {
  if (!isNativeHeadToken(a) || !isNativeHeadToken(b)) return 'unknown'
  return a === b ? 'same' : 'changed'
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Claude: a row carries a message when it is a user/assistant turn with a
 * `message` object, and is not injected meta context.
 *
 * Keyed on the presence of `message` rather than on a list of excluded types,
 * so a type this repo has never seen cannot default into the head. Measured:
 * only `user` and `assistant` rows have one, and all 52,762 of them had a uuid.
 */
function isClaudeMessageRow(row: Record<string, unknown>): boolean {
  if (row.type !== 'user' && row.type !== 'assistant') return false
  if (row.isMeta === true) return false
  return asObject(row.message) !== null
}

/**
 * Codex: a row carries a message when its payload is a user-visible message.
 *
 * `role: "developer"` is excluded — that is the instruction block written when
 * a thread is opened or resumed, i.e. spawn-time, i.e. exactly what must not
 * move the head. Everything outside this set (session_meta, turn_context,
 * world_state, token_count, reasoning, tool calls) is excluded by omission.
 */
function isCodexMessageRow(row: Record<string, unknown>): boolean {
  const payload = asObject(row.payload)
  if (!payload) return false
  const kind = payload.type
  if (row.type === 'response_item') {
    if (kind === 'message') return payload.role === 'user' || payload.role === 'assistant'
    return kind === 'agent_message'
  }
  if (row.type === 'event_msg') return kind === 'agent_message' || kind === 'user_message'
  return false
}

export function isMessageBearingRow(
  provider: NativeHeadProvider,
  row: Record<string, unknown>,
): boolean {
  // Exhaustive, not a binary fallthrough. A ternary gave every unrecognised
  // provider Codex row semantics, so a future provider would silently classify
  // against the wrong schema — and the fail-open direction here is a head that
  // does not advance on real messages, i.e. divergence that never reports.
  if (provider === 'claude') return isClaudeMessageRow(row)
  if (provider === 'codex') return isCodexMessageRow(row)
  if (provider === 'cursor') {
    const role = row.role
    return role === 'user' || role === 'assistant'
  }
  return false
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Per-row identity feeding the digest.
 *
 * The whole normalized line, hashed. Not the uuid: `uuid` is absent on Codex
 * rows entirely, and hashing the line needs no schema beyond the classifier
 * above while detecting any byte that changed. The output is one-way, so no
 * transcript content survives into the token.
 */
function rowIdentity(normalizedLine: string): string {
  return sha256Hex(normalizedLine)
}

/**
 * Identities of the message-bearing rows in a window, oldest first.
 *
 * Null means the window could not be fully understood. Two lines are exempt
 * from that, and only two:
 *
 *   The FIRST line when the window is truncated. It is a fragment by
 *   construction, so it is dropped without being parsed at all — including in
 *   the lucky case where the cut lands on a row boundary and it would parse.
 *   Dropping it unconditionally keeps the rule one sentence long.
 *
 *   The LAST line, when it does not parse. These files are appended to, so a
 *   torn final row is normal. It is skipped rather than counted: an incomplete
 *   row is not yet a row, and it will move the head when it completes.
 *
 * Any OTHER unparseable non-blank line is corruption in the middle of a file
 * that is supposed to be append-only, and corruption is an unknown.
 */
function messageRowIdentities(provider: NativeHeadProvider, tail: TailRead): string[] | null {
  const lines = tail.text.split('\n')
  const first = tail.truncated ? 1 : 0
  const identities: string[] = []

  for (let i = first; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === '') continue

    const row = parseJsonObject(line)
    if (row === null) {
      if (i === lines.length - 1) continue
      return null
    }

    if (isMessageBearingRow(provider, row)) identities.push(rowIdentity(line))
  }

  return identities
}

/**
 * The single Claude transcript for this thread, or null.
 *
 * A Claude session id does not encode its project slug, so every folder under
 * `projects/` is a candidate and the file is probed by exact name. Two matches
 * — the same id filed under two project slugs, which a moved or re-rooted
 * workspace can produce — is an ambiguity, and an ambiguity is an unknown. The
 * store's prefix-match-first-wins would have picked one at random.
 */
/**
 * Locate the one transcript for a thread, or null when it is not exactly one.
 *
 * Exported so the workspace resolver reuses this scan instead of reimplementing
 * the ambiguity rule. Two modules disagreeing about which file IS the thread is
 * the same class of drift that let a truncated id through the occupancy detector.
 */
export function transcriptPathFor(
  provider: string,
  threadId: string,
  deps: NativeHeadDeps,
): string | null {
  try {
    if (!isValidNativeThreadId(threadId)) return null
    if (provider === 'claude') return claudeTranscriptPath(threadId, deps)
    if (provider === 'codex') return codexRolloutPath(threadId, deps)
    if (provider === 'cursor') return cursorAgentTranscriptPath(threadId, deps)
    return null
  } catch {
    return null
  }
}

function cursorAgentTranscriptPath(threadId: string, deps: NativeHeadDeps): string | null {
  return cursorTranscriptPath(threadId, deps.dirs.cursorProjectsDir)
}

function claudeTranscriptPath(threadId: string, deps: NativeHeadDeps): string | null {
  const root = deps.dirs.claudeProjectsDir
  if (!deps.dirExists(root)) return null

  const folders = deps.readDir(root)
  if (folders.length > MAX_CLAUDE_PROJECT_DIRS) return null

  const filename = `${threadId}.jsonl`
  let found: string | null = null
  for (const folder of folders) {
    const candidate = join(root, folder, filename)
    if (!deps.fileExists(candidate)) continue
    if (found !== null) return null
    found = candidate
  }
  return found
}

/**
 * The single Codex rollout for this thread, or null.
 *
 * Rollouts live at `sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<threadId>.jsonl`,
 * so the id is recoverable from the filename and the date path never has to be
 * guessed. `idFromCodexFilename` is the repo's existing parser for that name;
 * the `rollout-` prefix is additionally required because that is the documented
 * shape, and a file that does not match it is something this module has never
 * certified.
 */
function codexRolloutPath(threadId: string, deps: NativeHeadDeps): string | null {
  const root = deps.dirs.codexSessionsDir
  if (!deps.dirExists(root)) return null

  let scanned = 0
  let found: string | null = null

  const years = deps.readDir(root)
  if (years.length > MAX_CODEX_DIR_ENTRIES) return null
  for (const year of years) {
    const yearDir = join(root, year)
    if (!deps.dirExists(yearDir)) continue
    const months = deps.readDir(yearDir)
    if (months.length > MAX_CODEX_DIR_ENTRIES) return null

    for (const month of months) {
      const monthDir = join(yearDir, month)
      if (!deps.dirExists(monthDir)) continue
      const days = deps.readDir(monthDir)
      if (days.length > MAX_CODEX_DIR_ENTRIES) return null

      for (const day of days) {
        const dayDir = join(monthDir, day)
        if (!deps.dirExists(dayDir)) continue

        for (const name of deps.readDir(dayDir)) {
          if (++scanned > MAX_CODEX_FILES_SCANNED) return null
          if (!name.startsWith('rollout-')) continue
          if (idFromCodexFilename(name) !== threadId) continue
          // The Claude path has had this filter all along; the Codex path selected
          // on FILENAME alone, so a `rollout-*-<id>.jsonl` FIFO or directory was a
          // valid candidate. The open flags now make that safe, but two sibling
          // resolvers disagreeing about what counts as a transcript is the drift
          // that produced the hazard in the first place.
          if (!deps.fileExists(join(dayDir, name))) continue
          if (found !== null) return null
          found = join(dayDir, name)
        }
      }
    }
  }

  return found
}

/**
 * A bounded opaque revision token for a native desktop thread, or null for
 * UNKNOWN.
 *
 * Null is not "unchanged". A caller whose decision depends on comparing heads
 * must refuse the turn when it gets one, per plan 4.3.
 *
 * The token is a digest over the identities of the last `HEAD_ROW_COUNT`
 * message-bearing rows, salted with the provider and thread id. Consequences,
 * all of them intentional:
 *
 *   No transcript content leaves this function. SHA-256 is one-way.
 *   No filesystem path leaves it either — the located path is never hashed in,
 *   so the same thread moved between project folders keeps its token.
 *   No length signal leaves it. Two transcripts sharing their last three
 *   message rows produce the same token however different their sizes are, and
 *   the token is 36 characters for a 4 KB file and for a 121 MB one.
 */
export function nativeHead(
  provider: string,
  threadId: string,
  deps: NativeHeadDeps,
): string | null {
  try {
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'cursor') return null
    // Validated before any scan. A truncated or malformed id reaches a
    // filesystem path below, and "matched nothing" must never look like a
    // clean read of a real transcript.
    if (!isValidNativeThreadId(threadId)) return null

    const path = transcriptPathFor(provider, threadId, deps)
    if (path === null) return null

    const window = deps.tailWindowBytes ?? TAIL_WINDOW_BYTES_BY_PROVIDER[provider] ?? TAIL_WINDOW_BYTES
    const tail = deps.readTail(path, window)
    if (tail === null) return null

    const identities = messageRowIdentities(provider, tail)
    if (identities === null) return null

    // No message-bearing rows at all: a transcript that is nothing but session
    // and mode rows. There is nothing to watermark, so the answer is unknown
    // rather than a token that every future spawn row would leave unmoved.
    if (identities.length === 0) return null

    // Truncated AND short of a full row set means the window slid far enough to
    // matter: a later spawn-time append could push another row out and flip the
    // token without a real turn — the precise false-change this module exists
    // to prevent. Refuse instead of emitting a token that cannot be trusted to
    // stay put. Reachable only when three consecutive rows exceed 2 MiB.
    if (tail.truncated && identities.length < HEAD_ROW_COUNT) return null

    // A space separates the fields, and it is unambiguous rather than merely
    // conventional: the version is `nh1`, the provider is one of two literals,
    // the thread id is hex-and-hyphen by `isValidNativeThreadId`, and every
    // identity is 64 lowercase hex characters. No field can contain a space, so
    // no two different field lists can concatenate to the same string. (An
    // earlier draft used a literal NUL here, which achieves the same thing while
    // making the source read as a binary file to grep, git and review tools.)
    const digest = createHash('sha256')
    digest.update(NATIVE_HEAD_VERSION)
    digest.update(' ')
    digest.update(provider)
    digest.update(' ')
    digest.update(threadId)
    for (const identity of identities.slice(-HEAD_ROW_COUNT)) {
      digest.update(' ')
      digest.update(identity)
    }
    return `${NATIVE_HEAD_VERSION}:${digest.digest('hex').slice(0, 32)}`
  } catch {
    // Includes a throwing dependency. A watermark that raises into a route is
    // worse than one that says it does not know.
    return null
  }
}

// ---------------------------------------------------------------------------
// Real filesystem dependencies.
// ---------------------------------------------------------------------------

export function realNativeHeadDirs(): NativeHeadDirs {
  const roots = agentSessionRoots()
  return {
    claudeProjectsDir: roots.claudeProjects,
    codexSessionsDir: roots.codexSessions,
    cursorProjectsDir: roots.cursorProjects,
  }
}

function dirExists(path: string): boolean {
  // `throwIfNoEntry: false` separates the two cases a bare catch collapsed.
  // ENOENT is genuinely "not there" -> false. EACCES, ELOOP, EIO and friends mean
  // "cannot tell", and those must THROW so `nativeHead`'s outer catch turns them
  // into null. The catch-all previously DROPPED an unreadable candidate from
  // enumeration, which defeats the "two candidate transcripts -> null" ambiguity
  // rule: a transient stat failure on the LIVE transcript silently promoted a
  // stale twin to the only candidate, and its head never moves, so every later
  // comparison reads `same` while the desktop conversation diverges.
  const stat = statSync(path, { throwIfNoEntry: false })
  return stat !== undefined && stat.isDirectory()
}

/**
 * Entry names, THROWING on an unreadable directory.
 *
 * `readdirSync` already does this and it must not be softened. Returning `[]`
 * on EACCES would read as "no project folders", which resolves to "transcript
 * not found", which is a null — same answer here, but the habit is the fail-
 * open that has already shipped in this repo once, and the equivalent probe in
 * occupancy-probes.ts throws for the same reason.
 */
function readDir(path: string): string[] {
  return readdirSync(path)
}

function fileExists(path: string): boolean {
  // Same rule as dirExists: absent is false, unreadable throws. See the note there.
  const stat = statSync(path, { throwIfNoEntry: false })
  return stat !== undefined && stat.isFile()
}

/**
 * Last `maxBytes` of a file.
 *
 * One open, one fstat, one positioned read, so `truncated` and the bytes come
 * from the same view of the file. A short read returns null rather than a
 * partial window: a partial window silently drops trailing rows, and dropping
 * trailing rows is how a head fails to notice a real desktop turn.
 */
function readTail(path: string, maxBytes: number): TailRead | null {
  let fd = -1
  try {
    // THE THIRD INSTANCE OF THIS BUG, and the one reachable from both write
    // routes. `openSync` on a FIFO with no writer never returns, and it is a
    // synchronous syscall on Node's single thread, so a planted
    // `rollout-*-<id>.jsonl` FIFO wedges the ENTIRE server — health, meeting save,
    // transcribe-stream — not merely this request. Measured: blocked >34s in state
    // SN and had to be SIGKILLed. The `isFile()` check below runs AFTER the open
    // and cannot prevent it.
    //
    // occupancy-probes.readFile and attached-workspace.readHead already carry
    // these flags; this copy was missed. O_NOFOLLOW additionally refuses a
    // symlinked transcript that could point anywhere on disk.
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
    const nonBlock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | nonBlock)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return null

    const want = Math.min(stat.size, Math.max(0, maxBytes))
    const start = stat.size - want
    const buffer = Buffer.allocUnsafe(want)

    let read = 0
    while (read < want) {
      const n = readSync(fd, buffer, read, want - read, start + read)
      if (n <= 0) break
      read += n
    }
    if (read !== want) return null

    return { text: buffer.toString('utf8'), truncated: start > 0 }
  } catch {
    return null
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        /* already closed or never opened cleanly; nothing to recover */
      }
    }
  }
}

export function realNativeHeadDeps(dirs: NativeHeadDirs = realNativeHeadDirs()): NativeHeadDeps {
  return { dirs, dirExists, readDir, fileExists, readTail }
}
