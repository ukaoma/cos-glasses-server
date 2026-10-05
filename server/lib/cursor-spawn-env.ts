// Every Cursor `agent` spawn gets a config dir of its own (6.62.0, plan 3.4, canaries C9/K1).
//
// WHY. The CLI REWRITES `~/.cursor/cli-config.json` (`model`, `selectedModel`,
// `modelParameters`, `modelSelectionHistory`) whenever a run passes `--model` (C9,
// confirmed twice). COS passes `--model` on Continue, Messages, reviews, Live Cues and
// the lens gist, so every one of those silently changed the person's own CLI default.
//
// THE FIX, AS K1 PROVED IT (2026-10-05 09:21): `CURSOR_CONFIG_DIR` = a fresh per-spawn
// dir (0700) holding a COPY of `cli-config.json` (so auth and permissions follow the
// person's current config), with symlinks to `~/.cursor/{chats,hooks.json,mcp.json,
// plugins,skills-cursor}` so a `--resume` finds the chat, the COS observer still fires,
// and MCP servers still load. The rewrite lands in the copy, and the copy is deleted when
// the child exits.
//
// PER SPAWN, NEVER SHARED. One shared dir races between overlapping spawns (and the CLI
// already leaves `cli-config.json.*.tmp` files behind by the thousand). `mkdtemp` gives
// each child its own.
//
// CHILD ENV ONLY. `CURSOR_CONFIG_DIR` is set on the env object handed to the spawn, never
// on `process.env`: the server's own later reads must keep seeing the person's real dir.
//
// SYMLINKS ARE NEVER FOLLOWED ON CLEANUP. `release` unlinks each link by name first, then
// removes the dir. Deleting through `chats` would delete the person's chats.
//
// `dictation-clean.ts` is exempt: it builds a STRICTER per-spawn profile of its own (no
// MCP, no hooks, no inherited permissions), which this must not loosen.

import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, chmodSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** What K1 linked. The census test and `bin/cli.cjs` read this exact list. */
export const CURSOR_SPAWN_LINKS = ['chats', 'hooks.json', 'mcp.json', 'plugins', 'skills-cursor'] as const

/** A spawn dir older than this belongs to a server that died mid-run; a Continue lasts 30 min at most. */
export const CURSOR_SPAWN_STALE_MS = 6 * 60 * 60_000

const SPAWN_PREFIX = 'spawn-'

export interface CursorSpawnEnvOptions {
  /** The env the caller built for the child (already stripped as it wants). Default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv
  /** The person's Cursor config dir. Default: `CURSOR_CONFIG_DIR` of the server, else `~/.cursor`. */
  sourceDir?: string
  /** Where per-spawn dirs live. Default `~/.cos-glasses/cursor-cli`. */
  root?: string
  now?: number
}

export interface CursorSpawnIsolation {
  /** The child's env. Carries `CURSOR_CONFIG_DIR` only when `isolated`. */
  env: NodeJS.ProcessEnv
  dir: string | null
  isolated: boolean
  /** Idempotent. Unlinks the links by name, then removes the dir. */
  release: () => void
}

export const cursorSpawnStats = { created: 0, released: 0, failed: 0, swept: 0 }

/**
 * `~/.cos-glasses/cursor-cli`. `COS_CURSOR_SPAWN_ROOT` and `COS_CURSOR_SPAWN_SOURCE` exist
 * for the test config only (vitest.config.ts), so no suite that drives a Cursor spawn path
 * can read the live ~/.cursor or write under the live ~/.cos-glasses. Production sets neither.
 */
export function cursorSpawnRoot(): string {
  return process.env.COS_CURSOR_SPAWN_ROOT?.trim() || join(homedir(), '.cos-glasses', 'cursor-cli')
}

export function defaultCursorSourceDir(env: NodeJS.ProcessEnv = process.env): string {
  return process.env.COS_CURSOR_SPAWN_SOURCE?.trim() || env.CURSOR_CONFIG_DIR?.trim() || join(homedir(), '.cursor')
}

/** Remove one spawn dir without ever following a link out of it. */
export function removeCursorSpawnDir(dir: string): void {
  for (const name of CURSOR_SPAWN_LINKS) {
    const path = join(dir, name)
    try {
      if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
    } catch { /* absent */ }
  }
  // Anything else the CLI made in here is its own (the rewritten config, a stats cache).
  // A link the CLI made under another name is unlinked, not followed, by rmSync.
  rmSync(dir, { recursive: true, force: true })
}

