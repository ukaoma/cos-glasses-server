import express from 'express'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claudeSessionNamesVisible,
  claudeSessionsDir,
  claudeSessionsEnabled,
  claudeSessionsRouter,
  readClaudePeers,
} from './claude-sessions.js'
import {
  countPeers,
  derivedName,
  nameIsSafe,
  sortPeers,
  toPeer,
  workspaceFromCwd,
  type PeerProbes,
} from '../lib/claude-session-registry.js'

// Shaped from the LIVE registry on this machine, 2026-08-10: pid 36411, v2.1.226,
// nameSource derived, name cos-glasses-server-90, status waiting, socket present.
const raw = (over: Record<string, unknown> = {}) => ({
  pid: 36411,
  sessionId: 'd2382619-a990-49b4-adef-795a6be99ebc',
  cwd: '/Users/ukaoma/Documents/GitHub/cos-glasses-server',
  startedAt: 1786277452948,
  procStart: 'Sun Aug  9 12:10:52 2026',
  version: '2.1.226',
  peerProtocol: 1,
  kind: 'interactive',
  entrypoint: 'cli',
  messagingSocketPath: '/tmp/cc-socks/36411.sock',
  name: 'cos-glasses-server-90',
  nameSource: 'derived',
  status: 'waiting',
  updatedAt: 1786277619848,
  statusUpdatedAt: 1786277619848,
  waitingFor: 'dialog open',
  ...over,
})

const probes = (over: Partial<PeerProbes> = {}): PeerProbes => ({
  isAlive: () => true,
  socketExists: () => true,
  ...over,
})

describe('redaction is decided by nameSource, and only "derived" passes', () => {
  it('returns a derived name as-is', () => {
    const peer = toPeer(raw(), probes())!
    expect(peer.name).toBe('cos-glasses-server-90')
    expect(peer.nameRedacted).toBe(false)
  })

  it('REPLACES an auto name, because an LLM wrote it from the work', () => {
    // This is the correction that reshaped the design: redacting cwd while echoing
    // `name` was not redaction at all.
    const peer = toPeer(raw({ nameSource: 'auto', name: 'debugging the payments webhook retry' }), probes())!
    expect(peer.name).toBe('cos-glasses-server')
    expect(peer.nameRedacted).toBe(true)
    expect(JSON.stringify(peer)).not.toContain('payments')
  })

  it('REPLACES a user name', () => {
    const peer = toPeer(raw({ nameSource: 'user', name: 'Quilt-Persona-ICP work' }), probes())!
    expect(peer.nameRedacted).toBe(true)
    expect(peer.name).toBe('cos-glasses-server')
  })

  it('REPLACES a name with NO nameSource, because /rename clears the field', () => {
    const { nameSource, ...withoutSource } = raw({ name: 'client escalation' }) as any
    const peer = toPeer(withoutSource, probes())!
    expect(peer.nameRedacted).toBe(true)
    expect(peer.name).toBe('cos-glasses-server')
  })

  it('treats only the exact string as safe', () => {
    for (const value of ['derived ', 'Derived', 'auto', 'user', '', null, undefined, 1]) {
      expect(nameIsSafe(value), String(value)).toBe(false)
    }
    expect(nameIsSafe('derived')).toBe(true)
  })
})

describe('the owner opt-in for real names', () => {
  it('still redacts by default, so the published package is safe', () => {
    const peer = toPeer(raw({ nameSource: 'auto', name: 'Kevin/Miles grievance analysis' }), probes())!
    expect(peer.name).toBe('cos-glasses-server')
    expect(peer.nameRedacted).toBe(true)
  })

  it('shows any name once the owner opts in', () => {
    // The names ARE the value of this view. Redaction protects a LAN-exposed socket,
    // not the owner from himself.
    const peer = toPeer(raw({ nameSource: 'auto', name: 'Kevin/Miles grievance analysis' }), probes(), null, true)!
    expect(peer.name).toBe('Kevin/Miles grievance analysis')
    expect(peer.nameRedacted).toBe(false)
  })

  it('opting in never resurrects a path or an unlisted field', () => {
    const peer = toPeer(raw({ nameSource: 'user', logPath: '/Users/ukaoma/.claude/x.log' }), probes(), null, true)!
    const wire = JSON.stringify(peer)
    expect(wire).not.toContain('/Users/')
    expect(wire).not.toContain('logPath')
    expect(wire).not.toContain('cc-socks')
  })

  it('is a SEPARATE switch from the enable flag', () => {
    const prev = { e: process.env.COS_CLAUDE_SESSIONS_ENABLED, n: process.env.COS_CLAUDE_SESSIONS_SHOW_NAMES }
    try {
      process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
      delete process.env.COS_CLAUDE_SESSIONS_SHOW_NAMES
      // Turning the feature on must not silently also turn redaction off.
      expect(claudeSessionNamesVisible()).toBe(false)
      process.env.COS_CLAUDE_SESSIONS_SHOW_NAMES = '1'
      expect(claudeSessionNamesVisible()).toBe(true)
      for (const v of ['0', 'true', '']) {
        process.env.COS_CLAUDE_SESSIONS_SHOW_NAMES = v
        expect(claudeSessionNamesVisible(), v).toBe(false)
      }
    } finally {
      if (prev.e === undefined) delete process.env.COS_CLAUDE_SESSIONS_ENABLED; else process.env.COS_CLAUDE_SESSIONS_ENABLED = prev.e
      if (prev.n === undefined) delete process.env.COS_CLAUDE_SESSIONS_SHOW_NAMES; else process.env.COS_CLAUDE_SESSIONS_SHOW_NAMES = prev.n
    }
  })
})

