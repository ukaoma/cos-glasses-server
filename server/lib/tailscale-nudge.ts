// 6.89.0 Tailscale self-heal: the Mac-side "nudge" (docs/tailscale-self-heal.md).
//
// Why: on 2026-10-22 the Mac restarted at 14:09 and the server answered on every address from
// 14:10:58, but the iPhone's Tailscale extension kept a stale tunnel. Tailscale's own ping got
// through, no COS request did, and only toggling Tailscale on the phone (15:09) fixed it. The goal
// is that a Mac restart, a wake from sleep, a Tailscale restart on the Mac or a network change heals
// without anyone touching Tailscale.
//
// What a nudge is: two bounded `tailscale ping`s at one peer, run with execFile from a fixed path,
// never a shell:
//   1. `ping -c 3 --timeout 5s <ip>`: a disco ping. It makes both ends redo path discovery, and it
//      stops early once a direct path answers.
//   2. only after a pong, `ping --icmp -c 1 --timeout 5s <ip>`: a packet THROUGH WireGuard. The disco
//      ping alone can succeed while the data path is stale (it does not use the tunnel, which is what
//      10/22 looked like); a data packet makes WireGuard start a fresh handshake when its session is
//      stale.
// Whether this un-sticks the iOS extension in the field is NOT proven here; the field canary is.
//
// When (triggers), each needing the POSITIVE signal "tailscale status says this peer is Online"
// from a status read at most STATUS_FRESH_MS old. Absence of requests alone never nudges.
//   boot      30 s after the server starts.
//   wake      the wall clock moved 20 s+ more than the monotonic clock (the Mac slept).
//   network   this Mac's IPv4 interfaces changed (Tailscale's utun included).
//   tailscale Tailscale's own state changed: BackendState, this Mac's Tailscale IPs, or the peer
//             byte counters went backwards (tailscaled restarted).
//   silent    a phone that made an authenticated request in the last 5 minutes, or sent meeting
//             chunks in the last 15 minutes while a meeting is open, has made no request at all
//             for 45 s, while its peer is Online.
// Event triggers (boot, wake, network, tailscale) aim at peers this process has seen authenticate in
// the last 12 hours, plus Online iOS and Android peers (after a restart the Mac remembers no one),
// at most 4, and skip any peer that has already made a request since the event.
//
// Caps: one nudge per peer per 60 s, doubling per nudge that brings no request (60, 120, 240, 480,
// then 900 s), reset by any request from that peer; 30 nudges an hour in all; one at a time.
// COS_TAILSCALE_NUDGE=0 (or false/off) stops everything, read every tick, no restart needed.
// No LLM, no disk write, no shell. Logs carry trigger, outcome and timing only, never an address.

import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { readSwitch } from './env-switch.js'
import { isTailscaleIpv4, normalizeRemoteIp } from './network-policy.js'

export const TAILSCALE_NUDGE_LIMITS = Object.freeze({
  tickMs: 10_000,
  bootDelayMs: 30_000,
  wakeSettleMs: 15_000,
  networkSettleMs: 10_000,
  /** An event trigger that cannot run (Tailscale not Running yet) is dropped after this. */
  eventExpiryMs: 120_000,
  /** The monotonic clock stops while the Mac sleeps; a wall-clock lead past this is a wake. */
  wakeGapMs: 20_000,
  silenceMs: 45_000,
  activeWindowMs: 5 * 60_000,
  meetingWindowMs: 15 * 60_000,
  knownPeerWindowMs: 12 * 60 * 60_000,
  minIntervalMs: 60_000,
  maxBackoffMs: 15 * 60_000,
  maxPerHour: 30,
  eventMaxPeers: 4,
  statusPollMs: 60_000,
  statusFreshMs: 15_000,
  recoveredWithinMs: 90_000,
  discoTimeoutMs: 20_000,
  icmpTimeoutMs: 10_000,
  statusTimeoutMs: 5_000,
  binRecheckMs: 10 * 60_000,
  maxTrackedPeers: 16,
})

/** Fixed places the Tailscale CLI lives. No PATH lookup and no override: the path is never input. */
export const TAILSCALE_BIN_CANDIDATES = Object.freeze([
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
])

export const DISCO_PING_ARGS = (ip: string): string[] => ['ping', '-c', '3', '--timeout', '5s', ip]
export const ICMP_PING_ARGS = (ip: string): string[] => ['ping', '--icmp', '-c', '1', '--timeout', '5s', ip]
export const STATUS_ARGS: readonly string[] = Object.freeze(['status', '--json'])

