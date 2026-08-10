// Who else is alive on this Mac right now.
//
// Claude Code 2.1.224+ writes one JSON file per session into
// `<CLAUDE_CONFIG_DIR|~/.claude>/sessions/<pid>.json` and binds a Unix socket at
// `/tmp/cc-socks/<pid>.sock`. This reads that directory to answer one question the
// COS session index cannot: which processes are running, and which can be reached.
//
// PRESENCE, NOT MEMORY. The COS session index is durable by design and knows what
// was discussed and which business domain it belongs to. This registry is ephemeral
// by design — actively reaped on exit and again at next startup — and knows only
// where a process runs and whether it is busy. They are different layers and
// merging them into one list would lose both meanings.
//
// FOUR THINGS THAT LOOK TRUE AND ARE NOT, all probed on this machine 2026-08-10:
//
//  1. Recency is not liveness. Compute it with a signal 0, never infer it from
//     mtime.
//  2. A socket file is not liveness. `/tmp/cc-socks` had an orphaned `.sock` whose
//     PID was dead and whose registry file no longer existed. Sockets are not
//     reaped. Reachability needs alive AND a declared socket path AND that file
//     present.
//  3. A registry file outliving its process is the EXCEPTION. An earlier draft of
//     this work claimed the two newest files were dead and built a rule on it; on
//     re-probe fifteen minutes later all files mapped to live PIDs and the two
//     called dead no longer existed. Reaping is aggressive, so an "ended sessions"
//     section will be empty almost always. Design for that empty state.
//  4. `name` is not safe to echo. `nameSource: 'auto'` means an LLM wrote the label
//     FROM THE WORK, so it can carry conversation content, and `/rename` clears
//     nameSource entirely. Only `derived` is a function of the folder name.

/** Fields this module will read. Everything else in the file is ignored. */
export interface RawClaudeSession {
  pid?: unknown
  sessionId?: unknown
  cwd?: unknown
  startedAt?: unknown
  version?: unknown
  kind?: unknown
  entrypoint?: unknown
  messagingSocketPath?: unknown
  name?: unknown
  nameSource?: unknown
  status?: unknown
  updatedAt?: unknown
  waitingFor?: unknown
}

export interface ClaudePeer {
  /** Short form of sessionId. The full UUID is not needed to render a list. */
  id: string
  name: string
  /** True when `name` was replaced because the original could carry work content. */
  nameRedacted: boolean
  workspace: string
  entrypoint: string
  kind: string
  version: string
  alive: boolean
  reachable: boolean
  status: string | null
  waitingFor: string | null
  lastActiveAt: number | null
  startedAt: number | null
}

export interface PeerProbes {
  /** signal-0 liveness. EPERM (another user) must resolve to false, not true. */
  isAlive: (pid: number) => boolean
  /** Does the declared socket file exist right now? */
  socketExists: (path: string) => boolean
}

/** A registry filename is exactly `<pid>.json`. Not `*.json`. */
export const REGISTRY_FILENAME = /^\d+\.json$/

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function millis(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** Last path segment of a cwd, with no separators and no full path. */
export function workspaceFromCwd(cwd: string | null): string {
  if (!cwd) return 'unknown'
  const parts = cwd.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : 'unknown'
}

/**
 * The label Claude derives itself: `<folder>-<suffix>`.
 *
 * Recomputing the derived form is what lets a `user` or `auto` name be replaced with
 * something that carries no conversation content while still being recognizable.
 */
export function derivedName(cwd: string | null): string {
  return workspaceFromCwd(cwd)
}

/**
 * Is this name safe to return?
 *
 * ONLY `derived`. `auto` is LLM-written from the work; `user` is arbitrary text; and
 * `/rename` deletes nameSource, so a missing value means a renamed session, not a
 * derived one. Anything but an exact `derived` gets the recomputed folder name.
 */
export function nameIsSafe(nameSource: unknown): boolean {
  return nameSource === 'derived'
}

/**
 * Project one registry entry to the wire shape, or null if it is not usable.
 *
 * NEVER spreads the parsed object. The writer can also emit `logPath` (a full
 * filesystem path), `agent`, `jobId`, `bridgeSessionId` and `parkedJobId`, none of
 * which belong on a lens. Every field below is named explicitly.
 */
export function toPeer(
  raw: RawClaudeSession,
  probes: PeerProbes,
  fallbackMtimeMs: number | null = null,
): ClaudePeer | null {
  const pid = Number(raw.pid)
  if (!Number.isInteger(pid) || pid <= 0) return null
  const sessionId = str(raw.sessionId)
  if (!sessionId) return null

  const cwd = str(raw.cwd)
  const alive = probes.isAlive(pid)
  const socketPath = str(raw.messagingSocketPath)
  // Reachability is a conjunction. Any one of these alone is a false positive:
  // an alive process on an old build has no socket, and a socket file outlives
  // its process because nothing reaps /tmp/cc-socks.
  const reachable = alive && socketPath !== null && probes.socketExists(socketPath)

  const safe = nameIsSafe(raw.nameSource)
  const rawName = str(raw.name)
  return {
    id: sessionId.slice(0, 8),
    name: safe && rawName ? rawName : derivedName(cwd),
    nameRedacted: !(safe && rawName),
    workspace: workspaceFromCwd(cwd),
    entrypoint: str(raw.entrypoint) ?? 'unknown',
    kind: str(raw.kind) ?? 'unknown',
    version: str(raw.version) ?? 'unknown',
    alive,
    reachable,
    status: str(raw.status),
    waitingFor: str(raw.waitingFor),
    lastActiveAt: millis(raw.updatedAt) ?? fallbackMtimeMs ?? millis(raw.startedAt),
    startedAt: millis(raw.startedAt),
  }
}

/**
 * Alive first, then most recently active.
 *
 * Alive-first matters because the list is a presence view: a dead row is history and
 * must never outrank something running.
 */
export function sortPeers(peers: ClaudePeer[]): ClaudePeer[] {
  return [...peers].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1
    return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
  })
}

export interface PeerCounts {
  alive: number
  reachable: number
  stale: number
}

export function countPeers(peers: readonly ClaudePeer[]): PeerCounts {
  return {
    alive: peers.filter(p => p.alive).length,
    reachable: peers.filter(p => p.reachable).length,
    stale: peers.filter(p => !p.alive).length,
  }
}
