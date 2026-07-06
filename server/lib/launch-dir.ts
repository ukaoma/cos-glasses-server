// COS brain auto-detection for the "glasses inherit your COS" promise.
//
// The npx launcher (bin/cli.cjs) records the directory the user ran `npx
// @gotcos/glasses-server` from as COS_LAUNCH_DIR before re-spawning the server
// with cwd = the package root. If that launch directory contains a COS brain
// (a Starter-Kit scaffold: .cos/manifest.json, AGENTS.md, or CLAUDE.md), chat
// spawns of claude/codex use IT as their working directory — so the CLIs load
// the user's brain exactly as they would in a terminal session in that folder.
//
// Precedence stays: COS_SCRIPTS_DIR (full COS pipeline) > detected brain dir >
// process.cwd(). Explicit config always wins.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

let cached: string | null | undefined

/** The user's launch directory IF it contains a COS brain; otherwise null. */
export function cosBrainDir(): string | null {
  if (cached !== undefined) return cached
  const raw = process.env.COS_LAUNCH_DIR?.trim()
  if (!raw) { cached = null; return cached }
  const dir = resolve(raw)
  const hasBrain =
    existsSync(join(dir, '.cos', 'manifest.json')) ||
    existsSync(join(dir, 'AGENTS.md')) ||
    existsSync(join(dir, 'CLAUDE.md'))
  cached = hasBrain ? dir : null
  return cached
}
