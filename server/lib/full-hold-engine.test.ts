// X1 (Q1 O2): the engine that asked is the hook's own process: its registry record by pid (only when it
// names the session) and where it runs.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { engineForHookProcess, processHost, registryRecordForPid, registryStatusForPid } from './full-hold-engine.js'

const SID = 'a1b2c3d4-0000-4000-8000-00000000abcd'
function registry(records: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'x1-registry-'))
  for (const [name, value] of Object.entries(records)) writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
  return dir
}
const fakePs = (table: Record<string, string | null>) => async (args: string[]) => table[args.join(' ')] ?? null

describe('registryRecordForPid', () => {
  it('reads the record for that pid only when it names the session', () => {
    const dir = registry({
      '100.json': { pid: 100, sessionId: SID.toUpperCase(), entrypoint: 'cli', version: '2.1.322' },
      '200.json': { pid: 200, sessionId: 'b1b2c3d4-0000-4000-8000-00000000abcd', entrypoint: 'claude-desktop', version: '2.1.317' },
      '300.json': { pid: 999, sessionId: SID, entrypoint: 'cli', version: '2.1.322' },
      '400.json': 'not json',
    })
    expect(registryRecordForPid(100, SID, dir)).toEqual({ entrypoint: 'cli', version: '2.1.322' })
    expect(registryRecordForPid(200, SID, dir)).toBeNull()
    expect(registryRecordForPid(300, SID, dir)).toBeNull()
    expect(registryRecordForPid(400, SID, dir)).toBeNull()
    expect(registryRecordForPid(500, SID, dir)).toBeNull()
    for (const pid of [0, 1, -5, 1.5, Number.NaN]) expect(registryRecordForPid(pid, SID, dir)).toBeNull()
  })
})

describe('registryStatusForPid (round 3)', () => {
  it('the status for that pid only when it names the session; gone or reused is null', () => {
    const dir = registry({
      '100.json': { pid: 100, sessionId: SID, status: 'waiting', statusUpdatedAt: 1_794_285_453_035 },
      '200.json': { pid: 200, sessionId: 'b1b2c3d4-0000-4000-8000-00000000abcd', status: 'busy', statusUpdatedAt: 5 },
      '300.json': { pid: 300, sessionId: SID, status: 7, statusUpdatedAt: 'x' },
      '400.json': { pid: 999, sessionId: SID, status: 'busy', statusUpdatedAt: 5 },
    })
    expect(registryStatusForPid(100, SID, dir)).toEqual({ status: 'waiting', statusUpdatedAt: 1_794_285_453_035 })
    expect(registryStatusForPid(200, SID, dir)).toBeNull()
    expect(registryStatusForPid(300, SID, dir)).toEqual({ status: null, statusUpdatedAt: null })
    expect(registryStatusForPid(400, SID, dir)).toBeNull()
    expect(registryStatusForPid(500, SID, dir)).toBeNull()
    expect(registryStatusForPid(1, SID, dir)).toBeNull()
  })
})

describe('processHost', () => {
  it('a controlling terminal with no print or SDK flag is a terminal', async () => {
    expect(await processHost(100, fakePs({ '-o ppid=,tty= -p 100': '  55 ttys002\n', '-o args= -p 100': 'claude --model opus\n' }))).toBe('terminal')
  })
  it('Q1 C3: a print run or an SDK host in a terminal is not (and unreadable args are not)', async () => {
    for (const args of ['claude -p fix it', 'claude --print', 'node claude --input-format stream-json', 'claude --output-format=json', null]) {
      expect([args, await processHost(100, fakePs({ '-o ppid=,tty= -p 100': '  55 ttys002\n', '-o args= -p 100': args }))]).toEqual([args, 'other'])
    }
    // A word that only contains a flag is not the flag.
    expect(await processHost(100, fakePs({ '-o ppid=,tty= -p 100': '  55 ttys002\n', '-o args= -p 100': 'claude --model x-print' }))).toBe('terminal')
  })
  it('a child of Claude.app\'s helper is the desktop app', async () => {
    const ps = fakePs({ '-o ppid=,tty= -p 100': '  55 ??\n', '-o comm= -p 55': '/Applications/Claude.app/Contents/Helpers/disclaimer\n' })
    expect(await processHost(100, ps)).toBe('desktop-app')
  })
  it('anything else, or anything unreadable, is other', async () => {
    for (const ps of [
      fakePs({ '-o ppid=,tty= -p 100': '  55 ??\n', '-o comm= -p 55': '-zsh\n' }),
      fakePs({ '-o ppid=,tty= -p 100': '  55 ??\n', '-o comm= -p 55': '/tmp/Claude.app/Contents/Helpers/disclaimer-fake\n' }),
      fakePs({ '-o ppid=,tty= -p 100': '  55 ??\n', '-o comm= -p 55': null }),
      fakePs({ '-o ppid=,tty= -p 100': '  1 ??\n' }),
      fakePs({}),
    ]) expect(await processHost(100, ps)).toBe('other')
    expect(await processHost(1, fakePs({}))).toBe('other')
  })
})

describe('engineForHookProcess', () => {
  it('no ppid or no matching record is null; a match carries its host', async () => {
    const dir = registry({ '100.json': { pid: 100, sessionId: SID, entrypoint: 'claude-desktop', version: '2.1.317' } })
    const ps = fakePs({ '-o ppid=,tty= -p 100': '  55 ??\n', '-o comm= -p 55': '/Applications/Claude.app/Contents/Helpers/disclaimer\n' })
    expect(await engineForHookProcess(SID, null, { dir, ps })).toBeNull()
    expect(await engineForHookProcess(SID, 101, { dir, ps })).toBeNull()
    expect(await engineForHookProcess(SID, 100, { dir, ps })).toEqual({ entrypoint: 'claude-desktop', version: '2.1.317', host: 'desktop-app' })
  })
})
