/**
 * Principle 7: the engine never blocks live capture (6.47.0, QA round 1).
 *
 * WHAT WAS WRONG. Three separate things, all of which made the principle a claim rather than
 * a property.
 *
 *   1. `captureActive` defaulted to `() => false` and the PRODUCTION constructor passed no
 *      deps at all, so the only thing that ever deferred was a test.
 *   2. Input collection ran on the main thread and hashed EVERY sidecar it found — 817 MB of
 *      `.g2-chunks.json` on this Mac — on every one of five triggers.
 *   3. Nothing noticed that nothing had changed, so a pass over an unchanged backlog cost
 *      exactly as much as the first one.
 *
 * This file measures (2) and (3) against 500 synthetic sidecars, and pins (1) at its wiring.
 * The numbers are WALL TIME ON THE MAIN THREAD, because that is the thing a live capture
 * competes with; a budget in "files read" would pass while the event loop still stalled.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImportedMeetingLibrary } from './imported-meeting-library.js'
import {
  FIREFLIES_SIDECAR_VERSION,
  MAX_SCRIBE_BYTES,
  MeetingMergeRunner,
  collectEngineInputs,
  scanInputStamp,
  scribeMarkers,
} from './meeting-actions.js'
import { MeetingActionsStore } from './meeting-actions-store.js'
import { acquireMaintenanceWork } from './maintenance-lifecycle.js'
import { runEngine } from './meeting-engine/worker.js'

const roots: string[] = []
const savedEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value == null) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
    delete savedEnv[key]
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function scribe(title: string, source: string, extra = ''): string {
  return [
    `# ${title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    '| **Date** | 2026-08-20 15:00 |',
    '| **Duration** | 30 minutes |',
    `| **Source** | ${source} |`,
    '| **Domain** | personal |',
    '',
    ...(extra ? [extra, ''] : []),
    '## Transcript',
    '',
    '[00:00:05] Speaker A: Synthetic line.',
    '',
  ].join('\n')
}

/**
 * An operations tree with `count` G2 sidecars, each big enough that hashing it is real work.
 *
 * 64 KiB each, 500 of them: 32 MB of hashing per uncached pass. The production tree is 817 MB
 * and the point is the SHAPE of the cost, not its absolute size, so a budget that this passes
 * comfortably is one the real tree fails badly without the cache.
 */
const SIDECAR_BYTES = 64 * 1024

function operationsTree(count: number): { root: string; monthDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-collect-ops-'))
  roots.push(root)
  const monthDir = join(root, 'personal', 'meetings', '2026-08')
  mkdirSync(monthDir, { recursive: true })
  const filler = 'x'.repeat(SIDECAR_BYTES)
  for (let index = 0; index < count; index++) {
    const stem = `2026-08-20_Capture${String(index).padStart(4, '0')}`
    writeFileSync(join(monthDir, `${stem}.md`), scribe(`Capture ${index}`, 'G2 Glasses'))
    writeFileSync(join(monthDir, `${stem}.g2-chunks.json`), JSON.stringify({
      sessionId: `session_${index}`,
      startTime: Date.UTC(2026, 7, 20, 15, 0, 0) + index * 1000,
      durationMs: 600_000,
      chunks: [],
      batchSegments: [],
      filler,
    }))
  }
  return { root, monthDir }
}

function runnerFor(root: string): { runner: MeetingMergeRunner; store: MeetingActionsStore } {
  const dataDir = mkdtempSync(join(tmpdir(), 'cos-collect-data-'))
  roots.push(dataDir)
  const importsRoot = join(dataDir, 'imports')
  const library = new ImportedMeetingLibrary({ root: importsRoot })
  const store = new MeetingActionsStore({ root: importsRoot })
  setEnv('COS_OPERATIONS_DIR', root)
  const runner = new MeetingMergeRunner({
    store,
    library,
    mode: () => 'advise',
    isPipelineMac: () => true,
    runEngine: async request => runEngine(request),
    acquireLease: () => ({ id: 'l', setPhase: () => undefined, release: () => undefined }),
    admissionsOpen: () => true,
    captureActive: () => false,
    spawnPipeline: null,
    now: () => Date.now(),
    log: () => undefined,
  })
  return { runner, store }
}

