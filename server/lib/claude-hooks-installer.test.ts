import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HOOK_SUBSCRIPTIONS,
  hookCommand,
  hookStatus,
  installClaudeHooks,
  mergeHookSettings,
  shellQuote,
  stripHookSettings,
  subscribedEvents,
  uninstallClaudeHooks,
} from './claude-hooks-installer.js'

// The real ~/.claude/settings.json shape on the machine this was written on
// (2026-09-15): two foreign async blocks for an iTerm colour script, plus keys the
// installer must never touch.
const REAL_SHAPE = {
  model: 'opus',
  permissions: { allow: ['Bash(ls *)'], deny: [] },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/claude-active.sh start', async: true }] }],
    Stop: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/claude-active.sh stop', async: true }] }],
  },
  enabledPlugins: { 'everything-evenhub@x': true },
}

const SCRIPT = '/Users/example/.cos-glasses/bin/cos-session-hook'
const dir = () => mkdtempSync(join(tmpdir(), 'cos-hooks-'))

describe('mergeHookSettings is pure and preserves everything foreign', () => {
  it('appends one canonical block per subscribed event after the foreign blocks', () => {
    const { settings, changed } = mergeHookSettings(REAL_SHAPE, SCRIPT)
    expect(changed).toBe(true)
    const hooks = settings.hooks as Record<string, unknown[]>
    expect(hooks.SessionStart).toHaveLength(2)
    expect(JSON.stringify(hooks.SessionStart[0])).toContain('claude-active.sh start')
    expect(hooks.SessionStart[1]).toEqual({ hooks: [{ type: 'command', command: `${SCRIPT} SessionStart`, timeout: 5 }] })
    expect(hooks.Stop[1]).toEqual({ hooks: [{ type: 'command', command: `${SCRIPT} Stop`, timeout: 5 }] })
    expect(hooks.UserPromptSubmit[0]).toEqual({ hooks: [{ type: 'command', command: `${SCRIPT} UserPromptSubmit`, timeout: 10, async: true }] })
    expect(hooks.PermissionRequest).toEqual([{ hooks: [{ type: 'command', command: `${SCRIPT} PermissionRequest`, timeout: 130 }] }])
    expect(hooks.PreToolUse[0]).toMatchObject({ matcher: 'AskUserQuestion|ExitPlanMode' })
    expect(hooks.PostToolUse[0]).not.toHaveProperty('matcher')
    expect(settings.model).toBe('opus')
    expect(settings.permissions).toEqual(REAL_SHAPE.permissions)
    expect(settings.enabledPlugins).toEqual(REAL_SHAPE.enabledPlugins)
    expect(Object.keys(hooks)).toHaveLength(HOOK_SUBSCRIPTIONS.length)
  })

  it('is idempotent: merging the merged object changes nothing', () => {
    const once = mergeHookSettings(REAL_SHAPE, SCRIPT).settings
    const twice = mergeHookSettings(once, SCRIPT)
    expect(twice.changed).toBe(false)
    expect(twice.settings).toEqual(once)
  })

  it('collapses a stale copy of our block (old path) into one canonical block', () => {
    const stale = {
      hooks: { Stop: [
        { hooks: [{ type: 'command', command: '/old/.cos-glasses/bin/cos-session-hook Stop', timeout: 3 }] },
        { hooks: [{ type: 'command', command: '~/.claude/hooks/claude-active.sh stop', async: true }] },
      ] },
    }
    const { settings } = mergeHookSettings(stale, SCRIPT)
    const stop = (settings.hooks as Record<string, unknown[]>).Stop
    expect(stop).toHaveLength(2)
    expect(JSON.stringify(stop[0])).toContain('claude-active.sh')
    expect(JSON.stringify(stop[1])).toContain(`${SCRIPT} Stop`)
  })

  it('strip removes only ours and deletes emptied arrays', () => {
    const merged = mergeHookSettings(REAL_SHAPE, SCRIPT).settings
    const { settings, changed } = stripHookSettings(merged)
    expect(changed).toBe(true)
    expect(settings.hooks).toEqual(REAL_SHAPE.hooks)
    expect(settings.model).toBe('opus')
    expect(stripHookSettings(REAL_SHAPE).changed).toBe(false)
  })

  it('reports subscribed, missing and drifted events', () => {
    const merged = mergeHookSettings(REAL_SHAPE, SCRIPT).settings
    expect(subscribedEvents(merged, SCRIPT)).toEqual({ subscribed: HOOK_SUBSCRIPTIONS.map(s => s.event), missing: [], drifted: [] })
    const hooks = merged.hooks as Record<string, unknown[]>
    const drifted = { ...merged, hooks: { ...hooks, Stop: [{ hooks: [{ type: 'command', command: `${SCRIPT} Stop`, timeout: 99 }] }], PostCompact: [] } }
    const report = subscribedEvents(drifted, SCRIPT)
    expect(report.drifted).toEqual(['Stop'])
    expect(report.missing).toEqual(['PostCompact'])
  })

  it('quotes a home directory with a space and leaves a plain path alone', () => {
    expect(shellQuote('/Users/plain/.cos-glasses/bin/cos-session-hook')).toBe('/Users/plain/.cos-glasses/bin/cos-session-hook')
    expect(hookCommand('/Users/Some One/.cos-glasses/bin/cos-session-hook', 'Stop')).toBe(`'/Users/Some One/.cos-glasses/bin/cos-session-hook' Stop`)
  })
})

