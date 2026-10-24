// 6.89.0 Tailscale self-heal (lib/tailscale-nudge.ts, docs/tailscale-self-heal.md). Every test drives
// the nudger with a fake Tailscale runner, a fake clock and a fake monotonic clock. Nothing here runs
// the real CLI. Addresses and names are fictional.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DISCO_PING_ARGS,
  ICMP_PING_ARGS,
  STATUS_ARGS,
  TAILSCALE_BIN_CANDIDATES,
  TAILSCALE_NUDGE_LIMITS as L,
  TailscaleNudger,
  backoffMs,
  classifyDiscoPing,
  classifyIcmpPing,
  execFileRunner,
  networkFingerprint,
  parseTailscaleStatus,
  resolveTailscaleBin,
  tailscaleStateChanged,
  type RunResult,
} from './tailscale-nudge.js'

const PHONE = '100.70.1.10'
const LAPTOP = '100.70.1.20'
const SPARE_PHONE = '100.70.1.30'
const BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

interface PeerFixture { ip: string; online?: boolean; os?: string; rx?: number; tx?: number; handshake?: string }
function statusJson(peers: PeerFixture[], backendState = 'Running', selfIp = '100.70.0.1'): string {
  const Peer: Record<string, unknown> = {}
  peers.forEach((p, i) => {
    Peer[`nodekey:${i}`] = {
      HostName: `device-${i}`,
      OS: p.os ?? 'iOS',
      TailscaleIPs: [p.ip, `fd7a:115c:a1e0::${i + 1}`],
      Online: p.online ?? true,
      RxBytes: p.rx ?? 1000,
      TxBytes: p.tx ?? 2000,
      LastHandshake: p.handshake ?? '2026-10-23T20:00:00Z',
    }
  })
  return JSON.stringify({ BackendState: backendState, Self: { TailscaleIPs: [selfIp, 'fd7a:115c:a1e0::ff'] }, Peer })
}

const ok = (stdout: string, elapsedMs = 40): RunResult => ({ code: 0, signal: null, killed: false, stdout, stderr: '', elapsedMs })
const PONG_DIRECT = ok(`pong from device-0 (${PHONE}) via 192.0.2.5:41641 in 91ms\n`)
const PONG_DERP = ok(`pong from device-0 (${PHONE}) via DERP(dfw) in 140ms\n`)
const ICMP_PONG = ok(`pong from device-0 (${PHONE}) via ICMP in 27ms\n`)

/** A world: a clock, a monotonic clock, an env, a fingerprint and a runner that records every call. */
function world(opts: { peers?: PeerFixture[]; env?: Record<string, string | undefined>; bin?: string | null; meetings?: number } = {}) {
  const w = {
    wall: Date.parse('2026-10-23T20:00:00Z'),
    mono: 1_000_000,
    env: { ...(opts.env ?? {}) } as Record<string, string | undefined>,
    fp: 'en0=192.0.2.10,utun4=100.70.0.1',
    peers: opts.peers ?? [{ ip: PHONE, os: 'iOS' }],
    backend: 'Running',
    statusFails: false,
    meetings: opts.meetings ?? 0,
    disco: PONG_DIRECT as RunResult,
    icmp: ICMP_PONG as RunResult,
    calls: [] as Array<{ bin: string; args: string[]; timeoutMs: number }>,
    logs: [] as string[],
    nudger: null as unknown as TailscaleNudger,
    advance(ms: number) { w.wall += ms; w.mono += ms },
    sleep(ms: number) { w.wall += ms },
    pings() { return w.calls.filter(c => c.args[0] === 'ping') },
    discoPings() { return w.calls.filter(c => c.args[0] === 'ping' && !c.args.includes('--icmp')) },
    statusCalls() { return w.calls.filter(c => c.args[0] === 'status') },
  }
  w.nudger = new TailscaleNudger({
    now: () => w.wall,
    monotonic: () => w.mono,
    env: () => w.env as NodeJS.ProcessEnv,
    resolveBin: () => (opts.bin === undefined ? BIN : opts.bin),
    fingerprint: () => w.fp,
    activeMeetings: () => w.meetings,
    log: line => { w.logs.push(line) },
    runner: async (bin, args, timeoutMs) => {
      w.calls.push({ bin, args: [...args], timeoutMs })
      if (args[0] === 'status') return w.statusFails ? { ...ok(''), code: 1, stderr: 'failed to connect to local tailscaled' } : ok(statusJson(w.peers, w.backend))
      return args.includes('--icmp') ? w.icmp : w.disco
    },
  })
  return w
}

