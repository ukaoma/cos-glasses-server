// What a Codex session runs with, read from its own rollout (6.62.0, plan 3.2).
//
// WHY. `codex exec resume <id>` does NOT keep the session's settings. Canary C11
// (2026-10-05): a thread created `-s danger-full-access -m gpt-5.6-luna` (effort low)
// resumed with no flags ran turn 2 on `gpt-6.1-sol high workspace-write`, which are the
// CONFIG defaults. So a Continue that should carry the session's own permissions (D1)
// has to pass the session's model, effort and sandbox explicitly, and those live in the
// rollout's newest `turn_context` row.
//
// WHERE THAT ROW IS. Not in the tail a list read takes. Desktop rollout 01a10197 is 297 MB;
// its newest `turn_context` sat 3.23 MB from the end, with gaps up to 16 MB between them
// (validation W3). So the read scans BACKWARDS in 1 MB chunks up to a 64 MB cap, and the
// answer is cached by (path, size): rollouts only append, so the next read scans just the
// bytes written since (plus a small overlap for a row that was mid-write last time).
//
// WHAT IT NEVER DOES. It never broadens. No posture, or a posture this build does not
// recognise, plans the 6.61 sandbox (`getCodexTrustMode()`, normally read-only) with an
// honest note. `danger-full-access` passes through ONLY when the session ran with it AND
// the cwd sits under a folder Codex itself already trusts in `~/.codex/config.toml`
// (canaries C11/C12: in an untrusted folder `-s danger-full-access` makes Codex write a
// permanent `[projects."…"] trust_level = "trusted"` entry, which then loads that repo's
// own hooks and config). The config is parsed read-only, with a regex, and never written.