export type NudgeTrigger = 'boot' | 'wake' | 'network' | 'tailscale' | 'silent'
export type NudgeOutcome = 'pong_direct' | 'pong_relay' | 'no_pong' | 'timeout' | 'error' | 'unavailable'
export type DataPathOutcome = 'ok' | 'failed' | 'skipped'

export interface RunResult {
  code: number | null
  signal: string | null
  killed: boolean
  stdout: string
  stderr: string
  /** Set when the process could not be started at all (ENOENT, EACCES). */
  spawnError?: string
  elapsedMs: number
}
/** The one way this module runs Tailscale: a binary path and an argument array, never a shell. */
export type TailscaleRunner = (bin: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>

export const execFileRunner: TailscaleRunner = (bin, args, timeoutMs) => new Promise(resolve => {
  const started = Date.now()
  execFile(bin, [...args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' },
    (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null
      const spawnError = err && typeof err.code === 'string' ? err.code : undefined
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
        signal: err?.signal ?? null,
        killed: !!err?.killed,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        ...(spawnError ? { spawnError } : {}),
        elapsedMs: Date.now() - started,
      })
    })
})

export function resolveTailscaleBin(isExecutable: (p: string) => boolean = defaultIsExecutable): string | null {
  for (const candidate of TAILSCALE_BIN_CANDIDATES) if (isExecutable(candidate)) return candidate
  return null
}
function defaultIsExecutable(p: string): boolean {
  try { accessSync(p, fsConstants.X_OK); return true } catch { return false }
}

export interface PeerStatus {
  ip: string
  online: boolean
  os: string
  rxBytes: number
  txBytes: number
  /** Epoch ms of the last WireGuard handshake, or 0 for none. */
  lastHandshakeMs: number
}
export interface TailscaleStatus {
  backendState: string
  selfIps: string[]
  peers: PeerStatus[]
  at: number
}

/** Parse `tailscale status --json`. Returns null for anything that is not that shape. */
export function parseTailscaleStatus(text: string, at: number): TailscaleStatus | null {
  let raw: any
  try { raw = JSON.parse(text) } catch { return null }
  if (!raw || typeof raw !== 'object' || typeof raw.BackendState !== 'string') return null
  const v4 = (ips: unknown): string[] => Array.isArray(ips) ? ips.filter((ip): ip is string => typeof ip === 'string' && isTailscaleIpv4(ip)) : []
  const peers: PeerStatus[] = []
  const peerMap = raw.Peer && typeof raw.Peer === 'object' ? raw.Peer : {}
  for (const p of Object.values(peerMap) as any[]) {
    const ip = v4(p?.TailscaleIPs)[0]
    if (!ip) continue
    const hs = typeof p.LastHandshake === 'string' ? Date.parse(p.LastHandshake) : NaN
    peers.push({
      ip,
      online: p.Online === true,
      os: typeof p.OS === 'string' ? p.OS : '',
      rxBytes: Number.isFinite(p.RxBytes) ? p.RxBytes : 0,
      txBytes: Number.isFinite(p.TxBytes) ? p.TxBytes : 0,
      lastHandshakeMs: Number.isFinite(hs) && hs > 0 ? hs : 0,
    })
  }
  return { backendState: raw.BackendState, selfIps: v4(raw.Self?.TailscaleIPs).sort(), peers, at }
}

/** Disco ping output: "pong from <name> (<ip>) via <DERP(x) | ip:port | peer-relay(...)> in 91ms". */
export function classifyDiscoPing(result: RunResult): NudgeOutcome {
  if (result.spawnError) return 'unavailable'
  const pong = /pong from .* via (\S+) in [\d.]+ms/.exec(result.stdout)
  if (pong) return /^(DERP|peer-relay)/i.test(pong[1]) ? 'pong_relay' : 'pong_direct'
  if (result.killed || result.signal) return 'timeout'
  if (/no reply|timed out|timeout/i.test(result.stdout + result.stderr)) return 'no_pong'
  return result.code === 0 ? 'no_pong' : 'error'
}
export function classifyIcmpPing(result: RunResult): DataPathOutcome {
  return !result.spawnError && /pong from .* via ICMP/i.test(result.stdout) ? 'ok' : 'failed'
}

