import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { requireApiToken } from '../lib/api-auth.js'
import { dataPath } from '../lib/data-dir.js'
import { clearProfileCache, getVocabulary, getWhisperCorrections } from '../lib/profile.js'
import { resetDecoderCaches } from '../lib/whisper-local.js'
import { createTranscriptCleanupRouter, transcriptCleanupAdvertised, type TranscriptCleanupRouteDeps } from './transcript-cleanup.js'
import { glossaryRouter } from './glossary.js'
import { TranscriptCleanupBudget, TranscriptCleanupSettings } from '../lib/transcript-cleanup-state.js'
import { SuggestionStore } from '../lib/transcript-cleanup-suggestions.js'
import { appendLedger, newEditId, sha256 } from '../lib/transcript-cleanup-ledger.js'
import { readScreenContext, sweepTranscriptCleanupData, sessionFile } from '../lib/transcript-cleanup-screen.js'

const TOKEN = 'test-token-transcript-cleanup'
const SESSION = 'meeting_route_cleanup'
const NOW = Date.UTC(2026, 9, 18, 3, 0, 0)

let servers: Server[] = []
let roots: string[] = []
beforeEach(() => {
  rmSync(dataPath('transcript-cleanup'), { recursive: true, force: true })
  writeFileSync(process.env.COS_PROFILE_PATH!, JSON.stringify({ owner_name: 'Miles Ukaoma', vocabulary: ['Jewel360'], whisper_corrections: '{}' }))
  clearProfileCache()
  resetDecoderCaches()
})
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()))
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  // The profile path is shared by every test file in the run: never leave this owner behind for the next file.
  rmSync(process.env.COS_PROFILE_PATH!, { force: true })
  clearProfileCache()
})

