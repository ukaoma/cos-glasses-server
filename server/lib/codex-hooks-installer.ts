// Installing the COS session hook into Codex's user-level `~/.codex/hooks.json` (6.62.0), and
// knowing whether it is installed and TRUSTED.
//
// A SIBLING OF `claude-hooks-installer.ts`, never a branch of it. Claude's subscriptions,
// command bytes and status words stay exactly as they were (B2): Control 0.5.254 keys its
// banner and its Install check off `sessionHooks.state` / `installed`, and `hookHaltReady`
// feeds `deskClaude`. Codex is reported apart, as `sessionHooks.codex`.
//
// THE SAME BYTES, ITS OWN COPY AND COMMAND (QA W12). Codex runs `cos-session-hook-codex`, a
// copy of the packaged script this installer keeps current, never the stable Claude script: a
// rollback that reinstalls an older Claude script must not change what Codex runs (an older
// script has no provider stamp and a halt reply Codex fails open on). The command carries
// `COS_HOOK_PROVIDER=codex`, which makes the script print the deny-only halt reply Codex
// honours (canaries C10, C12) and stamp `"provider":"codex"` on what it spools. The bytes of
// the command never change between releases (no version in it), so a reinstall does not ask
// Miles to review the hooks again.
//
// THE MERGE NEVER MOVES A USER BLOCK (W2, QA W13). Codex trusts each hook by a POSITIONAL key,
// `<file>:<snake_event>:<block index>:<hook index>`, recorded as `trusted_hash` in
// `~/.codex/config.toml`. Claude's merge drops our block and appends a fresh one, which would
// move every user block after it to a new index and silently untrust it. Here our FIRST block
// is rewritten where it stands and a missing one is appended at the end. A second block of
// ours (a hand edit, or a COS block Codex imported from the Claude settings) is LEFT where it
// is and reported as drift: removing it would shift every user block after it, and whether
// Codex accepts an emptied group is unproven. Only a block whose every hook is ours is ours:
// a user block that also calls our script is left alone too, because rewriting it would drop
// the user's own hooks. Uninstall is the one write that removes our blocks, and a user block
// after one of them then moves (and Codex asks to review it again).
//
// TRUST IS READ, NEVER WRITTEN (K3). An untrusted user hook silently does not run (C1). Trust is
// recorded by Codex itself when Miles trusts the hooks once in the `codex` TUI; COS never writes
// `trusted_hash`. The state comes from Codex's own app-server (`hooks/list`, which also knows
// `modified`), read in the background and cached (`codex-hooks-trust` below).

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { atomicWriteFileSync } from './atomic-fs.js'
import {
  PERMISSION_HOOK_TIMEOUT_S,
  backupSettings,
  currentHookPaths,
  ensureStableHookScript,
  hookIsOurs,
  packagedHookScriptPath,
  shellQuote,
  cosGlassesHome,
  type HookPaths,
} from './claude-hooks-installer.js'
import { resolveProviderBinary } from './provider-binary.js'

export interface CodexHookSubscription {
  event: string
  /** Codex's own handler field (K2): `async` is honoured, and written explicitly every time. */
  async: boolean
  /** Codex's own handler field (K2). Claude's `timeout` may be silently ignored by Codex. */
  timeoutSec: number
  /** As Claude's PermissionRequest block: the wait rides the command as the script's `$2`. */
  passTimeout?: boolean
}

/**
 * Codex's events, its OWN list (W2). Synchronous: the turn transitions a row is derived from
 * (SessionStart, UserPromptSubmit, Stop, SessionEnd, and Interrupt, Codex's Esc), PreToolUse
 * (the halt check reads every tool call; UserPromptSubmit clears a halt marker), and
 * PermissionRequest (it must return a decision to answer from the lens). The rest are
 * fire-and-forget. Never Claude-only events (StopFailure, Notification, PostModelSwitch...),
 * which Codex does not fire.
 */