/** The cache key whose path ends in this basename. The root is realpath-resolved. */
function cacheKeyFor(cache: Record<string, unknown>, basename: string): string {
  const key = Object.keys(cache).find(path => path.endsWith(`/${basename}`))
  if (!key) throw new Error(`no hash cache entry for ${basename}`)
  return key
}

/** Wall time of one pass, on the main thread. */
async function timePass(runner: MeetingMergeRunner, label: string): Promise<number> {
  const startedAt = performance.now()
  await runner.run(label)
  return performance.now() - startedAt
}

describe('input collection does not stall the event loop', () => {
  it('reads every sidecar once, then never again until one moves', async () => {
    const { root, monthDir } = operationsTree(500)
    const { runner, store } = runnerFor(root)

    const first = await timePass(runner, 'first')
    expect(store.read().status.lastInputScan).toMatchObject({ count: 500, mode: 'advise' })
    expect(Object.keys(store.read().status.hashCache ?? {})).toHaveLength(500)

    // PASS TWO AND THREE: nothing has changed, so nothing is read. The budget is the
    // blocking figure the QA pass asked for.
    const second = await timePass(runner, 'second')
    const third = await timePass(runner, 'third')
    expect(second).toBeLessThan(100)
    expect(third).toBeLessThan(100)
    expect(store.read().status.lastRun).toMatchObject({ skippedReason: 'inputs_unchanged' })
    // And the saving is real, not an artefact of a fast first pass.
    expect(second).toBeLessThan(first)

    // ONE FILE MOVES: the pass collects again, and only that file is re-hashed.
    const changed = join(monthDir, '2026-08-20_Capture0007.g2-chunks.json')
    const before = store.read().status.hashCache!
    const doc = JSON.parse(readFileSync(changed, 'utf8')) as Record<string, unknown>
    doc.filler = `${String(doc.filler)}y`
    writeFileSync(changed, JSON.stringify(doc))
    const fourth = await timePass(runner, 'fourth')
    expect(store.read().status.lastRun?.skippedReason).toBeUndefined()
    const after = store.read().status.hashCache!
    // The collector resolves the operations root through realpath, so the cache is keyed on
    // the resolved path rather than the one this test built.
    const changedKey = cacheKeyFor(after, '2026-08-20_Capture0007.g2-chunks.json')
    expect(after[changedKey]).not.toEqual(before[changedKey])
    let moved = 0
    for (const [path, entry] of Object.entries(after)) {
      if (JSON.stringify(entry) !== JSON.stringify(before[path])) moved += 1
    }
    expect(moved).toBe(1)
    expect(fourth).toBeGreaterThan(0)
  })

  it('notices a file that was DELETED, not only one that was touched', async () => {
    // mtime alone cannot see a deletion: every surviving file's timestamp is where it was.
    const { root, monthDir } = operationsTree(4)
    const { runner, store } = runnerFor(root)
    await runner.run('first')
    await runner.run('second')
    expect(store.read().status.lastRun?.skippedReason).toBe('inputs_unchanged')
    rmSync(join(monthDir, '2026-08-20_Capture0002.g2-chunks.json'))
    await runner.run('third')
    expect(store.read().status.lastRun?.skippedReason).toBeUndefined()
    expect(store.read().status.lastInputScan?.count).toBe(3)
  })

  it('still drives waiting pipeline work on a pass that bails', async () => {
    // The bail must not hold an apply or an Undo hostage to whether any input file moved.
    const { root } = operationsTree(2)
    const { runner, store } = runnerFor(root)
    await runner.run('first')
    await store.update(current => {
      current.actions.push({
        id: 'a_00000000000000ab',
        kind: 'merge',
        tier: 'auto',
        inputs: { sessionIds: ['session_0'], firefliesIds: ['ff'] },
        fingerprints: '',
        outputs: [],
        outputSha256: [],
        state: 'pending',
        mode: 'imports',
        direction: 'apply',
        at: new Date().toISOString(),
      })
    })
    await runner.run('second')
    expect(store.read().status.lastRun?.skippedReason).toBe('inputs_unchanged')
  })

  it('scans with stats alone, opening nothing', () => {
    const { root } = operationsTree(3)
    setEnv('COS_OPERATIONS_DIR', root)
    const dataDir = mkdtempSync(join(tmpdir(), 'cos-collect-scan-'))
    roots.push(dataDir)
    const library = new ImportedMeetingLibrary({ root: join(dataDir, 'imports') })
    const stamp = scanInputStamp('advise', library)
    expect(stamp.count).toBe(3)
    expect(stamp.newestMtimeMs).toBeGreaterThan(0)
  })
})

