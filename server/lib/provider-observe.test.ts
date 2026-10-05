// 6.62.0 /qa: the background refresh behind health's provider fields. Every home here is a temp
// dir with a space and a dot directory; the "codex" binary is a fixture app-server.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { CODEX_HOOK_SUBSCRIPTIONS, __resetCodexHookTrustForTests, cachedCodexHookTrust, codexHookCommand, installCodexHooks, refreshCodexHookTrust, stableCodexHookScriptPath } from './codex-hooks-installer.js'
import { currentHookPaths } from './claude-hooks-installer.js'
import { CURSOR_SPAWN_STALE_MS } from './cursor-spawn-env.js'
import { __resetProviderObserveForTests, codexHooksHealthField, refreshAfterInstall, startProviderObserveRefresh } from './provider-observe.js'
import { __resetDeskCancelReadersForTests } from './session-cancel.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const KEYS = ['COS_CURSOR_SPAWN_ROOT', 'CODEX_HOME', 'CURSOR_CONFIG_DIR', 'COS_GLASSES_HOME', 'COS_CODEX_BIN'] as const
const saved: Record<string, string | undefined> = {}
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  __resetProviderObserveForTests()
  __resetCodexHookTrustForTests()
  __resetDeskCancelReadersForTests()
})

function homes(): string {
  for (const k of KEYS) saved[k] = process.env[k]
  const root = mkdtempSync(join(tmpdir(), 'cos-provider-observe-'))
  roots.push(root)
  const home = join(root, 'Ukaoma Chief Of Staff')
  process.env.COS_CURSOR_SPAWN_ROOT = join(home, '.cos-glasses', 'cursor-cli')
  process.env.CODEX_HOME = join(home, '.codex')
  process.env.CURSOR_CONFIG_DIR = join(home, '.cursor')
  process.env.COS_GLASSES_HOME = join(home, '.cos-glasses')
  mkdirSync(process.env.CODEX_HOME, { recursive: true })
  mkdirSync(process.env.COS_CURSOR_SPAWN_ROOT, { recursive: true })
  return home
}

/** A stand-in `codex` app-server answering hooks/list with OUR hooks at `status`, after `delayMs`. */
function fakeCodex(home: string, name: string, status: string, delayMs = 0): string {
  const dir = join(home, `Fake ${name}.app`)
  mkdirSync(dir, { recursive: true })
  const hooks = CODEX_HOOK_SUBSCRIPTIONS.map(sub => ({ handlerType: 'command', command: codexHookCommand(stableCodexHookScriptPath(), sub, currentHookPaths()), source: 'user', trustStatus: status, enabled: true }))
  const bin = join(dir, 'codex')
  writeFileSync(bin, `#!${process.execPath}
let buf = ''
process.stdin.on('data', c => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (msg.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
    if (msg.id === 2) setTimeout(() => process.stdout.write(JSON.stringify({ id: 2, result: { data: [{ cwd: '/', errors: [], warnings: [], hooks: ${JSON.stringify(hooks)} }] } }) + '\\n'), ${delayMs})
  }
})
`)
  chmodSync(bin, 0o755)
  return bin
}

describe('startProviderObserveRefresh (QA W20)', () => {
  it('reaps stale per-spawn Cursor folders at boot, and nothing else', () => {
    const home = homes()
    const root = process.env.COS_CURSOR_SPAWN_ROOT!
    const old = new Date(Date.now() - CURSOR_SPAWN_STALE_MS - 60_000)
    for (const name of ['spawn-old', 'spawn-new', 'not-a-spawn']) mkdirSync(join(root, name))
    utimesSync(join(root, 'spawn-old'), old, old)
    utimesSync(join(root, 'not-a-spawn'), old, old)
    const stop = startProviderObserveRefresh()
    stop()
    expect(existsSync(join(root, 'spawn-old'))).toBe(false)
    expect(existsSync(join(root, 'spawn-new'))).toBe(true)
    expect(existsSync(join(root, 'not-a-spawn'))).toBe(true)
    expect(home).toContain(' ')
  })
})

describe('refreshAfterInstall (QA W4)', () => {
  it('starts a FRESH trust read: a read begun before the install never stands in for one after it', async () => {
    const home = homes()
    process.env.COS_CODEX_BIN = fakeCodex(home, 'after', 'trusted')
    expect(installCodexHooks().ok).toBe(true)
    // A tick began a read before the install finished; it answers late, and untrusted.
    const before = refreshCodexHookTrust({ binary: fakeCodex(home, 'before', 'untrusted', 800) })
    refreshAfterInstall()
    expect(codexHooksHealthField().installed).toBe(true)
    await before
    const deadline = Date.now() + 5_000
    while (cachedCodexHookTrust().trust !== 'trusted' && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    expect(cachedCodexHookTrust()).toMatchObject({ trust: 'trusted', trustReason: null })
    expect(codexHooksHealthField()).toMatchObject({ installed: true, trust: 'trusted', trustReason: null })
  })
})
