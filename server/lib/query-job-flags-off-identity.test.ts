// 6.78.0 G-off (plan v3.1 section 3): with the phase flags off, the query-job journal, every
// snapshot (the body of GET /api/query-jobs/:id) and every replayed event are BYTE-IDENTICAL
// to 6.77.0. The golden file was recorded by running the same scenario module against the
// 6.77.0 checkout (aa87c9d) with its own QueryJobStore; nothing in it was written by hand.
// Random ids are normalized in order of first appearance, so equal order means equal bytes.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { QueryJobStore, createQueryJobJournalStorage } from './query-job-store.js'
import { runFlagsOffScenario, type ScenarioStoreCtor } from './__fixtures__/pi-durable/flags-off-scenario.js'

const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__/pi-durable/flags-off-6.77.0.json'), 'utf8'))
const FLAGS = ['COS_RESTART_NOTICE', 'COS_QUERY_JOB_DELTA_JOURNAL'] as const
const saved = Object.fromEntries(FLAGS.map(flag => [flag, process.env[flag]]))
afterEach(() => {
  for (const flag of FLAGS) {
    if (saved[flag] === undefined) delete process.env[flag]
    else process.env[flag] = saved[flag]
  }
})

describe('flags off: the 6.77.0 bytes (G-off)', () => {
  it('COS_RESTART_NOTICE=0 and the delta writer off: journal, snapshots, events and health equal 6.77.0', async () => {
    process.env.COS_RESTART_NOTICE = '0'
    delete process.env.COS_QUERY_JOB_DELTA_JOURNAL
    const out = await runFlagsOffScenario(QueryJobStore as unknown as ScenarioStoreCtor, () => createQueryJobJournalStorage())
    expect(GOLDEN._source).toBe('6.77.0 aa87c9d')
    // Line by line first, for a readable failure; then the whole record.
    expect(out.journal.length).toBe(GOLDEN.journal.length)
    out.journal.forEach((line, index) => expect(line, `journal row ${index + 1}`).toBe(GOLDEN.journal[index]))
    expect(out).toEqual({ journal: GOLDEN.journal, snapshots: GOLDEN.snapshots, events: GOLDEN.events, health: GOLDEN.health, requeued: GOLDEN.requeued })
    // No new key anywhere (plan G-off: `interruption` absent when its flag is off).
    expect(JSON.stringify(out)).not.toMatch(/interruption|"cause"|deltaOnly|partialChars/)
  })

  it('the defaults differ from 6.77.0 only where the restart notice writes (a guard that the golden can fail)', async () => {
    delete process.env.COS_RESTART_NOTICE
    delete process.env.COS_QUERY_JOB_DELTA_JOURNAL
    const out = await runFlagsOffScenario(QueryJobStore as unknown as ScenarioStoreCtor, () => createQueryJobJournalStorage())
    const changed = out.journal.map((line, index) => [index, line !== GOLDEN.journal[index]] as const).filter(([, differs]) => differs).map(([index]) => index)
    // Exactly the three interrupt rows: the graceful shutdown, and the two the boot wrote.
    expect(changed.map(index => JSON.parse(out.journal[index]!).type)).toEqual(['interrupted', 'interrupted', 'interrupted'])
    for (const index of changed) expect(JSON.parse(out.journal[index]!).patch).toHaveProperty('interruption')
  })
})