/**
 * The capture gate, wired to the thing that actually knows.
 *
 * NOT A SOURCE-SHAPE TEST. `expect(source).toContain('recording_chunk')` would pass against a
 * constructor that built the predicate and never called it. This takes a REAL
 * `recording_chunk` lease from the maintenance lifecycle, runs a pass with NO `captureActive`
 * dependency injected, and asserts the pass deferred — then releases the lease and asserts it
 * runs. The default is the code path under test.
 */
describe('principle 7: the pass defers while a capture is live', () => {
  function productionGateRunner(root: string): { runner: MeetingMergeRunner; store: MeetingActionsStore } {
    const dataDir = mkdtempSync(join(tmpdir(), 'cos-collect-gate-'))
    roots.push(dataDir)
    const importsRoot = join(dataDir, 'imports')
    const store = new MeetingActionsStore({ root: importsRoot })
    setEnv('COS_OPERATIONS_DIR', root)
    const runner = new MeetingMergeRunner({
      store,
      library: new ImportedMeetingLibrary({ root: importsRoot }),
      mode: () => 'advise',
      isPipelineMac: () => true,
      runEngine: async request => runEngine(request),
      acquireLease: () => ({ id: 'l', setPhase: () => undefined, release: () => undefined }),
      admissionsOpen: () => true,
      // captureActive DELIBERATELY ABSENT: the production default is what is under test.
      spawnPipeline: null,
      log: () => undefined,
    })
    return { runner, store }
  }

  it.each([
    ['a live chunk write', 'recording_chunk' as const],
    ['a meeting saving itself', 'meeting_save' as const],
  ])('defers while %s holds its lease, and runs once it is released', async (_label, kind) => {
    const { root } = operationsTree(2)
    const { runner, store } = productionGateRunner(root)
    const lease = acquireMaintenanceWork(kind, { allowDuringDrain: true })
    try {
      await runner.run('during-capture')
      expect(store.read().status.lastRun).toMatchObject({ skippedReason: 'capture_active' })
    } finally {
      lease.release()
    }
    await runner.run('after-capture')
    expect(store.read().status.lastRun?.skippedReason).toBeUndefined()
  })

  it('does NOT defer while a finalization lease is held', async () => {
    // The merge run is triggered from inside `meeting_batch_finalization` (routes/meeting.ts,
    // at the end of the finalization job). Counting it would defer the very pass the
    // finalization just asked for, and the six-hourly tick would be the next chance.
    const { root } = operationsTree(2)
    const { runner, store } = productionGateRunner(root)
    const lease = acquireMaintenanceWork('meeting_batch_finalization', { allowDuringDrain: true })
    try {
      await runner.run('from-finalization')
      expect(store.read().status.lastRun?.skippedReason).toBeUndefined()
    } finally {
      lease.release()
    }
  })
})

