// Key lanes K1 P4 (plan v4 8.2): every Codex home a reader must look in.
//
// A keyed (Lane B) Codex turn runs in its own home, `data/codex-homes/<profileId>/`, so its
// rollouts, writer locks and queue database never land in the user's `~/.codex`. Readers that
// FIND threads (the session list, the native head, the queue counts, occupancy, hook events)
// look in every home; readers of config, catalog or models stay on the server home.
//
//   codexHomes(serverHome)   the server home FIRST, then each profile home. With key lanes off
//                            or no profile home on disk it is exactly `[serverHome]`, so every
//                            reader built on it is identical to 963fe25.
//
// HARD RULE (zero impact without a key): nothing here creates a file or a directory. A profile
// home is listed only while key lanes are enabled AND `data/codex-homes/` exists. Importing this
// module reads nothing.
import { lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { dataPath } from './data-dir.js'
import { keyLanesEnabled } from './key-lanes.js'
import { isKeyProfileId } from '../../shared/key-preference.js'

/** The directory under the data dir. P1's Remove all keys deletes it (`routes/key-lanes.ts`). */
export const CODEX_PROFILE_HOMES_DIR = 'codex-homes'
/** A bound on how many profile homes one read lists (the profile store caps at 20). */
export const MAX_CODEX_PROFILE_HOMES = 64

/** The server's own Codex home: `CODEX_HOME`, else `~/.codex` (as the hooks installer reads it). */
export function serverCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CODEX_HOME?.trim()
  return raw ? resolve(raw) : join(homedir(), '.codex')
}

export function codexProfileHomesRoot(): string {
  return dataPath(CODEX_PROFILE_HOMES_DIR)
}

/** `data/codex-homes/<id>`. Throws on a malformed id (a caller bug, never user input). */
export function codexProfileHome(profileId: string): string {
  if (!isKeyProfileId(profileId)) throw new Error('invalid key profile id')
  return join(codexProfileHomesRoot(), profileId)
}

export interface CodexProfileHomeEntry {
  profileId: string
  home: string
}

/**
 * Profile homes on disk, sorted by id. Empty unless key lanes are enabled and the root exists.
 * A symlink, a file or a badly named entry is skipped, never followed.
 */
export function profileCodexHomes(env: NodeJS.ProcessEnv = process.env): CodexProfileHomeEntry[] {
  if (!keyLanesEnabled(env)) return []
  const root = codexProfileHomesRoot()
  let names: string[]
  try {
    if (!lstatSync(root).isDirectory()) return []
    names = readdirSync(root)
  } catch {
    return []
  }
  const out: CodexProfileHomeEntry[] = []
  for (const name of names.sort()) {
    if (!isKeyProfileId(name)) continue
    const home = join(root, name)
    try { if (!lstatSync(home).isDirectory()) continue } catch { continue }
    out.push({ profileId: name, home })
    if (out.length >= MAX_CODEX_PROFILE_HOMES) break
  }
  return out
}

/**
 * Every Codex home, the server home first. A reader passes its own server home (some honour
 * `COS_AGENT_SESSIONS_HOME`, some `CODEX_HOME`) so the first entry is exactly what it read before.
 */
export function codexHomes(serverHome: string = serverCodexHome(), env: NodeJS.ProcessEnv = process.env): string[] {
  return [serverHome, ...profileCodexHomes(env).map(entry => entry.home)]
}

/** The profile homes only, joined with a subpath (`sessions`, `thread-writer-locks`). */
export function profileCodexHomeSubdirs(sub: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return profileCodexHomes(env).map(entry => join(entry.home, sub))
}

/**
 * The profile id a path lives under (`data/codex-homes/<id>/...`), or undefined. Prefix-exact on
 * the real root, so a user folder that happens to be called `codex-homes` never matches.
 */
export function profileIdForCodexPath(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path) return undefined
  const root = codexProfileHomesRoot() + sep
  if (!path.startsWith(root)) return undefined
  const id = path.slice(root.length).split(sep)[0]
  return isKeyProfileId(id) ? id : undefined
}

const ROLLOUT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const MAX_DIR_ENTRIES = 512
const MAX_FILES = 20_000

/**
 * The profile whose home holds this Codex thread's rollout, or undefined. Walks
 * `sessions/<yyyy>/<mm>/<dd>/rollout-*-<id>.jsonl` in each profile home, bounded like
 * native-head's walk. With no profile home it returns at once without touching the disk.
 */
export function profileForCodexThread(threadId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const homes = profileCodexHomes(env)
  if (homes.length === 0) return undefined
  const needle = typeof threadId === 'string' ? threadId.trim().toLowerCase() : ''
  if (!/^[0-9a-f-]{36}$/.test(needle)) return undefined
  const list = (dir: string): string[] => {
    try {
      const names = readdirSync(dir)
      return names.length > MAX_DIR_ENTRIES ? [] : names
    } catch { return [] }
  }
  for (const { profileId, home } of homes) {
    let scanned = 0
    const root = join(home, 'sessions')
    for (const y of list(root)) for (const m of list(join(root, y))) for (const d of list(join(root, y, m))) {
      for (const name of list(join(root, y, m, d))) {
        if (++scanned > MAX_FILES) break
        if (!name.startsWith('rollout-')) continue
        if (ROLLOUT_ID_RE.exec(name)?.[1]?.toLowerCase() === needle) return profileId
      }
    }
  }
  return undefined
}

export function isProfileCodexThread(threadId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return profileForCodexThread(threadId, env) !== undefined
}
