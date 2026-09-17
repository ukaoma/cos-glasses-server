// The readers behind the live transport: the registry directory and the key file.
// They had no tests through 6.49.0 (QA, 2026-09-16); every case here is a fixture
// directory shaped like `~/.claude/sessions` on this Mac.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { continueLiveEnabled, pidAlive, readPeerInboxRecords, readPeerToken } from './session-peer-inbox-deps'

const SID = '7ff6893b-c323-49a5-8149-a21c59ed1e2f'

describe('readPeerInboxRecords', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cos-peer-registry-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const write = (pid: number, over: Record<string, unknown> = {}) => writeFileSync(join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: SID, messagingSocketPath: `/tmp/cc-socks/${pid}.sock`, peerProtocol: 1, entrypoint: 'claude-desktop', status: 'idle', startedAt: 1_789_525_763_791, ...over,
  }))

  it('reads the fields the transport needs, lower-casing the session id', () => {
    write(10487, { sessionId: SID.toUpperCase() })
    expect(readPeerInboxRecords(dir, () => true)).toEqual([{
      pid: 10487, sessionId: SID, socketPath: '/tmp/cc-socks/10487.sock', peerProtocol: 1, entrypoint: 'claude-desktop', status: 'idle', startedAt: 1_789_525_763_791,
    }])
  })

  it('6.49.1: drops a record whose pid is dead, so a stale file never chooses a dead socket', () => {
    write(111); write(222)
    expect(readPeerInboxRecords(dir, pid => pid === 222).map(r => r.pid)).toEqual([222])
  })

  it('skips what is not a record: other names, a symlink, a torn file, a missing pid', () => {
    write(333)
    writeFileSync(join(dir, '333.abc.key'), '{}')
    writeFileSync(join(dir, 'notes.json'), '{}')
    writeFileSync(join(dir, '444.json'), '{"pid": 444, "sessionId": "')
    writeFileSync(join(dir, '555.json'), JSON.stringify({ sessionId: SID }))
    symlinkSync(join(dir, '333.json'), join(dir, '666.json'))
    expect(readPeerInboxRecords(dir, () => true).map(r => r.pid)).toEqual([333])
  })

  it('answers [] for a directory that is not there', () => {
    expect(readPeerInboxRecords(join(dir, 'nope'), () => true)).toEqual([])
  })
})

describe('readPeerToken', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cos-peer-key-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const record = { pid: 777, sessionId: SID, socketPath: '/tmp/x', peerProtocol: 1, entrypoint: null, status: null }

  it('reads the token from the sibling key file, and null when there is none', () => {
    expect(readPeerToken(record, dir)).toBeNull()
    writeFileSync(join(dir, `777.${'a'.repeat(64)}.key`), JSON.stringify({ peerToken: 'tok-777', pidDomain: 'x', procStart: 1 }))
    writeFileSync(join(dir, `778.${'b'.repeat(64)}.key`), JSON.stringify({ peerToken: 'tok-778' }))
    expect(readPeerToken(record, dir)).toBe('tok-777')
  })

  it('refuses a malformed name, an oversized file and an empty token', () => {
    writeFileSync(join(dir, '777.short.key'), JSON.stringify({ peerToken: 'x' }))
    expect(readPeerToken(record, dir)).toBeNull()
    writeFileSync(join(dir, `777.${'c'.repeat(64)}.key`), JSON.stringify({ peerToken: '' }))
    expect(readPeerToken(record, dir)).toBeNull()
    writeFileSync(join(dir, `777.${'c'.repeat(64)}.key`), JSON.stringify({ peerToken: 'x'.repeat(5000) }))
    expect(readPeerToken(record, dir)).toBeNull()
  })
})

describe('the flag and the liveness probe', () => {
  it('continueLiveEnabled is the literal 1 and nothing else', () => {
    expect(continueLiveEnabled({ COS_CONTINUE_LIVE: '1' })).toBe(true)
    for (const v of ['true', 'yes', 'on', '0', '', undefined]) expect(continueLiveEnabled({ COS_CONTINUE_LIVE: v })).toBe(false)
  })

  it('pidAlive: this process is alive; a pid nobody has is not', () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(2_147_483_000)).toBe(false)
  })
})