/** Tick every 10 s for `ms`, the way the interval does. */
async function run(w: ReturnType<typeof world>, ms: number) {
  for (let t = 0; t < ms; t += L.tickMs) {
    w.advance(L.tickMs)
    await w.nudger.tick()
  }
}

/** A world past boot: the boot trigger has run (or been skipped) and its calls are cleared. */
async function pastBoot(opts: Parameters<typeof world>[0] = {}) {
  const w = world(opts)
  w.nudger.start()
  w.nudger.stop()
  await w.nudger.tick()
  // The boot nudge (if any) runs at 30 s; 100 s leaves it more than the 60 s minimum behind.
  await run(w, 100_000)
  w.calls.length = 0
  w.logs.length = 0
  return w
}

describe('the Tailscale command: fixed binary, argument arrays, no shell', () => {
  it('pings with exactly these arguments', () => {
    expect(DISCO_PING_ARGS(PHONE)).toEqual(['ping', '-c', '3', '--timeout', '5s', PHONE])
    expect(ICMP_PING_ARGS(PHONE)).toEqual(['ping', '--icmp', '-c', '1', '--timeout', '5s', PHONE])
    expect(STATUS_ARGS).toEqual(['status', '--json'])
  })

  it('looks for the CLI only at fixed absolute paths, in order, and never on PATH', () => {
    expect(TAILSCALE_BIN_CANDIDATES[0]).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
    for (const p of TAILSCALE_BIN_CANDIDATES) expect(p.startsWith('/')).toBe(true)
    const asked: string[] = []
    expect(resolveTailscaleBin(p => { asked.push(p); return p === '/usr/local/bin/tailscale' })).toBe('/usr/local/bin/tailscale')
    expect(asked).toEqual(TAILSCALE_BIN_CANDIDATES.slice(0, 3))
    expect(resolveTailscaleBin(() => false)).toBeNull()
  })

  it('execFileRunner passes arguments as data: shell syntax arrives literally and runs nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nudge-shell-'))
    const marker = join(dir, 'pwned')
    const res = await execFileRunner('/bin/echo', [`$(touch ${marker})`, ';', `touch ${marker}`, '|', '&&'], 5_000)
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe(`$(touch ${marker}) ; touch ${marker} | &&`)
    expect(existsSync(marker)).toBe(false)
  })

  it('execFileRunner reports a missing binary as a spawn error, and a hang as a kill', async () => {
    const missing = await execFileRunner('/nonexistent/tailscale', ['status'], 2_000)
    expect(missing.spawnError).toBe('ENOENT')
    expect(classifyDiscoPing(missing)).toBe('unavailable')
    const hung = await execFileRunner('/bin/sleep', ['5'], 200)
    expect(hung.killed).toBe(true)
    expect(hung.signal).toBe('SIGKILL')
    expect(classifyDiscoPing(hung)).toBe('timeout')
  })

  it('every runner call uses the resolved fixed binary and a bounded timeout', async () => {
    const w = world()
    w.nudger.start(); w.nudger.stop()
    await w.nudger.tick()
    await run(w, 40_000)
    expect(w.calls.length).toBeGreaterThan(0)
    for (const c of w.calls) {
      expect(c.bin).toBe(BIN)
      expect(c.timeoutMs).toBeGreaterThan(0)
      expect(c.timeoutMs).toBeLessThanOrEqual(20_000)
    }
  })
})

