// The current-request binding for provider CLI spawns (P0 from the 2026-09-27 memory audit).
//
// WHY THIS EXISTS. The COS UserPromptSubmit hook (a Python script in the COS repo, run by
// the Claude Code and Codex CLIs) builds its memory query from the prompt text the CLI hands
// it. On a glasses turn that text is not the user's question: the Codex and Cursor bridges
// send one concatenated "SYSTEM INSTRUCTIONS ... USER REQUEST ..." prompt, and the Claude
// bridge still wraps the question in image preambles and attachment JSON. The hook then
// embedded display rules, the calendar and standing tasks, and injected unrelated memories.
//
// THE CONTRACT (04_MVP_BUILD_SPEC.md, "Current-request contract", shared with the hook).
// Per CLI spawn with a genuine user query, write
//
//   <data dir>/turn-requests/<turnId or uuid>.json      directory 0700, file 0600
//   {"schema_version":1,"turn_id":"...","current_user_text":"...",
//    "full_prompt_sha256":"...","created_at":"ISO"}
//
// and pass its absolute path to the child as COS_TURN_REQUEST_FILE. The hook uses
// `current_user_text` only when sha256(hook_prompt.strip()) equals `full_prompt_sha256` and
// the stripped text is a substring of the hook prompt; otherwise it uses the prompt exactly
// as before. So a file that does not bind is harmless, and nothing here may fail a turn.
//
// THE HASH IS PYTHON'S strip(), NOT JS trim(). The two whitespace sets differ: Python also
// strips U+001C..U+001F and U+0085, and JS also strips U+FEFF. A prompt ending in one of
// those would never bind if the server hashed `prompt.trim()`. `stripLikePython` uses the
// exact `str.isspace()` set (checked against python3 over every code point, 2026-09-29).
//
// PRIVACY. The user's text lives only in this private file, never in argv or the child env
// (argv is world-readable through `ps`; env is readable by every descendant). The file is
// deleted when the child exits, and anything older than an hour is swept.

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  chmodSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { dataPath } from './data-dir.js'

/** The child env key that carries the file path. The hook reads exactly this name. */
export const TURN_REQUEST_ENV = 'COS_TURN_REQUEST_FILE'
export const TURN_REQUEST_SCHEMA_VERSION = 1
/** Files older than this are swept. No provider run outlives it: the longest wall cap is 20 min. */
export const TURN_REQUEST_STALE_MS = 60 * 60_000
/** The hook ignores a file of 64 KB or more, so one that large is never written. */
export const TURN_REQUEST_MAX_BYTES = 64 * 1024
const SWEEP_INTERVAL_MS = 10 * 60_000
const DIR_NAME = 'turn-requests'
/** A turn id is used as a file name only when it cannot escape or collide with the directory. */
const SAFE_TURN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Exactly the code points for which Python's `str.isspace()` is true. */
const PY_SPACE = '\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu')

/** Python's `str.strip()` with no arguments. */
export function stripLikePython(text: string): string {
  return text.replace(PY_STRIP, '')
}

/** Lowercase hex sha256 of the prompt as the hook will see it: UTF-8, Python-stripped. */
export function turnPromptSha256(prompt: string): string {
  return createHash('sha256').update(stripLikePython(prompt), 'utf8').digest('hex')
}

export function turnRequestDir(): string {
  return dataPath(DIR_NAME)
}

export interface TurnRequestBinding {
  /** Absolute path of the private file. */
  readonly path: string
  readonly turnId: string
  /** Delete the file. Idempotent and never throws. */
  release(): void
}

let lastSweepAt = 0

/**
 * Delete turn-request files older than `TURN_REQUEST_STALE_MS`. Runs at server startup and
 * again from `createTurnRequestBinding` at most every ten minutes, so a file whose child
 * never reported an exit (or a crash between write and spawn) cannot outlive an hour and a
 * turn. Returns how many files it removed. Never throws.
 */
export function sweepStaleTurnRequests(nowMs: number = Date.now()): number {
  lastSweepAt = nowMs
  const dir = turnRequestDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    try {
      const st = lstatSync(file)
      if (!st.isFile() && !st.isSymbolicLink()) continue
      if (nowMs - st.mtimeMs <= TURN_REQUEST_STALE_MS) continue
      unlinkSync(file)
      removed += 1
    } catch { /* raced with a release, or unreadable: leave it */ }
  }
  return removed
}

/** Ensure the private directory: a real directory (never a symlink), mode 0700. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('turn-requests is not a directory')
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
}

/**
 * Create `path` exclusively with mode 0600 and write `body`. O_EXCL refuses an existing path
 * of any kind, a planted symlink or FIFO included (POSIX: with O_CREAT|O_EXCL a symlink is
 * never followed), so nothing is ever written through a link or over another turn's file.
 * O_NOFOLLOW and O_NONBLOCK repeat that on the open line itself, as the server's hazard
 * invariants require of every synchronous open (hazard-invariants.test.ts).
 */
