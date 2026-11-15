/**
 * 7.0.45 (U1; Miles 2026-11-14, plan relayed from his glasses 8:23 PM, confirmed in the lead session 20:46): Cursor's plan
 * usage, read the way Claude's is, with no model turn. Read through the same UsageMonitor (usage.ts): the same cache,
 * holds and breaker, and no timer unless COS_WORK_USAGE_POLL=1.
 *
 * OFF unless the server's environment says COS_CURSOR_PLAN_USAGE=1. Off means none of this runs: no Keychain read, no
 * network call, and Cursor reads "No plan reading" exactly as before. Reading his Cursor sign-in from the Keychain is a
 * credential read, so turning the switch on is a line Miles types.
 *
 * What the Mac asks the first time (the on-state words say so; no copy ever suggests a standing allow): macOS shows
 * "security wants to use your confidential information stored in \"cursor-access-token\" in your keychain", with his
 * login password. Saying no reads as "Cursor's sign-in was not shared with COS" and holds 10 minutes.
 *
 * The sign-in: `/usr/bin/security find-generic-password -s cursor-access-token -a cursor-user -w`, the same tool and
 * item the Mac app's Cursor feed reads (cos-control-macos HelperSources/SessionUsageCollector.swift). It runs with
 * execFile (no shell), HOME and PATH only, stderr dropped, killed by its PID at 15 seconds. The token is read at the
 * moment of the call and lives only in this function's memory: it is never logged, saved, thrown, put in argv or in a
 * child's environment. The copy in Cursor's state.vscdb is encrypted and is never opened.
 *
 * The reads: three Connect JSON POSTs, body {}, to one fixed host and three fixed methods (CURSOR_READS). Nothing else is
 * ever requested: no UseSandBankedReset, no write of any kind, and the cursor-agent TUI is never launched (its /usage
 * auto-updates the CLI). A redirect is not followed: it fails the read, so the sign-in never reaches another host.
 *
 * What the bar uses: the structured percentages only (planUsage.autoPercentUsed, apiPercentUsed, totalPercentUsed).
 * Cursor's displayMessage did not match them on 2026-11-14, so it is kept as a note and never drawn.
 *
 * Fixtures: no reply has been recorded yet (Miles's go covers building, not reading). The parser follows the shape he
 * saw on 2026-11-14 as relayed; the lead's first live read is the first real sample.
 */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { resolveProviderBinary } from '../provider-binary.js'
import { UsageProbeError, USAGE_PROBE_TIMEOUT_MS, type UsageReading, type UsageWindow } from './usage.js'

/** The switch. Only the exact string "1" turns it on. */
export function cursorPlanUsageOn(env: NodeJS.ProcessEnv = process.env): boolean { return env.COS_CURSOR_PLAN_USAGE === '1' }

// ─── The sign-in (Keychain) ───

/** The one Keychain command. The token is never in argv: only the item's service and account names are. */
export const CURSOR_KEYCHAIN_TOOL = '/usr/bin/security'
export const CURSOR_KEYCHAIN_ARGS = ['find-generic-password', '-s', 'cursor-access-token', '-a', 'cursor-user', '-w'] as const
export const CURSOR_KEYCHAIN_TIMEOUT_MS = 15_000

export interface ExecResult { code: number | null; stdout: string; timedOut: boolean }
export type ExecFn = (file: string, args: readonly string[], options: { env: Record<string, string>; timeoutMs: number }) => Promise<ExecResult>

const realExec: ExecFn = (file, args, options) => new Promise(resolve => {
  execFile(file, [...args], { env: options.env, timeout: options.timeoutMs, killSignal: 'SIGTERM', maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true },
    (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout), timedOut: false })
      // On any failure the output is dropped: it is never the token, and it is never kept.
      const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string }
      resolve({ code: typeof e.code === 'number' ? e.code : null, stdout: '', timedOut: e.killed === true && e.signal === 'SIGTERM' })
    })
})

/** The child's whole environment: HOME (the keychain search list) and a fixed PATH. Nothing of the server's. */
export function keychainEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { HOME: env.HOME ?? '', PATH: '/usr/bin:/bin' }
}

/** `security` exits with the low byte of its OSStatus (the Mac helper's reading): 44 errSecItemNotFound; 51 errSecAuthFailed
 *  and 128 errSecUserCanceled, a person saying no; 36 a locked keychain. Each fails closed with fixed words. */