describe('reading Tailscale', () => {
  it('parses status --json: IPv4 Tailscale address, Online, OS, counters, handshake', () => {
    const s = parseTailscaleStatus(statusJson([{ ip: PHONE, rx: 5, tx: 7, handshake: '2026-10-23T19:59:00Z' }, { ip: LAPTOP, online: false, os: 'macOS' }]), 1)!
    expect(s.backendState).toBe('Running')
    expect(s.selfIps).toEqual(['100.70.0.1'])
    expect(s.peers).toEqual([
      { ip: PHONE, online: true, os: 'iOS', rxBytes: 5, txBytes: 7, lastHandshakeMs: Date.parse('2026-10-23T19:59:00Z') },
      { ip: LAPTOP, online: false, os: 'macOS', rxBytes: 1000, txBytes: 2000, lastHandshakeMs: Date.parse('2026-10-23T20:00:00Z') },
    ])
  })

  it('a zero handshake reads as none, and garbage reads as no status', () => {
    expect(parseTailscaleStatus(statusJson([{ ip: PHONE, handshake: '0001-01-01T00:00:00Z' }]), 1)!.peers[0].lastHandshakeMs).toBe(0)
    expect(parseTailscaleStatus('not json', 1)).toBeNull()
    expect(parseTailscaleStatus('{"Peer":{}}', 1)).toBeNull()
  })

  it('classifies ping output', () => {
    expect(classifyDiscoPing(PONG_DIRECT)).toBe('pong_direct')
    expect(classifyDiscoPing(PONG_DERP)).toBe('pong_relay')
    expect(classifyDiscoPing({ ...ok('timeout waiting for ping reply\n'), code: 1 })).toBe('no_pong')
    expect(classifyDiscoPing({ ...ok(''), code: 1, stderr: 'no matching peer' })).toBe('error')
    expect(classifyIcmpPing(ICMP_PONG)).toBe('ok')
    expect(classifyIcmpPing({ ...ok('timeout'), code: 1 })).toBe('failed')
  })

  it('a Tailscale state change is BackendState, this Mac\'s IPs, or counters going backwards', () => {
    const a = parseTailscaleStatus(statusJson([{ ip: PHONE, rx: 500, tx: 500 }]), 1)
    expect(tailscaleStateChanged(a, parseTailscaleStatus(statusJson([{ ip: PHONE, rx: 900, tx: 900 }]), 2))).toBe(false)
    expect(tailscaleStateChanged(a, parseTailscaleStatus(statusJson([{ ip: PHONE, rx: 10, tx: 10 }]), 2))).toBe(true)
    expect(tailscaleStateChanged(a, parseTailscaleStatus(statusJson([{ ip: PHONE, rx: 500, tx: 500 }], 'Starting'), 2))).toBe(true)
    expect(tailscaleStateChanged(a, parseTailscaleStatus(statusJson([{ ip: PHONE, rx: 500, tx: 500 }], 'Running', '100.70.0.2'), 2))).toBe(true)
    expect(tailscaleStateChanged(null, a)).toBe(false)
    expect(tailscaleStateChanged(a, null)).toBe(false)
  })

  it('the network fingerprint is external IPv4 only, sorted', () => {
    expect(networkFingerprint({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      utun4: [{ address: '100.70.0.1', family: 'IPv4', internal: false }],
      en0: [{ address: '192.0.2.10', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    })).toBe('en0=192.0.2.10,utun4=100.70.0.1')
  })
})

describe('the trigger table', () => {
  it('boot: nothing before 30 s, then the Online phone, once', async () => {
    const w = world({ peers: [{ ip: PHONE, os: 'iOS' }] })
    w.nudger.start(); w.nudger.stop()
    await run(w, 20_000)
    expect(w.pings()).toEqual([])
    await run(w, 20_000)
    expect(w.discoPings().map(c => c.args.at(-1))).toEqual([PHONE])
    expect(w.nudger.health().lastTrigger).toBe('boot')
    await run(w, 120_000)
    expect(w.discoPings()).toHaveLength(1)
  })

  it('boot: an offline peer, an unknown laptop, and a phone already back are left alone', async () => {
    const w = world({ peers: [{ ip: PHONE, online: false }, { ip: LAPTOP, os: 'macOS' }, { ip: SPARE_PHONE, os: 'android' }] })
    w.nudger.start(); w.nudger.stop()
    w.advance(5_000)
    w.nudger.noteRequest(`::ffff:${SPARE_PHONE}`)
    await run(w, 60_000)
    expect(w.pings()).toEqual([])
  })

  it('6.90.0: a boot or wake that skips a phone already back logs one line, trigger and outcome only', async () => {
    const w = world({ peers: [{ ip: PHONE, os: 'iOS' }] })
    w.nudger.start(); w.nudger.stop()
    w.advance(5_000)
    w.nudger.noteRequest(PHONE)
    await run(w, 60_000)
    expect(w.pings()).toEqual([])
    expect(w.logs.filter(l => l.includes('already_reconnected'))).toEqual(['[tailscale-nudge] trigger=boot outcome=already_reconnected'])
    w.logs.length = 0
    w.sleep(25 * 60_000)
    w.advance(10_000)
    w.nudger.noteRequest(PHONE)
    await w.nudger.tick()
    await run(w, 30_000)
    expect(w.pings()).toEqual([])
    expect(w.logs.filter(l => l.includes('already_reconnected'))).toEqual(['[tailscale-nudge] trigger=wake outcome=already_reconnected'])
    for (const line of w.logs) expect(line).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
  })

  it('6.90.0: a boot that nudges logs no already_reconnected line', async () => {
    const w = world({ peers: [{ ip: PHONE, os: 'iOS' }] })
    w.nudger.start(); w.nudger.stop()
    await run(w, 40_000)
    expect(w.discoPings()).toHaveLength(1)
    expect(w.logs.some(l => l.includes('already_reconnected'))).toBe(false)
  })

  it('boot: a laptop that authenticated here counts as known and is nudged', async () => {
    const w = world({ peers: [{ ip: LAPTOP, os: 'macOS' }] })
    w.nudger.noteRequest(LAPTOP, { authenticated: true })
    w.advance(1_000)
    w.nudger.start(); w.nudger.stop()
    await run(w, 40_000)
    expect(w.discoPings().map(c => c.args.at(-1))).toEqual([LAPTOP])
  })

  it('boot: at most four peers', async () => {
    const peers = Array.from({ length: 7 }, (_, i) => ({ ip: `100.70.2.${i + 1}`, os: 'iOS' }))
    const w = world({ peers })
    w.nudger.start(); w.nudger.stop()
    await run(w, 40_000)
    expect(w.discoPings()).toHaveLength(L.eventMaxPeers)
  })

  it('boot: waits while Tailscale is not Running, then runs when it is', async () => {
    const w = world()
    w.backend = 'Starting'
    w.nudger.start(); w.nudger.stop()
    await run(w, 60_000)
    expect(w.pings()).toEqual([])
    w.backend = 'Running'
    // A status older than 15 s is read again, so it is seen within two ticks, not at the next minute poll.
    await run(w, 20_000)
    expect(w.discoPings()).toHaveLength(1)
  })

  it('boot: dropped, logged, after two minutes without a Running Tailscale', async () => {
    const w = world()
    w.statusFails = true
    w.nudger.start(); w.nudger.stop()
    await run(w, 200_000)
    w.statusFails = false
    await run(w, 60_000)
    expect(w.pings()).toEqual([])
    expect(w.logs.some(l => l.includes('trigger=boot dropped'))).toBe(true)
  })

  it('wake: the wall clock leads the monotonic clock by more than 20 s', async () => {
    const w = await pastBoot()
    w.sleep(25 * 60_000)
    await run(w, 30_000)
    expect(w.discoPings()).toHaveLength(1)
    expect(w.nudger.health().lastTrigger).toBe('wake')
  })

  it('no wake for a gap under 20 s (a slow event loop is not a sleep)', async () => {
    const w = await pastBoot()
    w.sleep(15_000)
    await run(w, 60_000)
    expect(w.pings()).toEqual([])
  })

  it('network: an interface change nudges after it settles', async () => {
    const w = await pastBoot()
    w.fp = 'en0=192.0.2.44,utun4=100.70.0.1'
    await run(w, 30_000)
    expect(w.discoPings()).toHaveLength(1)
    expect(w.nudger.health().lastTrigger).toBe('network')
  })

  it('tailscale: tailscaled restarted (counters went backwards) nudges', async () => {
    const w = await pastBoot({ peers: [{ ip: PHONE, rx: 900_000, tx: 900_000 }] })
    w.peers = [{ ip: PHONE, rx: 10, tx: 10 }]
    await run(w, 90_000)
    expect(w.discoPings()).toHaveLength(1)
    expect(w.nudger.health().lastTrigger).toBe('tailscale')
  })

  it('silent: an authenticated phone quiet for 45 s while Online is nudged', async () => {
    const w = await pastBoot()
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 40_000)
    expect(w.pings()).toEqual([])
    await run(w, 10_000)
    expect(w.discoPings()).toHaveLength(1)
    const h = w.nudger.health()
    expect(h.lastTrigger).toBe('silent')
    expect(h.lastOutcome).toBe('pong_direct')
    expect(h.lastDataPath).toBe('ok')
  })

  it('silent, never on absence alone: no nudge while Tailscale says the peer is offline', async () => {
    const w = await pastBoot({ peers: [{ ip: PHONE, online: false }] })
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 4 * 60_000)
    expect(w.pings()).toEqual([])
  })

  it('silent, never on absence alone: no nudge when the peer is missing from status', async () => {
    const w = await pastBoot({ peers: [{ ip: LAPTOP }] })
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 4 * 60_000)
    expect(w.pings()).toEqual([])
  })

  it('silent, never on absence alone: no nudge when status cannot be read or Tailscale is stopped', async () => {
    for (const breakIt of [(w: any) => { w.statusFails = true }, (w: any) => { w.backend = 'Stopped' }]) {
      const w = await pastBoot()
      breakIt(w)
      w.nudger.noteRequest(PHONE, { authenticated: true })
      await run(w, 4 * 60_000)
      expect(w.pings()).toEqual([])
    }
  })

  it('silent: a phone last active more than 5 minutes ago, with no meeting, is left alone', async () => {
    const w = await pastBoot()
    w.nudger.noteRequest(PHONE, { authenticated: true })
    w.nudger.stop()
    w.advance(L.activeWindowMs + 10_000)
    await w.nudger.tick()
    await run(w, 60_000)
    expect(w.pings()).toEqual([])
  })

  it('silent: a phone that sent meeting chunks 10 minutes ago is nudged while a meeting is open', async () => {
    const w = await pastBoot({ meetings: 1 })
    w.nudger.noteRequest(PHONE, { authenticated: true, meetingChunk: true })
    w.advance(10 * 60_000)
    await w.nudger.tick()
    expect(w.discoPings()).toHaveLength(1)
  })

  it('silent: meeting chunks more than 15 minutes ago no longer count, even with a meeting open', async () => {
    const w = await pastBoot({ meetings: 1 })
    w.nudger.noteRequest(PHONE, { authenticated: true, meetingChunk: true })
    w.advance(L.meetingWindowMs + 10_000)
    await w.nudger.tick()
    await run(w, 60_000)
    expect(w.pings()).toEqual([])
  })

  it('silent: the same phone is left alone once no meeting is open', async () => {
    const w = await pastBoot({ meetings: 0 })
    w.nudger.noteRequest(PHONE, { authenticated: true, meetingChunk: true })
    w.advance(10 * 60_000)
    await w.nudger.tick()
    expect(w.pings()).toEqual([])
  })

  it('silent: an address that only ever hit public routes is not a paired phone', async () => {
    const w = await pastBoot()
    w.nudger.noteRequest(PHONE)
    await run(w, 4 * 60_000)
    expect(w.pings()).toEqual([])
  })

  it('only Tailscale addresses are tracked: loopback and Wi-Fi callers never are', async () => {
    const w = await pastBoot({ peers: [{ ip: PHONE }] })
    for (const a of ['127.0.0.1', '::1', '192.168.1.50', '::ffff:10.0.0.4']) w.nudger.noteRequest(a, { authenticated: true })
    await run(w, 4 * 60_000)
    expect(w.pings()).toEqual([])
  })

  it('Wi-Fi and loopback callers cannot crowd a tracked phone out of the bounded table', async () => {
    const w = await pastBoot({ peers: [{ ip: PHONE }] })
    w.nudger.noteRequest(PHONE, { authenticated: true })
    for (let i = 1; i <= 40; i++) w.nudger.noteRequest(`192.168.1.${i}`, { authenticated: true })
    await run(w, 50_000)
    expect(w.discoPings().map(c => c.args.at(-1))).toEqual([PHONE])
  })

  it('a request from the phone resets the silence: a chatty phone is never nudged', async () => {
    const w = await pastBoot()
    for (let i = 0; i < 30; i++) {
      w.nudger.noteRequest(PHONE, { authenticated: true })
      await run(w, 30_000)
    }
    expect(w.pings()).toEqual([])
  })
})