describe('never leaks a path or an unlisted field', () => {
  it('returns a basename workspace and no cwd', () => {
    const peer = toPeer(raw(), probes())!
    expect(peer.workspace).toBe('cos-glasses-server')
    expect(JSON.stringify(peer)).not.toContain('/Users/ukaoma')
  })

  it('drops messagingSocketPath, logPath and every other unlisted field', () => {
    // The writer can also emit logPath (a full path), agent, jobId, bridgeSessionId
    // and parkedJobId. Spreading the parsed object would ship all of them.
    const peer = toPeer(raw({
      logPath: '/Users/ukaoma/.claude/logs/secret-project.log',
      agent: 'internal-agent',
      jobId: 'job-9',
      bridgeSessionId: 'bridge-3',
      parkedJobId: 'parked-1',
    }), probes())!
    const wire = JSON.stringify(peer)
    for (const leak of ['logPath', 'secret-project', 'agent', 'jobId', 'bridgeSessionId', 'parkedJobId', 'cc-socks']) {
      expect(wire, leak).not.toContain(leak)
    }
    expect(Object.keys(peer).sort()).toEqual([
      'alive', 'entrypoint', 'id', 'kind', 'lastActiveAt', 'name', 'nameRedacted',
      'reachable', 'startedAt', 'status', 'version', 'waitingFor', 'workspace',
    ])
  })

  it('shortens the session UUID', () => {
    expect(toPeer(raw(), probes())!.id).toBe('d2382619')
  })

  it('handles a missing cwd without emitting undefined', () => {
    const { cwd, ...noCwd } = raw() as any
    const peer = toPeer(noCwd, probes())!
    expect(peer.workspace).toBe('unknown')
    expect(peer.nameRedacted).toBe(false)
    expect(workspaceFromCwd(null)).toBe('unknown')
    expect(derivedName(null)).toBe('unknown')
  })
})

describe('reachability is a conjunction, not any single signal', () => {
  it('is true only when alive AND declared AND the socket file exists', () => {
    expect(toPeer(raw(), probes())!.reachable).toBe(true)
  })

  it('is false for an alive session on a build with no socket path', () => {
    // Measured: the 2.1.222 row on this machine carries no messagingSocketPath.
    const { messagingSocketPath, ...old } = raw({ version: '2.1.222' }) as any
    const peer = toPeer(old, probes())!
    expect(peer.alive).toBe(true)
    expect(peer.reachable).toBe(false)
  })

  it('is false when the declared socket file is gone', () => {
    const peer = toPeer(raw(), probes({ socketExists: () => false }))!
    expect(peer.reachable).toBe(false)
  })

  it('is false for a dead process even with a socket still on disk', () => {
    // The orphan case, observed live: /tmp/cc-socks held a .sock whose PID was dead
    // and whose registry file was already gone. Sockets are not reaped.
    const peer = toPeer(raw(), probes({ isAlive: () => false, socketExists: () => true }))!
    expect(peer.alive).toBe(false)
    expect(peer.reachable).toBe(false)
  })
})