export async function readCursorToken(exec: ExecFn = realExec, env: NodeJS.ProcessEnv = process.env, timeoutMs = CURSOR_KEYCHAIN_TIMEOUT_MS): Promise<string> {
  const r = await exec(CURSOR_KEYCHAIN_TOOL, CURSOR_KEYCHAIN_ARGS, { env: keychainEnv(env), timeoutMs })
  if (r.timedOut) throw new UsageProbeError('timed_out', 'Keychain read timed out')
  if (r.code === 44) throw new UsageProbeError('sign_in_missing', 'Cursor sign-in not found in the Keychain')
  // A person said no (Deny, or cancelled the prompt): said as that, never as a generic failure (lead 20:58).
  if (r.code === 51 || r.code === 128) throw new UsageProbeError('keychain_refused', "Cursor's sign-in was not shared with COS")
  if (r.code === 36) throw new UsageProbeError('keychain_locked', 'Keychain locked')
  if (r.code !== 0) throw new UsageProbeError('error', 'Keychain read failed')
  const token = r.stdout.trim()
  if (!token || /\s/.test(token)) throw new UsageProbeError('sign_in_missing', 'Cursor sign-in not found in the Keychain')
  return token
}

/** Reads only the expiry claim. A token that is not a JWT is left for Cursor to judge (a 401 then pauses as usual). */
export function jwtExpired(token: string, nowMs: number): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return typeof claims?.exp === 'number' && Number.isFinite(claims.exp) && claims.exp * 1000 <= nowMs
  } catch { return false }
}

/** The installed CLI's version, from its install folder name (…/cursor-agent/versions/2026.11.13-eacade1/cursor-agent).
 *  Never by running cursor-agent: it can update itself. */
export function cursorCliVersion(resolve: () => { ok: boolean; path?: string } = () => resolveProviderBinary('cursor') as { ok: boolean; path?: string },
  real: (p: string) => string = realpathSync): string | null {
  try {
    const bin = resolve()
    if (!bin.ok || !bin.path) return null
    const v = basename(dirname(real(bin.path)))
    return /^\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{6,40}$/.test(v) ? v : null
  } catch { return null }
}

// ─── The three reads (a fixed allowlist) ───

export const CURSOR_HOST = 'api2.cursor.sh'
export const CURSOR_SERVICE = 'aiserver.v1.DashboardService'
export const CURSOR_READS = ['GetCurrentPeriodUsage', 'GetPlanInfo', 'GetHardLimit'] as const
export type CursorRead = typeof CURSOR_READS[number]

/** The only URLs this module can build. Any other method throws here, before a request exists. */
export function cursorReadUrl(method: string): string {
  if (!(CURSOR_READS as readonly string[]).includes(method)) throw new UsageProbeError('error', 'unexpected error')
  return `https://${CURSOR_HOST}/${CURSOR_SERVICE}/${method}`
}

export function cursorHeaders(token: string, version: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    'x-cursor-client-type': 'cli',
    'x-cursor-client-version': version,
    'x-ghost-mode': 'true',
  }
}

export interface FetchInit { method: 'POST'; headers: Record<string, string>; body: string; redirect: 'manual'; signal: AbortSignal }
export interface FetchReply { status: number; type?: string; text(): Promise<string> }
export type FetchFn = (url: string, init: FetchInit) => Promise<FetchReply>

const MAX_REPLY_CHARS = 256 * 1024

async function cursorRead(fetchFn: FetchFn, method: CursorRead, token: string, version: string, signal: AbortSignal): Promise<unknown> {
  const url = cursorReadUrl(method)
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.host !== CURSOR_HOST) throw new UsageProbeError('error', 'unexpected error')
  const reply = await fetchFn(url, { method: 'POST', headers: cursorHeaders(token, version), body: '{}', redirect: 'manual', signal })
  if (reply.type === 'opaqueredirect' || (reply.status >= 300 && reply.status < 400)) throw new UsageProbeError('redirected', 'Cursor answered with a redirect')
  if (reply.status === 401 || reply.status === 403) throw new UsageProbeError('sign_in_expired', 'Cursor sign-in expired')
  if (reply.status !== 200) throw new UsageProbeError('http_error', `Cursor answered HTTP ${Number.isInteger(reply.status) && reply.status >= 100 && reply.status <= 999 ? reply.status : 0}`)
  const text = await reply.text()
  if (text.length > MAX_REPLY_CHARS) throw new UsageProbeError('unknown_shape', 'unknown Cursor usage shape')
  try { return JSON.parse(text) } catch { throw new UsageProbeError('unknown_shape', 'unknown Cursor usage shape') }
}

// ─── The parser ───

/** Connect JSON may send numbers as strings (int64). Anything else is not a number. */
const numberOf = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null)
const short = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

export interface CursorDetail {
  /** Cursor's own sentence. It did not match the percentages on 2026-11-14: a note only, never the bar. */
  displayMessage: string | null
  /** The models Cursor counts in the Auto bucket (Grok ids on 2026-11-14). */
  autoBucketModels: string[]
  periodStart: string | null
  includedSpendCents: number | null
  limitCents: number | null
  bonusSpendCents: number | null
  /** On-demand spending: its own line, never the plan bar. Units are as Cursor states them; not drawn until a live read
   *  confirms them. */
  onDemand: { hardLimit: number | null; individualRemaining: number | null } | null
}

const percent = (v: unknown): number | null | 'bad' => {
  if (v === undefined || v === null) return null
  const n = numberOf(v)
  return n === null || n < 0 || n > 100 ? 'bad' : n
}