describe('caps and backoff', () => {
  it('backoff doubles from 60 s and stops at 15 minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(backoffMs)).toEqual([0, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000])
  })

  it('a phone that stays quiet is nudged at 45 s, then 60, 120, 240 s apart, and not after its 5-minute window', async () => {
    const w = await pastBoot()
    w.nudger.noteRequest(PHONE, { authenticated: true })
    const start = w.wall
    const times: number[] = []
    for (let t = 0; t < 30 * 60_000; t += L.tickMs) {
      w.advance(L.tickMs)
      const before = w.discoPings().length
      await w.nudger.tick()
      if (w.discoPings().length > before) times.push((w.wall - start) / 1000)
    }
    expect(times).toEqual([50, 110, 230])
  })

  it('during a meeting the gaps keep doubling to the 15-minute ceiling', async () => {
    const w = await pastBoot({ meetings: 1 })
    w.nudger.noteRequest(PHONE, { authenticated: true, meetingChunk: true })
    const start = w.wall
    const times: number[] = []
    for (let t = 0; t < 15 * 60_000; t += L.tickMs) {
      w.advance(L.tickMs)
      const before = w.discoPings().length
      await w.nudger.tick()
      if (w.discoPings().length > before) times.push((w.wall - start) / 1000)
    }
    // 50 (45 s silence on a 10 s tick), +60, +120, +240, +480; the window closes at 15 min.
    expect(times).toEqual([50, 110, 230, 470])
  })

  it('a request after a nudge resets the backoff and is logged as the answer', async () => {
    const w = await pastBoot()
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 50_000)
    expect(w.discoPings()).toHaveLength(1)
    w.advance(5_000)
    w.nudger.noteRequest(PHONE, { authenticated: true })
    expect(w.nudger.health().lastRecoveredAt).not.toBeNull()
    expect(w.logs.some(l => /peer answered [\d.]+s after the silent nudge/.test(l))).toBe(true)
    // Fresh silence: the next nudge waits only the 60 s minimum, not a doubled gap, and never less.
    const firstAt = Date.parse(w.nudger.health().lastAt!)
    await run(w, 60_000)
    expect(w.discoPings()).toHaveLength(2)
    expect(Date.parse(w.nudger.health().lastAt!) - firstAt).toBeGreaterThanOrEqual(L.minIntervalMs)
  })

  it('a quiet phone the caps hold back costs no status read beyond the minute poll', async () => {
    const w = await pastBoot()
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 50_000)
    expect(w.discoPings()).toHaveLength(1)
    w.calls.length = 0
    await run(w, 50_000)
    expect(w.statusCalls().length).toBeLessThanOrEqual(1)
  })

  it('a request long after a nudge is not counted as its answer', async () => {
    const w = await pastBoot({ peers: [{ ip: LAPTOP, os: 'macOS' }] })
    w.nudger.noteRequest(LAPTOP, { authenticated: true })
    await run(w, 50_000)
    expect(w.discoPings()).toHaveLength(1)
    w.advance(L.recoveredWithinMs + 1_000)
    w.nudger.noteRequest(LAPTOP, { authenticated: true })
    expect(w.nudger.health().lastRecoveredAt).toBeNull()
  })

  it('never more than one nudge a minute per peer, whatever fires', async () => {
    const w = await pastBoot()
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 50_000)
    expect(w.discoPings()).toHaveLength(1)
    w.fp = 'en0=192.0.2.99'
    await run(w, 30_000)
    expect(w.discoPings()).toHaveLength(1)
    await run(w, 40_000)
    expect(w.discoPings()).toHaveLength(2)
  })

  it('30 nudges an hour in all', async () => {
    // Laptops, so the boot trigger leaves them alone and every nudge here is a silent one.
    const peers = Array.from({ length: 16 }, (_, i) => ({ ip: `100.70.3.${i + 1}`, os: 'macOS' }))
    const w = await pastBoot({ peers, meetings: 1 })
    const keepWarm = () => { for (const p of peers) w.nudger.noteRequest(p.ip, { authenticated: true, meetingChunk: true }) }
    for (let round = 0; round < 6; round++) {
      keepWarm()
      await run(w, 60_000)
    }
    expect(w.discoPings().length).toBe(L.maxPerHour)
    expect(w.nudger.health().nudgesLastHour).toBe(L.maxPerHour)
    w.calls.length = 0
    keepWarm()
    await run(w, 60_000)
    expect(w.discoPings()).toEqual([])
  })

  it('the ICMP data-path ping runs only after a disco pong', async () => {
    const w = await pastBoot()
    w.disco = { ...ok('timeout waiting for ping reply\n'), code: 1 }
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 50_000)
    expect(w.pings().map(c => c.args)).toEqual([DISCO_PING_ARGS(PHONE)])
    expect(w.nudger.health().lastOutcome).toBe('no_pong')
    expect(w.nudger.health().lastDataPath).toBe('skipped')
  })

  it('one pass at a time: a tick during a slow ping does nothing', async () => {
    const w = await pastBoot({ peers: [{ ip: PHONE }, { ip: SPARE_PHONE }] })
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const slow = w.nudger as any
    const realRunner = slow.runner
    slow.runner = async (bin: string, args: string[], t: number) => {
      const result = realRunner(bin, args, t) // recorded now, answered only after release
      if (args[0] === 'ping') await gate
      return result
    }
    w.nudger.noteRequest(PHONE, { authenticated: true })
    w.nudger.noteRequest(SPARE_PHONE, { authenticated: true })
    w.advance(50_000)
    const first = w.nudger.tick()
    await new Promise(r => setTimeout(r, 5))
    for (let i = 0; i < 5; i++) { w.advance(L.tickMs); void w.nudger.tick(); await new Promise(r => setTimeout(r, 1)) }
    // Two phones are due, but the second waits for the first pass to finish: never two pings at once.
    expect(w.discoPings()).toHaveLength(1)
    release()
    await first
    expect(w.discoPings()).toHaveLength(2)
  })
})

