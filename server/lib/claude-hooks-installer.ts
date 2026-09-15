// Installing the COS session hook into `~/.claude/settings.json`, and knowing whether it
// is installed.
//
// USER LEVEL ONLY. Hooks in `~/.claude/settings.json` fire for every Claude Code session
// on this Mac (Desktop tabs, the CLI, `claude -p` jobs). The project-level file the COS
// repo owns (seven memory and canvas hooks) is never touched; Claude merges levels, so
// both sets run.
//
// THE MERGE IS A PURE FUNCTION over the settings object (`mergeHookSettings`), tested
// against the real file's shape: keep every block whose commands do not name our script,
// drop every block that does, append one canonical block per subscribed event. Other
// events and every other top-level key pass through untouched. Nothing is written when
// the merged object equals the current one.
//
// STABLE PATH. The script is copied from the package (`bin/hooks/cos-session-hook`) to
// `~/.cos-glasses/bin/cos-session-hook`, because the managed runtime's generation
// directory changes on every server update and a settings file pointing into it would
// break at the first Update Server. `status` reports `script_outdated` when the package
// copy differs from the installed one, and `install` re-copies.

import { copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync } from './atomic-fs.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Substring that marks a hook block as ours, whatever the home directory is. */
export const HOOK_SCRIPT_MARKER = '/.cos-glasses/bin/cos-session-hook'
export const HOOK_SCRIPT_NAME = 'cos-session-hook'

export interface HookSubscription {
  event: string
  matcher?: string
  async: boolean
  timeout: number
}

/**
 * Every event the reducer understands, with the timing each one needs. SessionStart,
 * Stop and SessionEnd are synchronous: measured 2026-09-15, an async Stop was dropped
 * when a print-mode process exited right after it (PostToolUse landed, Stop did not),
 * and Stop carries the idle transition and the reply. The write is a few milliseconds.
 * PermissionRequest must be synchronous to return a decision; the rest are
 * fire-and-forget.
 */
export const HOOK_SUBSCRIPTIONS: readonly HookSubscription[] = [
  { event: 'SessionStart', async: false, timeout: 5 },
  { event: 'SessionEnd', async: false, timeout: 5 },
  { event: 'UserPromptSubmit', async: true, timeout: 10 },
  { event: 'Stop', async: false, timeout: 5 },
  { event: 'StopFailure', async: true, timeout: 10 },
  { event: 'PermissionRequest', async: false, timeout: 130 },
  { event: 'PermissionDenied', async: true, timeout: 10 },
  { event: 'PreToolUse', matcher: 'AskUserQuestion|ExitPlanMode', async: true, timeout: 10 },
  { event: 'PostToolUse', async: true, timeout: 10 },
  { event: 'PostToolUseFailure', async: true, timeout: 10 },
  { event: 'Notification', matcher: 'permission_prompt|idle_prompt|elicitation_dialog|agent_needs_input', async: true, timeout: 10 },
  { event: 'SubagentStart', async: true, timeout: 10 },
  { event: 'SubagentStop', async: true, timeout: 10 },
  { event: 'PostCompact', async: true, timeout: 10 },
  { event: 'PostModelSwitch', async: true, timeout: 10 },
]

export function cosGlassesHome(): string {
  return process.env.COS_GLASSES_HOME ? resolve(process.env.COS_GLASSES_HOME) : join(homedir(), '.cos-glasses')
}

export function claudeSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude')
  return join(configDir, 'settings.json')
}

export function stableHookScriptPath(): string {
  return join(cosGlassesHome(), 'bin', HOOK_SCRIPT_NAME)
}

/** The copy shipped in this package. */
export function packagedHookScriptPath(): string {
  return resolve(__dirname, '..', '..', 'bin', 'hooks', HOOK_SCRIPT_NAME)
}

export function hookTokenPath(): string { return join(cosGlassesHome(), 'hook-token') }
export function hookPortPath(): string { return join(cosGlassesHome(), 'hook-port') }
export function hookDeskIdlePath(): string { return join(cosGlassesHome(), 'hook-desk-idle-s') }

/** sh-safe quoting for the settings command string. Paths with spaces get single quotes. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

export function hookCommand(scriptPath: string, event: string): string {
  return `${shellQuote(scriptPath)} ${event}`
}

type HookBlock = { matcher?: unknown; hooks?: unknown }

function blockIsOurs(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const hooks = (block as HookBlock).hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some(h => h && typeof h === 'object' && typeof (h as { command?: unknown }).command === 'string'
    && ((h as { command: string }).command.includes(HOOK_SCRIPT_MARKER) || (h as { command: string }).command.includes(HOOK_SCRIPT_NAME + ' ')))
}

function canonicalBlock(scriptPath: string, sub: HookSubscription): Record<string, unknown> {
  const hook: Record<string, unknown> = { type: 'command', command: hookCommand(scriptPath, sub.event), timeout: sub.timeout }
  if (sub.async) hook.async = true
  return sub.matcher ? { matcher: sub.matcher, hooks: [hook] } : { hooks: [hook] }
}

export interface MergeResult {
  settings: Record<string, unknown>
  changed: boolean
}

/** Pure. Adds or refreshes our blocks; every foreign block and key survives in order. */
export function mergeHookSettings(current: unknown, scriptPath: string): MergeResult {
  const settings: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {}
  const before = JSON.stringify(settings)
  const hooksIn = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks as Record<string, unknown> : {}
  const hooks: Record<string, unknown> = { ...hooksIn }
  for (const sub of HOOK_SUBSCRIPTIONS) {
    const existing = Array.isArray(hooks[sub.event]) ? hooks[sub.event] as unknown[] : []
    const foreign = existing.filter(b => !blockIsOurs(b))
    hooks[sub.event] = [...foreign, canonicalBlock(scriptPath, sub)]
  }
  settings.hooks = hooks
  return { settings, changed: JSON.stringify(settings) !== before }
}