/** Every external IPv4 interface address, sorted: changes when a network or the Tailscale tunnel changes. */
type InterfaceInfo = { address: string; family: string | number; internal: boolean }
export function networkFingerprint(nets: Record<string, InterfaceInfo[] | undefined> = networkInterfaces()): string {
  const out: string[] = []
  for (const [name, infos] of Object.entries(nets)) {
    for (const info of infos ?? []) {
      const family = typeof info.family === 'number' ? (info.family === 4 ? 'IPv4' : 'IPv6') : String(info.family)
      if (family === 'IPv4' && !info.internal) out.push(`${name}=${info.address}`)
    }
  }
  return out.sort().join(',')
}

/** Did Tailscale's own state change between two status reads? A failed read is not a change. */
export function tailscaleStateChanged(prev: TailscaleStatus | null, next: TailscaleStatus | null): boolean {
  if (!prev || !next) return false
  if (prev.backendState !== next.backendState) return true
  if (prev.selfIps.join(',') !== next.selfIps.join(',')) return true
  // tailscaled keeps per-peer byte counters for its lifetime: a total that went DOWN means it restarted.
  const total = (s: TailscaleStatus) => s.peers.reduce((n, p) => n + p.rxBytes + p.txBytes, 0)
  return total(next) < total(prev)
}

/** Seconds between nudges for a peer, given how many nudges in a row brought no request. */
export function backoffMs(consecutive: number): number {
  if (consecutive <= 0) return 0
  const { minIntervalMs, maxBackoffMs } = TAILSCALE_NUDGE_LIMITS
  return Math.min(minIntervalMs * 2 ** (consecutive - 1), maxBackoffMs)
}

export function isMobileOs(os: string): boolean {
  return /^(ios|android)$/i.test(os.trim())
}

interface PeerTrack {
  /** Any /api request from this address, public routes included: proof the data path works. */
  lastRequestAt: number
  lastAuthenticatedAt: number
  lastMeetingChunkAt: number
  lastNudgeAt: number
  /** Nudges since the last request from this peer. */
  consecutive: number
}

export interface TailscaleNudgeDeps {
  runner?: TailscaleRunner
  now?: () => number
  /** Monotonic milliseconds; it does not advance while the Mac sleeps. */
  monotonic?: () => number
  env?: () => NodeJS.ProcessEnv
  resolveBin?: () => string | null
  fingerprint?: () => string
  activeMeetings?: () => number
  log?: (line: string) => void
}

export interface TailscaleNudgeHealth {
  enabled: boolean
  /** null until the first look for the Tailscale CLI; false when it is not installed. */
  available: boolean | null
  lastAt: string | null
  lastTrigger: NudgeTrigger | null
  lastOutcome: NudgeOutcome | null
  lastDataPath: DataPathOutcome | null
  /** When a nudged peer next made a request, within 90 s of the nudge. */
  lastRecoveredAt: string | null
  nudgesLastHour: number
}

interface PendingEvent { trigger: Exclude<NudgeTrigger, 'silent'>; firedAt: number; dueAt: number }

export class TailscaleNudger {
  private readonly runner: TailscaleRunner
  private readonly now: () => number
  private readonly monotonic: () => number
  private readonly env: () => NodeJS.ProcessEnv
  private readonly resolveBinFn: () => string | null
  private readonly fingerprintFn: () => string
  private readonly activeMeetings: () => number
  private readonly log: (line: string) => void

  private readonly peers = new Map<string, PeerTrack>()
  private readonly hourLog: number[] = []
  private pending: PendingEvent | null = null
  private bin: string | null | undefined = undefined
  private binCheckedAt = 0
  private status: TailscaleStatus | null = null
  private previousStatus: TailscaleStatus | null = null
  private lastStatusAttemptAt = 0
  private lastFingerprint: string | null = null
  private lastTick: { wall: number; mono: number } | null = null
  private busy = false
  private timer: ReturnType<typeof setInterval> | null = null
  private lastNudge: { at: number; ip: string; trigger: NudgeTrigger; outcome: NudgeOutcome; dataPath: DataPathOutcome } | null = null
  private lastRecoveredAt: number | null = null

  constructor(deps: TailscaleNudgeDeps = {}) {
    this.runner = deps.runner ?? execFileRunner
    this.now = deps.now ?? Date.now
    this.monotonic = deps.monotonic ?? (() => Number(process.hrtime.bigint() / 1_000_000n))
    this.env = deps.env ?? (() => process.env)
    this.resolveBinFn = deps.resolveBin ?? (() => resolveTailscaleBin())
    this.fingerprintFn = deps.fingerprint ?? (() => networkFingerprint())
    this.activeMeetings = deps.activeMeetings ?? (() => 0)
    this.log = deps.log ?? (line => console.log(line))
  }

