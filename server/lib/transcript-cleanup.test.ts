import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataPath } from './data-dir.js'
import { createNotesSearch, runTranscriptCleanup, type CleanupDeps, type CleanupTrace, type ModelRun } from './transcript-cleanup.js'
import { TranscriptCleanupBudget, TranscriptCleanupSettings, cleanupLimits } from './transcript-cleanup-state.js'
import { SuggestionStore } from './transcript-cleanup-suggestions.js'
import { appendScreenContext, readScreenContext, type ScreenLine } from './transcript-cleanup-screen.js'
import { ledgerView, readLedger, undoCleanupEdits } from './transcript-cleanup-ledger.js'
import { LensGistLimitError } from './lens-gist-engines.js'
import type { OwnerCard } from './meeting-ask-owner.js'

const START = Date.UTC(2026, 9, 18, 2, 32, 0)
const SESSION = 'meeting_cleanup_001'

const OWNER: OwnerCard = { name: 'Jordan Ukamya', speakerLabel: 'MU', homeArea: null, notes: 'Married to Faith Ukamya.' }

let roots: string[] = []
beforeEach(() => { rmSync(dataPath('transcript-cleanup'), { recursive: true, force: true }) })
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

interface Word { word: string; p?: number; t: number }

/** A saved meeting: markdown with a transcript section, and a sidecar with timed, scored batch words. */
function meeting(lines: Array<[string, Word[]]>, engine = 'parakeet-ultra') {
  const dir = mkdtempSync(join(tmpdir(), 'cos-cleanup-'))
  roots.push(dir)
  const section = lines.map(([label, words]) => `[${label}]: ${words.map(w => w.word).join(' ')}`).join('\n')
  const markdown = `# G2 Recording 2026-10-17 2132\n\n| **Date** | 2026-10-17 |\n\n## Transcript\n\n${section}\n`
  const sidecar = {
    sessionId: SESSION,
    title: 'Family logistics',
    startTime: START,
    speakers: ['MU'],
    batchApplied: true,
    batchTranscript: section,
    batchSegments: [{
      startElapsed: 0,
      words: lines.flatMap(([, words]) => words.map(w => ({ word: w.word, start: w.t, end: w.t + 0.3, ...(w.p !== undefined ? { probability: w.p } : {}) }))),
      stt: { engine },
    }],
    lifecycleRevision: 3,
  }
  const meetingPath = join(dir, '2026-10-17_G2_Recording.md')
  const sidecarPath = join(dir, '2026-10-17_G2_Recording.g2-chunks.json')
  writeFileSync(meetingPath, markdown)
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2))
  return { dir, meetingPath, sidecarPath, markdown, sidecarText: JSON.stringify(sidecar, null, 2) }
}

const w = (text: string, t0: number, p = 0.95): Word[] => text.split(' ').map((word, i) => ({ word, p, t: t0 + i * 0.4 }))
const section = (path: string) => readFileSync(path, 'utf8').split('## Transcript\n\n')[1].trimEnd()

/** The reported Ukmya, Yukmya, eucmya and U cmya meeting (Miles, 2026-10-17). */
function ukamyaMeeting() {
  return meeting([
    ['MU', [...w('I talked to Faith', 1), { word: 'Ukmya', p: 0.62, t: 2.6 }, ...w('about the trip.', 3)]],
    ['Ext', [{ word: 'Yukmya', p: 0.41, t: 20 }, ...w('said the flight leaves at 6 and', 20.5), { word: 'eucmya', p: 0.38, t: 24 }, ...w('will not be late.', 24.5)]],
    ['MU', [...w('Then', 40), { word: 'U', p: 0.33, t: 40.5 }, { word: 'cmya', p: 0.44, t: 40.8 }, ...w('called back.', 41.2)]],
  ])
}

interface Harness { deps: Partial<CleanupDeps>; calls: Array<{ model: string; system: string; prompt: string }>; traces: CleanupTrace[]; budget: TranscriptCleanupBudget; settings: TranscriptCleanupSettings; suggestions: SuggestionStore }

