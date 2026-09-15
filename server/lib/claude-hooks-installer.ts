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
 * UserPromptSubmit, Stop and SessionEnd are synchronous: measured 2026-09-15, an async
 * Stop was dropped when a print-mode process exited right after it (PostToolUse landed,
 * Stop did not), and those four carry the transitions a row is derived from (a dropped
 * UserPromptSubmit would leave a running turn reading idle). The write is a few
 * milliseconds. PermissionRequest must be synchronous to return a decision; the rest
 * are fire-and-forget.
 */
export const HOOK_SUBSCRIPTIONS: readonly HookSubscription[] = [
  { event: 'SessionStart', async: false, timeout: 5 },
  { event: 'SessionEnd', async: false, timeout: 5 },
  { event: 'UserPromptSubmit', async: false, timeout: 5 },
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

/**
 * Where the token, port and spool live. Derived from `COS_DATA_DIR` when that is set, so
 * a scratch server booted with a temp data dir never touches the production files under
 * `~/.cos-glasses` (it did once, in review). `COS_GLASSES_HOME` overrides for tests.
 */
export function cosGlassesHome(): string {
  if (process.env.COS_GLASSES_HOME) return resolve(process.env.COS_GLASSES_HOME)
  if (process.env.COS_DATA_DIR) return dirname(resolve(process.env.COS_DATA_DIR))
  return join(homedir(), '.cos-glasses')
}

/** The spool the server drains; baked into the installed command so the script agrees. */
export function hookSpoolDir(): string {
  if (process.env.COS_SESSION_HOOKS_SPOOL_DIR) return resolve(process.env.COS_SESSION_HOOKS_SPOOL_DIR)
  return join(process.env.COS_DATA_DIR ? resolve(process.env.COS_DATA_DIR) : join(cosGlassesHome(), 'data'), 'hook-spool')
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

/**
 * The installed command carries the two paths the script needs as environment, so the
 * server and the script can never disagree about where the spool or the token is.
 */
export function hookCommand(scriptPath: string, event: string, paths: HookPaths = currentHookPaths()): string {
  return `COS_GLASSES_HOME=${shellQuote(paths.home)} COS_HOOK_SPOOL=${shellQuote(paths.spoolDir)} ${shellQuote(scriptPath)} ${event}`
}

export interface HookPaths {
  home: string
  spoolDir: string
}

export function currentHookPaths(): HookPaths {
  return { home: cosGlassesHome(), spoolDir: hookSpoolDir() }
}

type HookBlock = { matcher?: unknown; hooks?: unknown }

function blockIsOurs(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const hooks = (block as HookBlock).hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some(h => h && typeof h === 'object' && typeof (h as { command?: unknown }).command === 'string'
    && ((h as { command: string }).command.includes(HOOK_SCRIPT_MARKER) || (h as { command: string }).command.includes(HOOK_SCRIPT_NAME + ' ')))
}

function canonicalBlock(scriptPath: string, sub: HookSubscription, paths: HookPaths): Record<string, unknown> {
  const hook: Record<string, unknown> = { type: 'command', command: hookCommand(scriptPath, sub.event, paths), timeout: sub.timeout }
  if (sub.async) hook.async = true
  return sub.matcher ? { matcher: sub.matcher, hooks: [hook] } : { hooks: [hook] }
}

export type MergeResult =
  | { ok: true; settings: Record<string, unknown>; changed: boolean }
  /** The file holds a `hooks` shape this merge would have to destroy to proceed. */
  | { ok: false; reason: 'settings_hooks_invalid' }

/**
 * Pure. Adds or refreshes our blocks; every foreign block and key survives in order. A
 * `hooks` key that is not an object, or an event whose value is not an array, is refused
 * rather than replaced: "preserving every existing hook block" is the contract.
 */
export function mergeHookSettings(current: unknown, scriptPath: string, paths: HookPaths = currentHookPaths()): MergeResult {
  const settings: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {}
  const before = JSON.stringify(settings)
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) return { ok: false, reason: 'settings_hooks_invalid' }
  const hooksIn = (settings.hooks ?? {}) as Record<string, unknown>
  const hooks: Record<string, unknown> = { ...hooksIn }
  for (const sub of HOOK_SUBSCRIPTIONS) {
    const value = hooks[sub.event]
    if (value !== undefined && !Array.isArray(value)) return { ok: false, reason: 'settings_hooks_invalid' }
    const existing = Array.isArray(value) ? value : []
    const foreign = existing.filter(b => !blockIsOurs(b))
    hooks[sub.event] = [...foreign, canonicalBlock(scriptPath, sub, paths)]
  }
  settings.hooks = hooks
  return { ok: true, settings, changed: JSON.stringify(settings) !== before }
}

/** Pure. Removes our blocks; emptied event arrays are deleted, everything else survives. */
export function stripHookSettings(current: unknown): MergeResult {
  const settings: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {}
  const before = JSON.stringify(settings)
  const hooksIn = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks as Record<string, unknown> : null
  if (!hooksIn) return { ok: true, settings, changed: false }
  const hooks: Record<string, unknown> = {}
  for (const [event, blocks] of Object.entries(hooksIn)) {
    if (!Array.isArray(blocks)) { hooks[event] = blocks; continue }
    const foreign = blocks.filter(b => !blockIsOurs(b))
    if (foreign.length > 0) hooks[event] = foreign
  }
  settings.hooks = hooks
  return { ok: true, settings, changed: JSON.stringify(settings) !== before }
}

/** Which of our events a settings object carries, by exact canonical command. */
export function subscribedEvents(current: unknown, scriptPath: string, paths: HookPaths = currentHookPaths()): { subscribed: string[]; missing: string[]; drifted: string[] } {
  const hooks = current && typeof current === 'object' && (current as Record<string, unknown>).hooks
  const table = hooks && typeof hooks === 'object' ? hooks as Record<string, unknown> : {}
  const subscribed: string[] = []
  const missing: string[] = []
  const drifted: string[] = []
  for (const sub of HOOK_SUBSCRIPTIONS) {
    const blocks = Array.isArray(table[sub.event]) ? table[sub.event] as unknown[] : []
    const ours = blocks.filter(blockIsOurs)
    if (ours.length === 0) { missing.push(sub.event); continue }
    const canonical = JSON.stringify(canonicalBlock(scriptPath, sub, paths))
    if (ours.length === 1 && JSON.stringify(ours[0]) === canonical) subscribed.push(sub.event)
    else drifted.push(sub.event)
  }
  return { subscribed, missing, drifted }
}

export type HookInstallState =
  | 'installed'
  | 'drift'
  | 'missing'
  | 'script_outdated'
  /** The user-level file carries `disableAllHooks: true`: installed or not, nothing fires. */
  | 'disabled_by_settings'
  | 'settings_unparseable'
  | 'settings_symlink'
  /** The file exists but could not be read (EACCES, ELOOP, ENOTDIR): not "missing". */
  | 'settings_unreadable'

export interface HookStatus {
  state: HookInstallState
  /** True only for `installed`: the boolean Control's banner keys off. */
  installed: boolean
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

type SettingsRead = { ok: true; settings: unknown; existed: boolean } | { ok: false; reason: 'settings_unparseable' | 'settings_symlink' | 'settings_unreadable' }

function readSettings(path: string): SettingsRead {
  try {
    if (lstatSync(path).isSymbolicLink()) return { ok: false, reason: 'settings_symlink' }
  } catch (error) {
    // Only "no such file" is missing. Anything else is a file that could not be looked at,
    // and "I could not look" must never render as "it is not there".
    if ((error as { code?: string }).code === 'ENOENT') return { ok: true, settings: {}, existed: false }
    return { ok: false, reason: 'settings_unreadable' }
  }
  let text: string
  try { text = readFileSync(path, 'utf-8') } catch { return { ok: false, reason: 'settings_unreadable' } }
  try {
    return { ok: true, settings: JSON.parse(text), existed: true }
  } catch {
    return { ok: false, reason: 'settings_unparseable' }
  }
}

function hooksDisabled(settings: unknown): boolean {
  return !!settings && typeof settings === 'object' && (settings as { disableAllHooks?: unknown }).disableAllHooks === true
}

export function hookStatus(paths: { settingsPath?: string; scriptPath?: string; packageScriptPath?: string; hookPaths?: HookPaths } = {}): HookStatus {
  const settingsPath = paths.settingsPath ?? claudeSettingsPath()
  const scriptPath = paths.scriptPath ?? stableHookScriptPath()
  const packageScriptPath = paths.packageScriptPath ?? packagedHookScriptPath()
  const hookPaths = paths.hookPaths ?? currentHookPaths()
  const scriptSha = sha256File(scriptPath)
  const packageScriptSha = sha256File(packageScriptPath)
  const tokenPresent = existsSync(hookTokenPath())
  const read = readSettings(settingsPath)
  if (!read.ok) {
    return { state: read.reason, installed: false, settingsPath, scriptPath, scriptSha, packageScriptSha, subscribed: [], missing: HOOK_SUBSCRIPTIONS.map(s => s.event), drifted: [], tokenPresent }
  }
  const events = subscribedEvents(read.settings, scriptPath, hookPaths)
  let state: HookInstallState
  if (hooksDisabled(read.settings)) state = 'disabled_by_settings'
  else if (events.subscribed.length === 0 && events.drifted.length === 0) state = 'missing'
  else if (events.missing.length > 0 || events.drifted.length > 0) state = 'drift'
  else if (!scriptSha || (packageScriptSha && scriptSha !== packageScriptSha)) state = 'script_outdated'
  else state = 'installed'
  return { state, installed: state === 'installed', settingsPath, scriptPath, scriptSha, packageScriptSha, ...events, tokenPresent }
}

export interface InstallOptions {
  settingsPath?: string
  scriptPath?: string
  packageScriptPath?: string
  hookPaths?: HookPaths
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

/** Mint the per-install token once (0600, atomically); write port and desk-idle files every time. */
export function ensureHookRuntimeFiles(port: number, deskIdleSeconds: number): void {
  const home = cosGlassesHome()
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (!existsSync(hookTokenPath())) atomicWriteFileSync(hookTokenPath(), randomBytes(32).toString('hex'), { mode: 0o600 })
  atomicWriteFileSync(hookPortPath(), String(port), { mode: 0o600 })
  atomicWriteFileSync(hookDeskIdlePath(), String(Math.max(0, Math.trunc(deskIdleSeconds))), { mode: 0o600 })
}

export function readHookToken(): string | null {
  try { return readFileSync(hookTokenPath(), 'utf-8').trim() || null } catch { return null }
}

/**
 * Copy the packaged script to the stable path when it differs (`install`), or only when it
 * is missing (`onlyIfMissing`, used at boot: an older server booting must never downgrade
 * the script a newer `install` put there, since every Claude session on the Mac runs it).
 * Returns true when copied.
 */
export function ensureStableHookScript(scriptPath = stableHookScriptPath(), packageScriptPath = packagedHookScriptPath(), onlyIfMissing = false): boolean {
  const want = sha256File(packageScriptPath)
  if (!want) throw new Error(`hook script missing from the package at ${packageScriptPath}`)
  const have = sha256File(scriptPath)
  if (have === want) return false
  if (have && onlyIfMissing) return false
  mkdirSync(dirname(scriptPath), { recursive: true, mode: 0o755 })
  atomicWriteFileSync(scriptPath, readFileSync(packageScriptPath), { mode: 0o755 })
  chmodSync(scriptPath, 0o755)
  return true
}

export function installClaudeHooks(options: InstallOptions = {}): InstallResult {
  const settingsPath = options.settingsPath ?? claudeSettingsPath()
  const scriptPath = options.scriptPath ?? stableHookScriptPath()
  const packageScriptPath = options.packageScriptPath ?? packagedHookScriptPath()
  const hookPaths = options.hookPaths ?? currentHookPaths()
  const read = readSettings(settingsPath)
  const statusNow = () => hookStatus({ settingsPath, scriptPath, packageScriptPath, hookPaths })
  const refuse = (reason: string, scriptCopied = false): InstallResult => ({ ok: false, reason, changed: false, scriptCopied, backupPath: null, status: statusNow() })
  if (!read.ok) return refuse(read.reason)
  const merged = mergeHookSettings(read.settings, scriptPath, hookPaths)
  if (!merged.ok) return refuse(merged.reason)
  if (options.dryRun) {
    return { ok: true, changed: merged.changed, scriptCopied: false, backupPath: null, status: statusNow(), merged: merged.settings }
  }
  let scriptCopied = false
  try {
    scriptCopied = ensureStableHookScript(scriptPath, packageScriptPath)
    ensureHookRuntimeFiles(options.port ?? 3141, options.deskIdleSeconds ?? 90)
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error), scriptCopied)
  }
  let backupPath: string | null = null
  if (merged.changed) {
    if (read.existed) {
      backupPath = backupSettings(settingsPath)
      // No backup, no overwrite: "with a backup of the file" is the contract.
      if (!backupPath) return refuse('backup_failed', scriptCopied)
    }
    mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 })
    atomicWriteFileSync(settingsPath, JSON.stringify(merged.settings, null, 2) + '\n', { mode: 0o600 })
  }
  return { ok: true, changed: merged.changed, scriptCopied, backupPath, status: statusNow() }
}

