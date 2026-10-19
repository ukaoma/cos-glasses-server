// Key lanes K1, P11 QA fixes on the spend ledger: W3 (open reservations count after a restart)
// and W6 (no write through a symlink). Scratch COS_DATA_DIR before any import (importing runs it).
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

process.env.COS_DATA_DIR = mkdtempSync(join(tmpdir(), 'kl-ledger-data-'))
describe('QA W3: a reservation no settle answered still counts after a restart', () => {
  it('counts an open reserve row, answers reserves in order per turn, and ignores another key or day', async () => {
    const { ledgerSpentUsd, appendKeyLedgerRow } = await import('./key-ledger.js')
    const dir = mkdtempSync(join(tmpdir(), 'kl-w3-'))
    const file = join(dir, 'key-ledger.jsonl')
    const row = (kind: 'reserve' | 'settle' | 'reconcile', usd: number, turnId: string, keyRef = 'key_0123456789ab', ts = '2026-10-19T10:00:00.000Z') =>
      appendKeyLedgerRow({ ts, keyRef, profile: 'p', lane: 'key', turnId, tokens: { input: 0, output: 0 }, usd, kind }, file)
    row('reserve', 0.1, 't1'); row('settle', 0.04, 't1')          // answered: counts 0.04
    row('reserve', 0.2, 't2'); row('reserve', 0.3, 't2'); row('settle', 0.05, 't2') // second still open: 0.05 + 0.3
    row('reserve', 0.25, 't3')                                    // crash mid-stream: 0.25
    row('reconcile', 0.01, 't1')
    row('reserve', 5, 't4', 'key_000000000000')                   // another key
    row('reserve', 5, 't5', 'key_0123456789ab', '2026-10-18T10:00:00.000Z') // another day
    expect(ledgerSpentUsd('key_0123456789ab', '2026-10-19', file)).toBeCloseTo(0.04 + 0.05 + 0.3 + 0.25 + 0.01, 9)
    rmSync(dir, { recursive: true, force: true })
  })

  it('QA W6: a symlink at the ledger path is refused by the open itself', async () => {
    const { appendKeyLedgerRow } = await import('./key-ledger.js')
    const dir = mkdtempSync(join(tmpdir(), 'kl-w6-'))
    const target = join(dir, 'elsewhere.txt'); writeFileSync(target, '')
    const file = join(dir, 'key-ledger.jsonl'); symlinkSync(target, file)
    expect(() => appendKeyLedgerRow({ ts: '2026-10-19T10:00:00.000Z', keyRef: 'key_0123456789ab', profile: 'p', lane: 'key', turnId: 't', tokens: { input: 0, output: 0 }, usd: 0, kind: 'reserve' }, file)).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('')
    rmSync(dir, { recursive: true, force: true })
  })
})