describe('the kill switch', () => {
  it('COS_TAILSCALE_NUDGE=0, false or off: no status read and no ping, whatever fires', async () => {
    for (const value of ['0', 'false', 'off', ' OFF ']) {
      const w = world({ env: { COS_TAILSCALE_NUDGE: value } })
      w.nudger.start(); w.nudger.stop()
      w.nudger.noteRequest(PHONE, { authenticated: true })
      await run(w, 60_000)
      w.sleep(10 * 60_000)
      w.fp = 'en0=192.0.2.77'
      await run(w, 60_000)
      expect(w.calls, value).toEqual([])
      expect(w.nudger.health().enabled).toBe(false)
    }
  })

  it('on by default, and read every tick: turning it off mid-silence stops the next nudge', async () => {
    const w = await pastBoot()
    expect(w.nudger.health().enabled).toBe(true)
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 50_000)
    expect(w.discoPings()).toHaveLength(1)
    w.env.COS_TAILSCALE_NUDGE = '0'
    w.calls.length = 0
    await run(w, 10 * 60_000)
    expect(w.calls).toEqual([])
  })

  it('no Tailscale CLI on this machine: nothing runs, health says unavailable', async () => {
    const w = world({ bin: null })
    w.nudger.start(); w.nudger.stop()
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 5 * 60_000)
    expect(w.calls).toEqual([])
    expect(w.nudger.health().available).toBe(false)
  })
})

