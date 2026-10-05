// 6.62.0 (plan 2.3): the COS hook in Codex's user-level hooks.json. Every path is a temp dir
// with a space and a dot directory in it (the real repo path has spaces; `~/.codex` and
// `~/.cos-glasses` are dot dirs). Nothing here reads or writes the real ~/.codex, ~/.claude or
// ~/.cos-glasses, and the "app-server" is a fixture script speaking the same JSON-RPC.

import express from 'express'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { hookStatus, installClaudeHooks, packagedHookScriptPath, type HookPaths } from './claude-hooks-installer.js'
import {
  CODEX_HOOK_SUBSCRIPTIONS,
  CODEX_TRUST_CACHE_MS,
  CODEX_TRUST_KILL_GRACE_MS,
  CODEX_TRUST_REFRESH_MS,
  __resetCodexHookTrustForTests,
  cachedCodexHookTrust,
  codexHookAdvice,
  codexHookCommand,
  codexHookStatus,
  foldCodexTrust,
  installCodexHooks,
  mergeCodexHooks,
  readCodexHookTrust,
  refreshCodexHookTrust,
  stableCodexHookScriptPath,
  stripCodexHooks,
  uninstallCodexHooks,
} from './codex-hooks-installer.js'
import { createSessionHooksRouter, type SessionHooksCodexDeps } from '../routes/session-hooks.js'
import { invalidateHookStatus } from './session-hooks-runtime.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cos-codex-hooks-'))
  roots.push(root)
  const home = join(root, 'Ukaoma Chief Of Staff')
  const codexHome = join(home, '.codex')
  const cosHome = join(home, '.cos-glasses')
  mkdirSync(codexHome, { recursive: true })
  const hookPaths: HookPaths = { home: cosHome, spoolDir: join(cosHome, 'data', 'hook-spool') }
  return {
    root,
    home,
    codexHome,
    hooksPath: join(codexHome, 'hooks.json'),
    configPath: join(codexHome, 'config.toml'),
    scriptPath: join(cosHome, 'bin', 'cos-session-hook'),
    packageScriptPath: packagedHookScriptPath(),
    hookPaths,
  }
}

const user = (name: string, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `'/Users/me/bin/${name}'` }] })

