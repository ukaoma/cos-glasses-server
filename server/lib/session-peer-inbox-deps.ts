// The real world behind `session-peer-inbox.ts`: the registry directory, the key
// file beside each record, the session's transcript, and the flag.
//
// Kept apart from the pure module so the contract there never touches a path, and so
// this file is the ONE place that knows where Claude Code keeps these things. All of
// it is read-only: nothing here writes to `~/.claude`.

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeSessionsDir, REGISTRY_FILENAME } from './claude-session-registry.js'
import { transcriptPathFor, type NativeHeadDeps } from './native-head.js'
import { cosSpawnedPids } from './agent-session-ownership-store.js'
import { readTranscriptTailLines } from './thread-turn-queue-store.js'
import {
  deliverOverPeerInbox,
  type PeerDeliveryResult,
  type PeerInboxRecord,
  type TranscriptRowLike,
} from './session-peer-inbox.js'

/**
 * `COS_CONTINUE_LIVE`. OFF by default in 6.49.0.
 *
 * The transport rides a protocol Claude Code documents in a help string, not a
 * contract, and the first days are for reading the health row on one Mac. A literal
 * '1' turns it on; anything else, including absence, keeps every Continue on the
 * 6.48.2 path. Control's env allowlist carries the key so Update Server keeps it.
 */
export function continueLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_CONTINUE_LIVE === '1'
}

/** Registry files are small; anything larger is not one. */
const MAX_RECORD_BYTES = 64 * 1024
/** `<pid>.<64 hex>.key`, the sibling of `<pid>.json`. */
const KEY_FILENAME = /^(\d+)\.[0-9a-f]{64}\.key$/
/** Enough of the tail to hold the acceptance row for any prompt we could have sent. */
const ACCEPTANCE_TAIL_BYTES = 256 * 1024

/** One pass over `~/.claude/sessions`, records only. Never throws. */
export function readPeerInboxRecords(dir: string = claudeSessionsDir()): PeerInboxRecord[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: PeerInboxRecord[] = []
  for (const name of names) {
    if (!REGISTRY_FILENAME.test(name)) continue
    const full = join(dir, name)
    try {
      // lstat, not stat: a symlink here would let anything on the filesystem be read.
      const link = lstatSync(full)
      if (!link.isFile() || link.size > MAX_RECORD_BYTES) continue
      const raw = JSON.parse(readFileSync(full, 'utf-8')) as Record<string, unknown>
      const pid = Number(raw.pid)
      const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim().toLowerCase() : ''
      if (!Number.isInteger(pid) || pid <= 0 || !sessionId) continue
      out.push({
        pid,
        sessionId,
        socketPath: typeof raw.messagingSocketPath === 'string' && raw.messagingSocketPath.length > 0 ? raw.messagingSocketPath : null,
        peerProtocol: typeof raw.peerProtocol === 'number' && Number.isInteger(raw.peerProtocol) ? raw.peerProtocol : null,
        entrypoint: typeof raw.entrypoint === 'string' ? raw.entrypoint : null,
        status: typeof raw.status === 'string' ? raw.status : null,
      })
    } catch {
      // A torn read or a record the reaper just unlinked. Ordinary.
      continue
    }
  }
  return out
}

/**
 * The session's peer token, or null.
 *
 * Auth is optional on this platform (see the pure module's header), so null is the
 * common, acceptable answer whenever the file is absent, unreadable, or not ours.
 * The value is returned to the caller and never logged.
 */
export function readPeerToken(record: PeerInboxRecord, dir: string = claudeSessionsDir()): string | null {
  let names: string[]
  try { names = readdirSync(dir) } catch { return null }
  for (const name of names) {
    const m = KEY_FILENAME.exec(name)
    if (!m || Number(m[1]) !== record.pid) continue
    try {
      const full = join(dir, name)
      const link = lstatSync(full)
      if (!link.isFile() || link.size > 4096) return null
      const parsed = JSON.parse(readFileSync(full, 'utf-8')) as { peerToken?: unknown }
      return typeof parsed.peerToken === 'string' && parsed.peerToken.length > 0 ? parsed.peerToken : null
    } catch {
      return null
    }
  }
  return null
}

/** The newest rows of the session's transcript, parsed; [] when there is no file. */
export function readAcceptanceTail(sessionId: string, nativeHeadDeps: NativeHeadDeps): TranscriptRowLike[] {
  const path = transcriptPathFor('claude', sessionId, nativeHeadDeps)
  const lines = readTranscriptTailLines(path, ACCEPTANCE_TAIL_BYTES)
  if (!lines) return []
  const rows: TranscriptRowLike[] = []
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    try { rows.push(JSON.parse(line) as TranscriptRowLike) } catch { /* torn tail line */ }
  }
  return rows
}

export interface LiveDeliveryStats {
  attempts: number
  delivered: number
  /** By reason, so the health row says WHY the spawn path was taken. */
  fallbacks: Record<string, number>
  lastReason: string | null
  lastAt: number | null
}

const stats: LiveDeliveryStats = { attempts: 0, delivered: 0, fallbacks: {}, lastReason: null, lastAt: null }

/** For `/api/health`. A copy, never the live object. */
export function liveDeliveryStats(): LiveDeliveryStats {
  return { ...stats, fallbacks: { ...stats.fallbacks } }
}

/**
 * The route's dep: try the running session, report honestly. `disabled` is not
 * counted as an attempt, so the health row stays quiet while the flag is off.
 */
export function makeLiveTurnDeliverer(nativeHeadDeps: NativeHeadDeps) {
  return async (request: { provider: string; sessionId: string; prompt: string; verifyTimeoutMs?: number }): Promise<PeerDeliveryResult> => {
    const result = await deliverOverPeerInbox(
      { ...request, enabled: continueLiveEnabled() },
      {
        records: () => readPeerInboxRecords(),
        token: record => readPeerToken(record),
        transcriptTail: id => readAcceptanceTail(id, nativeHeadDeps),
        isCosOwnedPid: pid => cosSpawnedPids().has(pid),
        log: (level, event, detail) => {
          const line = `[${event}] ${JSON.stringify(detail)}`
          if (level === 'warn') console.warn(line)
          else console.log(line)
        },
      },
    )
    if (result.reason !== 'disabled') {
      stats.attempts += 1
      if (result.ok) stats.delivered += 1
      else stats.fallbacks[result.reason] = (stats.fallbacks[result.reason] ?? 0) + 1
      stats.lastReason = result.reason
      stats.lastAt = Date.now()
    }
    return result
  }
}