export const CODEX_HOOK_SUBSCRIPTIONS: readonly CodexHookSubscription[] = [
  { event: 'SessionStart', async: false, timeoutSec: 5 },
  { event: 'SessionEnd', async: false, timeoutSec: 5 },
  { event: 'UserPromptSubmit', async: false, timeoutSec: 5 },
  { event: 'Stop', async: false, timeoutSec: 5 },
  { event: 'Interrupt', async: false, timeoutSec: 5 },
  { event: 'PreToolUse', async: false, timeoutSec: 5 },
  { event: 'PermissionRequest', async: false, timeoutSec: PERMISSION_HOOK_TIMEOUT_S, passTimeout: true },
  { event: 'PostToolUse', async: true, timeoutSec: 10 },
  { event: 'SubagentStart', async: true, timeoutSec: 10 },
  { event: 'SubagentStop', async: true, timeoutSec: 10 },
  { event: 'PreCompact', async: true, timeoutSec: 10 },
  { event: 'PostCompact', async: true, timeoutSec: 10 },
]

/** QA W12: the script Codex runs, a copy of the packaged one beside the stable Claude script. */
export const CODEX_HOOK_SCRIPT_NAME = 'cos-session-hook-codex'

export function stableCodexHookScriptPath(): string {
  return join(cosGlassesHome(), 'bin', CODEX_HOOK_SCRIPT_NAME)
}

/** Ours in the Codex file: the Claude predicate (an imported block) or the Codex copy's name. */
function codexHookIsOurs(h: unknown): boolean {
  return hookIsOurs(h) || (!!h && typeof h === 'object' && typeof (h as { command?: unknown }).command === 'string'
    && (h as { command: string }).command.includes(`/${CODEX_HOOK_SCRIPT_NAME}`))
}

/** Codex's own home variable, as `occupancy-probes.ts` reads it. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CODEX_HOME?.trim()
  return raw ? resolve(raw) : join(homedir(), '.codex')
}

export function codexHooksPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), 'hooks.json')
}

/**
 * Is Codex on this Mac at all? Its binary resolves (the same resolution every Codex spawn
 * uses) AND it has a home: a Mac that never ran Codex gets no `~/.codex/hooks.json` from us.
 */
export function codexPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!resolveProviderBinary('codex', env).ok) return false
  try { return statSync(codexHome(env)).isDirectory() } catch { return false }
}

/** The Codex command: Claude's, with the provider in front. No version, so it never drifts on update. */
export function codexHookCommand(scriptPath: string, sub: CodexHookSubscription, paths: HookPaths = currentHookPaths()): string {
  const base = `COS_HOOK_PROVIDER=codex COS_GLASSES_HOME=${shellQuote(paths.home)} COS_HOOK_SPOOL=${shellQuote(paths.spoolDir)} ${shellQuote(scriptPath)} ${sub.event}`
  return sub.passTimeout ? `${base} ${Math.trunc(sub.timeoutSec)}` : base
}

function canonicalBlock(scriptPath: string, sub: CodexHookSubscription, paths: HookPaths): Record<string, unknown> {
  return { hooks: [{ type: 'command', command: codexHookCommand(scriptPath, sub, paths), timeoutSec: sub.timeoutSec, async: sub.async }] }
}

/** Ours only when EVERY hook in it is ours; a user block that also calls our script is not. */
function blockIsOurs(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const hooks = (block as { hooks?: unknown }).hooks
  return Array.isArray(hooks) && hooks.length > 0 && hooks.every(codexHookIsOurs)
}

/** Any hook of ours inside this block, pure or mixed. */
function blockMentionsUs(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const hooks = (block as { hooks?: unknown }).hooks
  return Array.isArray(hooks) && hooks.some(codexHookIsOurs)
}

export type CodexMergeResult =
  | { ok: true; settings: Record<string, unknown>; changed: boolean }
  | { ok: false; reason: 'codex_hooks_invalid' }

/**
 * Pure. Our first block for each subscribed event is REPLACED WHERE IT STANDS, or appended when
 * there is none; a second block of ours is left in place (and reads as drift, `duplicated`).
 * Every user block keeps its index, so every trust key Codex holds for it still names it. Other
 * events and keys pass through.
 */
export function mergeCodexHooks(current: unknown, scriptPath: string, paths: HookPaths = currentHookPaths()): CodexMergeResult {
  const settings: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {}
  const before = JSON.stringify(settings)
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) return { ok: false, reason: 'codex_hooks_invalid' }
  const hooks: Record<string, unknown> = { ...(settings.hooks as Record<string, unknown> | undefined ?? {}) }
  for (const sub of CODEX_HOOK_SUBSCRIPTIONS) {
    const value = hooks[sub.event]
    if (value !== undefined && !Array.isArray(value)) return { ok: false, reason: 'codex_hooks_invalid' }
    const blocks = Array.isArray(value) ? [...value] : []
    const ours = blocks.map((block, index) => (blockIsOurs(block) ? index : -1)).filter(index => index >= 0)
    const canonical = canonicalBlock(scriptPath, sub, paths)
    if (ours.length === 0) blocks.push(canonical)
    else blocks[ours[0]!] = canonical
    hooks[sub.event] = blocks
  }
  settings.hooks = hooks
  return { ok: true, settings, changed: JSON.stringify(settings) !== before }
}

