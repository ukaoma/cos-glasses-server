/**
 * T1 (Miles 2026-11-09 21:34, "The title keeps changing (probably every minutes) which creates alot of bouncing").
 *
 * A replay of an evening like 11/09's: ten sessions, every working one replying every minute, turns ending and starting,
 * a short question now and then, sub-agents starting and finishing, and two Todays (the desktop and the web) asking
 * once a minute each with slightly different counts. It counts what a person sees: the model calls, and how often the
 * text each Today shows changed. The first half of the file uses only APIs that existed before T1, so the same replay
 * runs against the base (T1_CHURN_REPORT_ONLY=1 prints the counts and skips the T1 assertions).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as brief from './today-brief.js'
import { createTodayBrief, normalizeTodayBriefInputs, type TodayBriefDeps, type TodayBriefInputs } from './today-brief.js'

const REPORT_ONLY = process.env.T1_CHURN_REPORT_ONLY === '1'
const T0 = Date.parse('2026-11-09T19:30:00')
const MIN = 60_000
let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'today-churn-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function harness(extra: Partial<TodayBriefDeps> = {}) {
  const clock = { t: T0 }
  const prompts: string[] = []
  const settingsFile = join(dir, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify({ schema: 1, enabled: true }))
  const deps: TodayBriefDeps = {
    stateFile: join(dir, 'state.json'), settingsFile, now: () => clock.t, env: () => ({}),
    generate: async prompt => { prompts.push(prompt); return `Your release lanes are moving, summary number ${prompts.length}. One session waits on a question.` },
    ...extra,
  }
  return { brief: createTodayBrief(deps), clock, prompts }
}

/** A tiny deterministic generator, so the replay is the same every run. */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }

interface Sim { title: string; provider: string; state: 'working' | 'open' | 'waiting'; until: number; replies: number; agents: number }
/** The evening: what each Today sends at minute m. The web counts one session differently for a few minutes at a time. */
function evening(minutes: number) {
  const r = rng(1109)
  const sims: Sim[] = Array.from({ length: 10 }, (_, i) => ({ title: `Lane ${String.fromCharCode(65 + i)} hardening`, provider: i < 8 ? 'claude' : 'codex', state: 'working', until: 3 + Math.floor(r() * 5), replies: 0, agents: i % 3 === 0 ? 2 : 0 }))
  const frames: Array<{ desktop: TodayBriefInputs; web: TodayBriefInputs }> = []
  const needs = [{ title: 'Review 3 memories', why: 'Learned from your meetings.' }]
  for (let m = 0; m < minutes; m++) {
    if (m === 60) sims.push({ title: 'Lane K follow up', provider: 'claude', state: 'working', until: m + 4, replies: 0, agents: 0 })   // a new session: material
    if (m === 90) needs.push({ title: 'Approve the server candidate', why: 'The suite is green.' })                                          // a new need: material
    for (const s of sims) {
      if (m >= s.until) {
        // A turn ends (idle 1 to 3 min), the next starts (4 to 7 min); about one turn in eight ends on a short question.
        if (s.state === 'working') { s.state = r() < 0.125 ? 'waiting' : 'open'; s.until = m + 1 + Math.floor(r() * 3) }
        else { s.state = 'working'; s.until = m + 4 + Math.floor(r() * 4) }
      }
      if (s.state === 'working') { s.replies++; if (r() < 0.15) s.agents = s.agents ? 0 : 1 + Math.floor(r() * 3) }
    }
    const rows = (webSkew: boolean) => sims.map((s, i) => ({
      title: s.title, provider: s.provider,
      // The web reads one waiting session as working for minutes at a time (its own state rule): the counts differ.
      state: webSkew && i === m % 10 && s.state === 'waiting' ? 'working' : s.state,
      minutes: m % 60, line: `${s.title} first ask. Latest reply number ${s.replies}`,
      waiting: s.state === 'waiting' ? `Question ${s.replies}` : '',
      agents: s.agents ? { active: s.agents, completed: 1, total: s.agents + 1 } : undefined,
    }))
    const page = (webSkew: boolean) => normalizeTodayBriefInputs({ sessions: rows(webSkew), needs, sessionsRead: true, needsComplete: true, unread: [], recording: false })
    frames.push({ desktop: page(false), web: page(true) })
  }
  return frames
}

async function replay(h: ReturnType<typeof harness>, minutes: number) {
  const frames = evening(minutes)
  const shown = { desktop: '', web: '' }
  const changes = { desktop: 0, web: 0 }
  for (const [m, f] of frames.entries()) {
    for (const who of ['desktop', 'web'] as const) {
      h.clock.t = T0 + m * MIN + (who === 'web' ? 20_000 : 0)
      const v = await h.brief.ask(f[who], brief.todayBriefFingerprint(f[who]))
      if (v.text && shown[who] && v.text !== shown[who]) changes[who]++
      if (v.text) shown[who] = v.text
    }
  }
  return { calls: h.prompts.length, changes }
}

describe('T1 replay: an evening of ten busy sessions and two Todays', () => {
  it('counts model calls and shown-text changes over two hours (fewer calls, the text holds still)', async () => {
    const h = harness()
    const out = await replay(h, 120)
    console.log(`T1_CHURN_REPLAY 120min calls=${out.calls} callsPerHour=${(out.calls / 2).toFixed(1)} desktopTextChanges=${out.changes.desktop} webTextChanges=${out.changes.web}`)
    if (REPORT_ONLY) return
    // First summary, the routine rewrites at 30-minute spacing, the new session (minute 60), the new need (minute 90).
    expect(out.calls).toBeLessThanOrEqual(6)
    expect(out.calls).toBeGreaterThanOrEqual(3)
    // Each Today's text changes only when a summary was written (no count re-flows from the minute-to-minute flips).
    expect(out.changes.desktop).toBeLessThanOrEqual(out.calls)
    expect(out.changes.web).toBeLessThanOrEqual(out.calls)
  }, 60_000)
})

