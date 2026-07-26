// COS brain auto-detection for the "glasses inherit your COS" promise.
//
// The npx launcher (bin/cli.cjs) records the directory the user ran `npx
// @gotcos/glasses-server` from as COS_LAUNCH_DIR before re-spawning the server
// with cwd = the package root. If that launch directory contains a COS brain
// (a Starter-Kit scaffold: .cos/manifest.json, AGENTS.md, or CLAUDE.md), chat
// spawns of claude/codex use IT as their working directory — so the CLIs load
// the user's brain exactly as they would in a terminal session in that folder.
//
// Provider precedence is: selected COS_WORKDIR > legacy provider override >
// COS_SCRIPTS_DIR repository root > process.cwd(). Pipeline data still uses
// COS_SCRIPTS_DIR independently.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

let cached: string | null | undefined

export function resolveCosBrainDir(raw: string | undefined): string | null {
  const candidate = raw?.trim()
  if (!candidate) return null
  const dir = resolve(candidate)
  const hasBrain =
    existsSync(join(dir, '.cos', 'manifest.json')) ||
    existsSync(join(dir, 'AGENTS.md')) ||
    existsSync(join(dir, 'CLAUDE.md'))
  return hasBrain ? dir : null
}

/** The user's launch directory IF it contains a COS brain; otherwise null. */
export function cosBrainDir(): string | null {
  if (cached !== undefined) return cached
  // COS_WORKDIR is the provider-neutral managed setting. COS_LAUNCH_DIR stays
  // as the interactive npx compatibility path.
  cached = resolveCosBrainDir(process.env.COS_WORKDIR ?? process.env.COS_LAUNCH_DIR)
  return cached
}

/**
 * Resolve the provider working directory from one authoritative contract.
 * COS_WORKDIR (via cosBrainDir) is the user-selected agent workspace and must
 * outrank legacy provider-specific and pipeline locations. COS_SCRIPTS_DIR is
 * still used by the Python pipeline; it is only a cwd fallback here.
 */
export function resolveProviderWorkDir(options: {
  legacyProviderDir?: string | null
  scriptsDir?: string | null
  fallback?: string
} = {}): string {
  const brain = cosBrainDir()
  if (brain) return brain
  const legacy = options.legacyProviderDir?.trim()
  if (legacy) return resolve(legacy)
  const scripts = options.scriptsDir?.trim()
  if (scripts) return resolve(scripts, '..', '..')
  return resolve(options.fallback ?? process.cwd())
}

/** Test-only cache reset for environment-precedence coverage. */
export function resetCosBrainDirCacheForTests(): void {
  cached = undefined
}