/** Pure. Removes our blocks (every event, subscribed or not); emptied events are deleted. */
export function stripCodexHooks(current: unknown): CodexMergeResult {
  const settings: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {}
  const before = JSON.stringify(settings)
  const hooksIn = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks as Record<string, unknown> : null
  if (!hooksIn) return { ok: true, settings, changed: false }
  const hooks: Record<string, unknown> = {}
  for (const [event, blocks] of Object.entries(hooksIn)) {
    if (!Array.isArray(blocks)) { hooks[event] = blocks; continue }
    const kept = blocks.filter(block => !blockIsOurs(block))
    if (kept.length > 0) hooks[event] = kept
  }
  settings.hooks = hooks
  return { ok: true, settings, changed: JSON.stringify(settings) !== before }
}

export function codexSubscribedEvents(current: unknown, scriptPath: string, paths: HookPaths = currentHookPaths()): { subscribed: string[]; missing: string[]; drifted: string[]; duplicated: string[] } {
  const hooks = current && typeof current === 'object' ? (current as Record<string, unknown>).hooks : null
  const table = hooks && typeof hooks === 'object' ? hooks as Record<string, unknown> : {}
  const subscribed: string[] = []
  const missing: string[] = []
  const drifted: string[] = []
  const duplicated: string[] = []
  for (const sub of CODEX_HOOK_SUBSCRIPTIONS) {
    const blocks = Array.isArray(table[sub.event]) ? table[sub.event] as unknown[] : []
    const mentions = blocks.filter(blockMentionsUs)
    if (mentions.length === 0) { missing.push(sub.event); continue }
    if (mentions.length === 1 && JSON.stringify(mentions[0]) === JSON.stringify(canonicalBlock(scriptPath, sub, paths))) subscribed.push(sub.event)
    else drifted.push(sub.event)
    if (mentions.length > 1) duplicated.push(sub.event)
  }
  return { subscribed, missing, drifted, duplicated }
}

export type CodexHookInstallState =
  | 'installed'
  | 'drift'
  | 'missing'
  /** The stable script is not this package's: a Codex halt needs THIS script's deny-only reply. */
  | 'script_outdated'
  | 'hooks_unparseable'
  | 'hooks_symlink'
  | 'hooks_unreadable'

export interface CodexHookStatus {
  state: CodexHookInstallState
  installed: boolean
  hooksPath: string
  scriptPath: string
  scriptSha: string | null
  packageScriptSha: string | null
  /**
   * The stable script is this package's, byte for byte. Unlike Claude there is no halt-capable
   * earlier script: every script before 6.62.0 prints the reply Codex fails open on (C10).
   */
  scriptOk: boolean
  subscribed: string[]
  missing: string[]
  drifted: string[]
  /** QA W13: events carrying more than one block of ours. Install leaves the extra (removing it would move user blocks). */
  duplicated: string[]
}

function sha256File(path: string): string | null {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') } catch { return null }
}

type HooksRead = { ok: true; settings: unknown; existed: boolean } | { ok: false; reason: 'hooks_unparseable' | 'hooks_symlink' | 'hooks_unreadable' }

function readHooksFile(path: string): HooksRead {
  try {
    if (lstatSync(path).isSymbolicLink()) return { ok: false, reason: 'hooks_symlink' }
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { ok: true, settings: {}, existed: false }
    return { ok: false, reason: 'hooks_unreadable' }
  }
  let text: string
  try { text = readFileSync(path, 'utf-8') } catch { return { ok: false, reason: 'hooks_unreadable' } }
  try { return { ok: true, settings: JSON.parse(text), existed: true } } catch { return { ok: false, reason: 'hooks_unparseable' } }
}

export interface CodexHookPaths {
  hooksPath?: string
  scriptPath?: string
  packageScriptPath?: string
  hookPaths?: HookPaths
}