function harness(opts: {
  enabled?: boolean
  reply?: (prompt: string) => string | Promise<string>
  fail?: Error
  owner?: OwnerCard | null
  vocabulary?: string[]
  speakers?: string[]
  screen?: ScreenLine[]
  env?: NodeJS.ProcessEnv
  live?: boolean
  now?: () => Date
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cos-cleanup-state-'))
  roots.push(dir)
  const settings = new TranscriptCleanupSettings(join(dir, 'settings.json'))
  if (opts.enabled !== false) settings.save({ enabled: true })
  const now = opts.now ?? (() => new Date(START + 3_600_000))
  const budget = new TranscriptCleanupBudget(join(dir, 'state.json'), now)
  const suggestions = new SuggestionStore(join(dir, 'suggestions.json'))
  const calls: Harness['calls'] = []
  const traces: CleanupTrace[] = []
  const deps: Partial<CleanupDeps> = {
    env: opts.env ?? {},
    now,
    settings,
    budget,
    suggestions,
    sessionLive: () => opts.live === true,
    claudeAvailable: () => true,
    callModel: async (model, system, prompt): Promise<ModelRun> => {
      calls.push({ model, system, prompt })
      if (opts.fail) throw opts.fail
      return { text: opts.reply ? await opts.reply(prompt) : '{"edits":[]}', inputTokens: 1200, outputTokens: 80, model }
    },
    speakers: () => opts.speakers ?? ['Gordon Smith', 'Ilona Jones'],
    vocabulary: () => opts.vocabulary ?? [],
    corrections: () => ({}),
    owner: () => (opts.owner === undefined ? OWNER : opts.owner),
    files: () => [],
    screen: () => opts.screen ?? [],
    searchNotes: async () => [],
    trace: row => { traces.push(row) },
  }
  return { deps, calls, traces, budget, settings, suggestions }
}

/** Reply "Ukamya" for every span that is near Ukamya, keep the rest. */
function replyUkamya(prompt: string): string {
  const edits = [...prompt.matchAll(/^(S\d+)[^\n]*\n {2}[^\n]*\[\[([^\]]+)\]\]/gm)].map(m => (
    /ukamya/i.test(m[0].split('\n')[0]) ? { id: m[1], action: 'replace', text: 'Ukamya' } : { id: m[1], action: 'keep' }))
  return `Here you go:\n\`\`\`json\n${JSON.stringify({ edits })}\n\`\`\`\nAll set.`
}

describe('transcript cleanup end to end (fake Claude provider)', () => {
  it('resolves Ukmya, Yukmya, eucmya and U cmya to Ukamya with the owner card and a screen line', async () => {
    const m = ukamyaMeeting()
    const h = harness({ reply: replyUkamya, screen: [{ at: START + 21_000, text: 'Faith Ukamya | Zoom', app: 'Zoom' }] })
    const out = await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(out.status).toBe('done')
    expect(section(m.meetingPath)).toBe([
      '[MU]: I talked to Faith Ukamya about the trip.',
      '[Ext]: Ukamya said the flight leaves at 6 and Ukamya will not be late.',
      '[MU]: Then Ukamya called back.',
    ].join('\n'))
    // Ukmya is one edit from the owner's surname: fixed for free, never sent.
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].prompt).not.toMatch(/\[\[Ukmya\]\]/)
    expect(h.calls[0].prompt).toMatch(/\[\[Yukmya\]\]/)
    expect(h.calls[0].prompt).toMatch(/\[\[eucmya\]\]/)
    expect(h.calls[0].prompt).toMatch(/\[\[U cmya\]\]/)
    // Textual and screen awareness reached the model.
    expect(h.calls[0].prompt).toContain('this COS belongs to Jordan Ukamya')
    expect(h.calls[0].prompt).toMatch(/screen at 0:21 Zoom: "Faith Ukamya \| Zoom"/)
    expect(h.calls[0].model).toBe('claude-haiku-5-5')
    const ledger = ledgerView(SESSION)
    expect(ledger.edits.map(e => [e.source, e.original, e.replacement])).toEqual([
      ['fuzzy', 'Ukmya', 'Ukamya'], ['model', 'Yukmya', 'Ukamya'], ['model', 'eucmya', 'Ukamya'], ['model', 'U cmya', 'Ukamya'],
    ])
    const sidecar = JSON.parse(readFileSync(m.sidecarPath, 'utf8'))
    expect(sidecar.batchTranscript).toBe(section(m.meetingPath))
    expect(sidecar.lifecycleRevision).toBe(4)
    expect(sidecar.transcriptCleanup).toMatchObject({ version: 1, fixes: 1, edits: 3, liveEdits: 4, model: 'claude-haiku-5-5' })
  })

  it('the trace carries counts, tokens and milliseconds, never transcript or screen text', async () => {
    const m = ukamyaMeeting()
    const h = harness({ reply: replyUkamya, screen: [{ at: START + 21_000, text: 'Faith Ukamya | Zoom' }] })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(h.traces).toHaveLength(1)
    const row = h.traces[0]
    expect(row).toMatchObject({ status: 'done', spansSent: 3, accepted: 3, fixes: 1, inputTokens: 1200, outputTokens: 80, screenLines: 1 })
    expect(row.spansFound).toBeGreaterThanOrEqual(3)
    const text = JSON.stringify(row)
    for (const word of ['Ukmya', 'Yukmya', 'eucmya', 'cmya', 'Faith', 'flight', 'Zoom', 'Ukamya']) expect(text, word).not.toContain(word)
  })

  it('a second run on the cleaned meeting is a no-op (idempotent finalization retry)', async () => {
    const m = ukamyaMeeting()
    const h = harness({ reply: replyUkamya })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    const after = readFileSync(m.meetingPath, 'utf8')
    const again = await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(again).toMatchObject({ status: 'skipped', reason: 'already_done' })
    expect(h.calls).toHaveLength(1)
    expect(readFileSync(m.meetingPath, 'utf8')).toBe(after)
  })

  it('Sonnet is selectable and the model id is always pinned', async () => {
    const m = ukamyaMeeting()
    const h = harness({ reply: replyUkamya })
    h.settings.save({ model: 'sonnet' })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(h.calls[0].model).toBe('claude-sonnet-5-5')
    const env = harness({ reply: replyUkamya, env: { COS_TRANSCRIPT_CLEANUP_MODEL: 'haiku' } })
    env.settings.save({ model: 'sonnet' })
    const m2 = ukamyaMeeting()
    rmSync(dataPath('transcript-cleanup'), { recursive: true, force: true })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m2.meetingPath, sidecarPath: m2.sidecarPath }, env.deps)
    expect(env.calls[0].model).toBe('claude-haiku-5-5')
  })
})

