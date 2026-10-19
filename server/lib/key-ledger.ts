// Key lanes K1 P2 (plan v4 4.5): the spend ledger, `data/key-ledger.jsonl`.
//
// One JSON row per reserve, settle or reconcile. 0600, append-only (one write(2) per row under
// O_APPEND, so rows from parallel turns never interleave), never written through a symlink. A row
// carries a key REF, never a secret, never a nonce. Reading never creates: a missing file is an
// empty ledger, an unreadable line is skipped and left in place.
//
// Spend for a UTC day is the sum of `settle` rows plus `reconcile` deltas. `reserve` rows are an
// audit trail only: open reservations live in the meter's memory, so a crash between reserve and
// settle forgets the reservation (OpenRouter's own usage_daily and the key's credit limit are the
// backstop, plan 4.5).
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from './data-dir.js'
import type { KeyLane, KeyLedgerKind, KeyLedgerRow, KeyRef } from './key-relay-contract.js'
import { KEY_REF_RE } from './key-relay-contract.js'

export const KEY_LEDGER_FILE = 'key-ledger.jsonl'
const ID_MAX = 128
const KINDS: readonly KeyLedgerKind[] = ['reserve', 'settle', 'reconcile']
const LANES: readonly KeyLane[] = ['key', 'direct']

export function keyLedgerPath(): string {
  return dataPath(KEY_LEDGER_FILE)
}

/** The UTC day (plan 4.5: OpenRouter usage_daily resets at UTC midnight). */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function clipId(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, ID_MAX) : ''
}

function finiteNonNeg(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/** Build a row from known fields only, so nothing else (a secret, a nonce) can ride along. */
export function toLedgerRow(input: KeyLedgerRow): KeyLedgerRow {
  if (!KEY_REF_RE.test(input.keyRef)) throw new Error('key ledger: bad key ref')
  if (!KINDS.includes(input.kind)) throw new Error('key ledger: bad kind')
  if (!LANES.includes(input.lane)) throw new Error('key ledger: bad lane')
  const usd = typeof input.usd === 'number' && Number.isFinite(input.usd) ? Math.round(input.usd * 1e8) / 1e8 : 0
  return {
    ts: clipId(input.ts),
    keyRef: input.keyRef,
    profile: clipId(input.profile),
    lane: input.lane,
    turnId: clipId(input.turnId),
    ...(input.generationId ? { generationId: clipId(input.generationId) } : {}),
    tokens: { input: Math.round(finiteNonNeg(input.tokens?.input)), output: Math.round(finiteNonNeg(input.tokens?.output)) },
    usd,
    kind: input.kind,
  }
}

/** Append one row. Throws only on a symlinked ledger; a disk error is reported to the caller. */
export function appendKeyLedgerRow(row: KeyLedgerRow, file: string = keyLedgerPath()): void {
  const line = JSON.stringify(toLedgerRow(row)) + '\n'
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('refusing to write the key ledger through a symlink')
  appendFileSync(file, line, { encoding: 'utf8', mode: 0o600, flag: 'a' })
  chmodSync(file, 0o600)
}

/** Every parseable row. Never creates the file. */
export function readKeyLedger(file: string = keyLedgerPath()): KeyLedgerRow[] {
  if (!existsSync(file)) return []
  const st = lstatSync(file)
  if (st.isSymbolicLink() || !st.isFile()) return []
  const rows: KeyLedgerRow[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as Partial<KeyLedgerRow>
      if (r && typeof r.keyRef === 'string' && typeof r.kind === 'string' && typeof r.usd === 'number' && typeof r.ts === 'string') rows.push(r as KeyLedgerRow)
    } catch { /* a torn line is skipped, never rewritten */ }
  }
  return rows
}

/** Settled spend (settle plus reconcile deltas) for one key on one UTC day, from the file. */
export function ledgerSpentUsd(keyRef: KeyRef, day: string, file: string = keyLedgerPath()): number {
  let sum = 0
  for (const r of readKeyLedger(file)) {
    if (r.keyRef !== keyRef || (r.kind !== 'settle' && r.kind !== 'reconcile')) continue
    if (r.ts.slice(0, 10) !== day) continue
    sum += Number.isFinite(r.usd) ? r.usd : 0
  }
  return Math.max(0, sum)
}
