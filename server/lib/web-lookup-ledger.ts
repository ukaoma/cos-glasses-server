// An honest daily count of every public web lookup COS makes, by feature, and of every lookup it held back and why.
//
// WHY. The settings line "Today: N topic checks, N web searches" counts only the general cues. The meeting assistant and the
// fact check also search and read pages, and nothing counted them, so the number read as the whole story when it was a part.
// This ledger is written where each lookup actually happens (searchMeetingWeb for a search, the page reader for a page, the
// gate that refuses for a withheld one), never inferred from a result or a log.
//
// It is a LEDGER, not a gate. No code path waits on it or is refused by it, and recording never throws: a lookup that cannot
// be counted still runs. The file is local-day keyed like the general cue state (same zone and rollover rule): a new local day
// starts from zero, a day in the future (a clock set back) is not trusted. A file that cannot be read says so in the view
// (`readable: false`) instead of reading as zero, and a corrupt one is moved aside so counting resumes the next time.
import { readFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

export type WebFeature = 'cues' | 'ask' | 'factCheck'
export const WEB_FEATURES: readonly WebFeature[] = ['cues', 'ask', 'factCheck']
/** Distinct withheld reasons kept per feature; the rest count under 'other' so a bad caller cannot grow the file. */
export const WEB_LEDGER_MAX_REASONS = 40

/** `pagesRead` is pages whose text was used; `pagesFailed` is page fetches that were attempted and returned nothing (blocked, too big, not an article, too slow). */
export interface WebFeatureToday { searches: number; pagesRead: number; pagesFailed: number }
export interface WebTodayView {
  day: string
  /** False when the file could not be read: the counts below are then zero and do not describe today. */
  readable: boolean
  cues: WebFeatureToday
  ask: WebFeatureToday
  factCheck: WebFeatureToday
  withheld: { total: number; byReason: Record<string, number>; byFeature: Record<WebFeature, number> }
}

interface FeatureState { searches: number; pagesRead: number; pagesFailed: number; withheld: Record<string, number> }
interface LedgerState { v: 1; zone: string; day: string; features: Record<WebFeature, FeatureState> }
type LedgerRead = { ok: true; state: LedgerState } | { ok: false; future: boolean }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
function validZone(zone: unknown): string | null {
  if (typeof zone !== 'string' || !zone) return null
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); return zone } catch { return null }
}
/** Local calendar day in `zone`. Intl, never toISOString: a UTC key flips the day at 19:00 Central (the rule live-cues-general.ts follows). */
function localDay(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}
const emptyFeature = (): FeatureState => ({ searches: 0, pagesRead: 0, pagesFailed: 0, withheld: {} })
const REASON = /^[a-z0-9][a-z0-9_:.-]{0,47}$/