/** Remove spawn dirs a dead server left behind. Never touches anything not named `spawn-*`. */
export function sweepStaleCursorSpawnDirs(root = cursorSpawnRoot(), now = Date.now(), maxAgeMs = CURSOR_SPAWN_STALE_MS): number {
  let names: string[]
  try { names = readdirSync(root) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(SPAWN_PREFIX)) continue
    const dir = join(root, name)
    try {
      const st = lstatSync(dir)
      if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue
      removeCursorSpawnDir(dir)
      removed++
    } catch { /* gone, or not ours to judge */ }
  }
  cursorSpawnStats.swept += removed
  return removed
}

let lastSweepAt = 0

/**
 * A config dir for ONE Cursor child. On any failure the child runs with the caller's env
 * unchanged (`isolated: false`): the 6.61 behaviour, logged and counted, never a refused
 * spawn, because a broken scratch dir must not take Continue or Messages down with it.
 */
export function cursorSpawnEnv(options: CursorSpawnEnvOptions = {}): CursorSpawnIsolation {
  const baseEnv = options.baseEnv ?? process.env
  const root = options.root ?? cursorSpawnRoot()
  const sourceDir = options.sourceDir ?? defaultCursorSourceDir(baseEnv)
  const now = options.now ?? Date.now()
  if (now - lastSweepAt > 10 * 60_000) {
    lastSweepAt = now
    try { sweepStaleCursorSpawnDirs(root, now) } catch { /* best effort */ }
  }
  let dir: string | null = null
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    dir = mkdtempSync(join(root, SPAWN_PREFIX))
    chmodSync(dir, 0o700)
    const config = join(sourceDir, 'cli-config.json')
    if (existsSync(config)) {
      copyFileSync(config, join(dir, 'cli-config.json'))
      chmodSync(join(dir, 'cli-config.json'), 0o600)
    }
    // `chats` must exist at the source: without it the CLI would write a new chat into this
    // dir, and the dir is deleted when the child exits.
    try {
      if (!existsSync(join(sourceDir, 'chats'))) mkdirSync(join(sourceDir, 'chats'), { recursive: true, mode: 0o700 })
    } catch { /* the link below still points at where the chats belong */ }
    for (const name of CURSOR_SPAWN_LINKS) {
      const target = join(sourceDir, name)
      try {
        statSync(target)
      } catch {
        continue
      }
      symlinkSync(target, join(dir, name))
    }
  } catch (error) {
    cursorSpawnStats.failed += 1
    console.warn(`[cursor-spawn-env] isolation unavailable, child uses the shared config: ${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message : error}`)
    if (dir) {
      try { removeCursorSpawnDir(dir) } catch { /* best effort */ }
    }
    return { env: { ...baseEnv }, dir: null, isolated: false, release: () => {} }
  }
  cursorSpawnStats.created += 1
  const env: NodeJS.ProcessEnv = { ...baseEnv, CURSOR_CONFIG_DIR: dir }
  let released = false
  const isolatedDir = dir
  return {
    env,
    dir: isolatedDir,
    isolated: true,
    release: () => {
      if (released) return
      released = true
      try {
        removeCursorSpawnDir(isolatedDir)
        cursorSpawnStats.released += 1
      } catch (error) {
        console.warn(`[cursor-spawn-env] cleanup failed: ${error instanceof Error ? error.message : error}`)
      }
    },
  }
}

/**
 * Release the isolation when the child is done: on `close`, or on an `error` from a child
 * that never started (no pid). An `error` from a RUNNING child (a failed kill) is not the
 * end of it, and pulling its config dir out from under it mid-run would be.
 */
export function releaseCursorSpawnOnExit(
  child: { pid?: number; once?: (event: string, listener: (...args: any[]) => void) => unknown; on: (event: string, listener: (...args: any[]) => void) => unknown },
  isolation: CursorSpawnIsolation,
): void {
  const listen = typeof child.once === 'function' ? child.once.bind(child) : child.on.bind(child)
  listen('close', () => isolation.release())
  listen('error', () => {
    if (typeof child.pid !== 'number') isolation.release()
  })
}
