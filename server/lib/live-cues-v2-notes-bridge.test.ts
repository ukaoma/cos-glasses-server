// The notes fallback over the REAL searchers (searchMemories, searchMeetingLibrary, the memory bridge), with a scratch
// COS scripts dir shaped like the public memory runtime: cos_api_bridge.py answers `memory` and nothing else, and there is
// no cue_memory.py. COS_SCRIPTS_DIR is read when python-bridge.ts loads, so it is set before any import.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'cues-notes-bridge-'))
const scripts = join(root, 'runtime')
const context = join(root, 'context')
const data = join(root, 'data')
mkdirSync(join(scripts, 'venv', 'bin'), { recursive: true })
symlinkSync('/usr/bin/python3', join(scripts, 'venv', 'bin', 'python3'))
writeFileSync(join(scripts, 'cos_api_bridge.py'), [
  'import json, sys',
  "if sys.argv[1:2] == ['memory'] and '--limit' in sys.argv:",
  '    print(json.dumps([{"id": "mem_pool_1", "content": "The pool contractor Delgado quoted 18500 for the resurfacing and wants a deposit by Friday.", "created_at": "2026-10-10T12:00:00+00:00"},',
  '                      {"id": "mem_swim", "content": "Talia has swim practice on Tuesdays.", "created_at": "2026-10-11T12:00:00+00:00"}]))',
  'else:',
  '    print(json.dumps({"error": "capability_not_available_in_public_file_runtime", "retryable": False}))',
  '',
].join('\n'))
mkdirSync(join(context, 'memory'), { recursive: true })
writeFileSync(join(context, 'memory', 'pebble-finish.md'), '# Pebble finish\n\nGrace prefers the pebble finish for the pool. Delgado said it adds a week.\n')
const saved = { ...process.env }
process.env.COS_SCRIPTS_DIR = scripts
process.env.COS_CONTEXT_DIR = context
process.env.COS_DATA_DIR = data
process.env.COS_PROFILE_PATH = join(data, '.cos-profile.json')
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))

const { notesMemory } = await import('./live-cues-v2-notes.js')
const { getMeetingStore } = await import('./meeting-store.js')
const { cueMemory, liveCuesV2Capability, shutdownLiveCuesV2 } = await import('./live-cues-v2.js')
const chunk = (text: string, elapsed: number) => ({ text, elapsed, speaker: 'Person A', similarity: 0.9 })
const chunks = [chunk('Delgado walked the backyard and measured the pool.', 1000), chunk('He will send the resurfacing quote.', 60_000)]
getMeetingStore().save({ sessionId: 'meeting_1791000000000_abcdef', startTime: Date.UTC(2026, 9, 3, 15, 0), durationMs: 900_000, title: 'Backyard pool walkthrough', domain: 'personal',
  transcript: chunks.map(c => `[${c.speaker}]: ${c.text}`).join('\n'), chunks, chunkEntries: chunks.map((c, i) => ({ chunkIndex: i, chunk: c })) } as never)

afterAll(() => { shutdownLiveCuesV2(); process.env = saved; rmSync(root, { recursive: true, force: true }) })

const WINDOW = 'So Delgado came back about the pool. Delgado wants the deposit for the resurfacing by Friday and we still have not picked the pebble finish.'

describe('notes fallback over the real searchers', () => {
  it('finds the owner\'s bridge note, file note and saved meeting with no cue_memory.py, inside the budget', async () => {
    const t0 = Date.now()
    const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA')   // the engine's bound; the markdown note is dated today
    const r = await notesMemory(WINDOW, tomorrow, new AbortController().signal, { sessionId: 'meeting_live' })
    expect(Date.now() - t0).toBeLessThan(3_000)
    const keys = r.notes.map(n => n.key)
    expect(keys).toContain('memory:mem_pool_1')                                   // served by the memory bridge only
    expect(keys.some(k => k.startsWith('memory:') && k !== 'memory:mem_pool_1')).toBe(true)  // the markdown note (searchMemories)
    expect(keys.some(k => k.startsWith('meeting:'))).toBe(true)                   // the saved G2 meeting (searchMeetingLibrary)
    expect(keys).not.toContain('memory:mem_swim')
    expect(r.notes.find(n => n.key === 'memory:mem_pool_1')).toMatchObject({ date: '2026-10-10', title: expect.stringContaining('Delgado') })
  })
  it('the capability says notes when there is no cue_memory.py, and cue_memory once the script exists', async () => {
    process.env.COS_LIVE_CUES_V2 = '1'
    expect(liveCuesV2Capability()).toMatchObject({ memory: 'notes' })
    expect(await cueMemory('w', '2026-10-18', new AbortController().signal)).toEqual({ notes: [], denseError: 'no_cue_memory_script' })
    writeFileSync(join(scripts, 'cue_memory.py'), 'import json\nprint(json.dumps({"notes": [{"id": "M1", "date": "2026-10-01", "title": "Q4", "notes": "n", "key": "k"}]}))\n')
    shutdownLiveCuesV2()                                                          // the memory source is cached for a minute per engine
    expect(liveCuesV2Capability()).toMatchObject({ memory: 'cue_memory' })
    expect((await cueMemory('w', '2026-10-18', new AbortController().signal)).notes.map(n => n.title)).toEqual(['Q4'])
  })
})
