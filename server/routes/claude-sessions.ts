// GET /api/claude-sessions — read-only presence view of Claude Code sessions.
//
// Named `claude-sessions` rather than `peers` deliberately. COS already overloads
// "session" three ways — meeting recording sessions, COS conversation sessions, and
// now Claude OS processes — and in a system where the glasses, the phone and the
// server are all arguably peers, `/api/peers` would be ambiguous in exactly the
// place clarity matters.
//
// OFF BY DEFAULT. This reads another product's private state directory (mode 0700)
// and serves a projection of it over a socket that binds 0.0.0.0 behind a
// private-network allowlist. In a published npm package that has to be opt-in, so it
// stays dark until COS_CLAUDE_SESSIONS_ENABLED is set.
//
// The redaction rules and the reachability conjunction live in
// lib/claude-session-registry.ts, with the evidence for each. This file is the fs
// and process plumbing only.

import { Router } from 'express'
import { existsSync } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  REGISTRY_FILENAME,
  countPeers,
  sortPeers,
  toPeer,
  type ClaudePeer,
  type PeerProbes,
  type RawClaudeSession,
} from '../lib/claude-session-registry.js'

export const claudeSessionsRouter = Router()

/** Guard against a directory someone has filled with junk. */
const MAX_REGISTRY_FILES = 500

export function claudeSessionsEnabled(): boolean {
  return process.env.COS_CLAUDE_SESSIONS_ENABLED === '1'
}

/**
 * Where the registry lives.
 *
 * `COS_CLAUDE_SESSIONS_DIR` first because it is both the override for a non-standard
 * install AND the test seam — `homedir()` is not mockable, so without an env hook the
 * only testable path would be the real one. Then CLAUDE_CONFIG_DIR, which real
 * installs do set; hardcoding ~/.claude breaks those.
 */
export function claudeSessionsDir(): string {
  const explicit = process.env.COS_CLAUDE_SESSIONS_DIR
  if (explicit) return resolve(explicit)
  const configDir = process.env.CLAUDE_CONFIG_DIR
  return join(configDir ? resolve(configDir) : join(homedir(), '.claude'), 'sessions')
}

const realProbes: PeerProbes = {
  isAlive: pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error: any) {
      // ESRCH: gone. EPERM: alive but owned by another user, which is NOT reachable
      // from here and must not be reported as ours.
      return false
    }
  },
  socketExists: path => {
    try { return existsSync(path) } catch { return false }
  },
}

export async function readClaudePeers(
  dir: string,
  probes: PeerProbes = realProbes,
): Promise<ClaudePeer[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // No directory means Claude Code has never run here, or the path is wrong.
    // An empty presence list is the honest answer; the route reports `enabled`
    // separately so this cannot be mistaken for "the feature is off".
    return []
  }
  const peers: ClaudePeer[] = []
  for (const name of names.filter(n => REGISTRY_FILENAME.test(n)).slice(0, MAX_REGISTRY_FILES)) {
    const full = join(dir, name)
    try {
      // lstat, not stat: a symlink here would let anything on the filesystem be read
      // and projected onto the lens.
      const link = await lstat(full)
      if (!link.isFile()) continue
      const raw = JSON.parse(await readFile(full, 'utf-8')) as RawClaudeSession
      // mtime is the fallback for lastActiveAt only, never for liveness.
      let mtimeMs: number | null = null
      try { mtimeMs = (await stat(full)).mtimeMs } catch { /* raced the reaper */ }
      const peer = toPeer(raw, probes, mtimeMs)
      if (peer) peers.push(peer)
    } catch {
      // ENOENT between readdir and read is NORMAL here — the reaper is actively
      // unlinking these — and a torn read is expected because writes are
      // read-modify-write. Neither is worth surfacing.
      continue
    }
  }
  return sortPeers(peers)
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

claudeSessionsRouter.get('/claude-sessions', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  if (!claudeSessionsEnabled()) {
    // 200, not 503. The feature being switched off is a normal configuration, not a
    // fault, and the companion needs to tell those apart to decide whether to render
    // the section at all.
    res.json({
      peers: [],
      counts: { alive: 0, reachable: 0, stale: 0 },
      enabled: false,
      reason: 'disabled',
      generatedAt: Date.now(),
    })
    return
  }
  try {
    const limit = boundedInteger(req.query.limit, 30, 1, 100)
    const peers = await readClaudePeers(claudeSessionsDir())
    res.json({
      peers: peers.slice(0, limit),
      counts: countPeers(peers),
      enabled: true,
      generatedAt: Date.now(),
    })
  } catch (error) {
    console.error(`[claude-sessions] read failed: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: 'Failed to read Claude session registry', reason: 'registry_read_failed' })
  }
})
