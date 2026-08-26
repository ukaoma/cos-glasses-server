import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The archive duplicate-append bug, and the upsert that fixes it.
 *
 * `runDailyArchiveMirror` re-archives every still-resident, non-today session at boot
 * and every 24h without evicting it, and `appendToArchive` used to merge with a blind
 * `existing.chats.push(...)`. Measured on the real corpus before the fix: 1.28 GB of
 * which ~1.26 GB (98%) was duplicates; 2026-07-30.json was 343 MB holding 4,421 chats
 * from TWO sessions.
 *
 * COS_DATA_DIR is scratched before EVERY import: archive.ts calls
 * checkYesterdayArchive() at module scope, so importing it points real work at whatever
 * data dir is configured. That is mandatory here, not hygiene.
 */
describe('appendToArchive deduplication', () => {
  let root = ''

  beforeEach(() => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'cos.archive.dedup.'))
    process.env.COS_DATA_DIR = join(root, 'data')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    delete process.env.COS_DATA_DIR
  })

  const DAY = '2026-07-30'

  function session(id: string, timestamps: number[]) {
    return {
      id,
      exchanges: timestamps.map((t, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `turn ${i} of ${id}`,
        timestamp: t,
      })),
      contextBreaks: [],
      createdAt: timestamps[0],
      lastActivity: timestamps[timestamps.length - 1],
    }
  }

  async function load(date: string) {
    const { loadArchive } = await import('./archive.js')
    return loadArchive(date)
  }

  it('THE BUG: archiving the same session twice yields ONE chat, not two', async () => {
    const { appendToArchive } = await import('./archive.js')
    const s = session('sess-a', [1_000, 2_000, 3_000, 4_000])

    await appendToArchive(DAY, s, { skipLLM: true })
    await appendToArchive(DAY, s, { skipLLM: true })

    const archive = await load(DAY)
    expect(archive?.chats).toHaveLength(1)
    expect(archive?.chats[0].sessionId).toBe('sess-a')
  })

  it('survives the boot-loop shape: ten re-archives still yield one chat', async () => {
    const { appendToArchive } = await import('./archive.js')
    const s = session('sess-a', [1_000, 2_000])
    for (let i = 0; i < 10; i++) await appendToArchive(DAY, s, { skipLLM: true })

    const archive = await load(DAY)
    expect(archive?.chats).toHaveLength(1)
  })

  it('REPLACES rather than skips when the session has grown since last archive', async () => {
    const { appendToArchive } = await import('./archive.js')
    await appendToArchive(DAY, session('sess-a', [1_000, 2_000]), { skipLLM: true })
    // Same chat identity (same first-exchange timestamp), more exchanges.
    await appendToArchive(DAY, session('sess-a', [1_000, 2_000, 3_000, 4_000]), { skipLLM: true })

    const archive = await load(DAY)
    expect(archive?.chats).toHaveLength(1)
    expect(archive?.chats[0].exchangeCount).toBe(4)
  })

  it('does NOT shrink a chat when an older, shorter copy is re-archived', async () => {
    const { appendToArchive } = await import('./archive.js')
    await appendToArchive(DAY, session('sess-a', [1_000, 2_000, 3_000, 4_000]), { skipLLM: true })
    await appendToArchive(DAY, session('sess-a', [1_000, 2_000]), { skipLLM: true })

    const archive = await load(DAY)
    expect(archive?.chats[0].exchangeCount).toBe(4)
  })

  it('THE CONTROL: distinct sessions are never merged', async () => {
    const { appendToArchive } = await import('./archive.js')
    await appendToArchive(DAY, session('sess-a', [1_000, 2_000]), { skipLLM: true })
    await appendToArchive(DAY, session('sess-b', [5_000, 6_000]), { skipLLM: true })
    await appendToArchive(DAY, session('sess-c', [9_000]), { skipLLM: true })

    const archive = await load(DAY)
    expect(archive?.chats).toHaveLength(3)
    expect(archive?.chats.map(c => c.sessionId).sort()).toEqual(['sess-a', 'sess-b', 'sess-c'])
  })

  it('does not merge two chats of the SAME session that started at different times', async () => {
    // Same sessionId, different startedAt — genuinely different conversations.
    const { appendToArchive } = await import('./archive.js')
    await appendToArchive(DAY, session('sess-a', [1_000, 2_000]), { skipLLM: true })
    await appendToArchive(DAY, session('sess-a', [7_000, 8_000]), { skipLLM: true })

    const archive = await load(DAY)
    expect(archive?.chats).toHaveLength(2)
  })

  it('does not rewrite the file when there is nothing new', async () => {
    // Re-serialising a large day file to identical bytes is pure cost on the process
    // that also records the wearer's live session — and it is the common case at boot.
    const { appendToArchive } = await import('./archive.js')
    const s = session('sess-a', [1_000, 2_000])
    await appendToArchive(DAY, s, { skipLLM: true })

    const path = join(root, 'data', 'archive', `${DAY}.json`)
    const before = statSync(path).mtimeMs
    const bytesBefore = readFileSync(path, 'utf8')

    await new Promise(r => setTimeout(r, 20))
    await appendToArchive(DAY, s, { skipLLM: true })

    expect(statSync(path).mtimeMs).toBe(before)
    expect(readFileSync(path, 'utf8')).toBe(bytesBefore)
  })

  it('renumbers ids contiguously and orders chats by start time', async () => {
    const { appendToArchive } = await import('./archive.js')
    await appendToArchive(DAY, session('sess-b', [5_000, 6_000]), { skipLLM: true })
    await appendToArchive(DAY, session('sess-a', [1_000, 2_000]), { skipLLM: true })

    const archive = await load(DAY)
    expect(archive?.chats.map(c => c.id)).toEqual([0, 1])
    expect(archive?.chats.map(c => c.sessionId)).toEqual(['sess-a', 'sess-b'])
  })

  it('SELF-HEALS a file already carrying duplicates from before the fix', async () => {
    // Simulates a day file written by the old blind-append code: the same chat three
    // times. The next append collapses it rather than requiring a separate migration.
    const { appendToArchive } = await import('./archive.js')
    const s = session('sess-a', [1_000, 2_000])
    await appendToArchive(DAY, s, { skipLLM: true })

    const path = join(root, 'data', 'archive', `${DAY}.json`)
    const day = JSON.parse(readFileSync(path, 'utf8'))
    day.chats = [day.chats[0], { ...day.chats[0], id: 1 }, { ...day.chats[0], id: 2 }]
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, JSON.stringify(day, null, 2), 'utf8')
    expect(JSON.parse(readFileSync(path, 'utf8')).chats).toHaveLength(3)

    await appendToArchive(DAY, session('sess-b', [5_000]), { skipLLM: true })

    const archive = await load(DAY)
    expect(archive?.chats).toHaveLength(2) // the 3 duplicates collapsed to 1, plus sess-b
    expect(archive?.chats.filter(c => c.sessionId === 'sess-a')).toHaveLength(1)
  })

  it('keeps the most complete copy when healing pre-existing duplicates', async () => {
    const { appendToArchive } = await import('./archive.js')
    await appendToArchive(DAY, session('sess-a', [1_000, 2_000]), { skipLLM: true })

    const path = join(root, 'data', 'archive', `${DAY}.json`)
    const day = JSON.parse(readFileSync(path, 'utf8'))
    const short = day.chats[0]
    // The LONGER duplicate goes FIRST on purpose. With it last, a naive last-wins
    // dedup picks it by accident and this test cannot fail — which is exactly what
    // mutation M3 exposed. Ordered this way, only "keep the most complete" passes.
    day.chats = [{ ...short, id: 0, exchangeCount: 6, endedAt: 9_000 }, { ...short, id: 1 }]
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, JSON.stringify(day, null, 2), 'utf8')

    await appendToArchive(DAY, session('sess-b', [5_000]), { skipLLM: true })

    const archive = await load(DAY)
    const healed = archive?.chats.find(c => c.sessionId === 'sess-a')
    expect(healed?.exchangeCount).toBe(6)
  })
})
