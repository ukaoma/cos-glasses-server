import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const tempRoots: string[] = []
const candidate = resolve('task-runtime')
const installer = resolve('bin/task-runtime-check.cjs')
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cos-portable-task-'))
  tempRoots.push(root)
  const data = join(root, 'data'), runtime = join(root, 'runtime')
  mkdirSync(join(data, 'work'), { recursive: true })
  const file = join(data, 'work', 'tasks.md')
  writeFileSync(file, '# INBOX\n- [ ] **Alex**: Fix hero — **Source:** meeting-1 — **Done when:** Mobile preview passes [run 2026-09-28 10:00] [stage review]\n- [ ] Repeat\n- [ ] Repeat\n- [x] Done\n<!-- hidden\n- [ ] Never show\n-->\n')
  return { root, data, runtime, file }
}
function check(args: string[]) {
  return spawnSync(process.execPath, [installer, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 20000 })
}
function direct(runtime: string, args: string[]) {
  return spawnSync('python3', ['-I', '-S', join(runtime, 'task_runtime.py'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 15000 })
}
describe('portable read-only task foundation', () => {
  it('installs without private imports/env, preserves parser semantics, and never changes source', () => {
    const f = fixture(), before = readFileSync(f.file)
    const run = check(['--install', '--runtime-dir', f.runtime, '--data-root', f.data, '--domain', 'work', '--operator', 'Alex'])
    expect(run.status, run.stderr).toBe(0)
    const result = JSON.parse(run.stdout)
    expect(result.capabilities).toMatchObject({ readOnly: true, writes: false, migration: false, requiresPrivateCheckout: false, identity: { stable: false } })
    expect(result.domains).toEqual(['work'])
    expect(result.tasks.rows).toHaveLength(4)
    expect(result.tasks.rows[0]).toMatchObject({ owner: 'Alex', delegated: false, description: 'Fix hero', source: 'meeting-1', done_when: 'Mobile preview passes', stage: 'review', run_at: '2026-09-28 10:00' })
    expect(new Set(result.tasks.rows.map((row: { id: string }) => row.id)).size).toBe(4)
    expect(result.tasks.sourceRevision).toBe(createHash('sha256').update(before).digest('hex'))
    expect(readFileSync(f.file)).toEqual(before)
    expect(check(['--install', '--runtime-dir', f.runtime]).status).not.toBe(0)
  })
  it('exposes legacy identity instability rather than falsely promising durable IDs', () => {
    const f = fixture(); cpSync(candidate, f.runtime, { recursive: true })
    const first = JSON.parse(direct(f.runtime, ['task-rows', '--root', f.data, '--domain', 'work']).stdout)
    writeFileSync(f.file, readFileSync(f.file, 'utf8').replace('Fix hero', 'Fix mobile hero'))
    const next = JSON.parse(direct(f.runtime, ['task-rows', '--root', f.data, '--domain', 'work']).stdout)
    expect(first.rows[0].id).not.toBe(next.rows[0].id)
    expect(next.identity.stable).toBe(false)
  })
  it('rejects writes, missing explicit roots, traversal and symlinked source files', () => {
    const f = fixture(); cpSync(candidate, f.runtime, { recursive: true })
    expect(direct(f.runtime, ['capture']).status).not.toBe(0)
    expect(direct(f.runtime, ['domains']).status).not.toBe(0)
    expect(direct(f.runtime, ['task-rows', '--root', f.data, '--domain', '../work']).status).not.toBe(0)
    mkdirSync(join(f.data, 'linked'))
    symlinkSync(f.file, join(f.data, 'linked', 'tasks.md'))
    expect(direct(f.runtime, ['task-rows', '--root', f.data, '--domain', 'linked']).status).not.toBe(0)
    expect(JSON.parse(direct(f.runtime, ['domains', '--root', f.data]).stdout).domains).toEqual(['work'])
  })
  it('refuses corrupted runtime before executing Python', () => {
    const f = fixture(); cpSync(candidate, f.runtime, { recursive: true })
    writeFileSync(join(f.runtime, 'task_runtime.py'), 'raise RuntimeError("must not execute")')
    const result = check(['--runtime-dir', f.runtime])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('checksum mismatch')
  })
  it('treats parenthetical-only owner labels as unknown instead of crashing', () => {
    const f = fixture(); cpSync(candidate, f.runtime, { recursive: true })
    writeFileSync(f.file, '# INBOX\n- [ ] **(unknown)**: Check the preview\n')
    const result = direct(f.runtime, ['task-rows', '--root', f.data, '--domain', 'work', '--operator', 'Alex'])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).rows[0].delegated).toBe(true)
  })
})