async function start(over: TranscriptCleanupRouteDeps = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cos-cleanup-route-'))
  roots.push(dir)
  const settings = new TranscriptCleanupSettings(join(dir, 'settings.json'))
  const budget = new TranscriptCleanupBudget(join(dir, 'state.json'), () => new Date(NOW))
  const suggestions = new SuggestionStore(join(dir, 'suggestions.json'))
  const meetingPath = join(dir, 'm.md'), sidecarPath = join(dir, 'm.g2-chunks.json')
  const state: { live: Set<string>; saved: Set<string> } = { live: new Set([SESSION]), saved: new Set() }
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', createTranscriptCleanupRouter({
    env: {},
    now: () => new Date(NOW),
    settings, budget, suggestions,
    sessionState: id => (state.live.has(id) ? 'active' : 'missing'),
    sessionStartedAt: () => NOW - 600_000,
    findMeeting: id => (state.saved.has(id) ? { meetingPath, sidecarPath } : null),
    ...over,
  }))
  app.use('/api', glossaryRouter)
  const server = await new Promise<Server>(r => { const l = app.listen(0, '127.0.0.1', () => r(l)) })
  servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const api = (path: string, init: RequestInit = {}, auth = true) => fetch(`${base}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-cos-token': TOKEN } : {}), ...(init.headers ?? {}) },
  })
  return { api, settings, budget, suggestions, state, meetingPath, sidecarPath, dir }
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

describe('auth', () => {
  it('every route needs the token, and with it every route is answered (never an Express 404)', async () => {
    const h = await start()
    const routes: Array<[string, string]> = [
      ['GET', '/api/transcript-cleanup/settings'], ['POST', '/api/transcript-cleanup/settings'],
      ['POST', `/api/meeting/${SESSION}/screen-context`], ['GET', `/api/meeting/${SESSION}/screen-context`], ['DELETE', `/api/meeting/${SESSION}/screen-context`],
      ['GET', `/api/meeting/${SESSION}/transcript-cleanup`], ['POST', `/api/meeting/${SESSION}/transcript-cleanup/undo`],
      ['GET', '/api/transcript-cleanup/suggestions'], ['POST', '/api/transcript-cleanup/suggestions/sug_0000000000000000/accept'],
      ['POST', '/api/transcript-cleanup/suggestions/sug_0000000000000000/dismiss'],
    ]
    for (const [method, path] of routes) {
      expect((await h.api(path, { method, body: method === 'GET' ? undefined : '{}' }, false)).status, `${method} ${path}`).toBe(401)
      const withToken = await h.api(path, { method, body: method === 'GET' ? undefined : '{}' })
      expect(withToken.status, `${method} ${path}`).not.toBe(401)
      const body = await withToken.json() as Record<string, unknown>
      expect(body, `${method} ${path}`).not.toEqual({})
    }
  })
})

describe('screen context route', () => {
  it('stores bounded lines for a live meeting and answers counts, never text', async () => {
    const h = await start()
    const res = await h.api(`/api/meeting/${SESSION}/screen-context`, post({ lines: [
      { at: NOW - 60_000, text: 'Queen Ukaoma joined', app: 'Zoom' },
      { at: new Date(NOW - 30_000).toISOString(), text: 'Agenda: travel' },
      { at: NOW - 20_000, text: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    ] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, protocol: 1, accepted: 2, duplicates: 0, held: 1, truncated: 0, invalid: 0, dropped: 0, stored: 2 })
    const stats = await (await h.api(`/api/meeting/${SESSION}/screen-context`)).json() as Record<string, unknown>
    expect(stats).toMatchObject({ protocol: 1, lines: 2, firstAt: NOW - 60_000, lastAt: NOW - 30_000 })
    expect(JSON.stringify(stats)).not.toMatch(/Ukaoma|Agenda/)
    expect(readScreenContext(SESSION).map(l => l.text)).toEqual(['Queen Ukaoma joined', 'Agenda: travel'])
  })

  it('refuses oversized requests, bad bodies and bad ids', async () => {
    const h = await start()
    const many = Array.from({ length: 101 }, (_, i) => ({ at: NOW, text: `line ${i}` }))
    expect((await h.api(`/api/meeting/${SESSION}/screen-context`, post({ lines: many }))).status).toBe(413)
    expect(await (await h.api(`/api/meeting/${SESSION}/screen-context`, post({ lines: [{ at: NOW, text: 'z'.repeat(40_000) }] }))).json()).toEqual({ error: 'request_too_large' })
    expect((await h.api(`/api/meeting/${SESSION}/screen-context`, post({ lines: 'nope' }))).status).toBe(400)
    expect((await h.api(`/api/meeting/${SESSION}/screen-context`, post([]))).status).toBe(400)
    expect((await h.api('/api/meeting/bad%20id!/screen-context', post({ lines: [{ at: NOW, text: 'x' }] }))).status).toBe(400)
    expect(readScreenContext(SESSION)).toEqual([])
  })

  it('an unknown meeting is 404; a saved one takes a late flush until its cleanup has run (then 409)', async () => {
    const h = await start()
    const lines = { lines: [{ at: NOW - 1_000, text: 'Final slide' }] }
    expect((await h.api('/api/meeting/meeting_unknown/screen-context', post(lines))).status).toBe(404)
    h.state.live.delete(SESSION)
    expect((await h.api(`/api/meeting/${SESSION}/screen-context`, post(lines))).status).toBe(404)
    h.state.saved.add(SESSION)
    expect((await h.api(`/api/meeting/${SESSION}/screen-context`, post(lines))).status).toBe(200)
    appendLedger(SESSION, [{ kind: 'run', runId: 'tc_0000000000000001', phase: 'done', at: new Date(NOW).toISOString(), inputSha: sha256('x'), outputSha: sha256('x') }])
    expect(await (await h.api(`/api/meeting/${SESSION}/screen-context`, post(lines))).json()).toEqual({ error: 'cleanup_done' })
  })

  it('DELETE removes the meeting\'s screen text', async () => {
    const h = await start()
    await h.api(`/api/meeting/${SESSION}/screen-context`, post({ lines: [{ at: NOW, text: 'a slide' }] }))
    expect(existsSync(sessionFile('screen', SESSION)!)).toBe(true)
    expect(await (await h.api(`/api/meeting/${SESSION}/screen-context`, { method: 'DELETE' })).json()).toEqual({ deleted: true })
    expect(existsSync(sessionFile('screen', SESSION)!)).toBe(false)
    expect(await (await h.api(`/api/meeting/${SESSION}/screen-context`, { method: 'DELETE' })).json()).toEqual({ deleted: false })
  })
})

describe('settings route', () => {
  it('off and Haiku by default; the toggle and the model persist; env pins win', async () => {
    const h = await start()
    expect(await (await h.api('/api/transcript-cleanup/settings')).json()).toMatchObject({ protocol: 1, enabled: false, source: 'default', model: 'haiku', modelId: 'claude-haiku-5-5', limits: { dailyCalls: 30, dailyTokens: 400000, maxSpansPerMeeting: 40 }, today: { calls: 0, tokens: 0, breakerOpenUntil: null } })
    expect(await (await h.api('/api/transcript-cleanup/settings', post({ enabled: true, model: 'sonnet' }))).json()).toMatchObject({ enabled: true, source: 'setting', model: 'sonnet', modelId: 'claude-sonnet-5-5' })
    expect(new TranscriptCleanupSettings(h.settings.file).stored()).toEqual({ enabled: true, model: 'sonnet' })
    for (const body of [{}, { enabled: 'yes' }, { model: 'opus' }, []]) expect((await h.api('/api/transcript-cleanup/settings', post(body))).status, JSON.stringify(body)).toBe(400)
    const pinned = await start({ env: { COS_TRANSCRIPT_CLEANUP: '0' } })
    expect((await pinned.api('/api/transcript-cleanup/settings', post({ enabled: true }))).status).toBe(409)
    expect(await (await pinned.api('/api/transcript-cleanup/settings')).json()).toMatchObject({ enabled: false, source: 'env' })
    expect(transcriptCleanupAdvertised({ COS_TRANSCRIPT_CLEANUP: '1' }, h.settings)).toEqual({ protocol: 1, enabled: true })
  })
})

describe('dictionary suggestions', () => {
  function seed(h: Awaited<ReturnType<typeof start>>, written = 'Ukaoma', heard = 'Ukoma') {
    return h.suggestions.record({ written, heard, evidence: [{ source: 'screen', detail: 'Zoom' }], sessionId: SESSION, at: new Date(NOW).toISOString(), inDictionary: () => false })!
  }

  it('lists pending suggestions with their evidence', async () => {
    const h = await start()
    const s = seed(h)
    const body = await (await h.api('/api/transcript-cleanup/suggestions')).json() as { suggestions: Array<Record<string, unknown>> }
    expect(body.suggestions).toEqual([{ ...s, inVocabulary: false }])
    expect(s.id).toMatch(/^sug_[0-9a-f]{16}$/)
    expect((await h.api('/api/transcript-cleanup/suggestions?status=bogus')).status).toBe(400)
  })

  it('dedupes by written form, case-insensitively, and never needs context-free evidence', async () => {
    const h = await start()
    const a = seed(h, 'Ukaoma', 'Ukoma')
    const b = seed(h, 'ukaoma', 'Yukoma')
    expect(b.id).toBe(a.id)
    expect(h.suggestions.list()).toHaveLength(1)
    expect(h.suggestions.list()[0]).toMatchObject({ written: 'Ukaoma', heard: ['Ukoma', 'Yukoma'], count: 2 })
    expect(h.suggestions.record({ written: 'Zebulon', heard: 'Zeb', evidence: [], sessionId: SESSION, at: 'x', inDictionary: () => false })).toBeNull()
    expect(h.suggestions.record({ written: 'Jewel360', heard: 'Joule', evidence: [{ source: 'file', detail: null }], sessionId: SESSION, at: 'x', inDictionary: w => w === 'Jewel360' })).toBeNull()
  })

  it('accept adds the word through the glossary vocabulary writer', async () => {
    const h = await start()
    const s = seed(h)
    const res = await h.api(`/api/transcript-cleanup/suggestions/${s.id}/accept`, post({}))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, any>
    expect(body).toMatchObject({ unchanged: false, entry: null, suggestion: { id: s.id, status: 'accepted', inVocabulary: true } })
    expect(body.glossary.vocabulary).toEqual(['Jewel360', 'Ukaoma'])
    expect(getVocabulary()).toEqual(['Jewel360', 'Ukaoma'])
    expect(getWhisperCorrections()).toEqual({})
    // The glossary's own route reads the same store.
    expect((await (await h.api('/api/transcription-glossary')).json() as any).vocabulary).toEqual(['Jewel360', 'Ukaoma'])
    // An accepted form is never suggested again.
    expect(seed(h)).toBeNull()
  })

  it('accept with correction learns heard to written through the logged, undoable writer', async () => {
    const h = await start()
    const s = seed(h)
    const body = await (await h.api(`/api/transcript-cleanup/suggestions/${s.id}/accept`, post({ correction: true }))).json() as Record<string, any>
    expect(body.entry).toMatchObject({ heard: 'Ukoma', written: 'Ukaoma', source: 'meeting', addedVocabulary: true })
    expect(getWhisperCorrections()).toEqual({ Ukoma: 'Ukaoma' })
    const recent = await (await h.api('/api/transcription-glossary/recent')).json() as any
    expect(recent.entries[0]).toMatchObject({ id: body.entry.id, heard: 'Ukoma' })
    expect((await h.api('/api/transcription-glossary/correction/undo', post({ id: body.entry.id }))).status).toBe(200)
    expect(getWhisperCorrections()).toEqual({})
  })

  it('dismiss keeps the word out for good; accept of a dismissed one is 409; unknown ids 404, bad ids 400', async () => {
    const h = await start()
    const s = seed(h)
    expect(await (await h.api(`/api/transcript-cleanup/suggestions/${s.id}/dismiss`, post({}))).json()).toMatchObject({ suggestion: { status: 'dismissed' } })
    expect(seed(h)).toBeNull()
    expect((await (await h.api('/api/transcript-cleanup/suggestions')).json() as any).suggestions).toEqual([])
    expect((await (await h.api('/api/transcript-cleanup/suggestions?status=all')).json() as any).suggestions).toHaveLength(1)
    expect(await (await h.api(`/api/transcript-cleanup/suggestions/${s.id}/accept`, post({}))).json()).toEqual({ error: 'suggestion_dismissed' })
    expect(getVocabulary()).toEqual(['Jewel360'])
    expect((await h.api('/api/transcript-cleanup/suggestions/sug_ffffffffffffffff/dismiss', post({}))).status).toBe(404)
    expect((await h.api('/api/transcript-cleanup/suggestions/../accept', post({}))).status).not.toBe(200)
    expect((await h.api('/api/transcript-cleanup/suggestions/sug_bad/accept', post({}))).status).toBe(400)
  })
})

describe('undo route and the sweep', () => {
  it('undoes one edit by id', async () => {
    const h = await start()
    h.state.saved.add(SESSION)
    const line = 'Then Ukaoma called back.'
    writeFileSync(h.meetingPath, `# M\n\n## Transcript\n\n[MU]: ${line}\n`)
    writeFileSync(h.sidecarPath, JSON.stringify({ sessionId: SESSION, batchTranscript: `[MU]: ${line}` }))
    const id = newEditId()
    appendLedger(SESSION, [
      { kind: 'run', runId: 'tc_00000000000000aa', phase: 'intent', at: 'a', inputSha: sha256('[MU]: Then U coma called back.') },
      { kind: 'edit', id, runId: 'tc_00000000000000aa', at: 'a', line: 0, offset: 5, original: 'U coma', replacement: 'Ukaoma', before: 'Then ', after: ' called back.', lineSha: sha256(line), source: 'model' },
      { kind: 'run', runId: 'tc_00000000000000aa', phase: 'done', at: 'a', inputSha: sha256('[MU]: Then U coma called back.'), outputSha: sha256(`[MU]: ${line}`) },
    ])
    const view = await (await h.api(`/api/meeting/${SESSION}/transcript-cleanup`)).json() as any
    expect(view).toMatchObject({ protocol: 1, cleanedCurrent: true, edits: [{ id, reverted: false }] })
    expect((await h.api(`/api/meeting/${SESSION}/transcript-cleanup/undo`, post({}))).status).toBe(400)
    expect(await (await h.api(`/api/meeting/${SESSION}/transcript-cleanup/undo`, post({ editId: id }))).json()).toEqual({ reverted: [id] })
    expect(readFileSync(h.meetingPath, 'utf8')).toContain('[MU]: Then U coma called back.')
    expect(JSON.parse(readFileSync(h.sidecarPath, 'utf8')).batchTranscript).toBe('[MU]: Then U coma called back.')
  })

  it('deletes cleanup data whose meeting is gone after the grace period, and screen text past retention', () => {
    const now = Date.now()
    appendLedger('meeting_gone', [{ kind: 'run', runId: 'tc_1', phase: 'done', at: 'a', inputSha: 'x' }])
    appendLedger('meeting_kept', [{ kind: 'run', runId: 'tc_2', phase: 'done', at: 'a', inputSha: 'x' }])
    expect(sweepTranscriptCleanupData({ now, known: id => id === 'meeting_kept' })).toEqual({ screenDeleted: 0, ledgersDeleted: 0 })
    expect(sweepTranscriptCleanupData({ now: now + 4 * 86_400_000, known: id => id === 'meeting_kept' })).toEqual({ screenDeleted: 0, ledgersDeleted: 1 })
    expect(existsSync(sessionFile('ledger', 'meeting_kept')!)).toBe(true)
    expect(existsSync(sessionFile('ledger', 'meeting_gone')!)).toBe(false)
    mkdirSync(dirname(sessionFile('screen', 'meeting_kept')!), { recursive: true })
    writeFileSync(sessionFile('screen', 'meeting_kept')!, '{"at":1,"text":"x"}\n')
    expect(sweepTranscriptCleanupData({ now: now + 31 * 86_400_000, known: () => true })).toEqual({ screenDeleted: 1, ledgersDeleted: 0 })
    expect(existsSync(sessionFile('ledger', 'meeting_kept')!)).toBe(true)
  })
})