describe('the generated hooks.json (K2 fields, Claude-shaped, the provider in the command)', () => {
  it('preserves a mixed user/COS block when it is the first matching block, on install and uninstall', () => {
    const f = fixture()
    const mixed = { hooks: [
      { type: 'command', command: `'${f.scriptPath}' Stop` },
      { type: 'command', command: "'/Users/me/bin/mine'" },
    ] }
    const original = { hooks: { Stop: [mixed, user('after')] } }
    const merged = mergeCodexHooks(original, f.scriptPath, f.hookPaths)
    if (!merged.ok) throw new Error(merged.reason)
    const blocks = (merged.settings.hooks as Record<string, unknown[]>).Stop
    expect(blocks.slice(0, 2)).toEqual(original.hooks.Stop)
    expect(blocks).toHaveLength(3)
    const stripped = stripCodexHooks(merged.settings)
    if (!stripped.ok) throw new Error(stripped.reason)
    expect((stripped.settings.hooks as Record<string, unknown[]>).Stop).toEqual(original.hooks.Stop)
  })

  it('one block per subscribed event: timeoutSec and an explicit async, COS_HOOK_PROVIDER=codex, never trusted_hash', () => {
    const f = fixture()
    const result = installCodexHooks(f)
    expect(result.ok).toBe(true)
    expect(result.status).toMatchObject({ state: 'installed', installed: true, scriptOk: true })
    const file = JSON.parse(readFileSync(f.hooksPath, 'utf8'))
    expect(Object.keys(file.hooks).sort()).toEqual(CODEX_HOOK_SUBSCRIPTIONS.map(s => s.event).sort())
    for (const sub of CODEX_HOOK_SUBSCRIPTIONS) {
      expect(file.hooks[sub.event]).toEqual([{ hooks: [{ type: 'command', command: codexHookCommand(f.scriptPath, sub, f.hookPaths), timeoutSec: sub.timeoutSec, async: sub.async }] }])
      const hook = file.hooks[sub.event][0].hooks[0]
      expect(hook.command.startsWith('COS_HOOK_PROVIDER=codex ')).toBe(true)
      expect(hook.command).toContain(`'${f.scriptPath}' ${sub.event}`)
      expect(hook).not.toHaveProperty('timeout')
    }
    // The halt check and the turn transitions are synchronous; PermissionRequest passes its wait.
    const sync = CODEX_HOOK_SUBSCRIPTIONS.filter(s => !s.async).map(s => s.event).sort()
    expect(sync).toEqual(['Interrupt', 'PermissionRequest', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    expect(file.hooks.PermissionRequest[0].hooks[0].command.endsWith(' PermissionRequest 630')).toBe(true)
    // No Claude-only event, and trust is never written by us.
    for (const claudeOnly of ['StopFailure', 'Notification', 'PostModelSwitch', 'PermissionDenied', 'PostToolUseFailure']) expect(file.hooks).not.toHaveProperty(claudeOnly)
    expect(JSON.stringify(file)).not.toContain('trusted_hash')
    expect(existsSync(f.configPath)).toBe(false)
    // The stable script was copied, so the command runs THIS package's script.
    expect(readFileSync(f.scriptPath).equals(readFileSync(f.packageScriptPath))).toBe(true)
    // Idempotent, byte for byte: the command never carries a version, so Codex asks no re-review.
    const bytes = readFileSync(f.hooksPath)
    expect(installCodexHooks(f).changed).toBe(false)
    expect(readFileSync(f.hooksPath).equals(bytes)).toBe(true)
  })
})

describe('the merge replaces our blocks IN PLACE and keeps every user block index (W2)', () => {
  it('a COS block between two user blocks is rewritten where it stands; a missing one is appended last', () => {
    const f = fixture()
    const staleOurs = { hooks: [{ type: 'command', command: `COS_GLASSES_HOME=x '${f.scriptPath}' PreToolUse`, timeout: 5 }] }
    const current = {
      someOtherKey: { keep: true },
      hooks: {
        PreToolUse: [user('a', 'Bash'), staleOurs, user('b', 'Edit')],
        Stop: [user('c')],
        UserPromptSubmit: [user('d'), user('e')],
        Notification: [user('f')],
      },
    }
    writeFileSync(f.hooksPath, JSON.stringify(current, null, 2))
    const merged = mergeCodexHooks(current, f.scriptPath, f.hookPaths)
    if (!merged.ok) throw new Error(merged.reason)
    const hooks = merged.settings.hooks as Record<string, unknown[]>
    // Trust keys are `<file>:<event>:<i>:<j>`: user blocks keep i.
    expect(hooks.PreToolUse[0]).toEqual(user('a', 'Bash'))
    expect(hooks.PreToolUse[2]).toEqual(user('b', 'Edit'))
    expect(JSON.stringify(hooks.PreToolUse[1])).toContain('COS_HOOK_PROVIDER=codex')
    expect(hooks.PreToolUse).toHaveLength(3)
    expect(hooks.Stop[0]).toEqual(user('c'))
    expect(JSON.stringify(hooks.Stop[1])).toContain('COS_HOOK_PROVIDER=codex')
    expect(hooks.UserPromptSubmit.slice(0, 2)).toEqual([user('d'), user('e')])
    expect(hooks.Notification).toEqual([user('f')])
    expect(merged.settings.someOtherKey).toEqual({ keep: true })

    // Through the file, with a backup of what was there.
    const result = installCodexHooks(f)
    expect(result.ok).toBe(true)
    expect(result.backupPath).not.toBeNull()
    expect(JSON.parse(readFileSync(result.backupPath!, 'utf8'))).toEqual(current)
    expect(readdirSync(f.codexHome).filter(n => n.startsWith('hooks.json.cos-backup-'))).toHaveLength(1)
    const written = JSON.parse(readFileSync(f.hooksPath, 'utf8')).hooks
    expect(written.PreToolUse[0]).toEqual(user('a', 'Bash'))
    expect(written.PreToolUse[2]).toEqual(user('b', 'Edit'))

    // QA W13: a SECOND block of ours (a hand edit, or a COS block Codex imported from the
    // Claude settings) is left where it stands: removing it would move the user block after it.
    // A user block that ALSO calls our script is not ours to rewrite either. Both read drift.
    const imported = { hooks: [{ type: 'command', command: `COS_GLASSES_HOME=x '${f.scriptPath}' PreToolUse`, timeout: 5 }] }
    const mixed = { hooks: [{ type: 'command', command: `'${f.scriptPath}' Stop` }, { type: 'command', command: `'/Users/me/bin/mine'` }] }
    const twice = { hooks: { ...written, PreToolUse: [...written.PreToolUse, imported, user('after', 'Read')], Stop: [...written.Stop, mixed] } }
    const again = mergeCodexHooks(twice, f.scriptPath, f.hookPaths)
    if (!again.ok) throw new Error(again.reason)
    const againHooks = again.settings.hooks as Record<string, unknown[]>
    expect(againHooks.PreToolUse).toEqual([user('a', 'Bash'), written.PreToolUse[1], user('b', 'Edit'), imported, user('after', 'Read')])
    expect(againHooks.Stop).toEqual([user('c'), written.Stop[1], mixed])
    writeFileSync(f.hooksPath, JSON.stringify(again.settings))
    const status = codexHookStatus(f)
    expect(status.state).toBe('drift')
    // In subscription order (CODEX_HOOK_SUBSCRIPTIONS): Stop is listed before PreToolUse.
    expect(status.drifted).toEqual(['Stop', 'PreToolUse'])
    expect(status.duplicated).toEqual(['Stop', 'PreToolUse'])
    expect(codexHookAdvice(status, 'unknown')).toContain('more than once for Stop, PreToolUse')
  })

  it('6.62.0 (QA W12): Codex runs its OWN copy of the script, so rolling the Claude script back changes nothing for Codex', () => {
    const f = fixture()
    const prev = process.env.COS_GLASSES_HOME
    process.env.COS_GLASSES_HOME = f.hookPaths.home
    try {
      expect(stableCodexHookScriptPath()).toBe(join(f.hookPaths.home, 'bin', 'cos-session-hook-codex'))
      const result = installCodexHooks({ hooksPath: f.hooksPath, hookPaths: f.hookPaths })
      expect(result.ok).toBe(true)
      expect(result.status).toMatchObject({ state: 'installed', scriptOk: true, scriptPath: stableCodexHookScriptPath() })
      const command = JSON.parse(readFileSync(f.hooksPath, 'utf8')).hooks.Stop[0].hooks[0].command as string
      expect(command).toContain(`'${stableCodexHookScriptPath()}' Stop`)
      expect(readFileSync(stableCodexHookScriptPath()).equals(readFileSync(f.packageScriptPath))).toBe(true)
      // A rollback reinstalls the 6.61.7 script at the CLAUDE stable path: Codex is unaffected.
      mkdirSync(join(f.hookPaths.home, 'bin'), { recursive: true })
      copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'cos-session-hook-6.61.7'), join(f.hookPaths.home, 'bin', 'cos-session-hook'))
      expect(codexHookStatus({ hooksPath: f.hooksPath, hookPaths: f.hookPaths })).toMatchObject({ state: 'installed', scriptOk: true })
      // An older copy at the CODEX path is not ok: its halt reply makes Codex fail open.
      copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'cos-session-hook-6.61.7'), stableCodexHookScriptPath())
      expect(codexHookStatus({ hooksPath: f.hooksPath, hookPaths: f.hookPaths })).toMatchObject({ state: 'script_outdated', scriptOk: false })
      // Hooks pointing at the shared script (a pre-W12 install) are ours, rewritten in place.
      const legacy = { hooks: { Stop: [user('c'), { hooks: [{ type: 'command', command: `COS_HOOK_PROVIDER=codex '${join(f.hookPaths.home, 'bin', 'cos-session-hook')}' Stop`, timeoutSec: 5, async: false }] }] } }
      const merged = mergeCodexHooks(legacy, stableCodexHookScriptPath(), f.hookPaths)
      if (!merged.ok) throw new Error(merged.reason)
      expect((merged.settings.hooks as Record<string, unknown[]>).Stop).toHaveLength(2)
      expect(JSON.stringify((merged.settings.hooks as Record<string, unknown[]>).Stop[1])).toContain('cos-session-hook-codex')
    } finally {
      if (prev === undefined) delete process.env.COS_GLASSES_HOME
      else process.env.COS_GLASSES_HOME = prev
    }
  })

  it('refuses a hooks shape it would have to destroy, and writes nothing', () => {
    const f = fixture()
    for (const bad of ['{"hooks":[]}', '{"hooks":{"Stop":{}}}', '{not json']) {
      writeFileSync(f.hooksPath, bad)
      const r = installCodexHooks(f)
      expect(r.ok).toBe(false)
      expect(readFileSync(f.hooksPath, 'utf8')).toBe(bad)
    }
  })

  it('uninstall removes only our blocks; user blocks keep their order', () => {
    const f = fixture()
    writeFileSync(f.hooksPath, JSON.stringify({ hooks: { PreToolUse: [user('a', 'Bash')], Stop: [user('c')] } }))
    expect(installCodexHooks(f).ok).toBe(true)
    const dry = uninstallCodexHooks({ ...f, dryRun: true })
    expect(dry.changed).toBe(true)
    expect(JSON.parse(readFileSync(f.hooksPath, 'utf8')).hooks.PreToolUse).toHaveLength(2)
    const r = uninstallCodexHooks(f)
    expect(r).toMatchObject({ ok: true, changed: true })
    expect(JSON.parse(readFileSync(f.hooksPath, 'utf8')).hooks).toEqual({ PreToolUse: [user('a', 'Bash')], Stop: [user('c')] })
    expect(r.status.state).toBe('missing')
    // Nothing there at all: nothing to do, no file created.
    const g = fixture()
    expect(uninstallCodexHooks(g)).toMatchObject({ ok: true, changed: false })
    expect(existsSync(g.hooksPath)).toBe(false)
  })
})

