// Key lanes P2 (plan v4 4.5): the per-key meter, reservations, the UTC day and the spend ledger.
// Runs on a private temp data dir; never the live ~/.cos-glasses.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'key-relay-meter-'))
process.env.COS_DATA_DIR = dataDir

const ledger = await import('./key-ledger.js')
const meterMod = await import('./key-relay-meter.js')
const { CURATED_KEY_MODELS } = await import('../routes/key-lanes.js')

const REF = 'key_0123456789ab'
const REF2 = 'key_ba9876543210'
const DAY0 = Date.parse('2026-10-19T12:00:00Z')

function wipe() {
  for (const f of readdirSync(dataDir)) rmSync(join(dataDir, f), { recursive: true, force: true })
}
beforeEach(wipe)
afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

function meter(cap = 1, now = () => DAY0) {
  return new meterMod.KeyRelayMeter({ now, capUsd: ref => (ref === REF || ref === REF2 ? cap : null) })
}

describe('key relay meter (plan 4.5)', () => {
  it('reserve refuses when spent plus the estimate exceeds the cap', () => {
    const m = meter(0.05)
    const a = m.reserve({ keyRef: REF, turnId: 't1', estimateUsd: 0.03 })
    expect(a.ok).toBe(true)
    const b = m.reserve({ keyRef: REF, turnId: 't1', estimateUsd: 0.03 })
    expect(b).toEqual({ ok: false, spentTodayUsd: 0.03, capUsd: 0.05 })
    expect(m.spentTodayUsd(REF)).toBeCloseTo(0.03)
  })

  it('one counter per key, shared by every profile and turn on it; other keys are separate', () => {
    const m = meter(0.05)
    expect(m.reserve({ keyRef: REF, turnId: 'a', estimateUsd: 0.02, profile: 'p1' }).ok).toBe(true)
    expect(m.reserve({ keyRef: REF, turnId: 'b', estimateUsd: 0.02, profile: 'p2' }).ok).toBe(true)
    expect(m.reserve({ keyRef: REF, turnId: 'c', estimateUsd: 0.02, profile: 'p3' }).ok).toBe(false)
    expect(m.reserve({ keyRef: REF2, turnId: 'd', estimateUsd: 0.02 }).ok).toBe(true)
  })

  it('settle replaces the reservation with the measured cost', () => {
    const m = meter()
    const r = m.reserve({ keyRef: REF, turnId: 't', estimateUsd: 0.5 })
    if (!r.ok) throw new Error('reserve')
    m.settle({ reservationId: r.reservationId, usd: 0.01, tokens: { input: 10, output: 5 } })
    expect(m.spentTodayUsd(REF)).toBeCloseTo(0.01)
    m.settle({ reservationId: r.reservationId, usd: 9, tokens: { input: 0, output: 0 } })
    expect(m.spentTodayUsd(REF)).toBeCloseTo(0.01)
  })

  it('spent today is max(local, usage_daily) plus open reservations', () => {
    const m = meter()
    const r = m.reserve({ keyRef: REF, turnId: 't', estimateUsd: 0.1 })
    if (!r.ok) throw new Error('reserve')
    m.settle({ reservationId: r.reservationId, usd: 0.1, tokens: { input: 1, output: 1 } })
    m.observeUsageDaily(REF, 0.4)
    expect(m.spentTodayUsd(REF)).toBeCloseTo(0.4)
    m.reserve({ keyRef: REF, turnId: 't', estimateUsd: 0.2 })
    expect(m.spentTodayUsd(REF)).toBeCloseTo(0.6)
    m.observeUsageDaily(REF, 0.05)
    expect(m.spentTodayUsd(REF)).toBeCloseTo(0.6)
  })

  it('a key with no cap (gone from the store) is refused', () => {
    const m = new meterMod.KeyRelayMeter({ now: () => DAY0, capUsd: () => null })
    expect(m.reserve({ keyRef: REF, turnId: 't', estimateUsd: 0 }).ok).toBe(false)
    expect(m.atCap(REF)).toBe(true)
  })

  it('the day is the UTC day: spend resets at UTC midnight', () => {
    let now = Date.parse('2026-10-19T23:59:00Z')
    const m = meter(1, () => now)
    const r = m.reserve({ keyRef: REF, turnId: 't', estimateUsd: 0.5 })
    if (!r.ok) throw new Error('reserve')
    m.settle({ reservationId: r.reservationId, usd: 0.9, tokens: { input: 1, output: 1 } })
    m.observeUsageDaily(REF, 0.95)
    expect(m.atCap(REF)).toBe(false)
    expect(m.spentTodayUsd(REF)).toBeCloseTo(0.95)
    now = Date.parse('2026-10-20T00:00:01Z')
    expect(m.spentTodayUsd(REF)).toBe(0)
  })

  it('a restarted meter reads today settled spend back from the ledger', () => {
    const a = meter()
    const r = a.reserve({ keyRef: REF, turnId: 't', estimateUsd: 0.3 })
    if (!r.ok) throw new Error('reserve')
    a.settle({ reservationId: r.reservationId, usd: 0.25, tokens: { input: 100, output: 50 } })
    a.reconcile({ keyRef: REF, turnId: 't', profile: 'p', lane: 'key', generationId: 'gen-1', deltaUsd: 0.05, tokens: { input: 100, output: 50 } })
    const b = meter()
    expect(b.spentTodayUsd(REF)).toBeCloseTo(0.3)
    const tomorrow = meter(1, () => DAY0 + 24 * 3600_000)
    expect(tomorrow.spentTodayUsd(REF)).toBe(0)
  })

  it('estimates: body bytes / 4 at the input price plus min(max_tokens, 4096) at the output price', () => {
    const price = { inUsdPerM: 2, outUsdPerM: 10 }
    expect(meterMod.estimateReserveUsd({ bodyBytes: 4000, maxTokens: 100, price })).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6)
    expect(meterMod.estimateReserveUsd({ bodyBytes: 0, maxTokens: 64000, price })).toBeCloseTo(4096 * 10 / 1e6)
    expect(meterMod.estimateReserveUsd({ bodyBytes: 0, maxTokens: null, price })).toBeCloseTo(4096 * 10 / 1e6)
  })

  it('prices the curated models from the catalog list and anything else at the fallback', () => {
    for (const c of CURATED_KEY_MODELS) expect(meterMod.defaultPriceFor(c.id)).toEqual({ inUsdPerM: c.inUsdPerM, outUsdPerM: c.outUsdPerM })
    expect(meterMod.defaultPriceFor('anthropic/unknown')).toEqual(meterMod.FALLBACK_PRICE)
  })

  it('creates nothing on disk until the first reservation', () => {
    const m = meter()
    expect(m.spentTodayUsd(REF)).toBe(0)
    expect(m.atCap(REF)).toBe(false)
    expect(readdirSync(dataDir)).toEqual([])
  })
})