describe('rejecting unusable rows', () => {
  it('needs a positive integer pid and a sessionId', () => {
    for (const bad of [{ pid: 0 }, { pid: -1 }, { pid: 'abc' }, { pid: 1.5 }, { sessionId: '' }, { sessionId: 42 }]) {
      expect(toPeer(raw(bad), probes()), JSON.stringify(bad)).toBeNull()
    }
  })

  it('defaults unknown strings rather than emitting null into the UI', () => {
    const { version, kind, entrypoint, ...sparse } = raw() as any
    const peer = toPeer(sparse, probes())!
    expect(peer.version).toBe('unknown')
    expect(peer.kind).toBe('unknown')
    expect(peer.entrypoint).toBe('unknown')
  })

  it('falls back to file mtime for lastActiveAt when updatedAt is missing', () => {
    const { updatedAt, ...noUpdate } = raw() as any
    expect(toPeer(noUpdate, probes(), 1786300000000)!.lastActiveAt).toBe(1786300000000)
    // And to startedAt when there is no mtime either.
    expect(toPeer(noUpdate, probes(), null)!.lastActiveAt).toBe(1786277452948)
  })
})

describe('ordering puts running work first', () => {
  it('sorts alive before dead, then by recency', () => {
    const peer = (over: Record<string, unknown>, alive: boolean) =>
      toPeer(raw(over), probes({ isAlive: () => alive }))!
    const sorted = sortPeers([
      peer({ sessionId: 'dead-new', updatedAt: 9000 }, false),
      peer({ sessionId: 'alive-old', updatedAt: 1000 }, true),
      peer({ sessionId: 'alive-new', updatedAt: 8000 }, true),
    ])
    expect(sorted.map(p => p.id)).toEqual(['alive-ne', 'alive-ol', 'dead-new'])
  })

  it('counts alive, reachable and stale separately', () => {
    const peers = [
      toPeer(raw({ sessionId: 'a1' }), probes())!,
      toPeer(raw({ sessionId: 'a2' }), probes({ socketExists: () => false }))!,
      toPeer(raw({ sessionId: 'd1' }), probes({ isAlive: () => false }))!,
    ]
    expect(countPeers(peers)).toEqual({ alive: 2, reachable: 1, stale: 1 })
  })
})

describe('reading a real directory', () => {
  let dir: string
  beforeEach(() => {
    const parent = mkdtempSync(join(tmpdir(), 'cos-claude-sessions-'))
    dir = resolve(parent, '.claude-fixture', 'sessions')
    mkdirSync(dir, { recursive: true })
  })

  const write = (name: string, body: unknown) =>
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))

  it('reads only <pid>.json, not every .json', async () => {
    write('36411.json', raw())
    write('notes.json', raw({ sessionId: 'should-not-appear' }))
    write('36411.json.bak', raw({ sessionId: 'also-not' }))
    const peers = await readClaudePeers(dir, probes())
    expect(peers.map(p => p.id)).toEqual(['d2382619'])
  })

  it('skips a symlink instead of following it off the filesystem', async () => {
    const target = join(dir, '..', 'elsewhere.json')
    writeFileSync(target, JSON.stringify(raw({ sessionId: 'via-symlink' })))
    symlinkSync(target, join(dir, '99999.json'))
    write('36411.json', raw())
    const peers = await readClaudePeers(dir, probes())
    expect(peers.map(p => p.id)).toEqual(['d2382619'])
  })

  it('survives a torn or malformed file', async () => {
    write('36411.json', raw())
    write('36412.json', '{"pid": 36412, "sessionId": ')
    write('36413.json', 'null')
    const peers = await readClaudePeers(dir, probes())
    expect(peers).toHaveLength(1)
  })

  it('returns an empty list for a directory that does not exist', async () => {
    expect(await readClaudePeers(join(dir, 'nope'), probes())).toEqual([])
  })

  it('mixes live, unreachable and dead in one read', async () => {
    write('36411.json', raw({ sessionId: 'live-reach' }))
    const { messagingSocketPath, ...noSock } = raw({ sessionId: 'live-nosock', pid: 36412 }) as any
    write('36412.json', noSock)
    write('36413.json', raw({ sessionId: 'dead-row', pid: 36413 }))
    const peers = await readClaudePeers(dir, probes({ isAlive: pid => pid !== 36413 }))
    expect(countPeers(peers)).toEqual({ alive: 2, reachable: 1, stale: 1 })
    expect(peers[peers.length - 1]!.alive).toBe(false)
  })
})

