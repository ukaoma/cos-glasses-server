import { afterAll, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAskTranscript, readBoundedFile, type AskTranscriptSources } from './meeting-ask-transcript.js'
import { MeetingStore } from './meeting-store.js'
// 6.71.1: an ended meeting stays askable from its saved record.
const ID = 'meeting_1791700000000_abcdef'
const START = Date.UTC(2026, 9, 11, 15, 26)
const chunk = (text: string, elapsed: number, speaker = 'Person A') => ({ text, elapsed, speaker, similarity: 0.9 })
const none: AskTranscriptSources = { live: () => null, status: () => ({ state: 'missing' }), activeFile: () => null, saved: () => null, read: () => null, now: () => START + 20 * 60_000 }

describe('Meeting Ask transcript sources', () => {
  it('live: the in-memory session, chunk indices as ids, no ended flag', () => {
    const t = resolveAskTranscript(ID, { ...none, live: () => ({ startTime: START, entries: [{ chunkIndex: 0, chunk: chunk('Hello', 1000) }, { chunkIndex: 1, chunk: chunk('', 2000) }, { chunkIndex: 2, chunk: chunk('Key sk-abcdefghijklmnopqrstuvwx', 3000, 'You') }] }) })
    expect(t.turns.map(x => x.id)).toEqual([0, 2]); expect(t.turns[1].text).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(t.elapsedMs).toBe(20 * 60_000); expect(t.ended).toBeUndefined(); expect(t.source).toBe('live'); expect(t.notices).toEqual([])
  })
  describe('ended, from a real MeetingStore save', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-transcript-'))
    const store = new MeetingStore(join(dir, 'recordings'))
    const chunks = [chunk('We picked the annual plan.', 6000), chunk('I will send the sheet.', 61_000, 'You'), chunk('Rollout owner is open.', 900_000, 'Person B')]
    store.save({ sessionId: ID, startTime: START, durationMs: 969_000, title: '', domain: 'personal', transcript: chunks.map(c => `[${c.speaker}]: ${c.text}`).join('\n'), chunks, chunkEntries: chunks.map((c, i) => ({ chunkIndex: i * 2, chunk: c })) } as any)
    const saved: AskTranscriptSources = { ...none, saved: id => store.findBySessionId(id), read: readBoundedFile }
    it('ended within the hour: the saved sidecar, same chunk ids, ended with the close time', () => {
      const closed = new Date(START + 16 * 60_000).toISOString()
      const t = resolveAskTranscript(ID, { ...saved, status: () => ({ state: 'closed', lastActivityAt: closed }) })
      expect(t.turns.map(x => [x.id, x.speaker, x.elapsedMs])).toEqual([[0, 'Person A', 6000], [2, 'You', 61_000], [4, 'Person B', 900_000]])
      expect(t).toMatchObject({ ended: true, endedAt: closed, source: 'saved', elapsedMs: 969_000 })
      expect(t.notices[0]).toBe('This meeting has ended. Answers use its saved transcript.')
    })
    it('ended long ago but saved: no close record, so endedAt is start plus duration', () => {
      const t = resolveAskTranscript(ID, saved)
      expect(t.turns).toHaveLength(3); expect(t.endedAt).toBe(new Date(START + 969_000).toISOString()); expect(t.ended).toBe(true)
    })
    it('a saved record with no chunk metadata falls back to the Markdown transcript, without times', () => {
      const record = store.findBySessionId(ID)!
      const t = resolveAskTranscript(ID, { ...saved, read: path => path === record.sidecarPath ? '{"sessionId":"' + ID + '","schemaVersion":1}' : readBoundedFile(path) })
      expect(t.turns.map(x => [x.speaker, x.text])).toEqual([['Person A', 'We picked the annual plan.'], ['You', 'I will send the sheet.'], ['Person B', 'Rollout owner is open.']])
      expect(t.notices).toContain('Turn times are not available for this saved transcript.')
    })
    it('a sidecar naming another session is not used for this one', () => {
      const record = store.findBySessionId(ID)!
      const t = resolveAskTranscript(ID, { ...saved, read: path => path === record.sidecarPath ? JSON.stringify({ sessionId: 'meeting_other', chunks: [chunk('Not this meeting', 1)] }) : readBoundedFile(path) })
      expect(t.turns.map(x => x.text)).not.toContain('Not this meeting')
    })
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
  })
  it('an unsaved capture still on disk answers from the durable active-session file', () => {
    const file = JSON.stringify({ sessionId: ID, startTime: START, lastActivityAt: START + 300_000, chunksIndexed: [{ i: 3, c: chunk('Still on disk', 290_000) }], chunks: [chunk('Still on disk', 290_000)] })
    const t = resolveAskTranscript(ID, { ...none, activeFile: () => file })
    expect(t.turns).toEqual([{ id: 3, elapsedMs: 290_000, speaker: 'Person A', text: 'Still on disk' }])
    expect(t).toMatchObject({ ended: true, source: 'active_file', elapsedMs: 300_000, endedAt: new Date(START + 300_000).toISOString() })
  })
  it('truly gone: 404 meeting_transcript_unavailable, also for empty or unreadable records', () => {
    for (const deps of [none, { ...none, activeFile: () => '{not json' }, { ...none, saved: () => ({ sidecarPath: '/nope.json', filepath: '/nope.md' }) }, { ...none, activeFile: () => JSON.stringify({ sessionId: ID, chunks: [chunk('  ', 1)] }) }]) {
      expect(() => resolveAskTranscript(ID, deps)).toThrow(expect.objectContaining({ reason: 'meeting_transcript_unavailable', status: 404 }))
    }
  })
  it('readBoundedFile refuses symlinks and missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-read-'))
    try {
      mkdirSync(join(dir, 'd')); writeFileSync(join(dir, 'f.json'), '{}')
      symlinkSync(join(dir, 'f.json'), join(dir, 'link.json'))
      expect(readBoundedFile(join(dir, 'link.json'))).toBeNull()
      expect(readBoundedFile(join(dir, 'f.json'))).toBe('{}'); expect(readBoundedFile(join(dir, 'missing'))).toBeNull(); expect(readBoundedFile(join(dir, 'd'))).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
