import { afterAll, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 6.71.1: Meeting Ask COS search is 'meaning' (embedding search) by default; 'keyword' makes no embedding request.
// The probe is real: a COS scripts folder that the semantic searches accept, with the one function that would
// spawn the embedding scripts replaced by a counter. 'meaning' must reach it, or the zero below proves nothing.
const fixture = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const scripts = mkdtempSync(join(tmpdir(), 'cos-scripts-'))
  mkdirSync(join(scripts, 'venv', 'bin'), { recursive: true })
  for (const f of ['venv/bin/python3', 'bot_memory.py', 'semantic_search.py']) writeFileSync(join(scripts, f), '')
  return { scripts, embeddings: [] as string[][] }
})
vi.mock('./python-bridge.js', async original => ({ ...(await original<typeof import('./python-bridge.js')>()), COS_SCRIPTS_DIR: fixture.scripts, PYTHON_BIN: join(fixture.scripts, 'venv', 'bin', 'python3') }))
vi.mock('./meeting-ask-search-process.js', async original => ({ ...(await original<typeof import('./meeting-ask-search-process.js')>()), runBoundedSearch: vi.fn(async (_bin: string, args: string[]) => { fixture.embeddings.push(args); return '[]' }) }))
import { searchAskHistory } from './live-cos-ask.js'
import { MeetingAskRuntime, MEETING_ASK_CAPABILITIES } from './meeting-ask-runtime.js'
import { MeetingAskStore } from './meeting-ask-store.js'

const dirs: string[] = []
afterAll(() => rmSync(fixture.scripts, { recursive: true, force: true }))
afterEach(() => { fixture.embeddings.length = 0; while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'ask-cos-')); dirs.push(d); return d }
const signal = () => new AbortController().signal

describe('COS search mode: embedding requests', () => {
  it('meaning (the default) runs both embedding searches; keyword runs none and says so', async () => {
    const meaning = await searchAskHistory('pricing decision', undefined, signal())
    expect(fixture.embeddings.map(a => a[0].split('/').pop())).toEqual(['bot_memory.py', 'semantic_search.py'])
    expect(meaning.notices.join(' ')).not.toContain('keywords only')
    fixture.embeddings.length = 0
    const keyword = await searchAskHistory('pricing decision', undefined, signal(), 'keyword')
    expect(fixture.embeddings).toEqual([])
    expect(keyword.notices).toContain('COS search used keywords only, as set in Meeting assistant settings.')
    expect(keyword.notices.join(' ')).not.toContain('semantic search is unavailable')
  })
})

function runtime(dir: string, extra: Record<string, unknown> = {}) {
  const store = new MeetingAskStore(dir)
  const search = vi.fn(async (_q: string, _s?: string, _signal?: AbortSignal, _mode?: string) => ({ sources: [], notices: [] }))
  const run = vi.fn()
    .mockResolvedValueOnce({ text: JSON.stringify({ sections: [], searchQuery: 'earlier pricing' }), model: 'haiku' })
    .mockResolvedValue({ text: JSON.stringify({ sections: [{ label: 'So what', text: 'Nothing earlier [T1].' }] }), model: 'haiku' })
  const rt = new MeetingAskRuntime({ store, identity: () => 'server-one', admissions: () => true, lease: () => ({ release() {} } as any), catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'haiku', models: ['haiku', 'sonnet'] }] as any, run, search, webCapability: () => ({ available: false, reason: 'test' }), ...extra })
  return { rt, store, search, run }
}
const submit = (rt: MeetingAskRuntime, requestId: string, action = 'ask') => rt.submit({ requestId, sessionId: 'meeting_cos_search', serverInstanceId: 'server-one', action, question: action === 'ask' ? 'Did we decide this before?' : '', elapsedMs: 1000, turns: [{ id: 0, elapsedMs: 0, speaker: 'A', text: 'Pricing again.' }] } as any)
async function done(rt: MeetingAskRuntime, id: string) { for (let i = 0; i < 200 && ['pending', 'running'].includes(rt.get(id).status); i++) await new Promise(r => setTimeout(r, 2)); return rt.get(id) }

describe('COS search mode: the Meeting Ask setting', () => {
  it('defaults to meaning, is advertised, and PUT {cosSearch} alone changes only it and survives a restart', async () => {
    const dir = temp(), { rt } = runtime(dir)
    const before = await rt.config()
    expect(before.cosSearch).toBe('meaning'); expect(before.capabilities.cosSearchMode).toBe(true); expect(MEETING_ASK_CAPABILITIES.cosSearchMode).toBe(true)
    const after = await rt.setConfig({ cosSearch: 'keyword' })
    expect(after.cosSearch).toBe('keyword'); expect(after.selected).toEqual(before.selected)
    expect((await runtime(dir).rt.config()).cosSearch).toBe('keyword')
    expect((await rt.setConfig({ engine: 'claude', model: 'sonnet' })).cosSearch).toBe('keyword')
    expect((await rt.setConfig({ engine: 'claude', model: 'haiku', cosSearch: 'meaning' }))).toMatchObject({ cosSearch: 'meaning', selected: { model: 'haiku' } })
  })
  it('refuses a bad value and writes nothing, not even a valid model sent with it', async () => {
    const dir = temp(), { rt } = runtime(dir)
    for (const bad of [{ cosSearch: 'semantic' }, { cosSearch: null }, { engine: 'claude', model: 'sonnet', cosSearch: 'KEYWORD' }]) {
      await expect(rt.setConfig(bad)).rejects.toMatchObject({ reason: 'invalid_cos_search' })
    }
    expect(await rt.config()).toMatchObject({ cosSearch: 'meaning', selected: { model: 'sonnet' } })
    await expect(rt.setConfig({})).rejects.toMatchObject({ reason: 'invalid_model' })
    await expect(runtime(dir, { admissions: () => false }).rt.setConfig({ cosSearch: 'keyword' })).rejects.toMatchObject({ reason: 'maintenance' })
    expect((await rt.config()).cosSearch).toBe('meaning')
  })
  it('every Meeting Ask COS search uses the setting: typed asks, What to ask and the legacy route', async () => {
    const dir = temp()
    const a = runtime(dir)
    await submit(a.rt, 'request_cos00001'); await done(a.rt, 'request_cos00001')
    expect(a.search.mock.calls[0][3]).toBe('meaning')
    await a.rt.setConfig({ cosSearch: 'keyword' })
    const b = runtime(dir)
    await submit(b.rt, 'request_cos00002'); await done(b.rt, 'request_cos00002')
    expect(b.search.mock.calls[0][3]).toBe('keyword')
    const c = runtime(dir)
    await submit(c.rt, 'request_cos00003', 'questions'); expect((await done(c.rt, 'request_cos00003')).status).toBe('completed')
    expect(c.search.mock.calls[0][3]).toBe('keyword')
    const d = runtime(dir, { run: vi.fn().mockResolvedValueOnce({ text: JSON.stringify({ sections: [], searchQuery: 'x' }), model: 'claude-haiku' }).mockResolvedValue({ text: JSON.stringify({ sections: [{ label: 'So what', text: 'y [T1]' }] }), model: 'claude-haiku' }) })
    await d.rt.legacy({ sessionId: 'meeting_cos_search', action: 'ask', question: 'Before?', elapsedMs: 1000, turns: [{ id: 0, elapsedMs: 0, speaker: 'A', text: 'x' }], history: [] }, signal())
    expect(d.search.mock.calls[0][3]).toBe('keyword')
  })
})
