// Where does a resumed provider turn actually run?
//
// The attach route resolves this server-side because plan 4.2 forbids the client
// sending a path, and the adapter needs a real cwd to spawn in. It is the missing
// half of `TargetResolution`, which carries non-identifying fingerprints for the
// wire but no directory to run in.
//
// WHY NOT DECODE THE PROJECT SLUG. Claude files transcripts under
// `~/.claude/projects/<slug>/<id>.jsonl` where the slug is the cwd with separators
// replaced. Decoding it back is LOSSY and wrong on this very machine:
//     slug   -Users-ukaoma-Documents-GitHub-Ukaoma-Chief-Of-Staff-MU-Chief-Staff
//     naive  /Users/ukaoma/Documents/GitHub/Ukaoma/Chief/Of/Staff/MU/Chief/Staff
//     real   /Users/ukaoma/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff
// The real path contains spaces AND hyphens, so the mapping is not invertible.
// Resuming in the wrong cwd is not a harmless error: Claude associates a session
// with its project, so a mismatched cwd risks writing a NEW session instead of
// appending to the target — a silent fork, which is precisely the outcome the
// adapter's id-equality check exists to catch and which is better never caused.
//
// So the cwd is read from the transcript itself, which records it verbatim.
// Verified 2026-08-16: Claude message rows carry a top-level `cwd` (234 of the
// first 300 rows of a live transcript, all identical); Codex records it once in the
// session meta row as `payload.cwd`.
//
// EVERYTHING HERE FAILS CLOSED. Ambiguity, an unreadable transcript, a missing cwd,
// a relative path, or a directory that no longer exists all return null, and a null
// makes attach REFUSE. A wrong cwd is worse than no attach.

import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { realNativeHeadDeps, transcriptPathFor, type NativeHeadDeps } from './native-head.js'

export type AttachedWorkspaceProvider = 'claude' | 'codex'

export interface ResolvedWorkspace {
  /**
   * Real directory to spawn in. SERVER-SIDE ONLY — never goes on the wire.
   * Plan 3.3 requires the client-visible reference to carry no filesystem path.
   */
  path: string
  /** Non-identifying, stable. Safe to persist in a binding and compare. */
  workspaceFingerprint: string
  /** Which transcript the cwd came from, fingerprinted the same way. */
  sourceFingerprint: string
}

export interface AttachedWorkspaceDeps {
  /** Absolute path of the transcript for this thread, or null when not exactly one. */
  transcriptPath: (provider: AttachedWorkspaceProvider, threadId: string) => string | null
  /** First bytes of the transcript. Null when unreadable. */
  readHead: (path: string, maxBytes: number) => string | null
  /** Does this directory exist right now? MUST THROW on "cannot tell". */
  dirExists: (path: string) => boolean
}

/** Enough to reach a Claude message row or the Codex session meta row. */
export const WORKSPACE_SCAN_BYTES = 512 * 1024

/** Rows to inspect before giving up. Bounds a pathological single-line file. */
export const WORKSPACE_SCAN_ROWS = 400

export function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Pull the recorded cwd out of transcript text.
 *
 * Claude puts it at the row's top level; Codex puts it in the session meta row's
 * `payload`. A torn trailing line is NORMAL — these files are appended to — so a
 * parse failure on any single row is skipped rather than fatal.
 *
 * Returns null when no row records one, and DISAGREEMENT is also null: a transcript
 * whose rows claim two different working directories is not something to guess at.
 */
export function cwdFromTranscript(text: string): string | null {
  const seen = new Set<string>()
  let rows = 0
  for (const line of text.split('\n')) {
    if (rows >= WORKSPACE_SCAN_ROWS) break
    const trimmed = line.trim()
    if (!trimmed) continue
    rows++
    let row: unknown
    try { row = JSON.parse(trimmed) } catch { continue }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const direct = record.cwd
    if (typeof direct === 'string' && direct.length > 0) seen.add(direct)
    const payload = record.payload
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const nested = (payload as Record<string, unknown>).cwd
      if (typeof nested === 'string' && nested.length > 0) seen.add(nested)
    }
    // One consistent answer found early is enough; keep scanning only while it is
    // still the only one, so a disagreement is detected rather than short-circuited.
    if (seen.size > 1) return null
  }
  if (seen.size !== 1) return null
  return [...seen][0]!
}

/**
 * Resolve where an attached turn for this thread must run.
 *
 * Null means REFUSE THE ATTACH. Callers must not substitute a default, and must
 * not fall back to the server's own cwd — that would run the user's turn against
 * whatever directory the LaunchAgent happened to start in.
 */
export function resolveAttachedWorkspace(
  provider: string,
  threadId: string,
  deps: AttachedWorkspaceDeps,
): ResolvedWorkspace | null {
  if (provider !== 'claude' && provider !== 'codex') return null
  let path: string | null
  let text: string | null
  try {
    path = deps.transcriptPath(provider, threadId)
    if (path === null) return null
    text = deps.readHead(path, WORKSPACE_SCAN_BYTES)
  } catch {
    return null
  }
  if (text === null) return null

  const cwd = cwdFromTranscript(text)
  if (cwd === null) return null
  // A relative cwd would resolve against the SERVER's working directory, which is
  // not a location we control and is never what the user meant.
  if (!isAbsolute(cwd)) return null

  let exists: boolean
  try {
    exists = deps.dirExists(cwd)
  } catch {
    return null
  }
  // The workspace was deleted or moved since the thread was last used. Spawning
  // there fails or, worse, succeeds somewhere unintended.
  if (!exists) return null

  return {
    path: cwd,
    workspaceFingerprint: fingerprint(cwd),
    sourceFingerprint: fingerprint(path),
  }
}

/**
 * Real filesystem wiring.
 *
 * `readHead`, not a tail read: the cwd lives in the EARLY rows (Claude's first
 * message row, Codex's session meta row), and the tail of a 13 GB rollout does not
 * contain it.
 *
 * O_NONBLOCK for the same reason `occupancy-probes.readFile` needs it — `openSync`
 * on a writer-less FIFO never returns, and it is a synchronous syscall on Node's
 * single thread, so one planted path would wedge the whole server rather than this
 * request. The `isFile` check runs after the open and cannot prevent that alone.
 */
export function realAttachedWorkspaceDeps(
  headDeps: NativeHeadDeps = realNativeHeadDeps(),
): AttachedWorkspaceDeps {
  return {
    transcriptPath: (provider, threadId) => transcriptPathFor(provider, threadId, headDeps),

    readHead: (path, maxBytes) => {
      let fd: number | null = null
      try {
        const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
        const nonBlock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0
        fd = openSync(path, fsConstants.O_RDONLY | noFollow | nonBlock)
        const stat = statSync(path, { throwIfNoEntry: false })
        if (stat === undefined || !stat.isFile()) return null
        const size = Math.min(maxBytes, stat.size)
        if (size <= 0) return null
        const buffer = Buffer.allocUnsafe(size)
        const read = readSync(fd, buffer, 0, size, 0)
        return buffer.subarray(0, read).toString('utf8')
      } catch {
        return null
      } finally {
        if (fd !== null) { try { closeSync(fd) } catch { /* already gone */ } }
      }
    },

    // ENOENT is absent; every other errno is "cannot tell" and throws, which the
    // resolver turns into a refusal. A bare catch here would let an unreadable
    // workspace look like a deleted one.
    dirExists: (path) => {
      const stat = statSync(path, { throwIfNoEntry: false })
      return stat !== undefined && stat.isDirectory()
    },
  }
}
