// 6.78.0 MVP-D release 1: the delta-only chunk journal. The READER is always on and ships now;
// the WRITER is behind COS_QUERY_JOB_DELTA_JOURNAL (default off) and ships on next release.
// Executed against the real store, its real storage and real files.
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DeltaQueryJobJournalStorage,
  NodeQueryJobJournalStorage,
  QueryJobStore,
  createQueryJobJournalStorage,
  type QueryJobJournalStorage,
} from './query-job-store.js'
import { QueryJobStore as QueryJobStore6510 } from './__fixtures__/query-job-store-6.51.0.js'
import { queryJobDeltaJournalEnabled } from './query-job-feature.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cos-delta-journal-'))
  roots.push(root)
  return root
}

function request(clientJobId = randomUUID()): Record<string, unknown> {
  return { clientJobId, generation: 1, query: 'stream a long answer', sessionId: 'session-delta', activityToolMode: 'preview' }
}

async function journalLines(root: string): Promise<string[]> {
  const files = (await readdir(root)).filter(name => name.endsWith('.jsonl')).sort()
  const lines: string[] = []
  for (const file of files) for (const line of (await readFile(join(root, file), 'utf8')).split('\n')) if (line.trim()) lines.push(line)
  return lines
}

async function journalBytes(root: string): Promise<number> {
  let bytes = 0
  for (const file of (await readdir(root)).filter(name => name.endsWith('.jsonl'))) bytes += (await stat(join(root, file))).size
  return bytes
}

/** Records every line the store hands its storage, then stores it for real. */
class Recording extends NodeQueryJobJournalStorage {
  readonly lines: string[] = []
  override append(root: string, day: string, line: string): Promise<void> {
    this.lines.push(line)
    return super.append(root, day, line)
  }
}

async function running(store: QueryJobStore): Promise<string> {
  const { job } = await store.admit(request())
  await store.markStarting(job.jobId)
  await store.markRunning(job.jobId, { provider: 'claude' })
  return job.jobId
}

async function stream(store: QueryJobStore, jobId: string, parts: string[], start = ''): Promise<string> {
  let acc = start
  for (const part of parts) { acc += part; await store.appendPartial(jobId, part, acc) }
  return acc
}

describe('the writer is off by default: every append is the 6.77.0 line', () => {
  it('createQueryJobJournalStorage() passes the store\'s lines through byte for byte', async () => {
    const root = await tempRoot()
    const recording = new Recording()
    const storage = new DeltaQueryJobJournalStorage({ inner: recording })
    const store = new QueryJobStore({ root, bootId: 'boot-a', storage })
    await store.init()
    const jobId = await running(store)
    const acc = await stream(store, jobId, ['One. ', 'Two. ', 'Three.'])
    await store.complete(jobId, { text: acc })
    // What was stored is exactly what the store produced, and nothing is a delta row.
    expect(await journalLines(root)).toEqual(recording.lines)
    expect(recording.lines.some(line => line.includes('deltaOnly'))).toBe(false)
    expect(storage.stripped).toBe(0)
  })

  it('the flag is a tri-state: 1, true and on write deltas; unset, 0 and anything else do not', () => {
    for (const value of ['1', 'true', 'on', ' ON ']) expect(queryJobDeltaJournalEnabled({ COS_QUERY_JOB_DELTA_JOURNAL: value }), value).toBe(true)
    for (const value of [undefined, '', '0', 'false', 'off', 'yes']) expect(queryJobDeltaJournalEnabled({ COS_QUERY_JOB_DELTA_JOURNAL: value }), String(value)).toBe(false)
    expect(queryJobDeltaJournalEnabled({})).toBe(false)
  })

  it('createQueryJobJournalStorage reads the flag it is given', async () => {
    for (const [env, writes] of [[{}, false], [{ COS_QUERY_JOB_DELTA_JOURNAL: '1' }, true]] as const) {
      const root = await tempRoot()
      const store = new QueryJobStore({ root, bootId: 'boot-a', storage: createQueryJobJournalStorage(env) })
      await store.init()
      const jobId = await running(store)
      await stream(store, jobId, ['a', 'b', 'c'])
      expect((await journalLines(root)).some(line => line.includes('"deltaOnly":true')), JSON.stringify(env)).toBe(writes)
    }
  })
})

