import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let draftDir = ''

async function loadStore() {
  vi.resetModules()
  draftDir = mkdtempSync(join(tmpdir(), 'cos-prompt-drafts-'))
  process.env.COS_PROMPT_DRAFT_DIR = draftDir
  return import('./prompt-draft-store.js')
}

beforeEach(() => { delete process.env.COS_PROMPT_DRAFT_DIR })
afterEach(() => {
  if (draftDir && existsSync(draftDir)) rmSync(draftDir, { recursive: true, force: true })
  delete process.env.COS_PROMPT_DRAFT_DIR
})

describe('prompt draft store', () => {
  it('creates drafts and idempotently records chunks by index', async () => {
    const store = await loadStore()
    const draft = store.createPromptDraft()
    await store.savePromptDraftChunk(draft.draftId, 0, Buffer.from('chunk-a'))
    const replay = await store.savePromptDraftChunk(draft.draftId, 0, Buffer.from('chunk-a'))
    expect(replay.receivedChunkIndexes).toEqual([0])
    expect(store.readPromptDraftChunks(draft.draftId)).toHaveLength(1)
    expect(statSync(join(draftDir, draft.draftId)).mode & 0o777).toBe(0o700)
    expect(statSync(join(draftDir, draft.draftId, 'meta.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(draftDir, draft.draftId, 'chunk-00000.wav')).mode & 0o777).toBe(0o600)
  })

  it('adopts a client recovery id once and remaps a collision', async () => {
    const store = await loadStore()
    const first = store.createPromptDraft('pd_client_1')
    const second = store.createPromptDraft('pd_client_1')
    expect(first.draftId).toBe('pd_client_1')
    expect(second.draftId).not.toBe(first.draftId)
  })

  it('same-hash replay preserves a transcript while changed bytes invalidate it', async () => {
    const store = await loadStore()
    const draft = store.createPromptDraft()
    const audio = Buffer.from('same-audio')
    await store.savePromptDraftChunk(draft.draftId, 0, audio)
    await store.markPromptDraftChunkTranscript(draft.draftId, 0, 'cached')
    await store.savePromptDraftChunk(draft.draftId, 0, audio)
    expect(store.loadPromptDraftMeta(draft.draftId)?.chunkTranscripts?.['0']).toBe('cached')
    await store.savePromptDraftChunk(draft.draftId, 0, Buffer.from('different'))
    expect(store.loadPromptDraftMeta(draft.draftId)?.chunkTranscripts?.['0']).toBeUndefined()
  })

  it('reports missing indexes and quarantines corrupt metadata', async () => {
    const store = await loadStore()
    const draft = store.createPromptDraft()
    await store.savePromptDraftChunk(draft.draftId, 0, Buffer.from('a'))
    const meta = await store.savePromptDraftChunk(draft.draftId, 2, Buffer.from('c'))
    expect(store.getMissingChunkIndexes(meta)).toEqual([1])

    const badDir = join(draftDir, 'bad')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'meta.json'), '{not json')
    expect(store.loadPromptDraftMeta('bad')).toBeNull()
    expect(readdirSync(badDir).some(name => name.startsWith('meta.json.corrupt-'))).toBe(true)
  })

  it('prunes expired draft directories', async () => {
    const store = await loadStore()
    const draft = store.createPromptDraft()
    const metaPath = join(draftDir, draft.draftId, 'meta.json')
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    meta.expiresAt = new Date(Date.now() - 1000).toISOString()
    writeFileSync(metaPath, JSON.stringify(meta))
    expect(store.prunePromptDrafts()).toBe(1)
    expect(existsSync(join(draftDir, draft.draftId))).toBe(false)
  })
})
