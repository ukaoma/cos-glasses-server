import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dataDir = ''

beforeEach(() => {
  // DATA_DIR is a module-level const, so the env must be set before the import.
  dataDir = mkdtempSync(join(tmpdir(), 'fence-store-'))
  process.env.COS_DATA_DIR = dataDir
  vi.resetModules()
})

afterEach(() => {
  delete process.env.COS_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
  vi.resetModules()
})

const row = (over: Record<string, unknown> = {}) => ({
  targetKey: '6:claude:4:t-01',
  provider: 'claude',
  reason: 'native_target_fenced',
  headBefore: 'abc',
  turnId: 'turn-1',
  bindingId: 'bnd-1',
  fencedAt: 1_000,
  ...over,
})

describe('thread fence store', () => {
  it('round-trips a fence through the file', async () => {
    const { readFences, writeFences } = await import('./thread-fence-store.js')
    expect(readFences()).toEqual([])
    writeFences([row()])
    expect(readFences()).toEqual([row()])
  })

  it('reads a missing file as empty', async () => {
    const { readFences } = await import('./thread-fence-store.js')
    expect(readFences()).toEqual([])
  })

  it('reads a CORRUPT file as empty rather than bricking every thread', async () => {
    // Failing closed here would refuse every thread on the machine with no way
    // back. Failing open is exactly the pre-6.36.10 behaviour (the fence was
    // process-local and died on restart), so it cannot be a regression.
    const { fencePath, readFences } = await import('./thread-fence-store.js')
    writeFileSync(fencePath(), '{ not json')
    expect(readFences()).toEqual([])
  })

  it('drops only the corrupt rows, keeping the rest fenced', async () => {
    const { fencePath, readFences } = await import('./thread-fence-store.js')
    writeFileSync(fencePath(), JSON.stringify([
      row(),
      { targetKey: '', provider: 'claude', reason: 'x', fencedAt: 1 }, // empty key
      { provider: 'claude', reason: 'x', fencedAt: 1 },                // no key
      null,
      row({ targetKey: '6:claude:4:t-02' }),
    ]))
    const kept = readFences()
    expect(kept).toHaveLength(2)
    expect(kept.map(r => r.targetKey)).toEqual(['6:claude:4:t-01', '6:claude:4:t-02'])
  })

  it('writes atomically — no .tmp left behind, and the file is valid JSON', async () => {
    const { fencePath, writeFences } = await import('./thread-fence-store.js')
    writeFences([row()])
    expect(() => JSON.parse(readFileSync(fencePath(), 'utf-8'))).not.toThrow()
    expect(() => readFileSync(`${fencePath()}.tmp`, 'utf-8')).toThrow()
  })

  it('stores under the data home, which survives an Update Server', async () => {
    const { fencePath } = await import('./thread-fence-store.js')
    // The generation directory is replaced wholesale on every update; a fence
    // living there would be silently reopened by a routine upgrade.
    expect(fencePath().startsWith(dataDir)).toBe(true)
  })
})

describe('thread fence store — a write must never erase what it could not read', () => {
  it('PRESERVES an unrecognised row through a write of the rows it did understand', async () => {
    // THE B1 CASE. TargetGuard hydrates only the rows readFences understood and
    // then saves its map wholesale. Without a merge, one unrecognised row means
    // the next fence on an unrelated thread erases every other fenced thread.
    const { fencePath, readFences, writeFences } = await import('./thread-fence-store.js')
    const future = { targetKey: '6:claude:4:t-99', schemaVersion: 2, somethingNew: true }
    writeFileSync(fencePath(), JSON.stringify([row(), future]))

    const understood = readFences()
    expect(understood).toHaveLength(1)

    // Simulate the guard saving its map (which never contained `future`).
    writeFences(understood)

    const onDisk = JSON.parse(readFileSync(fencePath(), 'utf-8'))
    expect(onDisk).toHaveLength(2)
    expect(onDisk).toContainEqual(future)
  })

  it('quarantines a corrupt file instead of destroying the evidence', async () => {
    const { fencePath, readFences } = await import('./thread-fence-store.js')
    writeFileSync(fencePath(), '{ not json')
    expect(readFences()).toEqual([])
    const quarantined = readdirSync(dataDir).filter(f => f.includes('.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dataDir, quarantined[0]), 'utf-8')).toBe('{ not json')
  })

  it('drops a row that fails ANY single field check', async () => {
    // Each of these is invalid in exactly one field, so a mutation deleting any
    // one validator is caught rather than surviving.
    const { fencePath, readFences } = await import('./thread-fence-store.js')
    const cases = [
      row({ targetKey: '' }),
      row({ provider: 12345 }),
      row({ reason: null }),
      row({ fencedAt: 'yesterday' }),
    ]
    for (const bad of cases) {
      writeFileSync(fencePath(), JSON.stringify([bad]))
      expect(readFences(), JSON.stringify(bad).slice(0, 60)).toEqual([])
    }
  })
})

describe('thread fence store — evidence fields survive the disk round trip', () => {
  const withEvidence = () => row({
    adapterReason: 'timeout',
    adapterDetail: null,
    fenceSite: 'ambiguous',
    exitCode: null,
    childReaped: true,
    stderrClass: 'none',
    durationMs: 1_260_000,
    spawns: [{ pid: 515151, startMs: 1_700_000_000_000 }],
  })

  it('round-trips the nested spawns array intact', async () => {
    // This is DISK-ONLY data with, until now, no disk-layer test at all.
    const { readFences, writeFences } = await import('./thread-fence-store.js')
    writeFences([withEvidence()])
    const [back] = readFences()
    expect(back.spawns).toEqual([{ pid: 515151, startMs: 1_700_000_000_000 }])
    expect(back.childReaped).toBe(true)
    expect(back.fenceSite).toBe('ambiguous')
    expect(back.exitCode).toBeNull()
  })

  it('an evidence-bearing row still passes isFenceRecord, so a write cannot sweep it aside', async () => {
    // THE DECISION THIS PROTECTS. The new fields were deliberately NOT added to
    // isFenceRecord; if they had been, a row would be reclassified as unrecognised
    // and land in the preserved-but-inert pile, silently un-enforcing a real fence.
    // The route-level test cannot cover this: TargetGuard's constructor calls
    // persistence.load() directly and never invokes the validator.
    const { fencePath, readFences, writeFences } = await import('./thread-fence-store.js')
    writeFences([withEvidence()])
    expect(readFences()).toHaveLength(1)
    const onDisk = JSON.parse(readFileSync(fencePath(), 'utf-8'))
    expect(onDisk).toHaveLength(1)  // not duplicated into the preserved pile
  })

  it('distinguishes an absent field from an explicit null', async () => {
    // A reader of the distribution must be able to tell "not recorded" from
    // "recorded as null". JSON drops undefined and keeps null.
    const { fencePath, readFences, writeFences } = await import('./thread-fence-store.js')
    writeFences([row({ exitCode: null, childReaped: undefined })])
    const raw = JSON.parse(readFileSync(fencePath(), 'utf-8'))[0]
    expect('exitCode' in raw).toBe(true)
    expect(raw.exitCode).toBeNull()
    expect('childReaped' in raw).toBe(false)
    expect(readFences()[0].childReaped).toBeUndefined()
  })

  it('keeps a legacy row with no evidence enforceable', async () => {
    const { readFences, writeFences } = await import('./thread-fence-store.js')
    writeFences([row()])
    const [back] = readFences()
    expect(back.targetKey).toBe('6:claude:4:t-01')
    expect(back.spawns).toBeUndefined()
  })
})