import { open, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One backward read. */
export const POSTURE_CHUNK_BYTES = 1024 * 1024
/** How far back a cold read looks before it gives up and plans the fallback. */
export const POSTURE_SCAN_CAP_BYTES = 64 * 1024 * 1024
/** Re-read before the cached size, so a row mid-write at the last read is seen whole. */
const POSTURE_REREAD_OVERLAP_BYTES = 64 * 1024
/** A `turn_context` row is about 4 KB; any line longer than this is something else. */
const MAX_TURN_CONTEXT_LINE_BYTES = 256 * 1024
const MAX_CACHE_ENTRIES = 256
const TURN_CONTEXT_MARKER = Buffer.from('"type":"turn_context"')

export type CodexSandboxType = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface CodexSessionPosture {
  model: string | null
  effort: string | null
  sandboxType: CodexSandboxType | null
  /** `sandbox_policy.network_access` for workspace-write; true for danger-full-access. */
  networkAccess: boolean | null
  approvalPolicy: string | null
  cwd: string | null
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const EFFORT_RE = /^[a-z]{2,16}$/

/** One rollout row to a posture, or null when it is not a usable `turn_context`. */
export function parseTurnContextLine(line: string): CodexSessionPosture | null {
  let row: any
  try {
    row = JSON.parse(line)
  } catch {
    return null
  }
  if (!row || typeof row !== 'object' || row.type !== 'turn_context') return null
  const payload = row.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const policy = payload.sandbox_policy
  const rawType = policy && typeof policy === 'object' ? policy.type : null
  const sandboxType: CodexSandboxType | null = rawType === 'read-only' || rawType === 'workspace-write' || rawType === 'danger-full-access'
    ? rawType
    : null
  let networkAccess: boolean | null = null
  if (sandboxType === 'danger-full-access') networkAccess = true
  else if (sandboxType === 'workspace-write' && typeof policy.network_access === 'boolean') networkAccess = policy.network_access
  else if (sandboxType === 'read-only') networkAccess = false
  const model = typeof payload.model === 'string' && MODEL_RE.test(payload.model) ? payload.model : null
  const effortRaw = typeof payload.effort === 'string'
    ? payload.effort
    : typeof payload?.collaboration_mode?.settings?.reasoning_effort === 'string'
      ? payload.collaboration_mode.settings.reasoning_effort
      : null
  const effort = effortRaw && EFFORT_RE.test(effortRaw) ? effortRaw : null
  return {
    model,
    effort,
    sandboxType,
    networkAccess,
    approvalPolicy: typeof payload.approval_policy === 'string' ? payload.approval_policy.slice(0, 32) : null,
    cwd: typeof payload.cwd === 'string' && payload.cwd.startsWith('/') ? payload.cwd : null,
  }
}

/**
 * The newest `turn_context` row in `[lower, upper)` of an open file, scanning backwards.
 * Null when there is none. A line whose start lies before `lower` is not looked at: it
 * cannot be judged whole.
 */
async function scanBackwards(
  handle: { read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }> },
  lower: number,
  upper: number,
): Promise<CodexSessionPosture | null> {
  let end = upper
  // Bytes after the first newline of the chunk we just read and before the newline that
  // ended the last line we judged: the start of a line that began in an earlier chunk.
  let carry: Buffer = Buffer.alloc(0)
  // The carry outgrew any turn_context row; skip until that line's start is found.
  let oversized = false
  while (end > lower) {
    const start = Math.max(lower, end - POSTURE_CHUNK_BYTES)
    const chunk = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, start)
    const data = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead)
    const buffer = carry.length > 0 ? Buffer.concat([data, carry]) : data
    // The tail of THIS buffer (after its last newline) is the line that was carried.
    let lineEnd = buffer.length
    let cursor = buffer.lastIndexOf(0x0a, lineEnd - 1)
    while (cursor >= 0) {
      const line = buffer.subarray(cursor + 1, lineEnd)
      if (!oversized && line.length <= MAX_TURN_CONTEXT_LINE_BYTES && line.indexOf(TURN_CONTEXT_MARKER) >= 0) {
        const posture = parseTurnContextLine(line.toString('utf8'))
        if (posture) return posture
      }
      oversized = false
      lineEnd = cursor
      cursor = lineEnd > 0 ? buffer.lastIndexOf(0x0a, lineEnd - 1) : -1
    }
    // What is left (before the first newline) began earlier; carry it, within bounds.
    const rest = buffer.subarray(0, lineEnd)
    if (start === 0) {
      // The file's first line: whole by definition.
      if (!oversized && rest.length <= MAX_TURN_CONTEXT_LINE_BYTES && rest.indexOf(TURN_CONTEXT_MARKER) >= 0) {
        return parseTurnContextLine(rest.toString('utf8'))
      }
      return null
    }
    if (oversized || rest.length > MAX_TURN_CONTEXT_LINE_BYTES) {
      carry = Buffer.alloc(0)
      oversized = true
    } else {
      carry = Buffer.from(rest)
    }
    end = start
  }
  return null
}

interface PostureCacheEntry {
  size: number
  posture: CodexSessionPosture | null
}

const postureCache = new Map<string, PostureCacheEntry>()

/** Tests only. */
export function __resetCodexPostureCacheForTests(): void {
  postureCache.clear()
  postureReadStats.reads = 0
  postureReadStats.bytes = 0
}

/** How much work the reader did: lets a test prove the cache and the incremental read. */
export const postureReadStats = { reads: 0, bytes: 0 }

/**
 * The session's newest posture, or null when the rollout carries none within the cap or
 * cannot be read. Never throws.
 */