describe('key spend ledger (plan 4.5)', () => {
  it('appends 0600 rows with known fields only', () => {
    const m = meter()
    const r = m.reserve({ keyRef: REF, turnId: 't', estimateUsd: 0.01, profile: 'sonnet', lane: 'key' })
    if (!r.ok) throw new Error('reserve')
    m.settle({ reservationId: r.reservationId, usd: 0.004, tokens: { input: 12, output: 3 }, generationId: 'gen-9' })
    const file = ledger.keyLedgerPath()
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const rows = ledger.readKeyLedger()
    expect(rows.map(x => x.kind)).toEqual(['reserve', 'settle'])
    expect(Object.keys(rows[1]).sort()).toEqual(['generationId', 'keyRef', 'kind', 'lane', 'profile', 'tokens', 'ts', 'turnId', 'usd'])
    expect(rows[1]).toMatchObject({ keyRef: REF, profile: 'sonnet', lane: 'key', turnId: 't', usd: 0.004, tokens: { input: 12, output: 3 }, generationId: 'gen-9' })
  })

  it('drops any extra field a caller passes, so nothing else can ride along', () => {
    ledger.appendKeyLedgerRow({ ts: '2026-10-19T00:00:00.000Z', keyRef: REF, profile: 'p', lane: 'key', turnId: 't', tokens: { input: 0, output: 0 }, usd: 0, kind: 'settle', secret: 'sk-or-v1-leak' } as never)
    expect(readFileSync(ledger.keyLedgerPath(), 'utf8')).not.toContain('sk-or-v1-leak')
    expect(() => ledger.appendKeyLedgerRow({ ts: '', keyRef: 'not-a-ref', profile: '', lane: 'key', turnId: '', tokens: { input: 0, output: 0 }, usd: 0, kind: 'settle' })).toThrow()
  })

  it('refuses to write through a symlink and skips a torn line', () => {
    const target = join(dataDir, 'elsewhere.jsonl')
    writeFileSync(target, '')
    symlinkSync(target, ledger.keyLedgerPath())
    expect(() => ledger.appendKeyLedgerRow({ ts: '2026-10-19T00:00:00.000Z', keyRef: REF, profile: 'p', lane: 'key', turnId: 't', tokens: { input: 0, output: 0 }, usd: 1, kind: 'settle' })).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('')
    rmSync(ledger.keyLedgerPath())
    writeFileSync(ledger.keyLedgerPath(), '{"torn\n' + JSON.stringify({ ts: '2026-10-19T01:00:00.000Z', keyRef: REF, profile: 'p', lane: 'key', turnId: 't', tokens: { input: 0, output: 0 }, usd: 0.2, kind: 'settle' }) + '\n')
    expect(ledger.ledgerSpentUsd(REF, '2026-10-19')).toBeCloseTo(0.2)
    expect(ledger.ledgerSpentUsd(REF, '2026-10-20')).toBe(0)
  })

  it('reading a missing ledger creates nothing', () => {
    expect(ledger.readKeyLedger()).toEqual([])
    expect(ledger.ledgerSpentUsd(REF, '2026-10-19')).toBe(0)
    expect(existsSync(ledger.keyLedgerPath())).toBe(false)
  })
})