describe('what it says', () => {
  it('health is counts, times and outcomes only', async () => {
    const w = await pastBoot()
    expect(Object.keys(w.nudger.health())).toEqual(['enabled', 'available', 'lastAt', 'lastTrigger', 'lastOutcome', 'lastDataPath', 'lastRecoveredAt', 'nudgesLastHour'])
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 50_000)
    const h = w.nudger.health()
    expect(h.lastAt).toBe(new Date(w.wall).toISOString())
    expect(h.nudgesLastHour).toBe(2) // the boot nudge and this one
    expect(JSON.stringify(h)).not.toContain('100.70')
  })

  it('log lines carry trigger, outcome and timing, never an address', async () => {
    const w = await pastBoot()
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 50_000)
    w.nudger.noteRequest(PHONE, { authenticated: true })
    expect(w.logs.length).toBeGreaterThanOrEqual(2)
    expect(w.logs.find(l => l.includes('trigger=silent'))).toMatch(/^\[tailscale-nudge\] trigger=silent outcome=pong_direct dataPath=ok pingMs=\d+ icmpMs=\d+ silentS=\d+ handshakeAgeS=/)
    for (const line of w.logs) expect(line).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
  })

  it('a failed ping logs the exit code, signal and kill flag', async () => {
    const w = await pastBoot()
    w.disco = { code: null, signal: 'SIGKILL', killed: true, stdout: '', stderr: '', elapsedMs: 20_000 }
    w.nudger.noteRequest(PHONE, { authenticated: true })
    await run(w, 50_000)
    expect(w.logs.at(-1)).toMatch(/outcome=timeout .* code=null signal=SIGKILL killed=true/)
  })
})

