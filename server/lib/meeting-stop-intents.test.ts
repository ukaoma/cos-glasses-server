import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createStopIntentStore,
  savedChunkReplay,
  STOP_INTENT_TERMINAL_RETAIN_MS,
  STOP_INTENT_WAITING_RETAIN_MS,
} from './meeting-stop-intents.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cos-stop-intents-'))
  roots.push(dir)
  return dir
}
const input = (over: Record<string, unknown> = {}) => ({ sessionId: 'meeting_a', finalChunkIndex: 4, source: 'companion', serverInstanceId: 'srv', ...over }) as Parameters<ReturnType<typeof createStopIntentStore>['record']>[0]

describe('stop intent store', () => {
  it('is durable: a second store on the same file (a restart) still knows the Stop', () => {
    const path = join(tempDir(), 'intents.json')
    let clock = 1_000
    const store = createStopIntentStore({ path, now: () => clock })
    expect(store.record(input())).toMatchObject({ ok: true, created: true })
    const reborn = createStopIntentStore({ path, now: () => clock })
    expect(reborn.get('meeting_a')).toMatchObject({ finalChunkIndex: 4, state: 'waiting', receivedAt: 1_000, posts: 1 })
    expect(reborn.waiting().map(intent => intent.sessionId)).toEqual(['meeting_a'])
  })

  it('a repeated Stop is idempotent, and only RAISES the final index', () => {
    let clock = 1_000
    const store = createStopIntentStore({ path: join(tempDir(), 'i.json'), now: () => clock })
    store.record(input())
    clock = 2_000
    expect(store.record(input({ finalChunkIndex: 2 }))).toMatchObject({ ok: true, created: false, raised: false, intent: { finalChunkIndex: 4, posts: 2, receivedAt: 1_000 } })
    expect(store.record(input({ finalChunkIndex: 9 }))).toMatchObject({ ok: true, raised: true, intent: { finalChunkIndex: 9, posts: 3 } })
  })

  it('a saved Stop is final; a revoked one is replaced by the next Stop', () => {
    const store = createStopIntentStore({ path: join(tempDir(), 'i.json') })
    store.record(input())
    store.update('meeting_a', { state: 'revoked', reason: 'chunk_beyond_final' })
    expect(store.record(input({ finalChunkIndex: 7 }))).toMatchObject({ ok: true, created: true, intent: { state: 'waiting', finalChunkIndex: 7, replaced: 'revoked' } })
    store.update('meeting_a', { state: 'saved', savedBy: 'server' })
    expect(store.record(input({ finalChunkIndex: 8 }))).toMatchObject({ ok: false, reason: 'terminal' })
  })

  it('prunes a waiting Stop after two retention horizons and a finished one after a day', () => {
    let clock = 1_000
    const store = createStopIntentStore({ path: join(tempDir(), 'i.json'), now: () => clock })
    store.record(input({ sessionId: 'done_one' }))
    store.update('done_one', { state: 'saved' })
    store.record(input({ sessionId: 'wait_one' }))
    expect(STOP_INTENT_WAITING_RETAIN_MS).toBeLessThan(STOP_INTENT_TERMINAL_RETAIN_MS)
    clock += STOP_INTENT_WAITING_RETAIN_MS
    store.record(input({ sessionId: 'trigger_a' }))
    expect(store.get('wait_one')).not.toBeNull()
    clock += 1
    store.record(input({ sessionId: 'trigger_b' }))
    expect(store.get('wait_one')).toBeNull()
    expect(store.get('done_one')).not.toBeNull()
    clock = 1_000 + STOP_INTENT_TERMINAL_RETAIN_MS + 1
    store.record(input({ sessionId: 'trigger_c' }))
    expect(store.get('done_one')).toBeNull()
  })

  it('a corrupt ledger is set aside, never trusted', () => {
    const dir = tempDir()
    const path = join(dir, 'i.json')
    writeFileSync(path, '{not json')
    const store = createStopIntentStore({ path })
    expect(store.waiting()).toEqual([])
    expect(readdirSync(dir).some(name => name.startsWith('i.json.corrupt.'))).toBe(true)
  })

  it('a malformed entry is skipped', () => {
    const path = join(tempDir(), 'i.json')
    writeFileSync(path, JSON.stringify({ intents: { meeting_a: { sessionId: 'meeting_a', finalChunkIndex: 'x' }, bad_key: { sessionId: 'other' } } }))
    expect(createStopIntentStore({ path }).waiting()).toEqual([])
  })

  it('writes the ledger 0600', () => {
    const path = join(tempDir(), 'i.json')
    createStopIntentStore({ path }).record(input())
    expect(JSON.parse(readFileSync(path, 'utf-8')).schemaVersion).toBe(1)
  })
})

describe('savedChunkReplay', () => {
  it('answers a held chunk with its saved text, a silent one as empty, and an unknown one with null', () => {
    const path = join(tempDir(), 'm.g2-chunks.json')
    writeFileSync(path, JSON.stringify({
      chunkEntries: [
        { chunkIndex: 0, chunk: { text: 'Hello.', speaker: 'MU', elapsed: 0, similarity: 1 } },
        { chunkIndex: 2, chunk: { text: 'Bye.', speaker: 'Ext', elapsed: 20_000, similarity: 0 } },
      ],
    }))
    expect(savedChunkReplay(path, 2, [0, 1, 2])).toEqual({ kind: 'canonical', chunk: { text: 'Bye.', speaker: 'Ext', elapsed: 20_000, similarity: 0 } })
    expect(savedChunkReplay(path, 1, [0, 1, 2])).toEqual({ kind: 'empty' })
    expect(savedChunkReplay(path, 3, [0, 1, 2])).toBeNull()
  })

  it('a missing sidecar answers null (refused as before)', () => {
    expect(savedChunkReplay(join(tempDir(), 'gone.json'), 0, [0])).toBeNull()
  })
})
