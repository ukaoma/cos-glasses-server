import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requireApiToken } from '../lib/api-auth.js'
import { LiveEventsHub, type LiveSessionReading, type LiveSources } from '../lib/live-events.js'
import { createLiveEventsRouter, frameText, liveEventsEnabled, liveEventsHandler, liveReadings, readingFor, realLiveSources, type LiveEventsRouterDeps } from './live-events.js'
import { readClaudePeerRecords } from './claude-sessions.js'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetSessionHooksForTests, sessionSignalStore } from '../lib/session-hooks-runtime.js'
import type { HookEnvelope } from '../lib/session-hook-events.js'
import { HOOK_ACTIVE_CAP_MS } from '../lib/codex-rollout-state.js'
import type { ClaudePeerRecord } from '../lib/claude-session-registry.js'
import type { SessionSignal } from '../lib/session-signal-store.js'

const TOKEN = '_live-events-test-token'

function fakeSources(initial: LiveSessionReading[] = []) {
  let sessions = initial
  let push: ((c: { sessionId: string; turnEnded: boolean }) => void) | null = null
  const sources: LiveSources = {
    async sessions() { return { sessions, degraded: false } },
    questions: () => [],
    queue: () => [],
    subscribe(listener) { push = listener; return () => { push = null } },
  }
  return { sources, set(v: LiveSessionReading[]) { sessions = v }, push: (id: string) => push?.({ sessionId: id, turnEnded: false }) }
}

const reading = (id: string, state: LiveSessionReading['state']): LiveSessionReading => ({
  provider: 'claude', sessionId: id, state, startedAt: 1, turnStartedAt: state === 'working' ? 2 : null, updatedAt: 3, source: 'hook',
})

const servers: http.Server[] = []
const hubs: LiveEventsHub[] = []
afterEach(() => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() }
  for (const h of hubs.splice(0)) h.dispose()
})

async function start(deps: Partial<LiveEventsRouterDeps> & { hub: LiveEventsHub }) {
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use('/api', createLiveEventsRouter({ enabled: true, ...deps }))
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

interface Opened { status: number; type: string; frames: Array<{ id?: string; data: any }>; body: string; close(): void; ended: Promise<void>; waitFor(pred: (f: any) => boolean, ms?: number): Promise<any> }

function open(url: string, headers: Record<string, string> = { 'X-Cos-Token': TOKEN }): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, res => {
      const frames: Opened['frames'] = []
      let buf = ''
      let body = ''
      const waiters: Array<{ pred: (f: any) => boolean; done: (f: any) => void }> = []
      let endResolve!: () => void
      const ended = new Promise<void>(r => { endResolve = r })
      res.on('data', chunk => {
        body += chunk
        buf += chunk
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const id = /^id: (.*)$/m.exec(block)?.[1]
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (data === undefined) continue
          const frame = { id, data: JSON.parse(data) }
          frames.push(frame)
          for (const w of waiters.splice(0)) { if (w.pred(frame.data)) w.done(frame.data); else waiters.push(w) }
        }
      })
      res.on('end', () => endResolve())
      res.on('close', () => endResolve())
      resolve({
        status: res.statusCode ?? 0,
        type: String(res.headers['content-type'] ?? ''),
        frames,
        get body() { return body },
        close: () => req.destroy(),
        ended,
        waitFor(pred, ms = 2_000) {
          const hit = frames.find(f => pred(f.data))
          if (hit) return Promise.resolve(hit.data)
          return new Promise((res2, rej) => {
            const t = setTimeout(() => rej(new Error('timed out waiting for a frame')), ms)
            waiters.push({ pred, done: f => { clearTimeout(t); res2(f) } })
          })
        },
      } as Opened)
    })
    req.on('error', reject)
  })
}

function hubOver(sources: LiveSources, extra: Partial<ConstructorParameters<typeof LiveEventsHub>[0]> = {}) {
  const hub = new LiveEventsHub({ sources, flushMs: 10, tickMs: 50, log: () => {}, ...extra })
  hubs.push(hub)
  return hub
}