describe('wiring', () => {
  const root = new URL('../../', import.meta.url)
  const index = readFileSync(new URL('server/index.ts', root), 'utf8')

  it('notes every /api request before the token check, and authenticated ones in it', () => {
    const note = index.indexOf('tailscaleNudger.noteRequest(req.socket?.remoteAddress, { meetingChunk: isMeetingChunkPost(req.method, req.path) })')
    const auth = index.indexOf("app.use('/api', requireApiToken(API_TOKEN")
    expect(note).toBeGreaterThan(0)
    expect(note).toBeLessThan(auth)
    const authed = index.indexOf('if (!isPublicApiRequest(req.method, req.path)) tailscaleNudger.noteRequest(req.socket?.remoteAddress, { authenticated: true })')
    expect(authed).toBeGreaterThan(auth)
    expect(authed).toBeLessThan(index.indexOf("app.use('/api', createPairingRouter("))
  })

  it('starts with the proof-safe services, stops in shutdown, and knows when a meeting is open', () => {
    expect(index).toMatch(/installTailscaleNudger\(\{ activeMeetings: \(\) => getActiveTranscriptionSessionCount\(\) \}\)/)
    expect(index.match(/tailscaleNudger\.start\(\)/g)).toHaveLength(1)
    expect(index.match(/tailscaleNudger\.stop\(\)/g)).toHaveLength(1)
  })

  it('the switch is forwarded by the managed runtime contract', () => {
    const contract = JSON.parse(readFileSync(new URL('managed-runtime-contract.json', root), 'utf8')) as { optionalEnvironment: string[] }
    expect(contract.optionalEnvironment).toContain('COS_TAILSCALE_NUDGE')
  })
})