describe('local notes for the names spans are near', () => {
  it('memories and earlier meetings by keyword, the bridge listing when memory finds nothing, never this meeting', async () => {
    const asked: string[] = []
    const search = createNotesSearch({
      memories: async q => { asked.push(`memories:${q}`); return q === 'Ukamya' ? [] : [{ id: 'mem_1', title: 'Gordon note', snippet: 'Gordon Smith runs demand' }] },
      meetings: async q => { asked.push(`meetings:${q}`); return [{ recordId: 'r1', sessionId: SESSION, title: 'this meeting' }, { recordId: 'r2', sessionId: 'other', title: 'Family sync', snippet: 'Faith Ukamya flight' }] },
      bridge: async () => { asked.push('bridge'); return [{ id: 'mem_9', content: 'Faith Ukamya is Miles\'s wife', summary: 'Faith Ukamya' }, { id: 'mem_8', content: 'unrelated' }] },
      score: (rows, q) => rows.filter(r => r.content.includes(q)).map(row => ({ row })),
    })
    const notes = await search(['Gordon', 'Ukamya'], SESSION, new AbortController().signal)
    expect(notes.map(n => [n.ref, n.kind, n.query])).toEqual([
      ['memory:mem_1', 'memory', 'Gordon'], ['meeting:r2', 'meeting', 'Gordon'], ['memory:mem_9', 'memory', 'Ukamya'],
    ])
    // The listing is read only for the name memory search found nothing for.
    expect(asked).toEqual(['memories:Gordon', 'meetings:Gordon', 'memories:Ukamya', 'bridge', 'meetings:Ukamya'])
  })

  it('notes reach the prompt beside the spans, bounded', async () => {
    const m = ukamyaMeeting()
    const h = harness({ reply: replyUkamya })
    let queries: string[] = []
    h.deps.searchNotes = async q => { queries = q; return [{ id: '', ref: 'memory:mem_9', kind: 'memory', title: 'Faith Ukamya', snippet: 'x'.repeat(2000), query: q[0] }] }
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(queries).toEqual(['Ukamya'])
    expect(h.calls[0].prompt).toMatch(/Note N1 \(memory\) "Faith Ukamya": x{200,280}/)
    expect(h.calls[0].prompt).not.toMatch(/x{300}/)
    expect(h.traces[0].notes).toBe(1)
  })
})

