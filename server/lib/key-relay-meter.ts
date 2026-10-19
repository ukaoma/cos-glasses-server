// Key lanes K1 P2 (plan v4 4.5): the per-key spend counter and its reservations.
//
// ONE counter per key ref, shared by every profile on that key, every parallel turn, hooks, the
// in-process direct lane (P5) and K3. reserve() is synchronous, so two parallel requests can never
// both pass a check that only one of them fits under: JavaScript runs one reserve at a time.
//
//   spent today = max(local settled, OpenRouter usage_daily) + open reservations
//   reserve     = body bytes / 4 at the input price + min(max_tokens, 4096) at the output price
//   refuse      when spent today + reserve > cap
//   settle      replaces the reservation with the measured cost (stream usage times price, or the
//               provider's own `usage.cost` when it sends one)
//
// The day is the UTC day, matching OpenRouter usage_daily. Overshoot is bounded by responses
// already streaming when the cap is reached; the OpenRouter key's own credit limit is the hard
// backstop. Nothing here starts a timer or opens a socket, and nothing is written until the first
// reservation.
import { randomBytes } from 'node:crypto'
import { getPublicKey } from './key-store.js'
import type { KeyLane, KeyMeter, KeyRef } from './key-relay-contract.js'
import { appendKeyLedgerRow, ledgerSpentUsd, utcDay } from './key-ledger.js'
import { KEY_CATALOG_CURATED } from './key-catalog.js'

export interface ModelPrice {
  inUsdPerM: number
  outUsdPerM: number
}

/**
 * A model COS has no price for is metered as if it were the most expensive Claude tier, so an
 * unknown price can only make the cap stricter, never looser.
 */
export const FALLBACK_PRICE: ModelPrice = { inUsdPerM: 15, outUsdPerM: 75 }
export const RESERVE_MAX_OUTPUT_TOKENS = 4096
export const BYTES_PER_TOKEN_ESTIMATE = 4
/** Turns whose settled spend the meter remembers (oldest dropped first). */
export const TURN_SPEND_MAX = 512

/** Curated prices (plan D10), then the fallback. P5's live catalog can be passed in instead. */
export function defaultPriceFor(model: string): ModelPrice {
  const curated = KEY_CATALOG_CURATED.find(m => m.id === model)
  return curated ? { inUsdPerM: curated.inUsdPerM, outUsdPerM: curated.outUsdPerM } : FALLBACK_PRICE
}

export function tokensToUsd(tokens: { input: number; output: number }, price: ModelPrice): number {
  return (Math.max(0, tokens.input) * price.inUsdPerM + Math.max(0, tokens.output) * price.outUsdPerM) / 1e6
}

/** Plan 4.5 reserve: input estimate plus min(max_tokens, 4096) output. A missing max_tokens reserves 4096. */
export function estimateReserveUsd(input: { bodyBytes: number; maxTokens?: number | null; price: ModelPrice }): number {
  const inTokens = Math.ceil(Math.max(0, input.bodyBytes) / BYTES_PER_TOKEN_ESTIMATE)
  const mt = typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0 ? input.maxTokens : RESERVE_MAX_OUTPUT_TOKENS
  const outTokens = Math.min(mt, RESERVE_MAX_OUTPUT_TOKENS)
  return tokensToUsd({ input: inTokens, output: outTokens }, input.price)
}

interface Reservation {
  keyRef: KeyRef
  turnId: string
  profile: string
  lane: KeyLane
  usd: number
}

interface DaySpend {
  day: string
  settledUsd: number
  usageDailyUsd?: number
}

export interface ReserveInput {
  keyRef: KeyRef
  turnId: string
  estimateUsd: number
  /** Ledger detail; the contract's KeyMeter.reserve leaves them out. */
  profile?: string
  lane?: KeyLane
  tokens?: { input: number; output: number }
}

export type ReserveResult = { ok: true; reservationId: string } | { ok: false; spentTodayUsd: number; capUsd: number }

export interface KeyRelayMeterOptions {
  now?: () => number
  /** The key's daily cap, or null when the key is gone (refuse). Default: the key store. */
  capUsd?: (keyRef: KeyRef) => number | null
  /** Ledger writer. Default: data/key-ledger.jsonl. */
  appendRow?: typeof appendKeyLedgerRow
  /** Settled spend already on disk for a key and UTC day. Default: the ledger file. */
  loadSettled?: (keyRef: KeyRef, day: string) => number
  log?: (line: string) => void
}