/** Pure. Removes our blocks; emptied event arrays are deleted, everything else survives. */
export function stripHookSettings(current: unknown): MergeResult {
  const settings: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {}
  const before = JSON.stringify(settings)
  const hooksIn = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks as Record<string, unknown> : null
  if (!hooksIn) return { settings, changed: false }
  const hooks: Record<string, unknown> = {}
  for (const [event, blocks] of Object.entries(hooksIn)) {
    if (!Array.isArray(blocks)) { hooks[event] = blocks; continue }
    const foreign = blocks.filter(b => !blockIsOurs(b))
    if (foreign.length > 0) hooks[event] = foreign
  }
  settings.hooks = hooks
  return { settings, changed: JSON.stringify(settings) !== before }
}

/** Which of our events a settings object carries, by exact canonical command. */
export function subscribedEvents(current: unknown, scriptPath: string): { subscribed: string[]; missing: string[]; drifted: string[] } {
  const hooks = current && typeof current === 'object' && (current as Record<string, unknown>).hooks
  const table = hooks && typeof hooks === 'object' ? hooks as Record<string, unknown> : {}
  const subscribed: string[] = []
  const missing: string[] = []
  const drifted: string[] = []
  for (const sub of HOOK_SUBSCRIPTIONS) {
    const blocks = Array.isArray(table[sub.event]) ? table[sub.event] as unknown[] : []
    const ours = blocks.filter(blockIsOurs)
    if (ours.length === 0) { missing.push(sub.event); continue }
    const canonical = JSON.stringify(canonicalBlock(scriptPath, sub))
    if (ours.length === 1 && JSON.stringify(ours[0]) === canonical) subscribed.push(sub.event)
    else drifted.push(sub.event)
  }
  return { subscribed, missing, drifted }
}

export type HookInstallState = 'installed' | 'drift' | 'missing' | 'script_outdated' | 'settings_unparseable' | 'settings_symlink'

export interface HookStatus {
  state: HookInstallState
  settingsPath: string
  scriptPath: string
  scriptSha: string | null
  packageScriptSha: string | null
  subscribed: string[]
  missing: string[]
  drifted: string[]
  tokenPresent: boolean
}

function sha256File(path: string): string | null {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') } catch { return null }
}

type SettingsRead = { ok: true; settings: unknown; existed: boolean } | { ok: false; reason: 'settings_unparseable' | 'settings_symlink' }

function readSettings(path: string): SettingsRead {
  try {
    if (lstatSync(path).isSymbolicLink()) return { ok: false, reason: 'settings_symlink' }
  } catch {
    return { ok: true, settings: {}, existed: false }
  }
  try {
    return { ok: true, settings: JSON.parse(readFileSync(path, 'utf-8')), existed: true }
  } catch {
    return { ok: false, reason: 'settings_unparseable' }
  }
}

export function hookStatus(paths: { settingsPath?: string; scriptPath?: string; packageScriptPath?: string } = {}): HookStatus {
  const settingsPath = paths.settingsPath ?? claudeSettingsPath()
  const scriptPath = paths.scriptPath ?? stableHookScriptPath()
  const packageScriptPath = paths.packageScriptPath ?? packagedHookScriptPath()
  const scriptSha = sha256File(scriptPath)
  const packageScriptSha = sha256File(packageScriptPath)
  const tokenPresent = existsSync(hookTokenPath())
  const read = readSettings(settingsPath)
  if (!read.ok) {
    return { state: read.reason, settingsPath, scriptPath, scriptSha, packageScriptSha, subscribed: [], missing: HOOK_SUBSCRIPTIONS.map(s => s.event), drifted: [], tokenPresent }
  }
  const events = subscribedEvents(read.settings, scriptPath)
  let state: HookInstallState
  if (events.subscribed.length === 0 && events.drifted.length === 0) state = 'missing'
  else if (events.missing.length > 0 || events.drifted.length > 0) state = 'drift'
  else if (!scriptSha || (packageScriptSha && scriptSha !== packageScriptSha)) state = 'script_outdated'
  else state = 'installed'
  return { state, settingsPath, scriptPath, scriptSha, packageScriptSha, ...events, tokenPresent }
}

export interface InstallOptions {
  settingsPath?: string
  scriptPath?: string
  packageScriptPath?: string
  port?: number
  deskIdleSeconds?: number
  dryRun?: boolean
}