describe('install and uninstall on disk', () => {
  function sandbox() {
    const root = dir()
    const settingsPath = join(root, 'claude', 'settings.json')
    mkdirSync(join(root, 'claude'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(REAL_SHAPE, null, 2))
    const packageScriptPath = join(root, 'pkg', 'cos-session-hook')
    mkdirSync(join(root, 'pkg'), { recursive: true })
    writeFileSync(packageScriptPath, '#!/bin/sh\nexit 0\n')
    const scriptPath = join(root, 'stable', 'bin', 'cos-session-hook')
    return { root, settingsPath, packageScriptPath, scriptPath }
  }

  it('copies the script, merges the settings, backs up the original, and reports installed', () => {
    const { settingsPath, packageScriptPath, scriptPath, root } = sandbox()
    process.env.COS_GLASSES_HOME = join(root, 'home')
    try {
      const result = installClaudeHooks({ settingsPath, packageScriptPath, scriptPath, port: 3999, deskIdleSeconds: 45 })
      expect(result.ok).toBe(true)
      expect(result.changed).toBe(true)
      expect(result.scriptCopied).toBe(true)
      expect(result.status.state).toBe('installed')
      expect(existsSync(scriptPath)).toBe(true)
      expect(lstatSync(scriptPath).mode & 0o777).toBe(0o755)
      expect(readFileSync(join(root, 'home', 'hook-port'), 'utf-8')).toBe('3999')
      expect(readFileSync(join(root, 'home', 'hook-desk-idle-s'), 'utf-8')).toBe('45')
      expect(readFileSync(join(root, 'home', 'hook-token'), 'utf-8')).toMatch(/^[0-9a-f]{64}$/)
      expect(lstatSync(join(root, 'home', 'hook-token')).mode & 0o777).toBe(0o600)
      expect(readdirSync(join(root, 'claude')).some(n => n.startsWith('settings.json.cos-backup-'))).toBe(true)
      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(written.model).toBe('opus')
      expect(written.hooks.PermissionRequest[0].hooks[0].command).toBe(`${scriptPath} PermissionRequest`)
      // A second install changes nothing and mints no second token.
      const token = readFileSync(join(root, 'home', 'hook-token'), 'utf-8')
      const again = installClaudeHooks({ settingsPath, packageScriptPath, scriptPath, port: 3999 })
      expect(again.changed).toBe(false)
      expect(readFileSync(join(root, 'home', 'hook-token'), 'utf-8')).toBe(token)
      // Uninstall restores the foreign hooks exactly.
      const removed = uninstallClaudeHooks({ settingsPath, packageScriptPath, scriptPath })
      expect(removed.changed).toBe(true)
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).hooks).toEqual(REAL_SHAPE.hooks)
      expect(hookStatus({ settingsPath, packageScriptPath, scriptPath }).state).toBe('missing')
    } finally {
      delete process.env.COS_GLASSES_HOME
    }
  })

  it('reports script_outdated when the package copy moved on, and refuses a symlinked or unparseable settings file', () => {
    const { settingsPath, packageScriptPath, scriptPath, root } = sandbox()
    process.env.COS_GLASSES_HOME = join(root, 'home')
    try {
      installClaudeHooks({ settingsPath, packageScriptPath, scriptPath, port: 1 })
      writeFileSync(packageScriptPath, '#!/bin/sh\nexit 0 # v2\n')
      expect(hookStatus({ settingsPath, packageScriptPath, scriptPath }).state).toBe('script_outdated')
      expect(installClaudeHooks({ settingsPath, packageScriptPath, scriptPath, port: 1 }).scriptCopied).toBe(true)
      expect(hookStatus({ settingsPath, packageScriptPath, scriptPath }).state).toBe('installed')

      writeFileSync(settingsPath, '{ not json')
      const bad = installClaudeHooks({ settingsPath, packageScriptPath, scriptPath, port: 1 })
      expect(bad.ok).toBe(false)
      expect(bad.reason).toBe('settings_unparseable')
      expect(readFileSync(settingsPath, 'utf-8')).toBe('{ not json')

      const linkPath = join(root, 'claude', 'link.json')
      symlinkSync(settingsPath, linkPath)
      expect(installClaudeHooks({ settingsPath: linkPath, packageScriptPath, scriptPath, port: 1 }).reason).toBe('settings_symlink')
    } finally {
      delete process.env.COS_GLASSES_HOME
    }
  })

  it('dry run writes nothing and returns the merged object', () => {
    const { settingsPath, packageScriptPath, scriptPath, root } = sandbox()
    process.env.COS_GLASSES_HOME = join(root, 'home')
    try {
      const before = readFileSync(settingsPath, 'utf-8')
      const result = installClaudeHooks({ settingsPath, packageScriptPath, scriptPath, port: 1, dryRun: true })
      expect(result.ok).toBe(true)
      expect(result.merged?.hooks).toHaveProperty('PermissionRequest')
      expect(readFileSync(settingsPath, 'utf-8')).toBe(before)
      expect(existsSync(scriptPath)).toBe(false)
    } finally {
      delete process.env.COS_GLASSES_HOME
    }
  })

  it('a missing settings file is created with only our hooks, 0600', () => {
    const { packageScriptPath, scriptPath, root } = sandbox()
    process.env.COS_GLASSES_HOME = join(root, 'home')
    try {
      const fresh = join(root, 'fresh', 'settings.json')
      const result = installClaudeHooks({ settingsPath: fresh, packageScriptPath, scriptPath, port: 1 })
      expect(result.ok).toBe(true)
      expect(lstatSync(fresh).mode & 0o777).toBe(0o600)
      expect(Object.keys(JSON.parse(readFileSync(fresh, 'utf-8')))).toEqual(['hooks'])
      chmodSync(fresh, 0o600)
    } finally {
      delete process.env.COS_GLASSES_HOME
    }
  })
})
