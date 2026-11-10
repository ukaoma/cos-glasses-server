// X1 (Q1 review O2, 2026-11-09): WHICH engine asked, read from the process that ran the hook, never
// from the session id alone.
//
// The hook script posts its own `$PPID`, which is the Claude Code process that ran it (measured: a
// CLI 2.1.322 run and the Desktop engine 2.1.317 both, `~/.claude/sessions/<ppid>.json` names the
// same session). Reading the record for the session id instead lets a second process that shares the
// id (an older CLI, a `claude -p --resume <id>`) inherit a tab's version (Q1 O2).
//
// The entrypoint is not enough either. `claude -p` takes `CLAUDE_CODE_ENTRYPOINT` from whatever
// started it: a print run launched from a Desktop tab's shell registers as `claude-desktop`, and its
// `kind` reads `interactive` (measured 22:05). A print run has no dialog, and it does reach the
// PermissionRequest hook for an approval and waits on it (measured: a 20 s hold blocked it 20 s), so a
// full hold there would stall a headless job for up to an hour. What does tell them apart is where
// the process runs (census of 25 live sessions, 22:06):
//   - a Desktop tab's engine is a child of Claude.app's own `Contents/Helpers/disclaimer`;
//   - an interactive CLI has a controlling terminal (`ttys000`);
//   - a print run started from a shell or a tool has neither.
// Anything that cannot be read is `other`, and `other` is never proven.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EngineFacts, EngineHost } from './full-hold.js'

export function claudeSessionsRegistryDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude')
  return join(configDir, 'sessions')
}

/** `~/.claude/sessions/<pid>.json`, only when it names `sessionId`. Bounded, synchronous; null on anything else. */
export function registryRecordForPid(pid: number, sessionId: string, dir = claudeSessionsRegistryDir()): { entrypoint: string | null; version: string | null } | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    const text = readFileSync(join(dir, `${pid}.json`), 'utf-8')
    if (text.length > 256 * 1024) return null
    const raw = JSON.parse(text) as Record<string, unknown>
    if (typeof raw.sessionId !== 'string' || raw.sessionId.toLowerCase() !== sessionId.toLowerCase()) return null
    if (typeof raw.pid === 'number' && raw.pid !== pid) return null
    return {
      entrypoint: typeof raw.entrypoint === 'string' && raw.entrypoint ? raw.entrypoint : null,
      version: typeof raw.version === 'string' && raw.version ? raw.version.slice(0, 32) : null,
    }
  } catch {
    return null
  }
}

type PsRun = (args: string[]) => Promise<string | null>

const runPs: PsRun = args => new Promise(resolve => {
  try {
    execFile('/bin/ps', args, { timeout: 1_000, maxBuffer: 64 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout)))
  } catch {
    resolve(null)
  }
})

/** Where a Claude Code process runs: Claude.app's helper, a terminal, or neither. */
export async function processHost(pid: number, ps: PsRun = runPs): Promise<EngineHost> {
  if (!Number.isInteger(pid) || pid <= 1) return 'other'
  const own = await ps(['-o', 'ppid=,tty=', '-p', String(pid)])
  if (!own) return 'other'
  const [ppidRaw, tty] = own.trim().split(/\s+/)
  const ppid = Number(ppidRaw)
  if (tty && tty !== '??' && tty !== '-' && /^tty/.test(tty)) return 'terminal'
  if (!Number.isInteger(ppid) || ppid <= 1) return 'other'
  const parent = await ps(['-o', 'comm=', '-p', String(ppid)])
  const path = parent ? parent.trim() : ''
  return /\/Claude\.app\/Contents\/Helpers\/disclaimer$/.test(path) ? 'desktop-app' : 'other'
}

/** The engine facts the full hold reads, for the process that ran the hook. Null when its record does not name the session. */
export async function engineForHookProcess(sessionId: string, ppid: number | null, deps: { dir?: string; ps?: PsRun } = {}): Promise<EngineFacts | null> {
  if (ppid === null) return null
  const record = registryRecordForPid(ppid, sessionId, deps.dir)
  if (!record) return null
  return { ...record, host: await processHost(ppid, deps.ps) }
}