describe('GET /api/events', () => {
  it('refuses an unauthenticated request with the gate JSON, before any stream header', async () => {
    const url = await start({ hub: hubOver(fakeSources().sources) })
    const r = await open(`${url}/api/events`, {})
    expect(r.status).toBe(401)
    expect(r.type).toContain('application/json')
    await r.ended
    expect(JSON.parse(r.body).reason).toBe('pairing_token_rejected')
  })

  it('opens an event stream with the /stream headers and a snapshot first', async () => {
    const f = fakeSources([reading('aaaaaaaa-1', 'working')])
    const url = await start({ hub: hubOver(f.sources) })
    const r = await open(`${url}/api/events`)
    expect(r.status).toBe(200)
    expect(r.type).toContain('text/event-stream')
    const snap = await r.waitFor(d => d.kind === 'snapshot')
    expect(r.frames[0]!.data.kind).toBe('snapshot')
    // The snapshot carries the id of the state it describes, so the browser's own reconnect resumes from it.
    expect(r.frames[0]!.id).toBe(`${snap.epoch}.${snap.seq}`)
    expect(snap.sessions.map((s: any) => [s.sessionId, s.state])).toEqual([['aaaaaaaa-1', 'working']])
    expect(r.body.startsWith('retry: 3000\n\n')).toBe(true)
    r.close()
  })

  it('pushes a change within the flush window and stamps it with an epoch.seq id', async () => {
    const f = fakeSources([reading('aaaaaaaa-1', 'idle')])
    const url = await start({ hub: hubOver(f.sources, { tickMs: 60_000 }) })
    const r = await open(`${url}/api/events`)
    await r.waitFor(d => d.kind === 'snapshot')
    f.set([reading('aaaaaaaa-1', 'working')])
    const t0 = Date.now()
    f.push('aaaaaaaa-1')
    const frame = await r.waitFor(d => d.kind === 'session' && d.session.state === 'working', 1_000)
    expect(Date.now() - t0).toBeLessThan(1_000)
    const line = r.frames.find(x => x.data === frame)!
    expect(line.id).toBe(`${frame.epoch}.${frame.seq}`)
    r.close()
  })

  it('resumes from Last-Event-ID with the missed frames and a resume marker, no snapshot', async () => {
    const f = fakeSources([reading('aaaaaaaa-1', 'idle')])
    const hub = hubOver(f.sources, { tickMs: 60_000 })
    const url = await start({ hub })
    const keep = await open(`${url}/api/events`)
    await keep.waitFor(d => d.kind === 'snapshot')
    const cursor = `${hub.epoch}.${hub.newestSeq}`
    f.set([reading('aaaaaaaa-1', 'working')]); f.push('aaaaaaaa-1')
    await keep.waitFor(d => d.kind === 'session' && d.session.state === 'working')
    f.set([reading('aaaaaaaa-1', 'waiting')]); f.push('aaaaaaaa-1')
    await keep.waitFor(d => d.kind === 'session' && d.session.state === 'waiting')
    const r = await open(`${url}/api/events`, { 'X-Cos-Token': TOKEN, 'Last-Event-ID': cursor })
    const marker = await r.waitFor(d => d.kind === 'resume')
    expect(marker.replayed).toBe(2)
    expect(r.frames.map(x => x.data.kind)).toEqual(['session', 'session', 'resume'])
    expect(r.frames.map(x => x.data.session?.state).slice(0, 2)).toEqual(['working', 'waiting'])
    // The query form wins over the header, for a manual reconnect.
    const q = await open(`${url}/api/events?after=${hub.epoch}.${hub.newestSeq}`, { 'X-Cos-Token': TOKEN, 'Last-Event-ID': cursor })
    expect((await q.waitFor(d => d.kind === 'resume')).replayed).toBe(0)
    keep.close(); r.close(); q.close()
  })

  it('answers a cursor it cannot honour with a fresh snapshot', async () => {
    const f = fakeSources([reading('aaaaaaaa-1', 'idle')])
    const hub = hubOver(f.sources, { tickMs: 60_000 })
    const url = await start({ hub })
    for (const id of ['1.1', `${hub.epoch + 1}.0`, `${hub.epoch}.999999`, 'garbage']) {
      const r = await open(`${url}/api/events`, { 'X-Cos-Token': TOKEN, 'Last-Event-ID': id })
      const first = await r.waitFor(() => true)
      expect(first.kind).toBe('snapshot')
      r.close()
    }
  })

  it('sends a heartbeat on its interval with the newest seq and no id line', async () => {
    const f = fakeSources([])
    const hub = hubOver(f.sources, { tickMs: 60_000 })
    const url = await start({ hub, heartbeatMs: 40 })
    const r = await open(`${url}/api/events`)
    const hb = await r.waitFor(d => d.kind === 'heartbeat', 1_000)
    expect(hb.seq).toBe(hub.newestSeq)
    expect(r.frames.find(x => x.data === hb)!.id).toBeUndefined()
    r.close()
  })

  it('at the cap the OLDEST stream is closed to admit the new one, and it is logged (ghost review W5)', async () => {
    const f = fakeSources([])
    const lines: string[] = []
    const url = await start({ hub: hubOver(f.sources), maxStreams: 2, log: l => { lines.push(l) } })
    const a = await open(`${url}/api/events`)
    await a.waitFor(d => d.kind === 'snapshot')
    const b = await open(`${url}/api/events`)
    await b.waitFor(d => d.kind === 'snapshot')
    const c = await open(`${url}/api/events`)
    expect(c.status).toBe(200)
    await c.waitFor(d => d.kind === 'snapshot')
    await a.ended   // the oldest was closed
    expect(lines.some(l => /stream cap 2 reached: closing the oldest/.test(l))).toBe(true)
    // b is still open: a frame still reaches it.
    f.set([reading('bbbbbbbb-1', 'working')]); f.push('bbbbbbbb-1')
    await b.waitFor(d => d.kind === 'session')
    b.close(); c.close()
  })

  it('refuses with a 503 JSON before any stream header only when nothing can be closed', async () => {
    const f = fakeSources([])
    const lines: string[] = []
    const url = await start({ hub: hubOver(f.sources), maxStreams: 0, log: l => { lines.push(l) } })
    const b = await open(`${url}/api/events`)
    expect(b.status).toBe(503)
    expect(b.type).toContain('application/json')
    await b.ended
    expect(JSON.parse(b.body).reason).toBe('live_events_capacity')
    expect(lines.some(l => /refused a new stream/.test(l))).toBe(true)
  })

  it('registers no route when switched off (404), and the switch reads absent as on', async () => {
    const app = express()
    app.use('/api', requireApiToken(TOKEN))
    app.use('/api', createLiveEventsRouter({ enabled: false, hub: hubOver(fakeSources().sources) }))
    const server = http.createServer(app); servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const r = await open(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`)
    expect(r.status).toBe(404)
    expect(liveEventsEnabled({})).toBe(true)
    expect(liveEventsEnabled({ COS_WEB_LIVE_EVENTS: '0' })).toBe(false)
    expect(liveEventsEnabled({ COS_WEB_LIVE_EVENTS: 'off' })).toBe(false)
    expect(liveEventsEnabled({ COS_WEB_LIVE_EVENTS: '1' })).toBe(true)
  })

  it('server/index.ts mounts the route only behind liveEventsEnabled() (ghost review W6)', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const mounts = index.match(/createLiveEventsRouter\(/g) ?? []
    expect(mounts.length).toBe(1)
    expect(index).toMatch(/\nif \(liveEventsEnabled\(\)\) \{\n  const liveEventsHub = new LiveEventsHub\(\{ sources: realLiveSources\(\{ broker: \(\) => permissionBroker \}\) \}\)\n  app\.use\('\/api', createLiveEventsRouter\(\{ hub: liveEventsHub \}\)\)\n\}/)
  })

  it('the switch is in the managed-runtime contract and .env.example', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    expect(contract.optionalEnvironment).toContain('COS_WEB_LIVE_EVENTS')
    expect(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')).toMatch(/^# COS_WEB_LIVE_EVENTS=0$/m)
  })
})

describe('liveEventsHandler backpressure', () => {
  it('drops a client whose unsent bytes pass the ceiling instead of buffering', async () => {
    const f = fakeSources([reading('aaaaaaaa-1', 'idle')])
    const hub = hubOver(f.sources, { tickMs: 60_000 })
    const handler = liveEventsHandler({ hub, maxBufferBytes: 64, heartbeatMs: 60_000 })
    const req = Object.assign(new EventEmitter(), { query: {}, get: () => undefined }) as any
    const writes: string[] = []
    let ended = false
    const res = Object.assign(new EventEmitter(), {
      writableLength: 0,
      set() { return res },
      status() { return res },
      json() { return res },
      writeHead() { return res },
      flushHeaders() {},
      write(chunk: string) { writes.push(chunk); res.writableLength += chunk.length; return false },
      end() { ended = true },
    }) as any
    await handler(req, res)
    // The snapshot alone is past 64 unsent bytes: the stream is closed and the slot released.
    expect(ended).toBe(true)
    expect(hub.streamCount).toBe(0)
    const n = writes.length
    f.set([reading('aaaaaaaa-1', 'working')]); f.push('aaaaaaaa-1')
    await new Promise(r => setTimeout(r, 40))
    expect(writes.length).toBe(n)
  })

  it('a stream torn down while its snapshot is written starts no heartbeat (review N1)', async () => {
    const f = fakeSources([reading('aaaaaaaa-1', 'idle')])
    const hub = hubOver(f.sources, { tickMs: 60_000 })
    const lines: string[] = []
    const handler = liveEventsHandler({ hub, maxBufferBytes: 64, heartbeatMs: 5, log: l => { lines.push(l) } })
    const req = Object.assign(new EventEmitter(), { query: {}, get: () => undefined }) as any
    const writes: string[] = []
    const res = Object.assign(new EventEmitter(), {
      writableLength: 0, set() { return res }, status() { return res }, json() { return res }, writeHead() { return res }, flushHeaders() {},
      write(chunk: string) { writes.push(chunk); res.writableLength += chunk.length; return false }, end() {},
    }) as any
    const intervals = vi.spyOn(globalThis, 'setInterval')
    let heartbeats = -1
    try { await handler(req, res); heartbeats = intervals.mock.calls.filter(c => c[1] === 5).length } finally { intervals.mockRestore() }
    expect(heartbeats).toBe(0)   // no heartbeat timer outlives the stream (counted before mockRestore clears the calls)
    const n = writes.length
    await new Promise(r => setTimeout(r, 40))
    expect(writes.length).toBe(n)
    expect(lines.some(l => /stopped reading/.test(l))).toBe(true)
  })

  it('keeps a client that reads (no unsent bytes) open', async () => {
    const f = fakeSources([reading('aaaaaaaa-1', 'idle')])
    const hub = hubOver(f.sources, { tickMs: 60_000 })
    const handler = liveEventsHandler({ hub, maxBufferBytes: 64, heartbeatMs: 60_000 })
    const req = Object.assign(new EventEmitter(), { query: {}, get: () => undefined }) as any
    let ended = false
    const res = Object.assign(new EventEmitter(), {
      writableLength: 0, set() { return res }, status() { return res }, json() { return res }, writeHead() { return res }, flushHeaders() {},
      write() { return true }, end() { ended = true },
    }) as any
    await handler(req, res)
    expect(ended).toBe(false)
    expect(hub.streamCount).toBe(1)
    req.emit('close')
    expect(hub.streamCount).toBe(0)
  })
})

describe('realLiveSources (the registry read)', () => {
  it('a hook push rebuilds against the registry as last read; a failed registry read is degraded, never "nothing alive"', async () => {
    const prev = process.env.COS_CLAUDE_SESSIONS_ENABLED
    process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
    try {
      let reads = 0, fail = false
      const sources = realLiveSources({ broker: () => null, readPeers: async () => { reads++; if (fail) throw new Error('EACCES'); return [] } })
      await sources.sessions(1)
      expect(reads).toBe(1)
      await sources.sessions(2, { hooksOnly: true })
      await sources.sessions(3, { hooksOnly: true })
      expect(reads).toBe(1)
      fail = true
      expect((await sources.sessions(4)).degraded).toBe(true)
      expect(reads).toBe(2)
      expect((await sources.sessions(5, { hooksOnly: true })).degraded).toBe(true)
    } finally { if (prev === undefined) delete process.env.COS_CLAUDE_SESSIONS_ENABLED; else process.env.COS_CLAUDE_SESSIONS_ENABLED = prev }
  })
  it('readClaudePeerRecords throws for a folder it cannot read when asked to; a missing folder is still empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-registry-'))
    try {
      expect(await readClaudePeerRecords(join(dir, 'missing'), undefined, undefined, true)).toEqual([])
      chmodSync(dir, 0o000)
      await expect(readClaudePeerRecords(dir, undefined, undefined, true)).rejects.toBeTruthy()
      expect(await readClaudePeerRecords(dir)).toEqual([])   // the list route keeps its old answer
    } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('frame privacy on the wire', () => {
  it('a snapshot from real readings carries no text fields', async () => {
    const peer = { sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', id: 'aaaaaaaa', name: 'Payroll export fix', workspace: '/Users/me/secret-project', alive: true, status: 'busy', statusUpdatedAt: 5, startedAt: 1, lastActiveAt: 5 } as unknown as ClaudePeerRecord
    const readings = liveReadings({
      peers: [peer], signals: [], now: 10, signalFor: () => undefined,
      reading: (provider, id) => ({ provider, sessionId: id, state: 'working', startedAt: 1, turnStartedAt: 5, updatedAt: 5, source: 'registry' }),
    })
    const f = fakeSources(readings)
    const hub = hubOver(f.sources, { tickMs: 60_000 })
    await hub.attach(() => {})
    const text = frameText(hub.snapshotFrame())
    for (const word of ['Payroll', 'secret-project', '/Users', 'workspace', 'name']) expect(text).not.toContain(word)
    expect(text).toContain('aaaaaaaa-1111-2222-3333-444444444444')
  })
})

describe('liveReadings (which sessions are open)', () => {
  const sig = (over: Partial<SessionSignal>): SessionSignal => ({
    sessionId: 'x', firstSeenAt: 1, lastEventAt: 1_000_000, lastEvent: 'Stop', cwd: null, transcriptPath: null, permissionMode: null, model: null,
    turnOpen: false, turnStartedAt: null, promptId: null, stopAt: null, waiting: null, failure: null, lastReply: '', lastTool: null, lastToolAt: null,
    subagentsOpen: 0, ended: null, keepWarm: false, compactions: 0, childEvents: 0, entrypoint: null, hooksSeen: true, ...over,
  } as SessionSignal)
  const stub = (provider: any, id: string, _p: any, signal: any): LiveSessionReading => ({ provider, sessionId: id, state: signal?.turnOpen ? 'working' : 'idle', startedAt: 1, turnStartedAt: null, updatedAt: 1, source: 'hook' })
  const now = 1_000_000 + 60_000

  it('a Claude tab is open while its registry record is alive; a dead one is not', () => {
    const alive = { sessionId: 'aaaaaaaa-1', alive: true } as ClaudePeerRecord
    const dead = { sessionId: 'bbbbbbbb-2', alive: false } as ClaudePeerRecord
    const out = liveReadings({ peers: [alive, dead], signals: [], now, signalFor: () => undefined, reading: stub })
    expect(out.map(r => r.sessionId)).toEqual(['aaaaaaaa-1'])
  })

  it('with the registry readable, a Claude hook record with no alive record is not open, unless it ended recently (then ended)', () => {
    const quiet = sig({ sessionId: 'cccccccc-3', turnOpen: true })
    const ended = sig({ sessionId: 'dddddddd-4', ended: { at: now - 1_000, reason: 'exit' } })
    const out = liveReadings({ peers: [], signals: [quiet, ended], now, signalFor: () => undefined, reading: stub })
    expect(out.map(r => [r.sessionId, r.state])).toEqual([['dddddddd-4', 'ended']])
  })

  it('Codex and Cursor sessions are open from their hooks inside the open window; keep-warm and stale ones are skipped', () => {
    const codex = sig({ sessionId: 'eeeeeeee-5', provider: 'codex', turnOpen: true })
    const cursorOld = sig({ sessionId: 'ffffffff-6', provider: 'cursor', lastEventAt: now - 31 * 60_000 })
    const warm = sig({ sessionId: 'abababab-7', provider: 'codex', keepWarm: true, turnOpen: true })
    const out = liveReadings({ peers: [], signals: [codex, cursorOld, warm], now, signalFor: () => undefined, reading: stub })
    expect(out.map(r => [r.provider, r.sessionId])).toEqual([['codex', 'eeeeeeee-5']])
  })
})

describe('readingFor (the same derivation as the list rows)', () => {
  const SID = '12345678-aaaa-bbbb-cccc-1234567890ab'
  const T0 = 1_800_000_000_000
  const env = (ts: number, event: HookEnvelope['event'], payload: Record<string, unknown> = {}): HookEnvelope =>
    ({ ts, ppid: 4242, event, sessionId: SID, payload: { session_id: SID, ...payload } })
  const saved = process.env.COS_SESSION_HOOKS
  afterEach(() => {
    __resetSessionHooksForTests()
    if (saved === undefined) delete process.env.COS_SESSION_HOOKS
    else process.env.COS_SESSION_HOOKS = saved
  })

  it('working with the turn clock while the hooks speak inside the cap; idle once quiet past it; idle with replies after Stop', () => {
    process.env.COS_SESSION_HOOKS = '1'
    sessionSignalStore.apply(env(T0, 'SessionStart', { source: 'startup' }))
    sessionSignalStore.apply(env(T0 + 1_000, 'UserPromptSubmit', { prompt: 'never on the wire' }))
    const working = readingFor('claude', SID, undefined, sessionSignalStore.get(SID), T0 + 2_000)
    expect(working).toMatchObject({ state: 'working', turnStartedAt: T0 + 1_000, startedAt: T0, source: 'hook' })
    expect(JSON.stringify(working)).not.toContain('never on the wire')
    const quiet = readingFor('claude', SID, undefined, sessionSignalStore.get(SID), T0 + 1_000 + HOOK_ACTIVE_CAP_MS + 1)
    expect(quiet.state).toBe('idle')
    sessionSignalStore.apply(env(T0 + 3_000, 'Stop', {}))
    expect(readingFor('claude', SID, undefined, sessionSignalStore.get(SID), T0 + 4_000).state).toBe('idle')
  })

  it('waiting on a permission prompt', () => {
    process.env.COS_SESSION_HOOKS = '1'
    sessionSignalStore.apply(env(T0, 'UserPromptSubmit', { prompt: 'x' }))
    sessionSignalStore.apply(env(T0 + 1_000, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'whoami' } }))
    expect(readingFor('claude', SID, undefined, sessionSignalStore.get(SID), T0 + 2_000).state).toBe('waiting')
  })

  it('a registry-only tab (hooks off) reads the registry status', () => {
    process.env.COS_SESSION_HOOKS = '0'
    const peer = { sessionId: SID, alive: true, status: 'busy', statusUpdatedAt: T0, startedAt: T0 - 5_000, waitingFor: null, lastActiveAt: T0 } as unknown as ClaudePeerRecord
    expect(readingFor('claude', SID, peer, undefined, T0 + 1_000)).toMatchObject({ state: 'working', source: 'registry', turnStartedAt: T0, startedAt: T0 - 5_000 })
    expect(readingFor('claude', SID, { ...peer, status: 'idle' } as ClaudePeerRecord, undefined, T0 + 1_000).state).toBe('idle')
  })
})
