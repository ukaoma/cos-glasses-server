// 6.62.0 (plans 1.8, 3.3): reading a Cursor session's model, and mapping it to a flat slug.
//
// Real SQLite files built with /usr/bin/sqlite3 in a temp dir whose path has a space and a
// dot component. Never the live ~/.cursor or Cursor's state.vscdb.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  COMPOSER_MODEL_TTL_MS,
  SQLITE3_BIN,
  __resetCursorSessionModelCachesForTests,
  cliChatLastWriteMs,
  cursorModelReadStats,
  cursorSlugCandidates,
  pickListedCursorModel,
  readCliChatFacts,
  readComposerFacts,
} from './cursor-session-model'
import { REPORTED_MODEL_RE } from './session-continue-facts'

const COMPOSER = 'cb97612a-8a47-455d-b2e0-65b394fbbb1d'
const OTHER = 'da2e661c-293a-4c7f-a8d6-6cd788b84c2e'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cursor model '))
  __resetCursorSessionModelCachesForTests()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function sql(db: string, statement: string): void {
  execFileSync(SQLITE3_BIN, [db, statement])
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`

const GROK_XHIGH_FAST = {
  modelName: 'grok-4.7',
  maxMode: true,
  selectedModels: [{ modelId: 'grok-4.7', parameters: [
    { id: 'context', value: '500k' }, { id: 'reasoning_effort', value: 'xhigh' }, { id: 'fast', value: 'true' },
  ] }],
}

describe('cursorSlugCandidates', () => {
  it('maps family + reasoning_effort + fast to a flat slug, most specific first (C5)', () => {
    expect(cursorSlugCandidates(GROK_XHIGH_FAST)).toEqual(['grok-4.7-xhigh-fast', 'grok-4.7-xhigh', 'grok-4.7-fast', 'grok-4.7'])
    expect(cursorSlugCandidates({ modelName: 'composer-2.5', selectedModels: [{ modelId: 'composer-2.5', parameters: [{ id: 'fast', value: true }] }] }))
      .toEqual(['composer-2.5-fast', 'composer-2.5'])
    expect(cursorSlugCandidates({ modelName: 'claude-opus-5.5' })).toEqual(['claude-opus-5.5'])
  })

  it('never builds a bracket id or a value that is not a slug', () => {
    expect(cursorSlugCandidates({ modelName: 'grok-4.7[effort=low]' })).toEqual([])
    expect(cursorSlugCandidates({ modelName: '--force' })).toEqual([])
    expect(cursorSlugCandidates({ selectedModels: [{ modelId: 'grok-4.7', parameters: [{ id: 'reasoning_effort', value: 'x y' }] }] })).toEqual(['grok-4.7'])
    expect(cursorSlugCandidates(null)).toEqual([])
  })

  it('every slug it can produce meets the lens rule for reported_model', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      for (const fast of ['true', 'false']) {
        for (const slug of cursorSlugCandidates({ selectedModels: [{ modelId: 'grok-4.7', parameters: [{ id: 'reasoning_effort', value: effort }, { id: 'fast', value: fast }] }] })) {
          expect(REPORTED_MODEL_RE.test(slug), slug).toBe(true)
          expect(slug.length).toBeLessThanOrEqual(100)
        }
      }
    }
  })

  it('takes the first candidate the installed Cursor lists', () => {
    const listed = new Set(['grok-4.7-xhigh-fast', 'grok-4.7-high-fast'])
    expect(pickListedCursorModel(cursorSlugCandidates(GROK_XHIGH_FAST), id => listed.has(id))).toBe('grok-4.7-xhigh-fast')
    expect(pickListedCursorModel(['nope-1', 'nope-2'], id => listed.has(id))).toBeNull()
    expect(pickListedCursorModel(['x'], () => { throw new Error('boom') })).toBeNull()
  })
})

describe('readComposerFacts (state.vscdb, exact keys)', () => {
  function composerDb(): string {
    const dir = join(root, '.config', 'globalStorage')
    mkdirSync(dir, { recursive: true })
    const db = join(dir, 'state.vscdb')
    sql(db, 'CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    const value = JSON.stringify({
      composerId: COMPOSER,
      name: 'A name the names query owns',
      modelConfig: GROK_XHIGH_FAST,
      workspaceIdentifier: { id: 'b215', uri: { fsPath: '/Users/me/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff' } },
    })
    sql(db, `INSERT INTO cursorDiskKV VALUES (${quote(`composerData:${COMPOSER}`)}, ${quote(value)})`)
    sql(db, `INSERT INTO cursorDiskKV VALUES ('composerData:not-a-uuid', '{"modelConfig":{"modelName":"evil"}}')`)
    return db
  }

  it('reads modelConfig and the workspace for the asked ids only, in one query', async () => {
    const db = composerDb()
    const facts = await readComposerFacts([COMPOSER, OTHER, "x'); DROP TABLE cursorDiskKV; --"], db, { now: 1_000 })
    expect(facts.get(COMPOSER)?.modelConfig).toEqual(GROK_XHIGH_FAST)
    expect(facts.get(COMPOSER)?.workspace).toBe('/Users/me/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff')
    expect(facts.get(OTHER)).toBeNull()
    expect(facts.size).toBe(2)
    expect(cursorModelReadStats.composerQueries).toBe(1)
  })

  it('caches each id for 60 s, including a miss, then reads again', async () => {
    const db = composerDb()
    await readComposerFacts([COMPOSER, OTHER], db, { now: 1_000 })
    await readComposerFacts([COMPOSER, OTHER], db, { now: 59_000 })
    expect(cursorModelReadStats.composerQueries).toBe(1)
    await readComposerFacts([COMPOSER], db, { now: 61_001 })
    expect(cursorModelReadStats.composerQueries).toBe(2)
  })

  it('answers empty, never throws, for a missing database or a failing reader', async () => {
    expect((await readComposerFacts([COMPOSER], join(root, 'nope.vscdb'))).size).toBe(0)
    const db = composerDb()
    const failed = await readComposerFacts([COMPOSER], db, { now: 1_000, run: async () => { throw new Error('timeout') } })
    expect(failed.get(COMPOSER)).toBeNull()
    // 6.62.0 /qa (W11): a failure is cached for the same 60 s as an answer: no second
    // query inside the window, a fresh one after it.
    expect((await readComposerFacts([COMPOSER], db, { now: 1_000 + COMPOSER_MODEL_TTL_MS - 1 })).get(COMPOSER)).toBeNull()
    expect(cursorModelReadStats.composerQueries).toBe(1)
    expect((await readComposerFacts([COMPOSER], db, { now: 1_000 + COMPOSER_MODEL_TTL_MS })).get(COMPOSER)?.modelConfig).toEqual(GROK_XHIGH_FAST)
    expect(cursorModelReadStats.composerFailures).toBe(1)
  })

  it('caches a failed CLI chat read for 60 s too (W11)', async () => {
    const dir = join(root, '.cursor', 'chats', 'h', OTHER)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'store.db'), 'not a database')
    let runs = 0
    const run = async () => { runs += 1; throw new Error('SQLITE_NOTADB') }
    expect(await readCliChatFacts(dir, { run, now: 5_000 })).toBeNull()
    expect(await readCliChatFacts(dir, { run, now: 5_000 + COMPOSER_MODEL_TTL_MS - 1 })).toBeNull()
    expect(runs).toBe(1)
    expect(await readCliChatFacts(dir, { run, now: 5_000 + COMPOSER_MODEL_TTL_MS })).toBeNull()
    expect(runs).toBe(2)
  })
})

describe('readCliChatFacts (store.db, immutable)', () => {
  function chat(blobs: string[], meta: Record<string, unknown> | null): string {
    const dir = join(root, '.cursor', 'chats', 'b8880bc6', OTHER)
    mkdirSync(dir, { recursive: true })
    const db = join(dir, 'store.db')
    sql(db, 'CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);')
    blobs.forEach((blob, index) => sql(db, `INSERT INTO blobs VALUES ('b${index}', CAST(${quote(blob)} AS BLOB))`))
    if (meta) sql(db, `INSERT INTO meta VALUES ('0', ${quote(Buffer.from(JSON.stringify(meta)).toString('hex'))})`)
    return dir
  }

  it('reads the newest modelName and the hex-encoded meta mode', async () => {
    const dir = chat([
      '{"content":[{"providerOptions":{"cursor":{"modelName":"composer-2.5-fast"}}}]}',
      '{"role":"user","content":"hello"}',
      '{"content":[{"providerOptions":{"cursor":{"modelName":"grok-4.7-low-fast"}}}]}',
    ], { agentId: OTHER, mode: 'ask', isRunEverything: false })
    expect(await readCliChatFacts(dir)).toEqual({ model: 'grok-4.7-low-fast', mode: 'ask' })
  })

  it('caches on the file stat and re-reads when store.db changes', async () => {
    const dir = chat(['{"providerOptions":{"cursor":{"modelName":"grok-4.7-low-fast"}}}'], { mode: 'default' })
    await readCliChatFacts(dir)
    await readCliChatFacts(dir)
    expect(cursorModelReadStats.chatQueries).toBe(1)
    sql(join(dir, 'store.db'), `INSERT INTO blobs VALUES ('z', CAST('{"providerOptions":{"cursor":{"modelName":"opus-5.5-high"}}}' AS BLOB))`)
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(dir, 'store.db'), later, later)
    expect((await readCliChatFacts(dir))?.model).toBe('opus-5.5-high')
  })

  it('is null for a missing store, and drops a modelName that is not a slug', async () => {
    expect(await readCliChatFacts(join(root, 'nowhere'))).toBeNull()
    const dir = chat(['{"providerOptions":{"cursor":{"modelName":"bad name; rm -rf"}}}'], null)
    expect(await readCliChatFacts(dir)).toEqual({ model: null, mode: null })
  })

  it('reports the newest write across store.db, its WAL and the transcript', () => {
    const dir = join(root, '.cursor', 'chats', 'h', OTHER)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'store.db'), 'x')
    const transcript = join(root, 'transcript.jsonl')
    writeFileSync(transcript, '{}')
    const old = new Date(Date.now() - 120_000)
    utimesSync(join(dir, 'store.db'), old, old)
    const now = new Date()
    utimesSync(transcript, now, now)
    expect(Math.abs((cliChatLastWriteMs(dir, transcript) ?? 0) - now.getTime())).toBeLessThan(1_000)
    expect(cliChatLastWriteMs(join(root, 'none'), null)).toBeNull()
  })
})