describe('the writer, on: a chunk is stored as its delta only when that is the whole truth', () => {
  it('suffix chunks become delta rows, and a reboot reads the partial back exactly', async () => {
    const root = await tempRoot()
    const writer = new DeltaQueryJobJournalStorage({ writeDeltas: true })
    const a = new QueryJobStore({ root, bootId: 'boot-a', storage: writer })
    await a.init()
    const jobId = await running(a)
    const acc = await stream(a, jobId, ['First part. ', 'Second part. ', 'Third part.'])
    // The first chunk of a job follows its accepted row (partial ''), so it strips too.
    expect(writer.stripped).toBe(3)
    const rows = (await journalLines(root)).map(line => JSON.parse(line)).filter(row => row.type === 'chunk')
    for (const row of rows) {
      expect(row.patch).not.toHaveProperty('partialText')
      expect(row.eventData).not.toHaveProperty('partialText')
      expect(row.eventData.deltaOnly).toBe(true)
    }
    expect(rows.map(row => row.eventData.partialChars)).toEqual([12, 25, 36])

    const b = new QueryJobStore({ root, bootId: 'boot-b', storage: new DeltaQueryJobJournalStorage() })
    await b.init()
    const snapshot = await b.getSnapshot(jobId)
    expect(snapshot.partialText).toBe(acc)
    expect(snapshot.partialTruncated).toBe(false)
    // Replayed chunk events carry the full partial, as a 6.77.0 journal's did.
    const chunks = (await b.replay(jobId, 1, 0)).events.filter(event => event.type === 'chunk')
    expect(chunks.map(event => event.data.partialText)).toEqual(['First part. ', 'First part. Second part. ', acc])
    expect(chunks.every(event => !('deltaOnly' in event.data) && !('partialChars' in event.data))).toBe(true)
  })

  it('an authoritative rewrite (the coordinator flush REPLACES the partial) is kept whole (QJ-7b)', async () => {
    const root = await tempRoot()
    const writer = new DeltaQueryJobJournalStorage({ writeDeltas: true })
    const a = new QueryJobStore({ root, bootId: 'boot-a', storage: writer })
    await a.init()
    const jobId = await running(a)
    await stream(a, jobId, ['Checking the file. ', 'Two items.'])
    const final = 'FINAL: two open items.'
    await a.appendPartial(jobId, final, final)
    expect(writer.keptFull).toBe(1)
    const b = new QueryJobStore({ root, bootId: 'boot-b' })
    await b.init()
    expect((await b.getSnapshot(jobId)).partialText).toBe(final)
  })

  it('a truncated delta is kept whole', async () => {
    const root = await tempRoot()
    const writer = new DeltaQueryJobJournalStorage({ writeDeltas: true })
    const a = new QueryJobStore({ root, bootId: 'boot-a', storage: writer })
    await a.init()
    const jobId = await running(a)
    // The store cuts a delta at 16,000 characters and says so (deltaTruncated).
    await a.appendPartial(jobId, 'x'.repeat(20_000), 'x'.repeat(20_000))
    const chunk = (await journalLines(root)).map(line => JSON.parse(line)).find(row => row.type === 'chunk')!
    expect(chunk.eventData.deltaTruncated).toBe(true)
    expect(chunk.patch.partialText).toHaveLength(20_000)
    expect(chunk.eventData).not.toHaveProperty('deltaOnly')
    expect(writer.stripped).toBe(0)
  })

  it('the first chunk of a job this writer never saw (another process admitted it) is written whole', async () => {
    const root = await tempRoot()
    const inner = new Recording()
    const writer = new DeltaQueryJobJournalStorage({ writeDeltas: true, inner })
    const row = { schemaVersion: 1, jobId: randomUUID(), type: 'chunk', patch: { partialText: 'abc', partialTruncated: false }, eventData: { text: 'c', partialText: 'abc', partialTruncated: false, deltaTruncated: false } }
    await writer.append(root, '2026-10-18', JSON.stringify(row))
    expect(inner.lines).toEqual([JSON.stringify(row)])
    expect(writer.keptFull).toBe(1)
    // Its next suffix chunk is a delta.
    await writer.append(root, '2026-10-18', JSON.stringify({ ...row, patch: { partialText: 'abcd', partialTruncated: false }, eventData: { text: 'd', partialText: 'abcd', partialTruncated: false, deltaTruncated: false } }))
    expect(JSON.parse(inner.lines[1]!).eventData).toMatchObject({ deltaOnly: true, partialChars: 4, text: 'd' })
  })

  it('writes less, and grows with the answer, not its square', async () => {
    const sizes: Record<string, number[]> = { full: [], delta: [] }
    for (const [mode, storage] of [['full', () => new NodeQueryJobJournalStorage()], ['delta', () => new DeltaQueryJobJournalStorage({ writeDeltas: true })]] as const) {
      for (const pieces of [40, 80]) {
        const root = await tempRoot()
        const store = new QueryJobStore({ root, bootId: 'boot-a', storage: storage() })
        await store.init()
        const jobId = await running(store)
        await stream(store, jobId, Array.from({ length: pieces }, (_, i) => `piece ${String(i).padStart(3, '0')} of the answer. `))
        sizes[mode]!.push(await journalBytes(root))
      }
    }
    const fullGrowth = sizes.full![1]! / sizes.full![0]!
    const deltaGrowth = sizes.delta![1]! / sizes.delta![0]!
    expect(deltaGrowth).toBeLessThan(2.2)
    expect(fullGrowth).toBeGreaterThan(3)
    expect(sizes.delta![1]!).toBeLessThan(sizes.full![1]! / 4)
  })
})