/** GetCurrentPeriodUsage (+ GetPlanInfo, GetHardLimit when they answered) to a reading. Null, which fails the read closed,
 *  when the Auto or API percent is missing or any percent is outside 0 to 100. */
export function parseCursorUsage(usage: unknown, planInfo: unknown = null, hardLimit: unknown = null): (UsageReading & { cursor: CursorDetail }) | null {
  const u = obj(usage)
  const pu = obj(u?.planUsage)
  if (!u || !pu) return null
  const auto = percent(pu.autoPercentUsed), api = percent(pu.apiPercentUsed), total = percent(pu.totalPercentUsed)
  if (auto === 'bad' || api === 'bad' || total === 'bad' || auto === null || api === null) return null
  const endMs = numberOf(u.billingCycleEnd), startMs = numberOf(u.billingCycleStart)
  const resetsAt = endMs && endMs > 0 ? new Date(endMs).toISOString() : null
  const durationMins = startMs && endMs && endMs > startMs ? Math.round((endMs - startMs) / 60_000) : undefined
  const win = (kind: string, usedPct: number): UsageWindow => (durationMins ? { kind, usedPct, resetsAt, durationMins } : { kind, usedPct, resetsAt })
  const windows: UsageWindow[] = [win('auto', auto), win('api', api)]
  if (total !== null) windows.push(win('included', total))
  const p = obj(planInfo)
  const plan = short(p?.planName, 60) ?? short(obj(p?.planInfo)?.planName, 60) ?? null
  const h = obj(hardLimit)
  const models = Array.isArray(u.autoBucketModels) ? u.autoBucketModels.filter((m: unknown): m is string => typeof m === 'string' && m.length <= 100).slice(0, 50) : []
  const cursor: CursorDetail = {
    displayMessage: short(u.displayMessage, 200),
    autoBucketModels: models,
    periodStart: startMs && startMs > 0 ? new Date(startMs).toISOString() : null,
    includedSpendCents: numberOf(pu.includedSpend), limitCents: numberOf(pu.limit), bonusSpendCents: numberOf(pu.bonusSpend),
    onDemand: h ? { hardLimit: numberOf(h.hardLimit), individualRemaining: numberOf(h.individualRemaining) } : null,
  }
  return { plan, windows, allowed: null, available: true, cursor }
}

/** Which bucket a model paces on: an Auto-bucket model (Grok, or any id Cursor lists in autoBucketModels) on Auto, a
 *  named API model on API. */
export function cursorBucketFor(model: string, reading: UsageReading | null | undefined): 'auto' | 'api' {
  const listed = (reading as { cursor?: CursorDetail } | null | undefined)?.cursor?.autoBucketModels ?? []
  return listed.includes(model) || /^grok/i.test(model) ? 'auto' : 'api'
}

// ─── The probe ───

export interface CursorProbeDeps { exec?: ExecFn; fetch?: FetchFn; version?: () => string | null; now?: () => number; env?: NodeJS.ProcessEnv; timeoutMs?: number }

/** One read. Every failure is a UsageProbeError with fixed words (usage.ts keeps them on the safe list); the token is
 *  in none of them. The caller (UsageMonitor.refresh) holds 10 minutes after any failure and pauses an hour after three. */
export async function probeCursorUsage(deps: CursorProbeDeps = {}): Promise<UsageReading> {
  const env = deps.env ?? process.env
  if (!cursorPlanUsageOn(env)) throw new UsageProbeError('error', 'unexpected error') // never reached: the monitor checks first
  const version = (deps.version ?? (() => cursorCliVersion()))()
  if (!version) throw new UsageProbeError('not_found', 'Cursor CLI not found')
  const token = await readCursorToken(deps.exec ?? realExec, env)
  if (jwtExpired(token, (deps.now ?? Date.now)())) throw new UsageProbeError('sign_in_expired', 'Cursor sign-in expired')
  const fetchFn: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchReply>)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? USAGE_PROBE_TIMEOUT_MS)
  timer.unref?.()
  try {
    const usage = await cursorRead(fetchFn, 'GetCurrentPeriodUsage', token, version, ctl.signal)
    // The plan name and the on-demand limit are extras: if either fails, the bar still draws without it.
    const planInfo = await cursorRead(fetchFn, 'GetPlanInfo', token, version, ctl.signal).catch(() => null)
    const hardLimit = await cursorRead(fetchFn, 'GetHardLimit', token, version, ctl.signal).catch(() => null)
    const reading = parseCursorUsage(usage, planInfo, hardLimit)
    if (!reading) throw new UsageProbeError('unknown_shape', 'unknown Cursor usage shape')
    return reading
  } catch (error) {
    if (ctl.signal.aborted) throw new UsageProbeError('timed_out', 'timed out')
    if (error instanceof UsageProbeError) throw error
    throw new UsageProbeError('error', 'unexpected error') // a network error's own text is never kept
  } finally { clearTimeout(timer) }
}
