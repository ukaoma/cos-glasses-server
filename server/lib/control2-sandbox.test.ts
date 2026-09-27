import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, linkSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControl2Snapshot, probeControl2Sandbox, runControl2Sandbox, type Control2Snapshot } from './control2-sandbox.js'

const temporary: string[] = []
const snapshots: Control2Snapshot[] = []
afterEach(() => { for (const s of snapshots.splice(0)) s.dispose(); for (const p of temporary.splice(0)) rmSync(p, { recursive: true, force: true }) })
function source() { const p = mkdtempSync(join(tmpdir(), 'control2-test-')); temporary.push(p); return p }
function snapshot() { const s = createControl2Snapshot(); snapshots.push(s); return s }

describe('Control 2 isolated snapshot admission', () => {
  it('copies explicit regular files without changing the source', () => {
    const root = source(); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'page.txt'), 'approved')
    const s = createControl2Snapshot({ sourceRoot: root, relativePaths: ['src/page.txt'] }); snapshots.push(s)
    writeFileSync(join(s.root, 'src/page.txt'), 'draft')
    expect(readFileSync(join(root, 'src/page.txt'), 'utf8')).toBe('approved')
    expect(s.files).toEqual(['src/page.txt'])
  })
  it.each(['../escape', '/absolute', 'a/../escape', '.env', '.git/config', 'nested/.credentials', 'private.pem', 'credentials.json'])('refuses unsafe or credential path %s', name => {
    expect(() => createControl2Snapshot({ sourceRoot: source(), relativePaths: [name] })).toThrow()
  })
  it('rejects file and parent-directory symlinks, hardlinks and directories', () => {
    const root = source(); const outside = source(); writeFileSync(join(outside, 'sentinel'), 'protected')
    symlinkSync(join(outside, 'sentinel'), join(root, 'link')); symlinkSync(outside, join(root, 'parent'))
    linkSync(join(outside, 'sentinel'), join(root, 'hardlink')); mkdirSync(join(root, 'directory'))
    for (const path of ['link', 'parent/sentinel', 'hardlink', 'directory']) expect(() => createControl2Snapshot({ sourceRoot: root, relativePaths: [path] })).toThrow()
  })
})

describe.skipIf(process.platform !== 'darwin')('actual macOS process sandbox', () => {
  it('passes both positive controls and real negative probes, including descendants', async () => {
    const result = await probeControl2Sandbox()
    expect(result, JSON.stringify(result)).toMatchObject({ supported: true, proven: true, code: 'sandbox_probe_proven' })
    expect(result.checks.timeoutDescendantGone).toBe(true)
    expect(result.checks.cancelDescendantGone).toBe(true)
  }, 15000)
  it('rejects arbitrary roots, executables, long deadlines and disposed snapshots', async () => {
    const s = snapshot()
    await expect(runControl2Sandbox({ snapshot: { id: 'fake', root: '/' }, executable: '/bin/sh' })).rejects.toThrow('unowned_sandbox_root')
    await expect(runControl2Sandbox({ snapshot: s, executable: process.execPath })).rejects.toThrow('sandbox_executable_unsupported')
    await expect(runControl2Sandbox({ snapshot: s, executable: '/bin/echo', timeoutMs: 30001 })).rejects.toThrow('sandbox_timeout_invalid')
    s.dispose()
    await expect(runControl2Sandbox({ snapshot: s, executable: '/bin/echo' })).rejects.toThrow('unowned_sandbox_root')
  })
  it('refuses parallel ownership and disposal during a run; cancels descendants', async () => {
    const s = snapshot(); const controller = new AbortController()
    const running = runControl2Sandbox({ snapshot: s, executable: '/bin/sh', args: ['-c', 'sleep 20 & wait'], signal: controller.signal })
    await expect(runControl2Sandbox({ snapshot: s, executable: '/bin/echo' })).rejects.toThrow('sandbox_already_running')
    expect(() => s.dispose()).toThrow('sandbox_still_running')
    controller.abort()
    expect((await running).canceled).toBe(true)
  })
  it('never starts a pre-canceled command', async () => {
    const s = snapshot(); const controller = new AbortController(); controller.abort()
    const result = await runControl2Sandbox({ snapshot: s, executable: '/bin/sh', args: ['-c', 'printf should-not-run'], signal: controller.signal })
    expect(result).toMatchObject({ canceled: true, stdout: '', durationMs: 0 })
  })
})