describe('stop conditions', () => {
  it('switch off: no call, no file written, the meeting is byte-identical', async () => {
    const m = ukamyaMeeting()
    const h = harness({ enabled: false, reply: replyUkamya })
    const out = await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(out).toEqual({ status: 'skipped', reason: 'switch_off', applied: 0 })
    expect(h.calls).toHaveLength(0)
    expect(h.traces).toHaveLength(0)
    expect(readFileSync(m.meetingPath, 'utf8')).toBe(m.markdown)
    expect(readFileSync(m.sidecarPath, 'utf8')).toBe(m.sidecarText)
    expect(existsSync(dataPath('transcript-cleanup'))).toBe(false)
  })

  it('env COS_TRANSCRIPT_CLEANUP=0 beats a saved on; =1 beats a saved off', async () => {
    const m = ukamyaMeeting()
    const off = harness({ env: { COS_TRANSCRIPT_CLEANUP: '0' }, reply: replyUkamya })
    expect((await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, off.deps)).reason).toBe('switch_off')
    expect(off.calls).toHaveLength(0)
    const on = harness({ enabled: false, env: { COS_TRANSCRIPT_CLEANUP: '1' }, reply: replyUkamya })
    on.settings.save({ enabled: false })
    expect((await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, on.deps)).status).toBe('done')
    expect(on.calls).toHaveLength(1)
  })

  it('a live session is never cleaned', async () => {
    const m = ukamyaMeeting()
    const h = harness({ live: true, reply: replyUkamya })
    expect(await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)).toMatchObject({ status: 'skipped', reason: 'session_live' })
    expect(h.calls).toHaveLength(0)
    expect(readFileSync(m.meetingPath, 'utf8')).toBe(m.markdown)
  })

  it('daily call cap: the model is not asked, fuzzy fixes still apply (correction_skipped style)', async () => {
    const h = harness({ reply: replyUkamya, env: { COS_TRANSCRIPT_CLEANUP_DAILY: '1' } })
    const first = ukamyaMeeting()
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: first.meetingPath, sidecarPath: first.sidecarPath }, h.deps)
    expect(h.calls).toHaveLength(1)
    const second = ukamyaMeeting()
    const out = await runTranscriptCleanup({ sessionId: 'meeting_cleanup_002', meetingPath: second.meetingPath, sidecarPath: second.sidecarPath }, h.deps)
    expect(out).toMatchObject({ status: 'done', modelSkipped: 'daily_calls', applied: 1 })
    expect(h.calls).toHaveLength(1)
    expect(section(second.meetingPath)).toContain('Faith Ukamya about')
    expect(section(second.meetingPath)).toContain('Yukmya said')
    expect(JSON.parse(readFileSync(second.sidecarPath, 'utf8')).transcriptCleanup.modelSkipped).toBe('daily_calls')
  })

  it('daily token cap stops the next call', async () => {
    const h = harness({ reply: replyUkamya, env: { COS_TRANSCRIPT_CLEANUP_DAILY_TOKENS: '1000' } })
    const first = ukamyaMeeting()
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: first.meetingPath, sidecarPath: first.sidecarPath }, h.deps)
    const second = ukamyaMeeting()
    expect((await runTranscriptCleanup({ sessionId: 'meeting_cleanup_002', meetingPath: second.meetingPath, sidecarPath: second.sidecarPath }, h.deps)).modelSkipped).toBe('daily_tokens')
    expect(h.calls).toHaveLength(1)
  })

  it('breaker: three failures in a row open it for 30 minutes, then one trial call', async () => {
    let clock = START + 3_600_000
    const h = harness({ fail: new Error('claude exited 1'), now: () => new Date(clock) })
    for (let i = 0; i < 3; i++) {
      const m = ukamyaMeeting()
      const out = await runTranscriptCleanup({ sessionId: `meeting_cleanup_10${i}`, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
      expect(out.modelSkipped).toBe('model_failed')
      // A failed call never costs the free fixes.
      expect(section(m.meetingPath)).toContain('Faith Ukamya about')
    }
    expect(h.calls).toHaveLength(3)
    const blocked = ukamyaMeeting()
    expect((await runTranscriptCleanup({ sessionId: 'meeting_cleanup_200', meetingPath: blocked.meetingPath, sidecarPath: blocked.sidecarPath }, h.deps)).modelSkipped).toBe('breaker_open')
    expect(h.calls).toHaveLength(3)
    clock += 31 * 60_000
    const trial = ukamyaMeeting()
    expect((await runTranscriptCleanup({ sessionId: 'meeting_cleanup_201', meetingPath: trial.meetingPath, sidecarPath: trial.sidecarPath }, h.deps)).modelSkipped).toBe('model_failed')
    expect(h.calls).toHaveLength(4)
    const again = ukamyaMeeting()
    expect((await runTranscriptCleanup({ sessionId: 'meeting_cleanup_202', meetingPath: again.meetingPath, sidecarPath: again.sidecarPath }, h.deps)).modelSkipped).toBe('breaker_open')
  })

  it('a provider limit opens the breaker at once; a success closes it', async () => {
    const h = harness({ fail: new LensGistLimitError('claude: usage limit reached') })
    const m = ukamyaMeeting()
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(h.budget.gate(cleanupLimits({}))).toBe('breaker_open')
    const b = new TranscriptCleanupBudget(join(roots[0], 'x-state.json'), () => new Date(START))
    b.recordFailure(cleanupLimits({}), false)
    b.recordFailure(cleanupLimits({}), false)
    b.recordSuccess()
    b.recordFailure(cleanupLimits({}), false)
    expect(b.gate(cleanupLimits({}))).toBeNull()
  })

  it('a reply that is not JSON counts as a failure, and nothing from it is applied', async () => {
    const h = harness({ reply: () => 'Sure! Ukamya everywhere.' })
    const m = ukamyaMeeting()
    const out = await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(out.modelSkipped).toBe('model_failed')
    expect(h.traces[0].modelError).toBe('bad_reply')
    expect(h.budget.read().consecutiveFailures).toBe(1)
    expect(section(m.meetingPath)).toContain('Yukmya said')
  })

  it('ANTHROPIC_API_KEY without COS_ALLOW_API_FALLBACK=1, or no Claude CLI, never calls', async () => {
    const m = ukamyaMeeting()
    const h = harness({ reply: replyUkamya, env: { ANTHROPIC_API_KEY: 'test-key-not-real' } })
    expect((await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)).modelSkipped).toBe('api_key_in_env')
    expect(h.calls).toHaveLength(0)
    const allowed = harness({ reply: replyUkamya, env: { ANTHROPIC_API_KEY: 'test-key-not-real', COS_ALLOW_API_FALLBACK: '1' } })
    const m2 = ukamyaMeeting()
    rmSync(dataPath('transcript-cleanup'), { recursive: true, force: true })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m2.meetingPath, sidecarPath: m2.sidecarPath }, allowed.deps)
    expect(allowed.calls).toHaveLength(1)
    const nocli = harness({ reply: replyUkamya })
    nocli.deps.claudeAvailable = () => false
    const m3 = ukamyaMeeting()
    rmSync(dataPath('transcript-cleanup'), { recursive: true, force: true })
    expect((await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m3.meetingPath, sidecarPath: m3.sidecarPath }, nocli.deps)).modelSkipped).toBe('claude_not_found')
    expect(nocli.calls).toHaveLength(0)
  })

  it('an unreadable or future-dated state file reads as a spent day', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-cleanup-budget-')); roots.push(dir)
    const file = join(dir, 'state.json')
    const b = new TranscriptCleanupBudget(file, () => new Date(START))
    const limits = cleanupLimits({})
    expect(b.gate(limits)).toBeNull()
    writeFileSync(file, '{broken')
    expect(b.gate(limits)).toBe('daily_calls')
    expect(b.charge(limits)).toBe(false)
    writeFileSync(file, JSON.stringify({ day: '2099-01-01', calls: 0, tokens: 0, consecutiveFailures: 0, breakerOpenUntil: null }))
    expect(b.gate(limits)).toBe('daily_calls')
    writeFileSync(file, JSON.stringify({ day: '2001-01-01', calls: 999, tokens: 999, consecutiveFailures: 0, breakerOpenUntil: null }))
    expect(b.gate(limits)).toBeNull()
    writeFileSync(file, JSON.stringify({ day: new Date(START).toLocaleDateString('en-CA'), calls: -5, tokens: 0, consecutiveFailures: 0, breakerOpenUntil: null }))
    expect(b.gate(limits)).toBe('daily_calls')
  })

  it('per-meeting span cap bounds what is sent', async () => {
    const words: Word[] = []
    for (let i = 0; i < 60; i++) words.push({ word: `word${i}`, p: 0.2, t: i }, { word: 'and', p: 0.99, t: i + 0.5 }, { word: 'then', p: 0.99, t: i + 0.7 })
    const m = meeting([['MU', words]])
    const h = harness({ env: { COS_TRANSCRIPT_CLEANUP_MAX_SPANS: '5' } })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(h.traces[0].spansFound).toBe(60)
    expect(h.traces[0].spansSent).toBe(5)
    expect([...h.calls[0].prompt.matchAll(/^S\d+/gm)]).toHaveLength(5)
  })
})