  enabled(): boolean {
    return readSwitch(this.env().COS_TAILSCALE_NUDGE, true)
  }

  /** Start the tick. The boot trigger is due 30 s from now. Timers are unref'd. */
  start(): void {
    if (this.timer) return
    const at = this.now()
    this.pending = { trigger: 'boot', firedAt: at, dueAt: at + TAILSCALE_NUDGE_LIMITS.bootDelayMs }
    this.timer = setInterval(() => { void this.tick() }, TAILSCALE_NUDGE_LIMITS.tickMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Called for every /api request (before the token check) with the socket address. Only
   * Tailscale addresses are tracked. Never throws.
   */
  noteRequest(remoteAddress: string | undefined | null, kind: { authenticated?: boolean; meetingChunk?: boolean } = {}): void {
    try {
      const ip = normalizeRemoteIp(remoteAddress ?? '')
      if (!isTailscaleIpv4(ip)) return
      const at = this.now()
      let track = this.peers.get(ip)
      if (!track) {
        track = { lastRequestAt: 0, lastAuthenticatedAt: 0, lastMeetingChunkAt: 0, lastNudgeAt: 0, consecutive: 0 }
      }
      this.peers.delete(ip)
      this.peers.set(ip, track)
      while (this.peers.size > TAILSCALE_NUDGE_LIMITS.maxTrackedPeers) this.peers.delete(this.peers.keys().next().value as string)
      if (track.consecutive > 0 && this.lastNudge?.ip === ip && at - this.lastNudge.at <= TAILSCALE_NUDGE_LIMITS.recoveredWithinMs
        && (this.lastRecoveredAt === null || this.lastRecoveredAt < this.lastNudge.at)) {
        this.lastRecoveredAt = at
        this.log(`[tailscale-nudge] peer answered ${((at - this.lastNudge.at) / 1000).toFixed(1)}s after the ${this.lastNudge.trigger} nudge`)
      }
      track.lastRequestAt = at
      track.consecutive = 0
      if (kind.authenticated) track.lastAuthenticatedAt = at
      if (kind.meetingChunk) track.lastMeetingChunkAt = at
    } catch { /* observer only */ }
  }

  health(): TailscaleNudgeHealth {
    const at = this.now()
    return {
      enabled: this.enabled(),
      available: this.bin === undefined ? null : this.bin !== null,
      lastAt: this.lastNudge ? new Date(this.lastNudge.at).toISOString() : null,
      lastTrigger: this.lastNudge?.trigger ?? null,
      lastOutcome: this.lastNudge?.outcome ?? null,
      lastDataPath: this.lastNudge?.dataPath ?? null,
      lastRecoveredAt: this.lastRecoveredAt !== null ? new Date(this.lastRecoveredAt).toISOString() : null,
      nudgesLastHour: this.hourLog.filter(t => at - t < 3_600_000).length,
    }
  }

  /** One decision pass. Public for tests; the interval calls it. Never throws, never overlaps. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try { await this.tickInner() } catch { /* a failed pass waits for the next tick */ } finally { this.busy = false }
  }

  private async tickInner(): Promise<void> {
    const at = this.now()
    const mono = this.monotonic()
    const L = TAILSCALE_NUDGE_LIMITS
    // Wake and network detection run even when switched off, so turning it on later starts clean.
    if (this.lastTick && (at - this.lastTick.wall) - (mono - this.lastTick.mono) > L.wakeGapMs) {
      this.raise('wake', at, L.wakeSettleMs)
    }
    this.lastTick = { wall: at, mono }
    const fp = safe(this.fingerprintFn, '')
    if (this.lastFingerprint !== null && fp !== this.lastFingerprint) this.raise('network', at, L.networkSettleMs)
    this.lastFingerprint = fp

    if (!this.enabled()) return
    if (!this.ensureBin(at)) return

    if (at - this.lastStatusAttemptAt >= L.statusPollMs) {
      // Compared only on a successful read: a failed one leaves the last good status in place.
      const before = this.status
      const read = await this.readStatus(at)
      if (read && tailscaleStateChanged(before, read)) this.raise('tailscale', at, L.networkSettleMs)
    }

    const pending = this.pending
    if (pending && at >= pending.dueAt) {
      await this.runEvent(pending, at)
      return
    }
    await this.runSilent(at)
  }