describe('the route', () => {
  const closers: Array<() => Promise<void>> = []
  let dir: string
  let prevEnabled: string | undefined
  let prevDir: string | undefined

  beforeEach(() => {
    prevEnabled = process.env.COS_CLAUDE_SESSIONS_ENABLED
    prevDir = process.env.COS_CLAUDE_SESSIONS_DIR
    const parent = mkdtempSync(join(tmpdir(), 'cos-claude-route-'))
    dir = resolve(parent, '.claude-fixture', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '36411.json'), JSON.stringify(raw()))
    process.env.COS_CLAUDE_SESSIONS_DIR = dir
  })

  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
    if (prevEnabled === undefined) delete process.env.COS_CLAUDE_SESSIONS_ENABLED
    else process.env.COS_CLAUDE_SESSIONS_ENABLED = prevEnabled
    if (prevDir === undefined) delete process.env.COS_CLAUDE_SESSIONS_DIR
    else process.env.COS_CLAUDE_SESSIONS_DIR = prevDir
  })

  async function start(): Promise<string> {
    const app = express()
    app.use('/api', claudeSessionsRouter)
    const server = await new Promise<ReturnType<typeof app.listen>>(r => {
      const l = app.listen(0, '127.0.0.1', () => r(l))
    })
    closers.push(() => new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res())))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('is OFF by default and says so without reading anything', async () => {
    delete process.env.COS_CLAUDE_SESSIONS_ENABLED
    expect(claudeSessionsEnabled()).toBe(false)
    const base = await start()
    const res = await fetch(`${base}/api/claude-sessions`)
    expect(res.status).toBe(200)
    // 200, not 503: switched off is configuration, not a fault, and the companion
    // needs to tell those apart to decide whether to render the section.
    expect(await res.json()).toMatchObject({ enabled: false, reason: 'disabled', peers: [] })
  })

  it('only "1" enables it', async () => {
    for (const value of ['0', 'true', 'yes', '']) {
      process.env.COS_CLAUDE_SESSIONS_ENABLED = value
      expect(claudeSessionsEnabled(), value).toBe(false)
    }
    process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
    expect(claudeSessionsEnabled()).toBe(true)
  })

  it('serves peers once enabled', async () => {
    process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
    const base = await start()
    const body = await (await fetch(`${base}/api/claude-sessions`)).json() as any
    expect(body.enabled).toBe(true)
    expect(body.peers).toHaveLength(1)
    expect(body.peers[0]).toMatchObject({ id: 'd2382619', workspace: 'cos-glasses-server' })
    // This route deliberately probes the real OS process table. The fixture PID
    // may be alive or stale on a developer machine, but it must still project
    // exactly one safe row rather than making test success depend on PID reuse.
    expect(body.counts.alive + body.counts.stale).toBe(1)
    expect(typeof body.generatedAt).toBe('number')
  })

  it('clamps limit', async () => {
    process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
    for (let pid = 36412; pid < 36420; pid += 1) {
      writeFileSync(join(dir, `${pid}.json`), JSON.stringify(raw({ pid, sessionId: `s-${pid}` })))
    }
    const base = await start()
    const one = await (await fetch(`${base}/api/claude-sessions?limit=1`)).json() as any
    expect(one.peers).toHaveLength(1)
    // counts describe the whole registry, not the page. Asserted as alive+stale
    // rather than alive: this goes through the route, which uses the REAL
    // process.kill probe, and whether invented pids 36412-36419 happen to be running
    // is a property of the machine. An earlier version asserted alive===9 and failed
    // for exactly that reason — a fixture cannot dictate the liveness of a real pid.
    expect(one.counts.alive + one.counts.stale).toBe(9)
    const zero = await (await fetch(`${base}/api/claude-sessions?limit=0`)).json() as any
    expect(zero.peers).toHaveLength(1)
    const big = await (await fetch(`${base}/api/claude-sessions?limit=9999`)).json() as any
    expect(big.peers).toHaveLength(9)
  })

  it('never sends no-store-less responses, since this is presence data', async () => {
    process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
    const base = await start()
    const res = await fetch(`${base}/api/claude-sessions`)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('honors CLAUDE_CONFIG_DIR rather than hardcoding ~/.claude', () => {
    delete process.env.COS_CLAUDE_SESSIONS_DIR
    const prev = process.env.CLAUDE_CONFIG_DIR
    try {
      process.env.CLAUDE_CONFIG_DIR = '/tmp/custom-claude'
      expect(claudeSessionsDir()).toBe('/tmp/custom-claude/sessions')
      delete process.env.CLAUDE_CONFIG_DIR
      expect(claudeSessionsDir()).toMatch(/\/\.claude\/sessions$/)
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })

  it('is imported and mounted in the real entrypoint', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url).pathname, 'utf8')
    expect(index).toMatch(/import \{ claudeSessionsRouter \} from '\.\/routes\/claude-sessions\.js'/)
    expect(index).toMatch(/app\.use\('\/api', claudeSessionsRouter\)/)
  })
})