describe('the .fireflies.json reader refuses what it cannot trust', () => {
  function tree(sidecar: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'cos-collect-ff-'))
    roots.push(root)
    const monthDir = join(root, 'personal', 'meetings', '2026-08')
    mkdirSync(monthDir, { recursive: true })
    writeFileSync(join(monthDir, '2026-08-20_Weekly.md'), scribe('Weekly', 'Fireflies'))
    writeFileSync(join(monthDir, '2026-08-20_Weekly.fireflies.json'), JSON.stringify(sidecar))
    setEnv('COS_OPERATIONS_DIR', root)
    return root
  }

  function collect(): ReturnType<typeof collectEngineInputs> {
    const dataDir = mkdtempSync(join(tmpdir(), 'cos-collect-lib-'))
    roots.push(dataDir)
    return collectEngineInputs('advise', new ImportedMeetingLibrary({ root: join(dataDir, 'imports') }))
  }

  const base = {
    sidecar_version: FIREFLIES_SIDECAR_VERSION,
    clipped: false,
    id: 'ff-1',
    date: Date.UTC(2026, 7, 20, 15, 0, 0),
    duration: 30,
    participants: [],
    sentences: [{ text: 'alpha beta gamma', speaker_name: 'A', start_time: 1, end_time: 4 }],
  }

  it('accepts a version 1 sidecar that was not clipped', () => {
    tree(base)
    const inputs = collect()
    expect(inputs.fireflies.map(row => row.id)).toEqual(['ff-1'])
    expect(inputs.skipped).toEqual({})
  })

  it.each([
    ['no version at all', { ...base, sidecar_version: undefined }, 'fireflies_sidecar_version'],
    ['a version it does not know', { ...base, sidecar_version: 2 }, 'fireflies_sidecar_version'],
    ['a version that is a string', { ...base, sidecar_version: '1' }, 'fireflies_sidecar_version'],
    // The one that matters: the pipeline's de-bleed rewrites the sentences in place, so a
    // sidecar built after it describes a recording with a whole real meeting cut out.
    ['sentences the pipeline clipped', { ...base, clipped: true }, 'fireflies_sidecar_clipped'],
  ])('refuses %s, and counts why', (_label, sidecar, reason) => {
    tree(sidecar as Record<string, unknown>)
    const inputs = collect()
    expect(inputs.fireflies).toEqual([])
    expect(inputs.skipped).toEqual({ [reason]: 1 })
  })

  it('refuses a scribe too large to read for its markers, rather than calling it unblended', () => {
    // Answering "not blended" for a file nobody read is the answer that makes the engine
    // propose merging a meeting that was already merged.
    const root = tree(base)
    const monthDir = join(root, 'personal', 'meetings', '2026-08')
    const path = join(monthDir, '2026-08-20_Weekly.md')
    writeFileSync(path, 'x'.repeat(MAX_SCRIBE_BYTES + 1))
    expect(statSync(path).size).toBeGreaterThan(MAX_SCRIBE_BYTES)
    expect(scribeMarkers(path)).toEqual({ blended: false, oversized: true })
    const inputs = collect()
    expect(inputs.fireflies).toEqual([])
    expect(inputs.skipped).toEqual({ fireflies_scribe_oversized: 1 })
  })

  it('reads the markers of a scribe under the cap', () => {
    const root = tree(base)
    const path = join(root, 'personal', 'meetings', '2026-08', '2026-08-20_Weekly.md')
    writeFileSync(path, scribe('Weekly', 'Fireflies', '<!-- g2-transcript-blended -->\n<!-- merge-action: a_0123456789abcdef -->'))
    expect(scribeMarkers(path)).toEqual({ blended: true, mergeActionId: 'a_0123456789abcdef' })
  })
})

describe('the hash cache keys on mtime AND size', () => {
  it('re-reads a same-size rewrite that moved the mtime', async () => {
    // An atomic replace of a sidecar is exactly a same-size rewrite, and mtime alone is the
    // only thing that separates it from no change at all.
    const { root, monthDir } = operationsTree(2)
    const { runner, store } = runnerFor(root)
    await runner.run('first')
    const target = join(monthDir, '2026-08-20_Capture0001.g2-chunks.json')
    const key = cacheKeyFor(store.read().status.hashCache!, '2026-08-20_Capture0001.g2-chunks.json')
    const before = store.read().status.hashCache![key]
    // One byte of the filler, swapped in place: valid JSON, identical SIZE, different bytes.
    const doc = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>
    doc.filler = `y${String(doc.filler).slice(1)}`
    writeFileSync(target, JSON.stringify(doc))
    const now = new Date(Date.now() + 5_000)
    utimesSync(target, now, now)
    expect(statSync(target).size).toBe(before.size)
    await runner.run('second')
    const after = store.read().status.hashCache![key]
    expect(after.sha256).not.toBe(before.sha256)
    expect(after.mtimeMs).not.toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
  })
})