  private raise(trigger: PendingEvent['trigger'], at: number, settleMs: number): void {
    // A boot still waiting keeps its own due time; any later event replaces an earlier one.
    if (this.pending?.trigger === 'boot' && trigger !== 'boot') {
      this.pending = { trigger, firedAt: this.pending.firedAt, dueAt: Math.max(this.pending.dueAt, at + settleMs) }
      return
    }
    this.pending = { trigger, firedAt: at, dueAt: at + settleMs }
  }

  private ensureBin(at: number): boolean {
    if (this.bin === undefined || (this.bin === null && at - this.binCheckedAt >= TAILSCALE_NUDGE_LIMITS.binRecheckMs)) {
      this.bin = safe(this.resolveBinFn, null)
      this.binCheckedAt = at
    }
    return this.bin !== null
  }

  private async readStatus(at: number): Promise<TailscaleStatus | null> {
    this.lastStatusAttemptAt = at
    const result = await this.runner(this.bin as string, STATUS_ARGS, TAILSCALE_NUDGE_LIMITS.statusTimeoutMs)
    if (result.spawnError === 'ENOENT') this.bin = null
    const parsed = result.spawnError ? null : parseTailscaleStatus(result.stdout, at)
    if (parsed) {
      this.previousStatus = this.status
      this.status = parsed
    }
    return parsed
  }

  /** A status no older than STATUS_FRESH_MS, read now if needed; null when Tailscale cannot say. */
  private async freshStatus(at: number): Promise<TailscaleStatus | null> {
    if (this.status && at - this.status.at <= TAILSCALE_NUDGE_LIMITS.statusFreshMs) return this.status
    const before = this.status
    const read = await this.readStatus(at)
    if (read && tailscaleStateChanged(before, read)) this.raise('tailscale', at, TAILSCALE_NUDGE_LIMITS.networkSettleMs)
    return read
  }

  private async runEvent(pending: PendingEvent, at: number): Promise<void> {
    const L = TAILSCALE_NUDGE_LIMITS
    const status = await this.freshStatus(at)
    if (!status || status.backendState !== 'Running') {
      if (at - pending.firedAt > L.eventExpiryMs) {
        this.pending = null
        this.log(`[tailscale-nudge] trigger=${pending.trigger} dropped: Tailscale ${status ? 'not running' : 'did not answer'} for ${Math.round((at - pending.firedAt) / 1000)}s`)
      }
      return
    }
    if (this.pending === pending) this.pending = null
    const known = (ip: string) => {
      const t = this.peers.get(ip)
      return !!t && t.lastAuthenticatedAt > 0 && at - t.lastAuthenticatedAt <= L.knownPeerWindowMs
    }
    const candidates = status.peers
      .filter(p => p.online && (known(p.ip) || isMobileOs(p.os)))
      // Already back since the event: nothing to heal.
      .filter(p => (this.peers.get(p.ip)?.lastRequestAt ?? 0) < pending.firedAt)
      .sort((a, b) => Number(known(b.ip)) - Number(known(a.ip)))
      .slice(0, L.eventMaxPeers)
    for (const peer of candidates) {
      if (!this.enabled()) return
      await this.maybeNudge(peer, pending.trigger, status, at, 0)
    }
  }

  private async runSilent(at: number): Promise<void> {
    const L = TAILSCALE_NUDGE_LIMITS
    const meetingOpen = safe(this.activeMeetings, 0) > 0
    const silent: Array<[string, PeerTrack]> = []
    for (const [ip, t] of this.peers) {
      const expected = (t.lastAuthenticatedAt > 0 && at - t.lastAuthenticatedAt <= L.activeWindowMs)
        || (meetingOpen && t.lastMeetingChunkAt > 0 && at - t.lastMeetingChunkAt <= L.meetingWindowMs)
      // Only a peer the caps would let us nudge now: a status read for one we cannot nudge is waste.
      if (expected && at - t.lastRequestAt >= L.silenceMs && this.allowed(ip, at)) silent.push([ip, t])
    }
    if (silent.length === 0) return
    // Never on absence alone: only a peer that Tailscale itself reports Online is nudged.
    const status = await this.freshStatus(at)
    if (!status || status.backendState !== 'Running') return
    for (const [ip, t] of silent) {
      const peer = status.peers.find(p => p.ip === ip)
      if (!peer || !peer.online) continue
      if (!this.enabled()) return
      await this.maybeNudge(peer, 'silent', status, at, at - t.lastRequestAt)
    }
  }