export class KeyRelayMeter implements KeyMeter {
  private readonly now: () => number
  private readonly capOf: (keyRef: KeyRef) => number | null
  private readonly append: typeof appendKeyLedgerRow
  private readonly loadSettled: (keyRef: KeyRef, day: string) => number
  private readonly log: (line: string) => void
  private readonly days = new Map<KeyRef, DaySpend>()
  private readonly reservations = new Map<string, Reservation>()
  /** P11: settled spend per turn id (newest TURN_SPEND_MAX), so a keyed answer can carry its cost. */
  private readonly turnSpend = new Map<string, number>()
  /** P11 (plan 4.5 "Cap value"): the cap Control last saved per key, this boot. */
  private readonly savedCaps = new Map<KeyRef, number>()
  private readonly capMismatchLogged = new Set<KeyRef>()

  constructor(options: KeyRelayMeterOptions = {}) {
    this.now = options.now ?? Date.now
    this.capOf = options.capUsd ?? (ref => getPublicKey(ref)?.capUsd ?? null)
    this.append = options.appendRow ?? appendKeyLedgerRow
    this.loadSettled = options.loadSettled ?? ((ref, day) => ledgerSpentUsd(ref, day))
    this.log = options.log ?? (line => console.warn(line))
  }

  private today(keyRef: KeyRef): DaySpend {
    const day = utcDay(this.now())
    let d = this.days.get(keyRef)
    if (!d || d.day !== day) {
      let settledUsd = 0
      try { settledUsd = this.loadSettled(keyRef, day) } catch { settledUsd = 0 }
      d = { day, settledUsd }
      this.days.set(keyRef, d)
    }
    return d
  }

  private write(row: Parameters<typeof appendKeyLedgerRow>[0]): void {
    try { this.append(row) } catch (err) {
      // The in-memory counter still holds the spend; only the audit row is lost.
      this.log(`[key-relay] ledger write skipped: ${(err as Error)?.name ?? 'error'}`)
    }
  }

  capUsd(keyRef: KeyRef): number | null {
    const raw = this.capOf(keyRef)
    const cap = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    // A key that is gone always refuses, whatever was saved before.
    if (cap === null) return null
    // Plan 4.5: the server keeps Control's last saved value. A cap that changed in the file by any
    // other path (a Lane A turn editing provider-keys.json) is ignored and logged once. The first
    // value seen this boot is the baseline until Control saves one.
    const saved = this.savedCaps.get(keyRef)
    if (saved === undefined) {
      this.savedCaps.set(keyRef, cap)
      return cap
    }
    if (saved !== cap && !this.capMismatchLogged.has(keyRef)) {
      this.capMismatchLogged.add(keyRef)
      this.log(`[key-relay] cap for ${keyRef} changed outside COS Control; keeping the saved cap`)
    }
    return saved
  }

  /** P11: the key-lanes routes call this when COS Control saves a key or changes its cap. */
  noteSavedCap(keyRef: KeyRef, capUsd: number): void {
    if (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd <= 0) return
    this.savedCaps.set(keyRef, capUsd)
    this.capMismatchLogged.delete(keyRef)
  }

  /** P11: what this turn has settled so far on any key (0 when nothing settled). */
  turnSettledUsd(turnId: string): number {
    return this.turnSpend.get(turnId) ?? 0
  }

  private addTurnSpend(turnId: string, usd: number): void {
    if (!turnId) return
    const prior = this.turnSpend.get(turnId) ?? 0
    this.turnSpend.delete(turnId)
    this.turnSpend.set(turnId, prior + usd)
    while (this.turnSpend.size > TURN_SPEND_MAX) {
      const oldest = this.turnSpend.keys().next().value
      if (oldest === undefined) break
      this.turnSpend.delete(oldest)
    }
  }

  openReservationsUsd(keyRef: KeyRef): number {
    let sum = 0
    for (const r of this.reservations.values()) if (r.keyRef === keyRef) sum += r.usd
    return sum
  }

  /** Plan 4.5: max(local ledger, usage_daily) plus open reservations. */
  spentTodayUsd(keyRef: KeyRef): number {
    const d = this.today(keyRef)
    return Math.max(d.settledUsd, d.usageDailyUsd ?? 0) + this.openReservationsUsd(keyRef)
  }