describe('the reader never assembles a wrong answer from a gap', () => {
  it('a lost delta row: the job keeps the last partial it can prove, marked truncated, until a whole row', async () => {
    const root = await tempRoot()
    const a = new QueryJobStore({ root, bootId: 'boot-a', storage: new DeltaQueryJobJournalStorage({ writeDeltas: true }) })
    await a.init()
    const jobId = await running(a)
    await stream(a, jobId, ['Alpha. ', 'Bravo. ', 'Charlie.'])
    // Drop the middle delta row from the file (what a torn row in the middle would leave).
    const file = join(root, (await readdir(root)).find(name => name.endsWith('.jsonl'))!)
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    const chunkIndexes = lines.map((line, index) => [index, JSON.parse(line).type] as const).filter(([, type]) => type === 'chunk').map(([index]) => index)
    lines.splice(chunkIndexes[1]!, 1)
    await writeFile(file, `${lines.join('\n')}\n`)

    const b = new QueryJobStore({ root, bootId: 'boot-b' })
    await b.init()
    const snapshot = await b.getSnapshot(jobId)
    expect(snapshot.partialText).toBe('Alpha. ')
    expect(snapshot.partialTruncated).toBe(true)
    expect(snapshot.status).toBe('interrupted')
  })

  it('a whole row after a gap restores the partial', async () => {
    const root = await tempRoot()
    const a = new QueryJobStore({ root, bootId: 'boot-a', storage: new DeltaQueryJobJournalStorage({ writeDeltas: true }) })
    await a.init()
    const jobId = await running(a)
    await stream(a, jobId, ['Alpha. ', 'Bravo. '])
    const final = 'FINAL.'
    await a.appendPartial(jobId, final, final)
    // A suffix after the whole row is a delta again, and must build on the whole row.
    await a.appendPartial(jobId, ' More.', `${final} More.`)
    const file = join(root, (await readdir(root)).find(name => name.endsWith('.jsonl'))!)
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    const chunks = lines.map(line => JSON.parse(line)).filter(row => row.type === 'chunk')
    expect(chunks.map(row => row.eventData.deltaOnly === true)).toEqual([true, true, false, true])
    const firstChunk = lines.findIndex(line => JSON.parse(line).type === 'chunk')
    lines.splice(firstChunk, 1)
    await writeFile(file, `${lines.join('\n')}\n`)
    const b = new QueryJobStore({ root, bootId: 'boot-b' })
    await b.init()
    const snapshot = await b.getSnapshot(jobId)
    expect(snapshot.partialText).toBe(`${final} More.`)
    expect(snapshot.partialTruncated).toBe(false)
  })

  it('a journal with no delta rows reads exactly as before (the reader on a 6.77.0 journal)', async () => {
    const root = await tempRoot()
    const a = new QueryJobStore({ root, bootId: 'boot-a' })
    await a.init()
    const jobId = await running(a)
    await stream(a, jobId, ['One. ', 'Two.'])
    const viaReader = new QueryJobStore({ root, bootId: 'boot-b', storage: new DeltaQueryJobJournalStorage() })
    await viaReader.init()
    const plain = new QueryJobStore6510({ root, bootId: 'boot-c' })
    await plain.init()
    const read = await viaReader.getSnapshot(jobId)
    const old = await plain.getSnapshot(jobId)
    expect(read.partialText).toBe(old.partialText)
    expect(read.partialText).toBe('One. Two.')
  })
})

describe('rollback of a writer-on journal (why the writer ships a release after the reader)', () => {
  it('a 6.51.0 reader keeps every finished answer whole and shows a mid-run job with an empty partial', async () => {
    const root = await tempRoot()
    const a = new QueryJobStore({ root, bootId: 'boot-a', storage: new DeltaQueryJobJournalStorage({ writeDeltas: true }) })
    await a.init()
    const finished = await running(a)
    const answer = await stream(a, finished, ['Done one. ', 'Done two.'])
    await a.markAnswerReady(finished, answer)
    await a.complete(finished, { text: answer })
    const midRun = await running(a)
    await stream(a, midRun, ['Half ', 'way.'])

    const old = new QueryJobStore6510({ root, bootId: 'boot-old' })
    await old.init()
    expect((await old.getSnapshot(finished)).response).toBe(answer)
    expect((await old.getSnapshot(midRun)).partialText).toBe('')
  })
})

// Satisfies the type import for readers of this file: the storage seam is the public one.
export type { QueryJobJournalStorage }