export function codexHookStatus(paths: CodexHookPaths = {}): CodexHookStatus {
  const hooksPath = paths.hooksPath ?? codexHooksPath()
  const scriptPath = paths.scriptPath ?? stableCodexHookScriptPath()
  const packageScriptPath = paths.packageScriptPath ?? packagedHookScriptPath()
  const hookPaths = paths.hookPaths ?? currentHookPaths()
  const scriptSha = sha256File(scriptPath)
  const packageScriptSha = sha256File(packageScriptPath)
  const scriptOk = scriptSha !== null && scriptSha === packageScriptSha
  const read = readHooksFile(hooksPath)
  if (!read.ok) {
    return { state: read.reason, installed: false, hooksPath, scriptPath, scriptSha, packageScriptSha, scriptOk, subscribed: [], missing: CODEX_HOOK_SUBSCRIPTIONS.map(s => s.event), drifted: [], duplicated: [] }
  }
  const events = codexSubscribedEvents(read.settings, scriptPath, hookPaths)
  let state: CodexHookInstallState
  if (events.subscribed.length === 0 && events.drifted.length === 0) state = 'missing'
  else if (events.missing.length > 0 || events.drifted.length > 0) state = 'drift'
  else if (!scriptOk) state = 'script_outdated'
  else state = 'installed'
  return { state, installed: state === 'installed', hooksPath, scriptPath, scriptSha, packageScriptSha, scriptOk, ...events }
}

export interface CodexInstallResult {
  ok: boolean
  reason?: string
  changed: boolean
  scriptCopied: boolean
  backupPath: string | null
  status: CodexHookStatus
  merged?: Record<string, unknown>
}