export interface InstallResult {
  ok: boolean
  reason?: string
  changed: boolean
  scriptCopied: boolean
  backupPath: string | null
  status: HookStatus
  /** The merged settings, for `--dry-run` to print. */
  merged?: Record<string, unknown>
}

const BACKUPS_KEPT = 3

function backupSettings(settingsPath: string): string | null {
  if (!existsSync(settingsPath)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${settingsPath}.cos-backup-${stamp}`
  try {
    copyFileSync(settingsPath, backup)
    chmodSync(backup, 0o600)
  } catch { return null }
  try {
    const dir = dirname(settingsPath)
    const prefix = `${settingsPath.slice(dir.length + 1)}.cos-backup-`
    const olds = readdirSync(dir).filter(n => n.startsWith(prefix)).sort()
    for (const old of olds.slice(0, Math.max(0, olds.length - BACKUPS_KEPT))) {
      try { unlinkSync(join(dir, old)) } catch { /* fine */ }
    }
  } catch { /* the backup itself succeeded */ }
  return backup
}

/** Mint the per-install token once (0600); write port and desk-idle files every time. */
export function ensureHookRuntimeFiles(port: number, deskIdleSeconds: number): void {
  const home = cosGlassesHome()
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (!existsSync(hookTokenPath())) writeFileSync(hookTokenPath(), randomBytes(32).toString('hex'), { mode: 0o600 })
  writeFileSync(hookPortPath(), String(port), { mode: 0o600 })
  writeFileSync(hookDeskIdlePath(), String(Math.max(0, Math.trunc(deskIdleSeconds))), { mode: 0o600 })
}

export function readHookToken(): string | null {
  try { return readFileSync(hookTokenPath(), 'utf-8').trim() || null } catch { return null }
}

/** Copy the packaged script to the stable path when it differs. Returns true when copied. */
export function ensureStableHookScript(scriptPath = stableHookScriptPath(), packageScriptPath = packagedHookScriptPath()): boolean {
  const want = sha256File(packageScriptPath)
  if (!want) throw new Error(`hook script missing from the package at ${packageScriptPath}`)
  if (sha256File(scriptPath) === want) return false
  mkdirSync(dirname(scriptPath), { recursive: true, mode: 0o755 })
  atomicWriteFileSync(scriptPath, readFileSync(packageScriptPath), { mode: 0o755 })
  chmodSync(scriptPath, 0o755)
  return true
}

export function installClaudeHooks(options: InstallOptions = {}): InstallResult {
  const settingsPath = options.settingsPath ?? claudeSettingsPath()
  const scriptPath = options.scriptPath ?? stableHookScriptPath()
  const packageScriptPath = options.packageScriptPath ?? packagedHookScriptPath()
  const read = readSettings(settingsPath)
  const statusNow = () => hookStatus({ settingsPath, scriptPath, packageScriptPath })
  if (!read.ok) return { ok: false, reason: read.reason, changed: false, scriptCopied: false, backupPath: null, status: statusNow() }
  const merged = mergeHookSettings(read.settings, scriptPath)
  if (options.dryRun) {
    return { ok: true, changed: merged.changed, scriptCopied: false, backupPath: null, status: statusNow(), merged: merged.settings }
  }
  let scriptCopied = false
  try {
    scriptCopied = ensureStableHookScript(scriptPath, packageScriptPath)
    ensureHookRuntimeFiles(options.port ?? 3141, options.deskIdleSeconds ?? 90)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), changed: false, scriptCopied, backupPath: null, status: statusNow() }
  }
  let backupPath: string | null = null
  if (merged.changed) {
    backupPath = backupSettings(settingsPath)
    mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 })
    atomicWriteFileSync(settingsPath, JSON.stringify(merged.settings, null, 2) + '\n', { mode: 0o600 })
  }
  return { ok: true, changed: merged.changed, scriptCopied, backupPath, status: statusNow() }
}

export function uninstallClaudeHooks(options: Pick<InstallOptions, 'settingsPath' | 'scriptPath' | 'packageScriptPath' | 'dryRun'> = {}): InstallResult {
  const settingsPath = options.settingsPath ?? claudeSettingsPath()
  const scriptPath = options.scriptPath ?? stableHookScriptPath()
  const packageScriptPath = options.packageScriptPath ?? packagedHookScriptPath()
  const read = readSettings(settingsPath)
  const statusNow = () => hookStatus({ settingsPath, scriptPath, packageScriptPath })
  if (!read.ok) return { ok: false, reason: read.reason, changed: false, scriptCopied: false, backupPath: null, status: statusNow() }
  const stripped = stripHookSettings(read.settings)
  if (options.dryRun) return { ok: true, changed: stripped.changed, scriptCopied: false, backupPath: null, status: statusNow(), merged: stripped.settings }
  let backupPath: string | null = null
  if (stripped.changed) {
    backupPath = backupSettings(settingsPath)
    atomicWriteFileSync(settingsPath, JSON.stringify(stripped.settings, null, 2) + '\n', { mode: 0o600 })
  }
  return { ok: true, changed: stripped.changed, scriptCopied: false, backupPath, status: statusNow() }
}
