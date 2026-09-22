import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HOOK_SUBSCRIPTIONS,
  cosGlassesHome,
  hookCommand,
  hookSpoolDir,
  hookStatus,
  installClaudeHooks,
  mergeHookSettings,
  packagedHookScriptPath,
  shellQuote,
  stripHookSettings,
  subscribedEvents,
  uninstallClaudeHooks,
  type HookPaths,
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
const PATHS: HookPaths = { home: '/Users/example/.cos-glasses', spoolDir: '/Users/example/.cos-glasses/data/hook-spool' }
const cmd = (event: string) => `COS_GLASSES_HOME=${PATHS.home} COS_HOOK_SPOOL=${PATHS.spoolDir} ${SCRIPT} ${event}`
const dir = () => mkdtempSync(join(tmpdir(), 'cos-hooks-'))

function merged(current: unknown, paths = PATHS): { settings: Record<string, unknown>; changed: boolean } {
  const result = mergeHookSettings(current, SCRIPT, paths)
  if (!result.ok) throw new Error(result.reason)
  return result
}

describe('mergeHookSettings is pure and preserves everything foreign', () => {
  it('appends one canonical block per subscribed event after the foreign blocks', () => {
    const { settings, changed } = merged(REAL_SHAPE)
    expect(changed).toBe(true)
    const hooks = settings.hooks as Record<string, unknown[]>
    expect(hooks.SessionStart).toHaveLength(2)
    expect(JSON.stringify(hooks.SessionStart[0])).toContain('claude-active.sh start')
    // The four transition events are synchronous (an async Stop was dropped at print-mode exit).
    expect(hooks.SessionStart[1]).toEqual({ hooks: [{ type: 'command', command: cmd('SessionStart'), timeout: 5 }] })
    expect(hooks.Stop[1]).toEqual({ hooks: [{ type: 'command', command: cmd('Stop'), timeout: 5 }] })
    expect(hooks.UserPromptSubmit[0]).toEqual({ hooks: [{ type: 'command', command: cmd('UserPromptSubmit'), timeout: 5 }] })
    expect(hooks.SessionEnd[0]).toEqual({ hooks: [{ type: 'command', command: cmd('SessionEnd'), timeout: 5 }] })
    expect(hooks.PostToolUse[0]).toEqual({ hooks: [{ type: 'command', command: cmd('PostToolUse'), timeout: 10, async: true }] })
    expect(hooks.PermissionRequest).toEqual([{ hooks: [{ type: 'command', command: cmd('PermissionRequest'), timeout: 130 }] }])
    // 6.53.0: PreToolUse is synchronous with NO matcher (was async `AskUserQuestion|ExitPlanMode`
    // through 6.52). The script's halt check must see every tool call, and it returns in
    // about 11 ms; the script itself still spools only those two tools. Updated on purpose.
    expect(hooks.PreToolUse).toEqual([{ hooks: [{ type: 'command', command: cmd('PreToolUse'), timeout: 5 }] }])
    expect(hooks.PreToolUse[0]).not.toHaveProperty('matcher')
    expect(hooks.PostToolUse[0]).not.toHaveProperty('matcher')
    expect(settings.model).toBe('opus')
    expect(settings.permissions).toEqual(REAL_SHAPE.permissions)
    expect(settings.enabledPlugins).toEqual(REAL_SHAPE.enabledPlugins)
    expect(Object.keys(hooks)).toHaveLength(HOOK_SUBSCRIPTIONS.length)
  })

  it('is idempotent: merging the merged object changes nothing', () => {
    const once = merged(REAL_SHAPE).settings
    const twice = merged(once)
    expect(twice.changed).toBe(false)
    expect(twice.settings).toEqual(once)
  })

  it('a different spool or home in the baked command is drift, and reinstalling rewrites it', () => {
    const once = merged(REAL_SHAPE).settings
    const other: HookPaths = { home: '/Users/example/.cos-glasses', spoolDir: '/Volumes/scratch/hook-spool' }
    expect(subscribedEvents(once, SCRIPT, other).drifted).toEqual(HOOK_SUBSCRIPTIONS.map(s => s.event))
    const again = merged(once, other)
    expect(again.changed).toBe(true)
    expect(subscribedEvents(again.settings, SCRIPT, other).drifted).toEqual([])
    const stop = (again.settings.hooks as Record<string, unknown[]>).Stop
    expect(stop).toHaveLength(2)
    expect(JSON.stringify(stop[1])).toContain('COS_HOOK_SPOOL=/Volumes/scratch/hook-spool')
  })

  it('refuses a hooks shape it would have to destroy, and never writes it', () => {
    expect(mergeHookSettings({ hooks: [] }, SCRIPT, PATHS)).toEqual({ ok: false, reason: 'settings_hooks_invalid' })
    expect(mergeHookSettings({ hooks: 'none' }, SCRIPT, PATHS)).toEqual({ ok: false, reason: 'settings_hooks_invalid' })
    expect(mergeHookSettings({ hooks: { Stop: { hooks: [] } } }, SCRIPT, PATHS)).toEqual({ ok: false, reason: 'settings_hooks_invalid' })
    // A foreign event with an odd shape is not ours to judge: it survives untouched.
    const odd = merged({ hooks: { SomethingElse: 'keep' } }).settings
    expect((odd.hooks as Record<string, unknown>).SomethingElse).toBe('keep')
  })

  it('collapses a stale copy of our block (old path) into one canonical block', () => {
    const stale = {
      hooks: { Stop: [
        { hooks: [{ type: 'command', command: '/old/.cos-glasses/bin/cos-session-hook Stop', timeout: 3 }] },
        { hooks: [{ type: 'command', command: '~/.claude/hooks/claude-active.sh stop', async: true }] },
      ] },
    }
    const { settings } = merged(stale)
    const stop = (settings.hooks as Record<string, unknown[]>).Stop
    expect(stop).toHaveLength(2)
    expect(JSON.stringify(stop[0])).toContain('claude-active.sh')
    expect(JSON.stringify(stop[1])).toContain(`${SCRIPT} Stop`)
  })

  it('strip removes only ours and deletes emptied arrays', () => {
    const installed = merged(REAL_SHAPE).settings
    const stripped = stripHookSettings(installed)
    if (!stripped.ok) throw new Error(stripped.reason)
    expect(stripped.changed).toBe(true)
    expect(stripped.settings.hooks).toEqual(REAL_SHAPE.hooks)
    expect(stripped.settings.model).toBe('opus')
    expect(stripHookSettings(REAL_SHAPE)).toMatchObject({ ok: true, changed: false })
  })

  it('reports subscribed, missing and drifted events', () => {
    const installed = merged(REAL_SHAPE).settings
    expect(subscribedEvents(installed, SCRIPT, PATHS)).toEqual({ subscribed: HOOK_SUBSCRIPTIONS.map(s => s.event), missing: [], drifted: [] })
    const hooks = installed.hooks as Record<string, unknown[]>
    const drifted = { ...installed, hooks: { ...hooks, Stop: [{ hooks: [{ type: 'command', command: cmd('Stop'), timeout: 99 }] }], PostCompact: [] } }
    const report = subscribedEvents(drifted, SCRIPT, PATHS)
    expect(report.drifted).toEqual(['Stop'])
    expect(report.missing).toEqual(['PostCompact'])
  })

  it('6.53.0: a 6.52 install (async PreToolUse with the question matcher) reads drift, and one install leaves ONE synchronous block', () => {
    // The shape every Mac carries until Install hooks runs after the update. The cancel
    // route reads this state and answers `hooks_outdated`, so the old block must not pass.
    const installed = merged(REAL_SHAPE).settings
    const hooks = installed.hooks as Record<string, unknown[]>
    const old652 = {
      ...installed,
      hooks: { ...hooks, PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: cmd('PreToolUse'), timeout: 10, async: true }] }] },
    }
    const report = subscribedEvents(old652, SCRIPT, PATHS)
    expect(report.drifted).toEqual(['PreToolUse'])
    expect(report.missing).toEqual([])
    // A foreign PreToolUse block survives; ours is replaced by exactly one block with no
    // matcher, never a second one beside the old (status requires exactly one).
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/guard.sh' }] }
    const withForeign = { ...old652, hooks: { ...old652.hooks, PreToolUse: [foreign, ...old652.hooks.PreToolUse] } }
    const again = merged(withForeign).settings
    const pre = (again.hooks as Record<string, unknown[]>).PreToolUse
    expect(pre).toEqual([foreign, { hooks: [{ type: 'command', command: cmd('PreToolUse'), timeout: 5 }] }])
    expect(subscribedEvents(again, SCRIPT, PATHS).drifted).toEqual([])
  })

  it('quotes a home directory with a space and leaves a plain path alone', () => {
    expect(shellQuote('/Users/plain/.cos-glasses/bin/cos-session-hook')).toBe('/Users/plain/.cos-glasses/bin/cos-session-hook')
    const spaced: HookPaths = { home: '/Users/Some One/.cos-glasses', spoolDir: '/Users/Some One/.cos-glasses/data/hook-spool' }
    expect(hookCommand('/Users/Some One/.cos-glasses/bin/cos-session-hook', 'Stop', spaced))
      .toBe(`COS_GLASSES_HOME='/Users/Some One/.cos-glasses' COS_HOOK_SPOOL='/Users/Some One/.cos-glasses/data/hook-spool' '/Users/Some One/.cos-glasses/bin/cos-session-hook' Stop`)
  })

  it('derives the token home and the spool from COS_DATA_DIR, so a scratch server never bakes the production paths', () => {
    const saved = { home: process.env.COS_GLASSES_HOME, data: process.env.COS_DATA_DIR, spool: process.env.COS_SESSION_HOOKS_SPOOL_DIR }
    try {
      delete process.env.COS_GLASSES_HOME
      delete process.env.COS_SESSION_HOOKS_SPOOL_DIR
      process.env.COS_DATA_DIR = '/Volumes/scratch/instance/data'
      expect(cosGlassesHome()).toBe('/Volumes/scratch/instance')
      expect(hookSpoolDir()).toBe('/Volumes/scratch/instance/data/hook-spool')
      process.env.COS_SESSION_HOOKS_SPOOL_DIR = '/Volumes/elsewhere/spool'
      expect(hookSpoolDir()).toBe('/Volumes/elsewhere/spool')
      process.env.COS_GLASSES_HOME = '/Volumes/home-override'
      expect(cosGlassesHome()).toBe('/Volumes/home-override')
    } finally {
      for (const [k, v] of [['COS_GLASSES_HOME', saved.home], ['COS_DATA_DIR', saved.data], ['COS_SESSION_HOOKS_SPOOL_DIR', saved.spool]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
    }
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
      expect(result.status.installed).toBe(true)
      expect(existsSync(scriptPath)).toBe(true)
      expect(lstatSync(scriptPath).mode & 0o777).toBe(0o755)
      expect(readFileSync(join(root, 'home', 'hook-port'), 'utf-8')).toBe('3999')
      expect(readFileSync(join(root, 'home', 'hook-desk-idle-s'), 'utf-8')).toBe('45')
      expect(readFileSync(join(root, 'home', 'hook-token'), 'utf-8')).toMatch(/^[0-9a-f]{64}$/)
      expect(lstatSync(join(root, 'home', 'hook-token')).mode & 0o777).toBe(0o600)
      expect(readdirSync(join(root, 'claude')).some(n => n.startsWith('settings.json.cos-backup-'))).toBe(true)
      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(written.model).toBe('opus')
      const command = written.hooks.PermissionRequest[0].hooks[0].command as string
      expect(command.endsWith(`${scriptPath} PermissionRequest`)).toBe(true)
      expect(command).toContain(`COS_GLASSES_HOME=${shellQuote(join(root, 'home'))} `)
      expect(command).toContain('COS_HOOK_SPOOL=')
      // A second install changes nothing and mints no second token.
      const token = readFileSync(join(root, 'home', 'hook-token'), 'utf-8')
      const again = installClaudeHooks({ settingsPath, packageScriptPath, scriptPath, port: 3999 })
      expect(again.changed).toBe(false)
      expect(readFileSync(join(root, 'home', 'hook-token'), 'utf-8')).toBe(token)
      // Uninstall restores the foreign hooks exactly.
      const removed = uninstallClaudeHooks({ settingsPath, packageScriptPath, scriptPath })
      expect(removed.changed).toBe(true)
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).hooks).toEqual(REAL_SHAPE.hooks)
      const gone = hookStatus({ settingsPath, packageScriptPath, scriptPath })
      expect(gone.state).toBe('missing')
      expect(gone.installed).toBe(false)
    } finally {
      delete process.env.COS_GLASSES_HOME
    }
  })

  // PREMISE CHANGED IN 6.53.0, on purpose. Through 6.52 this test pinned "an existing 6.51.0
  // install reads installed, no reinstall": 6.52.0 served the broker at the URL the 6.51
  // script already called. 6.53.0 changes BOTH the script (the halt check) and the
  // PreToolUse subscription, so an existing install must NOT read installed: the cancel
  // route keys `hooks_outdated` off exactly this, and Control's Install hooks banner too.
  it('6.53.0: an existing 6.51/6.52 install reads drift or script_outdated until Install hooks, then installed', () => {
    const { settingsPath, scriptPath, root } = sandbox()
    process.env.COS_GLASSES_HOME = join(root, 'home')
    try {
      const shipped = packagedHookScriptPath()
      expect(createHash('sha256').update(readFileSync(shipped)).digest('hex')).not.toBe('0a55756de9c88d7dc7a37fadb1ab627d55bb37ba27965178797423656d1df20a')
      // A Mac that ran 6.51.0's `--hooks install`: the old async PreToolUse block and the
      // old script (any other bytes stand in for it) at the stable path.
      installClaudeHooks({ settingsPath, packageScriptPath: shipped, scriptPath, port: 3141 })
      const current = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const pre = current.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>
      const oldCommand = pre[pre.length - 1]!.hooks[0]!.command
      current.hooks.PreToolUse = [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: oldCommand, timeout: 10, async: true }] }]
      writeFileSync(settingsPath, JSON.stringify(current, null, 2))
      writeFileSync(scriptPath, '#!/bin/sh\n# the 6.51.0 script\nexit 0\n')
      const before = hookStatus({ settingsPath, packageScriptPath: shipped, scriptPath })
      expect(before.state).toBe('drift')
      expect(before.drifted).toEqual(['PreToolUse'])
      expect(before.installed).toBe(false)
      // New subscription but the old script (Update Server alone never re-copies it).
      const fixed = installClaudeHooks({ settingsPath, packageScriptPath: shipped, scriptPath, port: 3141, dryRun: true }).merged!
      writeFileSync(settingsPath, JSON.stringify(fixed, null, 2))
      expect(hookStatus({ settingsPath, packageScriptPath: shipped, scriptPath }).state).toBe('script_outdated')
      // Install hooks: installed.
      const after = installClaudeHooks({ settingsPath, packageScriptPath: shipped, scriptPath, port: 3141 })
      expect(after.scriptCopied).toBe(true)
      expect(after.status.state).toBe('installed')
      expect(after.status.installed).toBe(true)
      copyFileSync(shipped, join(root, 'copy-check'))
      expect(readFileSync(scriptPath)).toEqual(readFileSync(join(root, 'copy-check')))
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

  it('reports disabled_by_settings when the file carries disableAllHooks, installed or not', () => {
    const { settingsPath, packageScriptPath, scriptPath, root } = sandbox()
    process.env.COS_GLASSES_HOME = join(root, 'home')
    try {
      writeFileSync(settingsPath, JSON.stringify({ ...REAL_SHAPE, disableAllHooks: true }))
      const status = hookStatus({ settingsPath, packageScriptPath, scriptPath })
      expect(status.state).toBe('disabled_by_settings')
      expect(status.installed).toBe(false)
      installClaudeHooks({ settingsPath, packageScriptPath, scriptPath, port: 1 })
      expect(hookStatus({ settingsPath, packageScriptPath, scriptPath }).state).toBe('disabled_by_settings')
    } finally {
      delete process.env.COS_GLASSES_HOME
    }
  })

  it('an unreadable settings file is settings_unreadable, never missing, and install refuses', () => {
    const { packageScriptPath, scriptPath, root } = sandbox()
    process.env.COS_GLASSES_HOME = join(root, 'home')
    try {
      // A directory where the file should be: exists, cannot be read as a file (EISDIR).
      const asDir = join(root, 'claude', 'settings-dir.json')
      mkdirSync(asDir)
      const status = hookStatus({ settingsPath: asDir, packageScriptPath, scriptPath })
      expect(status.state).toBe('settings_unreadable')
      expect(status.installed).toBe(false)
      const result = installClaudeHooks({ settingsPath: asDir, packageScriptPath, scriptPath, port: 1 })
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('settings_unreadable')
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