// ── the guards (T1 APIs) ────────────────────────────────────────────────────

const base = (over: { line?: string; state?: string; waiting?: string; extra?: boolean; need?: string } = {}) => normalizeTodayBriefInputs({
  sessions: [
    { title: 'Release QA', provider: 'claude', state: over.state ?? 'working', minutes: 5, line: over.line ?? 'reply 1', waiting: over.waiting ?? '' },
    { title: 'Server lane', provider: 'claude', state: 'working', minutes: 9, line: 'working on it' },
    ...(over.extra ? [{ title: 'A new lane', provider: 'codex', state: 'working', minutes: 1, line: 'started' }] : []),
  ],
  needs: over.need ? [{ title: over.need, why: '' }] : [],
  sessionsRead: true, needsComplete: true, unread: [], recording: false,
})

describe.skipIf(REPORT_ONLY)('T1 guards', () => {
  it('a routine change (a new reply, a state flip, a question) does not rewrite inside 30 minutes; after 30 it may', async () => {
    const h = harness()
    await h.brief.ask(base())
    h.clock.t += 11 * MIN
    expect(await h.brief.ask(base({ line: 'reply 2' }))).toMatchObject({ state: 'stale', reason: 'interval' })
    h.clock.t += 8 * MIN
    expect((await h.brief.ask(base({ state: 'open', line: 'reply 3' }))).state).toBe('stale')
    h.clock.t += 8 * MIN
    expect((await h.brief.ask(base({ state: 'waiting', waiting: 'Publish?' }))).state).toBe('stale')
    expect(h.prompts).toHaveLength(1)
    h.clock.t += 3 * MIN   // 30 minutes after the summary was written
    expect((await h.brief.ask(base({ line: 'reply 4' }))).state).toBe('fresh')
    expect(h.prompts).toHaveLength(2)
  })
  it('a material change (a session opened, a new need) rewrites after the 10-minute interval, not 30', async () => {
    const h = harness()
    await h.brief.ask(base())
    h.clock.t += 10 * MIN
    expect((await h.brief.ask(base({ extra: true }))).state).toBe('fresh')
    h.clock.t += 10 * MIN
    expect((await h.brief.ask(base({ extra: true, need: 'Approve the candidate' }))).state).toBe('fresh')
    expect(h.prompts).toHaveLength(3)
  })
  it('the material key: typed messages and the session set count; peer messages, replies, states and durations do not', () => {
    const a = base()
    expect(brief.todayBriefMaterialKey(base({ line: 'reply 9', state: 'open' }))).toBe(brief.todayBriefMaterialKey(a))
    expect(brief.todayBriefMaterialKey(base({ extra: true }))).not.toBe(brief.todayBriefMaterialKey(a))
    const withAsk = (via: 'typed' | 'peer') => ({ ...a, sessions: a.sessions.map((s, i) => (i ? s : { ...s, recent: true, asks: [{ minutesAgo: 1, text: 'ship it', via }] })) })
    expect(brief.todayBriefMaterialKey(withAsk('peer'))).toBe(brief.todayBriefMaterialKey(a))
    expect(brief.todayBriefMaterialKey(withAsk('typed'))).not.toBe(brief.todayBriefMaterialKey(a))
  })
  it('the count sentence shows at once with no summary, then changes only after it held for 5 minutes', async () => {
    const h = harness()
    const first = await h.brief.ask(base({ state: 'waiting', waiting: 'Publish?' }))
    expect(first.text.startsWith('One thing needs you.')).toBe(true)
    // A flip to no waiting session, back inside 5 minutes: the text never changes.
    h.clock.t += 1 * MIN
    expect((await h.brief.ask(base())).text).toBe(first.text)
    h.clock.t += 2 * MIN
    expect((await h.brief.ask(base({ state: 'waiting', waiting: 'Publish?' }))).text).toBe(first.text)
    // No waiting session for 5 minutes and more: the count sentence goes, with no model call.
    h.clock.t += 1 * MIN
    await h.brief.ask(base())
    h.clock.t += 4 * MIN
    expect((await h.brief.ask(base())).text).toBe(first.text)
    h.clock.t += 1 * MIN
    const settled = await h.brief.ask(base())
    expect(settled.text.startsWith('One thing')).toBe(false)
    expect(h.prompts).toHaveLength(1)
    expect(h.brief.peek().text).toBe(settled.text)
  })
  it('a new summary shows with the count it was written after, at once', async () => {
    const h = harness()
    await h.brief.ask(base())
    h.clock.t += 10 * MIN
    const v = await h.brief.ask(base({ state: 'waiting', waiting: 'Publish?', need: 'Approve the candidate' }))
    expect(h.prompts).toHaveLength(2)
    expect(v.text.startsWith('Two things need you.')).toBe(true)
  })
  it('a forced refresh still writes at once (the person asked)', async () => {
    const h = harness()
    await h.brief.ask(base())
    h.clock.t += 1 * MIN
    expect((await h.brief.ask(base({ line: 'reply 2' }), '', { force: true })).state).toBe('fresh')
    expect(h.prompts).toHaveLength(2)
  })
})