export function uninstallClaudeHooks(options: Pick<InstallOptions, 'settingsPath' | 'scriptPath' | 'packageScriptPath' | 'hookPaths' | 'dryRun'> = {}): InstallResult {
  const settingsPath = options.settingsPath ?? claudeSettingsPath()
  const scriptPath = options.scriptPath ?? stableHookScriptPath()
  const packageScriptPath = options.packageScriptPath ?? packagedHookScriptPath()
  const hookPaths = options.hookPaths ?? currentHookPaths()
  const read = readSettings(settingsPath)
  const statusNow = () => hookStatus({ settingsPath, scriptPath, packageScriptPath, hookPaths })
  if (!read.ok) return { ok: false, reason: read.reason, changed: false, scriptCopied: false, backupPath: null, status: statusNow() }
  const stripped = stripHookSettings(read.settings)
  if (!stripped.ok) return { ok: false, reason: stripped.reason, changed: false, scriptCopied: false, backupPath: null, status: statusNow() }
  if (options.dryRun) return { ok: true, changed: stripped.changed, scriptCopied: false, backupPath: null, status: statusNow(), merged: stripped.settings }
  let backupPath: string | null = null
  if (stripped.changed) {
    backupPath = backupSettings(settingsPath)
    if (!backupPath) return { ok: false, reason: 'backup_failed', changed: false, scriptCopied: false, backupPath: null, status: statusNow() }
    atomicWriteFileSync(settingsPath, JSON.stringify(stripped.settings, null, 2) + '\n', { mode: 0o600 })
  }
  return { ok: true, changed: stripped.changed, scriptCopied: false, backupPath, status: statusNow() }
}