export class WebLookupLedger {
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}
  private systemZone(): string { return validZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC' }
  private fresh(nowMs: number): LedgerState {
    const zone = this.systemZone()
    return { v: 1, zone, day: localDay(nowMs, zone), features: { cues: emptyFeature(), ask: emptyFeature(), factCheck: emptyFeature() } }
  }
  private read(): LedgerRead {
    const nowMs = this.now()
    let raw: unknown
    try { raw = JSON.parse(readFileSync(this.file, 'utf8')) } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, state: this.fresh(nowMs) }
      return { ok: false, future: false }
    }
    if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.features)) return { ok: false, future: false }
    const zone = validZone(raw.zone), today = zone ? localDay(nowMs, zone) : ''
    if (!zone || typeof raw.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day)) return { ok: false, future: false }
    if (raw.day > today) return { ok: false, future: true }
    const rolled = raw.day < today
    const features = {} as Record<WebFeature, FeatureState>
    for (const f of WEB_FEATURES) {
      const s = raw.features[f]
      // pagesFailed arrived after the first files were written: a file without it reads as zero.
      if (!isRecord(s) || !whole(s.searches) || !whole(s.pagesRead) || !(s.pagesFailed === undefined || whole(s.pagesFailed)) || !isRecord(s.withheld)) return { ok: false, future: false }
      const withheld: Record<string, number> = {}
      for (const [reason, n] of Object.entries(s.withheld)) {
        if (!whole(n) || !REASON.test(reason)) return { ok: false, future: false }
        withheld[reason] = n
      }
      features[f] = rolled ? emptyFeature() : { searches: s.searches, pagesRead: s.pagesRead, pagesFailed: (s.pagesFailed as number | undefined) ?? 0, withheld }
    }
    return { ok: true, state: { v: 1, zone, day: today, features } }
  }
  private write(s: LedgerState): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      durableAtomicWriteFileSync(this.file, JSON.stringify(s) + '\n', { mode: 0o600 })
      return true
    } catch { return false }
  }
  /** One read-modify-write. A file that cannot be parsed is moved aside once so counting resumes; a future day is left alone
   *  (the day catches up) and nothing is counted until then. Never throws. */
  private update(change: (s: LedgerState) => void): boolean {
    try {
      let r = this.read()
      if (!r.ok && !r.future) {
        try { renameSync(this.file, `${this.file}.unreadable`) } catch { return false }
        r = this.read()
      }
      if (!r.ok) return false
      change(r.state)
      return this.write(r.state)
    } catch { return false }
  }
  /** One web search is starting now. */
  search(feature: WebFeature): boolean { return this.update(s => { s.features[feature].searches += 1 }) }
  /** `count` result or pasted pages were read. */
  pagesRead(feature: WebFeature, count = 1): boolean {
    if (!whole(count) || count === 0) return false
    return this.update(s => { s.features[feature].pagesRead += count })
  }
  /** `count` page fetches were attempted and returned nothing. */
  pagesFailed(feature: WebFeature, count = 1): boolean {
    if (!whole(count) || count === 0) return false
    return this.update(s => { s.features[feature].pagesFailed += count })
  }
  /** One lookup was proposed and refused, for `reason` (a gate reason code such as no_public_intent). */
  withheld(feature: WebFeature, reason: string): boolean {
    const key = REASON.test(reason) ? reason : 'other'
    return this.update(s => {
      const w = s.features[feature].withheld
      const name = key in w || Object.keys(w).length < WEB_LEDGER_MAX_REASONS ? key : 'other'
      w[name] = (w[name] ?? 0) + 1
    })
  }
  today(): WebTodayView {
    const r = this.read()
    const zeros = (): WebTodayView => ({ day: localDay(this.now(), this.systemZone()), readable: false, cues: { searches: 0, pagesRead: 0, pagesFailed: 0 }, ask: { searches: 0, pagesRead: 0, pagesFailed: 0 }, factCheck: { searches: 0, pagesRead: 0, pagesFailed: 0 },
      withheld: { total: 0, byReason: {}, byFeature: { cues: 0, ask: 0, factCheck: 0 } } })
    if (!r.ok) return zeros()
    const f = r.state.features
    const byReason: Record<string, number> = {}
    const byFeature = {} as Record<WebFeature, number>
    for (const name of WEB_FEATURES) {
      byFeature[name] = Object.values(f[name].withheld).reduce((a, b) => a + b, 0)
      for (const [reason, n] of Object.entries(f[name].withheld)) byReason[reason] = (byReason[reason] ?? 0) + n
    }
    const view = (s: FeatureState): WebFeatureToday => ({ searches: s.searches, pagesRead: s.pagesRead, pagesFailed: s.pagesFailed })
    return { day: r.state.day, readable: true, cues: view(f.cues), ask: view(f.ask), factCheck: view(f.factCheck),
      withheld: { total: WEB_FEATURES.reduce((n, name) => n + byFeature[name], 0), byReason, byFeature } }
  }
}

let shared: WebLookupLedger | null = null
/** The server's one ledger, in the data dir. Created on first use so importing this file touches nothing. */
export function webLedger(): WebLookupLedger {
  if (!shared) shared = new WebLookupLedger(dataPath('web-lookup-ledger.json'))
  return shared
}
/** Tests only: replace (or clear, with null) the shared ledger. */
export function setWebLedgerForTests(ledger: WebLookupLedger | null): void { shared = ledger }