export function installCodexHooks(options: CodexHookPaths & { dryRun?: boolean } = {}): CodexInstallResult {
  const hooksPath = options.hooksPath ?? codexHooksPath()
  const scriptPath = options.scriptPath ?? stableCodexHookScriptPath()
  const packageScriptPath = options.packageScriptPath ?? packagedHookScriptPath()
  const hookPaths = options.hookPaths ?? currentHookPaths()
  const statusNow = () => codexHookStatus({ hooksPath, scriptPath, packageScriptPath, hookPaths })
  const refuse = (reason: string, scriptCopied = false): CodexInstallResult => ({ ok: false, reason, changed: false, scriptCopied, backupPath: null, status: statusNow() })
  const read = readHooksFile(hooksPath)
  if (!read.ok) return refuse(read.reason)
  const merged = mergeCodexHooks(read.settings, scriptPath, hookPaths)
  if (!merged.ok) return refuse(merged.reason)
  if (options.dryRun) return { ok: true, changed: merged.changed, scriptCopied: false, backupPath: null, status: statusNow(), merged: merged.settings }
  let scriptCopied = false
  try {
    scriptCopied = ensureStableHookScript(scriptPath, packageScriptPath)
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  let backupPath: string | null = null
  if (merged.changed) {
    if (read.existed) {
      backupPath = backupSettings(hooksPath)
      if (!backupPath) return refuse('backup_failed', scriptCopied)
    }
    try {
      mkdirSync(dirname(hooksPath), { recursive: true, mode: 0o700 })
      atomicWriteFileSync(hooksPath, JSON.stringify(merged.settings, null, 2) + '\n', { mode: 0o600 })
    } catch (error) {
      return refuse((error as { code?: string }).code ?? 'write_failed', scriptCopied)
    }
  }
  return { ok: true, changed: merged.changed, scriptCopied, backupPath, status: statusNow() }
}

export function uninstallCodexHooks(options: CodexHookPaths & { dryRun?: boolean } = {}): CodexInstallResult {
  const hooksPath = options.hooksPath ?? codexHooksPath()
  const scriptPath = options.scriptPath ?? stableCodexHookScriptPath()
  const packageScriptPath = options.packageScriptPath ?? packagedHookScriptPath()
  const hookPaths = options.hookPaths ?? currentHookPaths()
  const statusNow = () => codexHookStatus({ hooksPath, scriptPath, packageScriptPath, hookPaths })
  const read = readHooksFile(hooksPath)
  if (!read.ok) return { ok: false, reason: read.reason, changed: false, scriptCopied: false, backupPath: null, status: statusNow() }
  if (!read.existed) return { ok: true, changed: false, scriptCopied: false, backupPath: null, status: statusNow() }
  const stripped = stripCodexHooks(read.settings)
  if (!stripped.ok) return { ok: false, reason: stripped.reason, changed: false, scriptCopied: false, backupPath: null, status: statusNow() }
  if (options.dryRun) return { ok: true, changed: stripped.changed, scriptCopied: false, backupPath: null, status: statusNow(), merged: stripped.settings }
  let backupPath: string | null = null
  if (stripped.changed) {
    backupPath = backupSettings(hooksPath)
    if (!backupPath) return { ok: false, reason: 'backup_failed', changed: false, scriptCopied: false, backupPath: null, status: statusNow() }
    atomicWriteFileSync(hooksPath, JSON.stringify(stripped.settings, null, 2) + '\n', { mode: 0o600 })
  }
  return { ok: true, changed: stripped.changed, scriptCopied: false, backupPath, status: statusNow() }
}

// ---------------------------------------------------------------------------
// Trust: Codex's own answer, read through its app-server (K3)
// ---------------------------------------------------------------------------

/** `HookTrustStatus` from the app-server schema, plus `unknown` when the read failed. */
export type CodexHookTrust = 'trusted' | 'untrusted' | 'modified' | 'managed' | 'unknown'

export interface CodexTrustRead {
  trust: CodexHookTrust
  /** How many of our hooks the app-server listed. */
  listed: number
  /** A code when `unknown`: `spawn_failed`, `timeout`, `rpc_error`, `not_listed`, `no_binary`. */
  reason: string | null
}

export const CODEX_TRUST_TIMEOUT_MS = 15_000

/**
 * Fold the statuses of OUR hooks into one word. Any modified hook (its bytes changed since it
 * was trusted) or untrusted one means a halt cannot be relied on; a disabled hook does not run,
 * so it counts as untrusted. Codex lists the user file's hooks as `source: user`.
 */
export function foldCodexTrust(hooks: readonly unknown[]): CodexTrustRead {
  const ours = hooks.filter((h): h is Record<string, unknown> => !!h && typeof h === 'object'
    && (h as Record<string, unknown>).source === 'user' && codexHookIsOurs(h))
  if (ours.length === 0) return { trust: 'unknown', listed: 0, reason: 'not_listed' }
  const statuses = ours.map(h => (h.enabled === false ? 'untrusted' : String(h.trustStatus)))
  if (statuses.includes('modified')) return { trust: 'modified', listed: ours.length, reason: null }
  if (statuses.some(s => s !== 'trusted' && s !== 'managed')) return { trust: 'untrusted', listed: ours.length, reason: null }
  if (ours.length < CODEX_HOOK_SUBSCRIPTIONS.length) return { trust: 'untrusted', listed: ours.length, reason: 'partial' }
  return { trust: statuses.every(s => s === 'managed') ? 'managed' : 'trusted', listed: ours.length, reason: null }
}

/**
 * One `hooks/list` round trip against `codex app-server --listen stdio://`: initialize, then
 * the list for one working directory, then the child is stopped. Never throws; any failure is
 * `unknown` with a code. `binary` is the resolved Codex binary (a fixture in tests).
 */
export function readCodexHookTrust(options: { binary: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CodexTrustRead> {
  return new Promise(resolvePromise => {
    let settled = false
    let buffer = ''
    let child: ReturnType<typeof spawn> | null = null
    const finish = (value: CodexTrustRead) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child?.kill('SIGTERM') } catch { /* gone */ }
      resolvePromise(value)
    }
    const timer = setTimeout(() => finish({ trust: 'unknown', listed: 0, reason: 'timeout' }), options.timeoutMs ?? CODEX_TRUST_TIMEOUT_MS)
    timer.unref?.()
    try {
      child = spawn(options.binary, ['app-server', '--listen', 'stdio://'], { cwd: options.cwd ?? homedir(), env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      finish({ trust: 'unknown', listed: 0, reason: 'spawn_failed' })
      return
    }
    const proc = child
    const send = (message: Record<string, unknown>) => {
      try { proc.stdin?.write(JSON.stringify(message) + '\n') } catch { /* the exit handler answers */ }
    }
    proc.on('error', () => finish({ trust: 'unknown', listed: 0, reason: 'spawn_failed' }))
    proc.on('exit', () => finish({ trust: 'unknown', listed: 0, reason: 'rpc_error' }))
    proc.stdin?.on('error', () => { /* a dead child; the exit handler answers */ })
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 4 * 1024 * 1024) { finish({ trust: 'unknown', listed: 0, reason: 'rpc_error' }); return }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let message: Record<string, unknown>
        try { message = JSON.parse(line) as Record<string, unknown> } catch { continue }
        if (message.id === 1) {
          if (message.error) { finish({ trust: 'unknown', listed: 0, reason: 'rpc_error' }); return }
          send({ method: 'initialized' })
          send({ id: 2, method: 'hooks/list', params: { cwds: [options.cwd ?? homedir()] } })
        } else if (message.id === 2) {
          const result = message.result as { data?: unknown } | undefined
          if (message.error || !result || !Array.isArray(result.data)) { finish({ trust: 'unknown', listed: 0, reason: 'rpc_error' }); return }
          const hooks = result.data.flatMap(entry => (entry && typeof entry === 'object' && Array.isArray((entry as { hooks?: unknown }).hooks) ? (entry as { hooks: unknown[] }).hooks : []))
          finish(foldCodexTrust(hooks))
          return
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cos-glasses-server', version: '0' } } })
  })
}

/** Codex's trust, cached five minutes (a spawn of the app-server is not a health-poll cost). */
export const CODEX_TRUST_CACHE_MS = 5 * 60_000

let trustCache: { at: number; value: CodexTrustRead } | null = null
let trustInFlight: Promise<CodexTrustRead> | null = null

export function cachedCodexHookTrust(nowMs = Date.now()): (CodexTrustRead & { checkedAt: number | null }) {
  if (trustCache && nowMs - trustCache.at < CODEX_TRUST_CACHE_MS) return { ...trustCache.value, checkedAt: trustCache.at }
  return { trust: 'unknown', listed: 0, reason: trustCache ? 'stale' : 'unchecked', checkedAt: trustCache?.at ?? null }
}

/**
 * Refresh the trust cache now (after an install, or on the background tick). One read at a
 * time; a caller during a read gets that read. With no Codex binary the answer is `unknown`.
 */
export function refreshCodexHookTrust(options: { binary?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; now?: () => number } = {}): Promise<CodexTrustRead> {
  if (trustInFlight) return trustInFlight
  const binary = options.binary ?? (() => {
    const resolved = resolveProviderBinary('codex', options.env ?? process.env)
    return resolved.ok ? resolved.path : null
  })()
  const read = binary
    ? readCodexHookTrust({ binary, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs })
    : Promise.resolve<CodexTrustRead>({ trust: 'unknown', listed: 0, reason: 'no_binary' })
  trustInFlight = read.then(value => {
    trustCache = { at: (options.now ?? Date.now)(), value }
    return value
  }).finally(() => { trustInFlight = null })
  return trustInFlight
}

export function __resetCodexHookTrustForTests(): void {
  trustCache = null
  trustInFlight = null
}

/** For `--hooks status`: say in words what a Codex state means. Null when ready. */
export function codexHookAdvice(status: Pick<CodexHookStatus, 'installed' | 'state'> & Partial<Pick<CodexHookStatus, 'duplicated'>>, trust: CodexHookTrust): string | null {
  if (status.duplicated && status.duplicated.length > 0) {
    // QA W13: Install leaves these alone (removing one would move the user's blocks).
    return `~/.codex/hooks.json carries the COS hook more than once for ${status.duplicated.join(', ')}, so it runs twice there. `
      + 'Remove the extra COS block by hand; Install never moves or removes your blocks.'
  }
  if (!status.installed) {
    return status.state === 'missing' || status.state === 'drift' || status.state === 'script_outdated'
      ? 'The COS hooks in ~/.codex/hooks.json are not current. Run `npx --yes @gotcos/glasses-server@latest --hooks install`, or press Install hooks in COS Control.'
      : 'The Codex hooks file could not be read as it is; nothing was changed. Fix or restore it, then install again.'
  }
  if (trust === 'trusted' || trust === 'managed') return null
  if (trust === 'unknown') return 'Codex did not say whether it trusts the COS hooks (see trustReason). If they never ran, run `codex` in Terminal and choose Trust all and continue.'
  return 'Codex has not trusted the COS hooks yet, so they do not run. Run `codex` in Terminal and choose Trust all and continue.'
}