function writePrivateFile(path: string, body: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK, 0o600)
  let ok = false
  try {
    // The umask can only remove bits, but set it explicitly so the contract does not rest on it.
    fchmodSync(fd, 0o600)
    const bytes = Buffer.from(body, 'utf8')
    let written = 0
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
    ok = true
  } finally {
    closeSync(fd)
    if (!ok) {
      try { unlinkSync(path) } catch { /* best effort */ }
    }
  }
}

/**
 * Write the turn-request file for ONE provider spawn, or return null.
 *
 * `userText` is the raw user query as the bridge received it, before any header, context,
 * image preamble or attachment block. `prompt` is the exact text the CLI will receive as the
 * user message (stdin), byte for byte.
 *
 * Null (and no file) when there is no genuine user query (empty or whitespace only, as for a
 * pre-warm or an image with no words), when the text is not inside the prompt (the hook
 * could never bind it), when the file would reach the hook's 64 KB limit, or on any
 * filesystem failure. The binding is an optimisation for memory retrieval: it must never
 * fail or delay the turn, so every failure is logged once and swallowed.
 */
export function createTurnRequestBinding(input: {
  userText: string
  prompt: string
  turnId?: string
  now?: () => Date
}): TurnRequestBinding | null {
  const userText = typeof input.userText === 'string' ? input.userText : ''
  const stripped = stripLikePython(userText)
  if (!stripped) return null
  if (typeof input.prompt !== 'string' || !input.prompt.includes(stripped)) return null

  const now = input.now?.() ?? new Date()
  const turnId = typeof input.turnId === 'string' && SAFE_TURN_ID.test(input.turnId)
    ? input.turnId
    : randomUUID()
  const record = {
    schema_version: TURN_REQUEST_SCHEMA_VERSION,
    turn_id: turnId,
    current_user_text: userText,
    full_prompt_sha256: turnPromptSha256(input.prompt),
    created_at: now.toISOString(),
  }
  const body = JSON.stringify(record)
  if (Buffer.byteLength(body, 'utf8') >= TURN_REQUEST_MAX_BYTES) return null

  try {
    const dir = turnRequestDir()
    ensurePrivateDir(dir)
    if (lastSweepAt === 0 || now.getTime() - lastSweepAt >= SWEEP_INTERVAL_MS) {
      sweepStaleTurnRequests(now.getTime())
    }
    let path = join(dir, `${turnId}.json`)
    try {
      writePrivateFile(path, body)
    } catch (error: any) {
      // A retried turn can reuse its id while the earlier child still holds its file.
      // Never overwrite it: that child's exit would delete this one's file.
      if (error?.code !== 'EEXIST') throw error
      path = join(dir, `${randomUUID()}.json`)
      writePrivateFile(path, body)
    }
    let released = false
    return {
      path,
      turnId,
      release() {
        if (released) return
        released = true
        try { unlinkSync(path) } catch { /* already gone */ }
      },
    }
  } catch (error) {
    console.error('[turn-request] binding unavailable:', error instanceof Error ? error.message : error)
    return null
  }
}

/** The minimal child surface this needs; a real ChildProcess satisfies it. */
interface ExitObservable {
  readonly pid?: number
  once(event: 'exit' | 'close', listener: (...args: any[]) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * Delete the binding's file when the child is gone, on every path: a normal exit, a kill
 * (timeout, abort, lost ownership), and a spawn failure. Node reports a spawn failure as
 * 'error' with no pid, then 'close'; an exited child always reports 'exit' and 'close'. An
 * 'error' on a child that DID start (a failed kill) is not an exit, so it keeps the file.
 */
export function releaseTurnRequestOnExit(child: ExitObservable, binding: TurnRequestBinding | null): void {
  if (!binding) return
  child.once('exit', () => binding.release())
  child.once('close', () => binding.release())
  child.once('error', () => {
    if (child.pid === undefined) binding.release()
  })
}

/**
 * Spawn through `start` and tie the binding's file to the child's lifetime. A synchronous
 * spawn throw deletes the file before rethrowing, so no path can leave it behind.
 */
export function spawnWithTurnRequest<T extends ExitObservable>(
  binding: TurnRequestBinding | null,
  start: () => T,
): T {
  let child: T
  try {
    child = start()
  } catch (error) {
    binding?.release()
    throw error
  }
  releaseTurnRequestOnExit(child, binding)
  return child
}

/**
 * Point the child env at this spawn's file, and never at an inherited one. A server started
 * from inside an agent session could carry the variable, and a stale path must not reach a
 * hook even though the hash check would reject it.
 */
export function applyTurnRequestEnv(env: NodeJS.ProcessEnv, binding: TurnRequestBinding | null): void {
  delete env[TURN_REQUEST_ENV]
  if (binding) env[TURN_REQUEST_ENV] = binding.path
}

/** Test seam: forget the sweep clock so a test can observe the first-use sweep. */
export function resetTurnRequestSweepForTests(): void {
  lastSweepAt = 0
}