  private allowed(ip: string, at: number): boolean {
    const L = TAILSCALE_NUDGE_LIMITS
    while (this.hourLog.length > 0 && at - this.hourLog[0] >= 3_600_000) this.hourLog.shift()
    if (this.hourLog.length >= L.maxPerHour) return false
    const t = this.peers.get(ip)
    if (!t || t.lastNudgeAt === 0) return true
    return at - t.lastNudgeAt >= Math.max(L.minIntervalMs, backoffMs(t.consecutive))
  }

  private async maybeNudge(peer: PeerStatus, trigger: NudgeTrigger, status: TailscaleStatus, at: number, silentMs: number): Promise<void> {
    if (!this.allowed(peer.ip, at)) return
    let track = this.peers.get(peer.ip)
    if (!track) {
      track = { lastRequestAt: 0, lastAuthenticatedAt: 0, lastMeetingChunkAt: 0, lastNudgeAt: 0, consecutive: 0 }
      this.peers.set(peer.ip, track)
      while (this.peers.size > TAILSCALE_NUDGE_LIMITS.maxTrackedPeers) this.peers.delete(this.peers.keys().next().value as string)
    }
    track.lastNudgeAt = at
    track.consecutive += 1
    this.hourLog.push(at)
    const bin = this.bin as string
    const disco = await this.runner(bin, DISCO_PING_ARGS(peer.ip), TAILSCALE_NUDGE_LIMITS.discoTimeoutMs)
    const outcome = classifyDiscoPing(disco)
    if (disco.spawnError === 'ENOENT') this.bin = null
    let dataPath: DataPathOutcome = 'skipped'
    let icmpMs = 0
    if (outcome === 'pong_direct' || outcome === 'pong_relay') {
      const icmp = await this.runner(bin, ICMP_PING_ARGS(peer.ip), TAILSCALE_NUDGE_LIMITS.icmpTimeoutMs)
      dataPath = classifyIcmpPing(icmp)
      icmpMs = icmp.elapsedMs
    }
    this.lastNudge = { at, ip: peer.ip, trigger, outcome, dataPath }
    const prev = this.previousStatus?.peers.find(p => p.ip === peer.ip)
    const rx = prev && this.previousStatus ? ` rxDelta=${peer.rxBytes - prev.rxBytes}/${Math.round((status.at - this.previousStatus.at) / 1000)}s` : ''
    const hs = peer.lastHandshakeMs > 0 ? ` handshakeAgeS=${Math.round((status.at - peer.lastHandshakeMs) / 1000)}` : ' handshakeAgeS=none'
    const failure = outcome === 'error' || outcome === 'timeout' || outcome === 'unavailable'
      ? ` code=${disco.code} signal=${disco.signal ?? 'none'} killed=${disco.killed}${disco.spawnError ? ` spawn=${disco.spawnError}` : ''}`
      : ''
    this.log(`[tailscale-nudge] trigger=${trigger} outcome=${outcome} dataPath=${dataPath} pingMs=${disco.elapsedMs} icmpMs=${icmpMs}`
      + `${silentMs > 0 ? ` silentS=${Math.round(silentMs / 1000)}` : ''}${hs}${rx} inRow=${track.consecutive} lastHour=${this.hourLog.length}${failure}`)
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

let singleton: TailscaleNudger | null = null
/** The server's nudger. Created on first use so /api/health can read it before start(). */
export function getTailscaleNudger(): TailscaleNudger {
  if (!singleton) singleton = new TailscaleNudger()
  return singleton
}
/** index.ts installs the server's nudger with its real meeting probe, before any request is noted. */
export function installTailscaleNudger(deps: TailscaleNudgeDeps = {}): TailscaleNudger {
  singleton?.stop()
  singleton = new TailscaleNudger(deps)
  return singleton
}
export function __setTailscaleNudgerForTests(nudger: TailscaleNudger | null): void {
  singleton = nudger
}
/** `{ tailscaleNudge }` for /api/health. Public route: no address, no peer name, counts and times only. */
export function tailscaleNudgeHealthField(): { tailscaleNudge: TailscaleNudgeHealth } {
  return { tailscaleNudge: getTailscaleNudger().health() }
}