describe('ledger undo', () => {
  it('restores one span, then the rest of its run, and refuses a stale edit', async () => {
    const m = ukamyaMeeting()
    const h = harness({ reply: replyUkamya })
    const out = await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    const edits = ledgerView(SESSION).edits
    const eucmya = edits.find(e => e.original === 'eucmya')!
    expect(undoCleanupEdits({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath, editId: eucmya.id })).toEqual({ ok: true, reverted: [eucmya.id] })
    expect(section(m.meetingPath)).toContain('[Ext]: Ukamya said the flight leaves at 6 and eucmya will not be late.')
    expect(undoCleanupEdits({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath, editId: eucmya.id })).toMatchObject({ ok: false, status: 409, error: 'already_reverted' })
    const all = undoCleanupEdits({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath, runId: out.runId })
    expect(all.ok && all.reverted.length).toBe(3)
    expect(section(m.meetingPath)).toBe(m.markdown.split('## Transcript\n\n')[1].trimEnd())
    expect(JSON.parse(readFileSync(m.sidecarPath, 'utf8')).batchTranscript).toBe(section(m.meetingPath))
    expect(ledgerView(SESSION).edits.every(e => e.reverted)).toBe(true)
  })

  it('undoes a whole run whose edits sit side by side in one line, by their exact offsets', async () => {
    const m = meeting([['Ext', [{ word: 'Hi', p: 0.99, t: 1 }, { word: 'Yukmya,', p: 0.4, t: 1.5 }, { word: 'and', p: 0.99, t: 2 }, { word: 'eucmya.', p: 0.4, t: 2.5 }]]])
    const h = harness({ reply: replyUkamya })
    const out = await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(section(m.meetingPath)).toBe('[Ext]: Hi Ukamya, and Ukamya.')
    expect(undoCleanupEdits({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath, runId: out.runId })).toMatchObject({ ok: true })
    expect(section(m.meetingPath)).toBe('[Ext]: Hi Yukmya, and eucmya.')
  })

  it('a markdown write that fails puts the sidecar back, and the run is recorded as failed', async () => {
    const { commitCleanTranscript } = await import('./transcript-cleanup-ledger.js')
    const m = ukamyaMeeting()
    const writes: string[] = []
    expect(() => commitCleanTranscript({
      meetingPath: m.meetingPath, sidecarPath: m.sidecarPath, markdown: m.markdown, sidecarText: m.sidecarText, transcript: '[MU]: x', summary: {},
      write: (path, data) => { writes.push(path); if (path === m.meetingPath) throw new Error('disk full'); writeFileSync(path, data) },
    })).toThrow(/markdown: disk full/)
    expect(writes).toEqual([m.sidecarPath, m.meetingPath, m.sidecarPath])
    expect(readFileSync(m.sidecarPath, 'utf8')).toBe(m.sidecarText)
    expect(readFileSync(m.meetingPath, 'utf8')).toBe(m.markdown)
  })

  it('an unwritable ledger stops the run before any model call or file change', async () => {
    rmSync(dataPath('transcript-cleanup'), { recursive: true, force: true })
    mkdirSync(dataPath('transcript-cleanup'), { recursive: true })
    writeFileSync(dataPath('transcript-cleanup', 'ledger'), 'not a directory')
    const m = ukamyaMeeting()
    const h = harness({ reply: replyUkamya })
    expect(await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)).toMatchObject({ status: 'failed', reason: 'ledger_unwritable' })
    expect(h.calls).toHaveLength(0)
    expect(readFileSync(m.meetingPath, 'utf8')).toBe(m.markdown)
  })

  it('refuses (409 stale) when the cleaned words were changed since', async () => {
    const m = ukamyaMeeting()
    const h = harness({ reply: replyUkamya })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    const edit = ledgerView(SESSION).edits.find(e => e.original === 'U cmya')!
    writeFileSync(m.meetingPath, readFileSync(m.meetingPath, 'utf8').replace('Then Ukamya called back.', 'Then Faith called back.'))
    expect(undoCleanupEdits({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath, editId: edit.id })).toEqual({ ok: false, status: 409, error: 'stale' })
    expect(undoCleanupEdits({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath, editId: 'te_0000000000000000' })).toMatchObject({ status: 404 })
  })

  it('writes nothing when a file changed while the model was answering', async () => {
    const m = ukamyaMeeting()
    const h = harness({
      reply: prompt => { writeFileSync(m.sidecarPath, readFileSync(m.sidecarPath, 'utf8').replace('"lifecycleRevision": 3', '"lifecycleRevision": 9')); return replyUkamya(prompt) },
    })
    const out = await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(out).toMatchObject({ status: 'failed', reason: 'changed_during_cleanup' })
    expect(readFileSync(m.meetingPath, 'utf8')).toBe(m.markdown)
    expect(readLedger(SESSION).rows.some(r => r.kind === 'run' && r.phase === 'failed')).toBe(true)
  })
})