export async function readCodexSessionPosture(path: string | null | undefined): Promise<CodexSessionPosture | null> {
  if (typeof path !== 'string' || !path.startsWith('/')) return null
  let size: number
  try {
    const st = await stat(path)
    if (!st.isFile()) return null
    size = st.size
  } catch {
    return null
  }
  const cached = postureCache.get(path)
  if (cached && cached.size === size) return cached.posture

  let lower = Math.max(0, size - POSTURE_SCAN_CAP_BYTES)
  // Grown since the last read: only the new bytes (plus the overlap) can hold a newer row.
  const incremental = !!cached && cached.size < size
  if (incremental) lower = Math.max(lower, cached!.size - POSTURE_REREAD_OVERLAP_BYTES)

  let found: CodexSessionPosture | null = null
  try {
    const handle = await open(path, 'r')
    try {
      postureReadStats.reads += 1
      postureReadStats.bytes += size - lower
      found = await scanBackwards(handle, lower, size)
    } finally {
      await handle.close()
    }
  } catch {
    return cached?.posture ?? null
  }
  const posture = found ?? (incremental ? cached!.posture : null)
  postureCache.delete(path)
  postureCache.set(path, { size, posture })
  while (postureCache.size > MAX_CACHE_ENTRIES) {
    const oldest = postureCache.keys().next()
    if (oldest.done) break
    postureCache.delete(oldest.value)
  }
  return posture
}

// ---------------------------------------------------------------------------
// Trust: which folders Codex itself already trusts
// ---------------------------------------------------------------------------

/** `~/.codex/config.toml`, honouring CODEX_HOME like the rest of the server. */
export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'config.toml')
}