  /** OpenRouter's usage_daily for this key (read at turn start and while a turn runs). */
  observeUsageDaily(keyRef: KeyRef, usd: number): void {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return
    const d = this.today(keyRef)
    d.usageDailyUsd = Math.max(d.usageDailyUsd ?? 0, usd)
  }

  /** True when the key has nothing left under its cap today (refuse a turn before spawn). */
  atCap(keyRef: KeyRef): boolean {
    const cap = this.capUsd(keyRef)
    return cap === null || this.spentTodayUsd(keyRef) >= cap
  }

  reserve(input: ReserveInput): ReserveResult {
    const cap = this.capUsd(input.keyRef)
    const spent = this.spentTodayUsd(input.keyRef)
    const estimate = Number.isFinite(input.estimateUsd) && input.estimateUsd > 0 ? input.estimateUsd : 0
    if (cap === null || spent + estimate > cap) {
      return { ok: false, spentTodayUsd: spent, capUsd: cap ?? 0 }
    }
    const reservationId = `res_${randomBytes(9).toString('base64url')}`
    const r: Reservation = { keyRef: input.keyRef, turnId: input.turnId, profile: input.profile ?? '', lane: input.lane ?? 'key', usd: estimate }
    this.reservations.set(reservationId, r)
    this.write({
      ts: new Date(this.now()).toISOString(), keyRef: r.keyRef, profile: r.profile, lane: r.lane, turnId: r.turnId,
      tokens: input.tokens ?? { input: 0, output: 0 }, usd: estimate, kind: 'reserve',
    })
    return { ok: true, reservationId }
  }

  settle(input: { reservationId: string; usd: number; tokens: { input: number; output: number }; generationId?: string }): void {
    const r = this.reservations.get(input.reservationId)
    if (!r) return
    this.reservations.delete(input.reservationId)
    const usd = Number.isFinite(input.usd) && input.usd > 0 ? input.usd : 0
    this.today(r.keyRef).settledUsd += usd
    this.addTurnSpend(r.turnId, usd)
    this.write({
      ts: new Date(this.now()).toISOString(), keyRef: r.keyRef, profile: r.profile, lane: r.lane, turnId: r.turnId,
      ...(input.generationId ? { generationId: input.generationId } : {}),
      tokens: input.tokens, usd, kind: 'settle',
    })
  }

  /** Settle at the full reserved amount (no usage arrived). */
  settleReserved(reservationId: string, tokens: { input: number; output: number } = { input: 0, output: 0 }, generationId?: string): void {
    const r = this.reservations.get(reservationId)
    if (!r) return
    this.settle({ reservationId, usd: r.usd, tokens, ...(generationId ? { generationId } : {}) })
  }

  /** The reserved amount of an open reservation, or null. */
  reservedUsd(reservationId: string): number | null {
    return this.reservations.get(reservationId)?.usd ?? null
  }

  /** Later correction from the provider's own generation cost (plan 4.5 reconcile). */
  reconcile(input: { keyRef: KeyRef; turnId: string; profile: string; lane: KeyLane; generationId: string; deltaUsd: number; tokens: { input: number; output: number } }): void {
    if (!Number.isFinite(input.deltaUsd) || input.deltaUsd === 0) return
    const d = this.today(input.keyRef)
    d.settledUsd = Math.max(0, d.settledUsd + input.deltaUsd)
    this.write({
      ts: new Date(this.now()).toISOString(), keyRef: input.keyRef, profile: input.profile, lane: input.lane, turnId: input.turnId,
      generationId: input.generationId, tokens: input.tokens, usd: input.deltaUsd, kind: 'reconcile',
    })
  }

  /** Drop every in-memory number (Remove all keys). The ledger file is the route's to delete. */
  clear(): void {
    this.days.clear()
    this.reservations.clear()
    this.turnSpend.clear()
    this.savedCaps.clear()
    this.capMismatchLogged.clear()
  }
}

let shared: KeyRelayMeter | null = null

/** The one meter the relay, the direct lane (P5) and K3 share. Created on first use. */
export function getSharedKeyMeter(): KeyRelayMeter {
  if (!shared) shared = new KeyRelayMeter()
  return shared
}

/** Tests only. */
export function __resetSharedKeyMeterForTests(): void {
  shared = null
}