describe('status', () => {
  it('missing, installed, and script_outdated when the stable script is not this package\'s (no prior script can halt Codex)', () => {
    const f = fixture()
    expect(codexHookStatus(f)).toMatchObject({ state: 'missing', installed: false, scriptOk: false })
    installCodexHooks(f)
    expect(codexHookStatus(f)).toMatchObject({ state: 'installed', installed: true, scriptOk: true })
    // The 6.61.7 script is halt-capable for CLAUDE only: its reply makes Codex fail open (C10).
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'cos-session-hook-6.61.7'), f.scriptPath)
    expect(codexHookStatus(f)).toMatchObject({ state: 'script_outdated', installed: false, scriptOk: false })
  })
})

describe('a Codex install leaves Claude\'s status and bytes unchanged (B2)', () => {
  it('the Claude settings file, its status and halt readiness are identical before and after', () => {
    const f = fixture()
    const settingsPath = join(f.home, '.claude', 'settings.json')
    mkdirSync(join(f.home, '.claude'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus', hooks: { Stop: [user('z')] } }, null, 2))
    const prevHome = process.env.COS_GLASSES_HOME
    process.env.COS_GLASSES_HOME = f.hookPaths.home
    try {
      expect(installClaudeHooks({ settingsPath, scriptPath: f.scriptPath, packageScriptPath: f.packageScriptPath, hookPaths: f.hookPaths, port: 3999 }).ok).toBe(true)
      const before = readFileSync(settingsPath)
      const statusBefore = hookStatus({ settingsPath, scriptPath: f.scriptPath, packageScriptPath: f.packageScriptPath, hookPaths: f.hookPaths })
      expect(statusBefore.state).toBe('installed')
      expect(installCodexHooks(f).ok).toBe(true)
      expect(uninstallCodexHooks(f).ok).toBe(true)
      expect(installCodexHooks(f).ok).toBe(true)
      expect(readFileSync(settingsPath).equals(before)).toBe(true)
      expect(hookStatus({ settingsPath, scriptPath: f.scriptPath, packageScriptPath: f.packageScriptPath, hookPaths: f.hookPaths })).toEqual(statusBefore)
      // And the Claude file never names the Codex provider.
      expect(before.toString('utf8')).not.toContain('COS_HOOK_PROVIDER')
    } finally {
      if (prevHome === undefined) delete process.env.COS_GLASSES_HOME
      else process.env.COS_GLASSES_HOME = prevHome
    }
  })
})

describe('trust from Codex\'s own app-server (K3)', () => {
  afterEach(() => __resetCodexHookTrustForTests())

  /** A stand-in `codex` that answers initialize and hooks/list exactly as the v2 schema says. */
  let fakes = 0
  function fakeCodex(f: ReturnType<typeof fixture>, mode: 'answer' | 'exit' | 'silent' | 'stubborn', hooks: unknown[] = [], delayMs = 0): string {
    const dir = join(f.home, `Fake Codex ${++fakes}.app`)
    const bin = join(dir, 'codex')
    mkdirSync(dir, { recursive: true })
    const log = join(f.home, 'calls.log')
    writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')
fs.writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid))
const mode = ${JSON.stringify(mode)}
if (mode === 'exit') process.exit(3)
if (mode === 'stubborn') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000) }
let buf = ''
process.stdin.on('data', c => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(msg) + '\\n')
    if (mode === 'silent' || mode === 'stubborn') continue
    if (msg.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'fake' } }) + '\\n')
    if (msg.id === 2) setTimeout(() => process.stdout.write(JSON.stringify({ id: 2, result: { data: [{ cwd: msg.params.cwds[0], errors: [], warnings: [], hooks: ${JSON.stringify(hooks)} }] } }) + '\\n'), ${delayMs})
  }
})
`)
    chmodSync(bin, 0o755)
    return bin
  }
  const listed = (f: ReturnType<typeof fixture>, trustStatus: string, extra: Record<string, unknown> = {}) =>
    CODEX_HOOK_SUBSCRIPTIONS.map((sub, i) => ({
      handlerType: 'command', command: codexHookCommand(f.scriptPath, sub, f.hookPaths), source: 'user', sourcePath: f.hooksPath,
      trustStatus, enabled: true, eventName: sub.event, key: `${f.hooksPath}:x:${i}:0`, currentHash: 'h', displayOrder: i, isManaged: false, timeoutSec: sub.timeoutSec, ...extra,
    }))

  it('trusted, untrusted and modified come from hooks/list; the request is initialize, initialized, hooks/list', async () => {
    const f = fixture()
    const trusted = await readCodexHookTrust({ binary: fakeCodex(f, 'answer', listed(f, 'trusted')), cwd: f.home })
    expect(trusted).toEqual({ trust: 'trusted', listed: CODEX_HOOK_SUBSCRIPTIONS.length, reason: null })
    const calls = readFileSync(join(f.home, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(calls[0]).toEqual(['app-server', '--listen', 'stdio://'])
    expect(calls.slice(1).map(c => c.method)).toEqual(['initialize', 'initialized', 'hooks/list'])
    expect(calls[3].params).toEqual({ cwds: [f.home] })
    expect((await readCodexHookTrust({ binary: fakeCodex(f, 'answer', listed(f, 'untrusted')), cwd: f.home })).trust).toBe('untrusted')
    const oneModified = listed(f, 'trusted')
    oneModified[3] = { ...oneModified[3]!, trustStatus: 'modified' }
    expect((await readCodexHookTrust({ binary: fakeCodex(f, 'answer', oneModified), cwd: f.home })).trust).toBe('modified')
  })

  it('a failure is unknown, never trusted: the child exits, never answers, or lists none of ours', async () => {
    const f = fixture()
    expect(await readCodexHookTrust({ binary: fakeCodex(f, 'exit'), cwd: f.home })).toMatchObject({ trust: 'unknown', reason: 'rpc_error' })
    expect(await readCodexHookTrust({ binary: fakeCodex(f, 'silent'), cwd: f.home, timeoutMs: 400 })).toMatchObject({ trust: 'unknown', reason: 'timeout' })
    expect(await readCodexHookTrust({ binary: join(f.home, 'no such codex'), cwd: f.home })).toMatchObject({ trust: 'unknown' })
    const projectOnly = listed(f, 'trusted', { source: 'project' })
    expect(await readCodexHookTrust({ binary: fakeCodex(f, 'answer', projectOnly), cwd: f.home })).toMatchObject({ trust: 'unknown', reason: 'not_listed' })
  })

  it('fold: a disabled hook or a partial list is not trusted; foreign hooks are ignored', () => {
    const f = fixture()
    const all = listed(f, 'trusted')
    expect(foldCodexTrust([...all, { command: "'/Users/me/bin/x'", source: 'user', trustStatus: 'untrusted' }]).trust).toBe('trusted')
    expect(foldCodexTrust(all.map((h, i) => (i === 0 ? { ...h, enabled: false } : h))).trust).toBe('untrusted')
    expect(foldCodexTrust(all.slice(1))).toMatchObject({ trust: 'untrusted', reason: 'partial' })
    expect(foldCodexTrust(all.map(h => ({ ...h, trustStatus: 'managed' }))).trust).toBe('managed')
  })

  it('the cache: unknown until read, then the answer for longer than a refresh period (QA W4), then stale', async () => {
    const f = fixture()
    expect(CODEX_TRUST_CACHE_MS).toBeGreaterThan(CODEX_TRUST_REFRESH_MS)
    expect(cachedCodexHookTrust(1_000)).toMatchObject({ trust: 'unknown', reason: 'unchecked', trustReason: 'unchecked', checkedAt: null })
    const t = 10_000
    await refreshCodexHookTrust({ binary: fakeCodex(f, 'answer', listed(f, 'trusted')), cwd: f.home, now: () => t })
    expect(cachedCodexHookTrust(t + 1_000)).toMatchObject({ trust: 'trusted', trustReason: null, checkedAt: t })
    // A refresh that lands late (a timeout, a slow tick) leaves no `unknown` gap.
    expect(cachedCodexHookTrust(t + CODEX_TRUST_REFRESH_MS + 60_000)).toMatchObject({ trust: 'trusted', checkedAt: t })
    expect(cachedCodexHookTrust(t + CODEX_TRUST_CACHE_MS)).toMatchObject({ trust: 'unknown', reason: 'stale', trustReason: 'stale', checkedAt: t })
  })

  it('QA W4: a failed read keeps the last answer and names why; a new answer replaces it', async () => {
    const f = fixture()
    let t = 10_000
    await refreshCodexHookTrust({ binary: fakeCodex(f, 'answer', listed(f, 'trusted')), cwd: f.home, now: () => t })
    t = 20_000
    expect(await refreshCodexHookTrust({ binary: fakeCodex(f, 'silent'), cwd: f.home, timeoutMs: 300, now: () => t })).toMatchObject({ trust: 'unknown', reason: 'timeout' })
    expect(cachedCodexHookTrust(t + 1)).toMatchObject({ trust: 'trusted', checkedAt: 10_000, trustReason: 'timeout' })
    t = 30_000
    await refreshCodexHookTrust({ binary: fakeCodex(f, 'answer', listed(f, 'untrusted')), cwd: f.home, now: () => t })
    expect(cachedCodexHookTrust(t + 1)).toMatchObject({ trust: 'untrusted', checkedAt: 30_000, trustReason: null })
    // Codex answering that it lists none of ours IS an answer, and replaces the last one.
    t = 40_000
    await refreshCodexHookTrust({ binary: fakeCodex(f, 'answer', []), cwd: f.home, now: () => t })
    expect(cachedCodexHookTrust(t + 1)).toMatchObject({ trust: 'unknown', checkedAt: 40_000, trustReason: 'not_listed' })
  })

  it('QA W4: a fresh read after an install supersedes one already in flight; the older one never writes', async () => {
    const f = fixture()
    const before = refreshCodexHookTrust({ binary: fakeCodex(f, 'answer', listed(f, 'untrusted'), 600), cwd: f.home })
    // A tick during the read joins it; the install starts a NEW one.
    expect(refreshCodexHookTrust({ binary: fakeCodex(f, 'answer', listed(f, 'modified')), cwd: f.home })).toBe(before)
    const after = refreshCodexHookTrust({ binary: fakeCodex(f, 'answer', listed(f, 'trusted')), cwd: f.home, fresh: true })
    expect(after).not.toBe(before)
    expect((await after).trust).toBe('trusted')
    expect((await before).trust).toBe('untrusted')
    expect(cachedCodexHookTrust().trust).toBe('trusted')
  })

  it('QA W4: an app-server that ignores SIGTERM is SIGKILLed after the grace', { timeout: 15_000 }, async () => {
    const f = fixture()
    const bin = fakeCodex(f, 'stubborn')
    expect(await readCodexHookTrust({ binary: bin, cwd: f.home, timeoutMs: 400 })).toMatchObject({ trust: 'unknown', reason: 'timeout' })
    const pid = Number(readFileSync(join(dirname(bin), 'pid'), 'utf8'))
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    expect(alive()).toBe(true)
    const deadline = Date.now() + CODEX_TRUST_KILL_GRACE_MS + 3_000
    while (alive() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
    expect(alive()).toBe(false)
  })
})

describe('the install route: Codex never fails it, never changes Claude\'s answer (B2)', () => {
  const keys = ['CLAUDE_CONFIG_DIR', 'COS_GLASSES_HOME', 'CURSOR_CONFIG_DIR'] as const
  const saved: Partial<Record<(typeof keys)[number], string | undefined>> = {}
  const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>(r => server.close(() => r()))
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    invalidateHookStatus()
  })

  async function route(f: ReturnType<typeof fixture>, codex: SessionHooksCodexDeps): Promise<string> {
    for (const k of keys) saved[k] = process.env[k]
    process.env.CLAUDE_CONFIG_DIR = join(f.home, '.claude')
    process.env.COS_GLASSES_HOME = f.hookPaths.home
    process.env.CURSOR_CONFIG_DIR = join(f.home, '.cursor')
    const app = express()
    app.use(express.json())
    app.use('/api', createSessionHooksRouter({ port: 3999, codex }))
    const server = await new Promise<ReturnType<typeof app.listen>>(r => { const l = app.listen(0, '127.0.0.1', () => r(l)) })
    servers.push(server)
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  const post = async (url: string) => { const r = await fetch(url, { method: 'POST' }); return { status: r.status, body: await r.json() as Record<string, any> } }

  it('Codex absent: skipped. Codex refusing or throwing: 200, Claude installed, the Codex answer reported apart', async () => {
    const f = fixture()
    let refreshed = 0
    const base = await route(f, {
      present: () => false,
      install: () => { throw new Error('must not run') },
      uninstall: () => { throw new Error('must not run') },
      refresh: () => { refreshed++ },
    })
    const absent = await post(`${base}/api/session-hooks/install`)
    expect(absent.status).toBe(200)
    expect(absent.body).toMatchObject({ ok: true, codex: { ok: true, skipped: 'codex_not_present' }, status: { state: 'installed', installed: true } })
    expect(refreshed).toBe(1)
  })

  it('a throwing Codex step, and a refusing one, leave the Claude result as it is', async () => {
    const f = fixture()
    const base = await route(f, {
      present: () => true,
      install: () => { throw new Error('boom /Users/secret/path') },
      uninstall: () => ({ ok: false, reason: 'hooks_unparseable', changed: false, scriptCopied: false, backupPath: null, status: codexHookStatus(f) }),
      refresh: () => {},
    })
    const threw = await post(`${base}/api/session-hooks/install`)
    expect(threw.status).toBe(200)
    expect(threw.body.ok).toBe(true)
    expect(threw.body.status).toMatchObject({ state: 'installed', installed: true })
    expect(threw.body.codex).toEqual({ ok: false, reason: 'codex_step_threw', detail: 'Error' })
    expect(JSON.stringify(threw.body.codex)).not.toContain('/Users/secret')
    const refused = await post(`${base}/api/session-hooks/uninstall`)
    expect(refused.status).toBe(200)
    expect(refused.body.ok).toBe(true)
    expect(refused.body.codex.ok).toBe(false)
  })

  it('a real Codex install through the route lands in the temp Codex home, with the Claude file untouched by it', async () => {
    const f = fixture()
    const base = await route(f, { present: () => true, install: o => installCodexHooks({ ...f, ...o }), uninstall: o => uninstallCodexHooks({ ...f, ...o }), refresh: () => {} })
    const dry = await post(`${base}/api/session-hooks/install?dryRun=1`)
    expect(dry.body.codex.merged.hooks.Stop).toHaveLength(1)
    expect(existsSync(f.hooksPath)).toBe(false)
    const done = await post(`${base}/api/session-hooks/install`)
    expect(done.body.codex).toMatchObject({ ok: true, changed: true, status: { state: 'installed', installed: true, scriptOk: true } })
    expect(readFileSync(join(f.home, '.claude', 'settings.json'), 'utf8')).not.toContain('COS_HOOK_PROVIDER')
    const gone = await post(`${base}/api/session-hooks/uninstall`)
    expect(gone.body.codex).toMatchObject({ ok: true, changed: true, status: { state: 'missing' } })
  })
})