/** The live config's text, or null. Read-only; never written by COS. */
export function readCodexConfigText(path = codexConfigPath()): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function unescapeTomlBasic(value: string): string {
  return value.replace(/\\(["\\])/g, '$1')
}

/**
 * Every `[projects."<path>"]` table whose `trust_level` is `"trusted"`. A regex parse on
 * purpose (the server has no TOML dependency): table headers in basic or literal strings,
 * the key read only up to the next table header.
 */
export function trustedCodexProjects(configText: string | null): string[] {
  if (typeof configText !== 'string' || configText.length === 0) return []
  const trusted: string[] = []
  const header = /^\s*\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*$/gm
  let match: RegExpExecArray | null
  while ((match = header.exec(configText)) !== null) {
    const projectPath = match[1] !== undefined ? unescapeTomlBasic(match[1]) : match[2]!
    const bodyStart = header.lastIndex
    const next = configText.slice(bodyStart).search(/^\s*\[/m)
    const body = next < 0 ? configText.slice(bodyStart) : configText.slice(bodyStart, bodyStart + next)
    if (/^\s*trust_level\s*=\s*["']trusted["']\s*(?:#.*)?$/m.test(body) && projectPath.startsWith('/')) {
      trusted.push(projectPath.replace(/\/+$/, '') || '/')
    }
  }
  return trusted
}

/** Is `cwd` that folder or inside it? Whole path segments only: `/a/b` does not cover `/a/bc`. */
export function codexCwdTrusted(cwd: string, configText: string | null): boolean {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return false
  const target = cwd.replace(/\/+$/, '') || '/'
  return trustedCodexProjects(configText).some(root => target === root || target.startsWith(root === '/' ? '/' : `${root}/`))
}

// ---------------------------------------------------------------------------
// The plan: what one Codex Continue runs with
// ---------------------------------------------------------------------------

export interface CodexContinuePlan {
  provider: 'codex'
  sandbox: CodexSandboxType
  /** `-m`, only when the model is in the full app-server list. */
  model: string | null
  /** `-c model_reasoning_effort="…"`. */
  effort: string | null
  /** `-c sandbox_workspace_write.network_access=…`, for workspace-write only. */
  networkAccess: boolean | null
  /** `session`: read from the rollout. `fallback`: the 6.61 sandbox, nothing else. */
  source: 'session' | 'fallback'
  /** At most 60 characters (plan 3.12). */
  note: string
}

export interface CodexPlanDeps {
  /** The 6.61 posture: `getCodexTrustMode()`. */
  fallbackSandbox: () => 'read-only' | 'workspace-write'
  /** The config text, read at plan time (never cached across turns). */
  configText: () => string | null
  /** Is this model in the full app-server list? */
  isKnownModel: (model: string) => boolean
  /** A display name for a known model (`gpt-6.1-sol` to `GPT-6.1 Sol`). */
  modelLabel?: (model: string) => string | null
}

export const CONTINUE_NOTE_MAX = 60

/** The first candidate that fits the lens budget. The last one must always fit. */
export function fitNote(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= CONTINUE_NOTE_MAX) return candidate
  }
  const last = candidates.filter((c): c is string => typeof c === 'string' && c.length > 0).pop() ?? ''
  return last.slice(0, CONTINUE_NOTE_MAX)
}

const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra',
}

export function effortLabel(effort: string | null): string | null {
  if (!effort) return null
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** `gpt-6.1-sol` to `GPT-6.1 Sol`, used when the catalog has no display name. */
export function defaultCodexModelLabel(model: string): string {
  return model
    .split('-')
    .map((part, index) => (index === 0 && /^gpt$/i.test(part) ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-')
    .replace(/^GPT-(\d+(?:\.\d+)*)-/, 'GPT-$1 ')
}

/**
 * The plan for one Codex Continue. Pure over its deps: every branch is a test.
 *
 * `posture` null (unreadable, or no `turn_context` within the cap) or with no sandbox this
 * build recognises: the fallback, never broader than 6.61 and never the config defaults.
 */
export function planCodexContinue(posture: CodexSessionPosture | null, cwd: string, deps: CodexPlanDeps): CodexContinuePlan {
  const fallback = (): CodexContinuePlan => {
    let sandbox: 'read-only' | 'workspace-write' = 'read-only'
    try {
      sandbox = deps.fallbackSandbox() === 'workspace-write' ? 'workspace-write' : 'read-only'
    } catch {
      sandbox = 'read-only'
    }
    return {
      provider: 'codex',
      sandbox,
      model: null,
      effort: null,
      networkAccess: null,
      source: 'fallback',
      note: sandbox === 'read-only' ? 'Read-only: session settings unreadable.' : 'Workspace write: session settings unreadable.',
    }
  }
  if (!posture || posture.sandboxType === null) return fallback()

  let known = false
  try {
    known = posture.model !== null && deps.isKnownModel(posture.model) === true
  } catch {
    known = false
  }
  const model = known ? posture.model : null
  const effort = posture.effort
  let label: string | null = null
  if (model) {
    try {
      label = deps.modelLabel?.(model) ?? null
    } catch {
      label = null
    }
    label = label || defaultCodexModelLabel(model)
  }
  const settings = [label, effortLabel(effort)].filter(Boolean).join(' ')
  const tail = model ? settings : 'Codex default model'

  if (posture.sandboxType === 'danger-full-access') {
    let trusted = false
    try {
      trusted = codexCwdTrusted(cwd, deps.configText())
    } catch {
      trusted = false
    }
    if (trusted) {
      return {
        provider: 'codex', sandbox: 'danger-full-access', model, effort, networkAccess: true, source: 'session',
        note: fitNote(`This Codex session's full access, ${tail}.`, "This Codex session's full access."),
      }
    }
    // The session ran with full access, but Codex has not trusted this folder: passing it
    // would make Codex trust it permanently. Workspace write, said plainly.
    return {
      provider: 'codex', sandbox: 'workspace-write', model, effort, networkAccess: true, source: 'session',
      note: fitNote('Workspace write: Codex has not trusted this folder.'),
    }
  }
  if (posture.sandboxType === 'workspace-write') {
    return {
      provider: 'codex', sandbox: 'workspace-write', model, effort,
      networkAccess: posture.networkAccess, source: 'session',
      note: fitNote(`This Codex session's workspace access, ${tail}.`, "This Codex session's workspace access."),
    }
  }
  return {
    provider: 'codex', sandbox: 'read-only', model, effort, networkAccess: null, source: 'session',
    note: fitNote(`Read-only, as this Codex session runs, ${tail}.`, 'Read-only, as this Codex session runs.'),
  }
}

/** `reported_model` for a Codex row (plan 1.8): `<model> <effort>`, or null. */
export function codexReportedModel(posture: CodexSessionPosture | null): string | null {
  if (!posture?.model) return null
  return posture.effort ? `${posture.model} ${posture.effort}` : posture.model
}