describe('per-meeting vocabulary and dictionary suggestions', () => {
  it('a screen line naming Ukamya corrects Ukmya to Ukamya with no dictionary entry and no model call', async () => {
    const m = meeting([['MU', [...w('I talked to Faith', 1), { word: 'Ukmya', p: 0.9, t: 2.6 }, ...w('about the trip.', 3)]]])
    const h = harness({ owner: null, speakers: [], vocabulary: [], screen: [{ at: START + 2_000, text: 'Faith Ukamya joined the meeting', app: 'Zoom' }] })
    const out = await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(section(m.meetingPath)).toBe('[MU]: I talked to Faith Ukamya about the trip.')
    expect(out).toMatchObject({ status: 'done', modelSkipped: 'no_spans', applied: 1 })
    expect(h.calls).toHaveLength(0)
    expect(ledgerView(SESSION).edits[0]).toMatchObject({ source: 'fuzzy', original: 'Ukmya', replacement: 'Ukamya', reasons: ['meeting_term'] })
    // ...and the screen's spelling becomes a dictionary SUGGESTION, never an addition.
    const list = h.suggestions.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ written: 'Ukamya', heard: ['Ukmya'], status: 'pending', count: 1 })
    expect(list[0].evidence).toEqual([{ source: 'screen', sessionId: SESSION, heard: 'Ukmya', at: new Date(START + 3_600_000).toISOString(), detail: 'Zoom' }])
  })

  it('a model edit writing a phrase from the screen suggests the phrase once, not its words again', async () => {
    const m = meeting([['MU', [...w('I met', 1), { word: 'Grays', p: 0.3, t: 2 }, { word: 'Yukmya', p: 0.4, t: 2.4 }, ...w('today.', 3)]]])
    const h = harness({ owner: null, speakers: [], vocabulary: [], screen: [{ at: START + 2_000, text: 'Faith Ukamya joined' }],
      reply: () => '{"edits":[{"id":"S1","action":"replace","text":"Faith Ukamya"}]}' })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(section(m.meetingPath)).toBe('[MU]: I met Faith Ukamya today.')
    expect(h.suggestions.list().map(x => [x.written, x.heard, x.evidence.map(e => e.source)])).toEqual([['Faith Ukamya', ['Grays Yukmya'], ['screen']]])
  })

  it('without the screen line the same meeting is left alone', async () => {
    const m = meeting([['MU', [...w('I talked to Faith', 1), { word: 'Ukmya', p: 0.9, t: 2.6 }, ...w('about the trip.', 3)]]])
    const h = harness({ owner: null, speakers: [], vocabulary: [] })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(section(m.meetingPath)).toBe('[MU]: I talked to Faith Ukmya about the trip.')
    expect(h.suggestions.list()).toHaveLength(0)
  })

  it('a screen term never rewrites an ordinary word: lowercase words and inflections of UI labels stay', async () => {
    const m = meeting([['MU', [...w('The setting was off and Setting it up took a minute, then Recordings started.', 1, 0.95)]]])
    const h = harness({ owner: null, speakers: [], screen: [{ at: START + 1_000, text: 'Settings Recording Participants' }] })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(section(m.meetingPath)).toBe('[MU]: The setting was off and Setting it up took a minute, then Recordings started.')
    // Inflections of a label are not doubtful either: nothing is sent.
    expect(h.traces[0].spansFound).toBe(0)
    expect(h.calls).toHaveLength(0)
  })

  it('an enrolled name is never a deterministic target: Kelsey stays Kelsey, the model decides', async () => {
    const m = meeting([['MU', [...w('I asked', 1), { word: 'Kelsey', p: 0.6, t: 2 }, ...w('about it.', 2.5)]]])
    const h = harness({ owner: null, speakers: ['Kelley Ruiz'], reply: () => '{"edits":[{"id":"S1","action":"keep"}]}' })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(h.traces[0].fixes).toBe(0)
    expect(h.calls[0].prompt).toMatch(/\[\[Kelsey\]\]/)
    expect(section(m.meetingPath)).toBe('[MU]: I asked Kelsey about it.')
  })

  it('no suggestion without context evidence: a dictionary word or a plain model fix records none', async () => {
    const m = ukamyaMeeting()
    const h = harness({ reply: replyUkamya, vocabulary: ['Ukamya'] })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    expect(section(m.meetingPath)).toContain('Then Ukamya called back.')
    expect(h.suggestions.list()).toHaveLength(0)
    // A low-confidence word fixed to a spelling no context source holds: still no suggestion.
    const m2 = meeting([['MU', [...w('We met at the', 1), { word: 'resturant', p: 0.2, t: 3 }, ...w('downtown.', 3.5)]]])
    rmSync(dataPath('transcript-cleanup'), { recursive: true, force: true })
    const h2 = harness({ owner: null, reply: () => '{"edits":[{"id":"S1","action":"replace","text":"restaurant"}]}' })
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m2.meetingPath, sidecarPath: m2.sidecarPath }, h2.deps)
    expect(section(m2.meetingPath)).toBe('[MU]: We met at the restaurant downtown.')
    expect(h2.suggestions.list()).toHaveLength(0)
  })

  it('owner card and COS people are evidence too, and suggestions dedupe by written form', async () => {
    const h = harness({ reply: replyUkamya, owner: OWNER, vocabulary: [] })
    const m = ukamyaMeeting()
    await runTranscriptCleanup({ sessionId: SESSION, meetingPath: m.meetingPath, sidecarPath: m.sidecarPath }, h.deps)
    const m2 = ukamyaMeeting()
    await runTranscriptCleanup({ sessionId: 'meeting_cleanup_002', meetingPath: m2.meetingPath, sidecarPath: m2.sidecarPath }, h.deps)
    const list = h.suggestions.list()
    expect(list).toHaveLength(1)
    expect(list[0].written).toBe('Ukamya')
    expect(list[0].count).toBe(8)
    expect(list[0].heard).toEqual(['Ukmya', 'Yukmya', 'eucmya', 'U cmya'])
    expect(new Set(list[0].evidence.map(e => e.source))).toEqual(new Set(['owner']))
    expect(list[0].evidence.length).toBeLessThanOrEqual(5)
  })
})

describe('screen context store', () => {
  it('bounds, dedupes, holds secrets and refuses bad clocks', () => {
    const now = START + 600_000
    const r = appendScreenContext(SESSION, { lines: [
      { at: START + 1_000, text: 'Faith Ukamya joined' },
      { at: START + 5_000, text: 'Faith  Ukamya joined' },
      { at: new Date(START + 60_000).toISOString(), text: 'x'.repeat(500), app: 'Keynote<script>' },
      { at: START + 2_000, text: 'API_KEY=sk-live-abcdefghijklmnop1234' },
      { at: START + 2_000, text: 'password: Hunter2!Hunter2!' },
      { at: START - 3_600_000, text: 'from an hour before the meeting' },
      { at: now + 3_600_000, text: 'from the future' },
      { at: START + 3_000 },
      'not an object',
    ] }, { now, sessionStartedAt: START })
    expect(r).toEqual({ accepted: 2, duplicates: 1, held: 2, truncated: 1, invalid: 4, dropped: 0, stored: 2 })
    const stored = readScreenContext(SESSION)
    expect(stored[1].text).toHaveLength(400)
    expect(stored[1].app).toBe('Keynotescript')
    expect(JSON.stringify(stored)).not.toMatch(/Hunter2|abcdefghijklmnop/)
    expect(() => appendScreenContext(SESSION, { lines: Array.from({ length: 101 }, (_, i) => ({ at: now, text: `l${i}` })) }, { now })).toThrow('too_many_lines')
    expect(() => appendScreenContext(SESSION, { lines: [{ at: now, text: 'y'.repeat(33 * 1024) }] }, { now })).toThrow('request_too_large')
    expect(() => appendScreenContext('../etc', { lines: [{ at: now, text: 'z' }] }, { now })).toThrow('invalid_session_id')
    expect(() => appendScreenContext(SESSION, { lines: [] }, { now })).toThrow('lines_required')
  })

  it('stops at 2,000 lines per meeting', () => {
    const now = START + 600_000
    let total = 0
    for (let batch = 0; batch < 21; batch++) {
      const r = appendScreenContext(SESSION, { lines: Array.from({ length: 100 }, (_, i) => ({ at: START + batch * 1000, text: `slide ${batch}-${i}` })) }, { now })
      total += r.accepted
      if (batch === 20) expect(r).toMatchObject({ accepted: 0, dropped: 100, stored: 2000 })
    }
    expect(total).toBe(2000)
    expect(readScreenContext(SESSION)).toHaveLength(2000)
  })
})

describe('transcription modules never reach the cleanup (Transcription MUST NEVER call claude -p)', () => {
  it('none of them imports a transcript-cleanup module', () => {
    const dir = join(import.meta.dirname)
    for (const name of ['whisper-local.ts', 'vad-silero.ts', 'parakeet.ts', 'meeting-batch-transcribe.ts', 'stt-live.ts', 'stt-runtime.ts']) {
      const src = readFileSync(join(dir, name), 'utf8')
      expect(src, name).not.toMatch(/transcript-cleanup/)
    }
    const stream = readFileSync(join(dir, '..', 'routes', 'transcribe-stream.ts'), 'utf8')
    expect(stream).not.toMatch(/transcript-cleanup/)
    expect(readdirSync(dir).filter(n => /^transcript-cleanup.*\.ts$/.test(n) && !n.endsWith('.test.ts')).length).toBeGreaterThanOrEqual(7)
  })
})

vi.setConfig({ testTimeout: 20_000 })
