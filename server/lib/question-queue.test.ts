// X1 (Miles 2026-11-12 17:31): the one queue. Every waiting question, approval and turn-end ask, oldest first, with
// the session's title, one count, and for two minutes after an answer, where it was answered. Present whatever the
// full-hold switches say (these tests run with both OFF unless they say otherwise).
import { afterEach, describe, expect, it } from 'vitest'
import { PermissionBroker, QUEUE_ANSWERED_KEEP_MS, answerSurfaceOf, type BrokerQueueSource, type PermissionBrokerDeps } from './permission-broker.js'
import { QUEUE_LINE_MAX, QUEUE_MAX, buildQuestionQueue, type QueueInput } from './question-queue.js'
import { TURN_ASK_ANSWERED_KEEP_MS, TurnEndAskTracker, WRAP_UP_TOOL, turnAskAnswerSurface } from './turn-end-ask.js'
import { SESSION_TITLE_CACHE_MAX, __resetSessionTitlesForTests, noteSessionTitle, sessionTitleFor } from './session-title-cache.js'
import { ASK_INPUT, Q1, SESSION, permissionEnvelope } from './__fixtures__/permission-broker.js'
import type { HookEnvelope } from './session-hook-events.js'

const live: PermissionBroker[] = []
afterEach(() => { for (const b of live.splice(0)) b.stop(); __resetSessionTitlesForTests() })

function broker(opts: { switches?: { questions: boolean; approvals: boolean } } = {}) {
  const s = { now: 1_000_000, idle: 200 as number | null }
  let seq = 0
  const deps: PermissionBrokerDeps = {
    now: () => s.now, mode: () => 'all', admissionsOpen: () => true,
    // A glasses client polled just now (hold=1) and the 6.59.0 liveness too: held items admit as today.
    lastQuestionsPollAt: () => s.now, lastLegacyPollAt: () => s.now, lastHoldPollAt: () => s.now, presenceAgeMs: () => 1_000,
    readDeskIdleSeconds: async () => s.idle, deskIdleSeconds: () => 90,
    timeoutMs: () => 110_000, awayHoldMs: () => 600_000, installedHookTimeoutS: () => 630,
    fullHold: () => opts.switches ?? { questions: false, approvals: false },
    pollMs: 60_000, newId: () => `pq_${String(++seq).padStart(24, '0')}`,
    log: () => {},
  }
  const b = new PermissionBroker(deps)
  live.push(b)
  return { s, b }
}
const ev = (ts: number, event: HookEnvelope['event'], payload: Record<string, unknown> = {}, sessionId = SESSION): HookEnvelope =>
  ({ ts, ppid: 4242, sessionId, event, payload: { session_id: sessionId, ...payload } })
const askEnv = (now: number, toolUseId = 'toolu_q1') => ({ ...permissionEnvelope('AskUserQuestion', ASK_INPUT, { tool_use_id: toolUseId }, now), hookWaitS: 630, askHold: 1 })
const bashEnv = (now: number) => ({ ...permissionEnvelope('Bash', { command: 'npm publish' }, { tool_use_id: 'toolu_b1' }, now), hookWaitS: 630 })
function park(b: PermissionBroker, r: Awaited<ReturnType<PermissionBroker['admit']>>) {
  if (!r.ok) throw Error(r.reason)
  return b.park(r.request, { writable: () => true, reply: () => true })
}
const ANSWER = { answers: [{ labels: ['Bump'] }, { labels: ['Blue'] }] }
const input = (over: Partial<QueueInput> = {}): QueueInput => ({ broker: [], turnEnd: [], turnEndAnswered: [], titleFor: () => null, words: true, ...over })

describe('broker.queueSources, with every full-hold switch OFF', () => {
  it('a question asked at the Mac that COS does not hold is listed, at the Mac, with its words', () => {
    const { s, b } = broker()
    b.observeHookEvent(ev(s.now, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_q1' }), false)
    const [q] = b.queueSources()
    expect(q).toMatchObject({ kind: 'question', where: 'mac', heldId: null, state: 'waiting', sessionId: SESSION })
    expect(q!.questions[0]!.question).toBe(Q1)
    // The 7.0.31 view stays gated: nothing in `waiting` with the switches off.
    expect(b.waitingList()).toEqual([])
  })

  it('a held question reads here with its id; a held approval too, with its summary', async () => {
    const { s, b } = broker()
    b.observeHookEvent(ev(s.now, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_q1' }), false)
    const qid = park(b, await b.admit(askEnv(s.now)))
    const aid = park(b, await b.admit(bashEnv(s.now + 1)))
    const sources = b.queueSources()
    expect(sources.map(x => [x.kind, x.where, x.heldId])).toEqual([['question', 'here', qid], ['approval', 'here', aid]])
    expect(sources[1]!.approval?.summary).toBe('npm publish')
  })

  it('an approval left for the Mac stays listed, at the Mac, with no words', async () => {
    const { s, b } = broker()
    const aid = park(b, await b.admit(bashEnv(s.now)))
    expect(b.answer(aid, { clientAnswerId: 'leave', handBack: true }, 'app').status).toBe(200)
    const [a] = b.queueSources()
    expect(a).toMatchObject({ kind: 'approval', where: 'mac', heldId: null, approval: null, state: 'waiting' })
  })

  it('answered: says where (web, glasses, the Mac), for two minutes, then leaves', async () => {
    const { s, b } = broker()
    const web = park(b, await b.admit(bashEnv(s.now)))
    expect(b.answer(web, { clientAnswerId: 'w1', decision: 'allow' }, 'web').status).toBe(200)
    b.observeHookEvent(ev(s.now, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_q1' }), false)
    const q = park(b, await b.admit(askEnv(s.now + 1)))
    expect(b.answer(q, { clientAnswerId: 'g1', ...ANSWER }, 'app', 'glasses').status).toBe(200)
    b.observeHookEvent(ev(s.now + 2, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_q1' }), false)
    expect(b.queueSources().every(x => x.state === 'answered')).toBe(true)
    const by = Object.fromEntries(b.queueSources().map(x => [x.kind, x.answeredBy]))
    expect(by).toEqual({ question: 'glasses', approval: 'web' })
    s.now += QUEUE_ANSWERED_KEEP_MS + 10
    expect(b.queueSources()).toEqual([])
  })

  it('a question answered at the Mac reads answered by the Mac', () => {
    const { s, b } = broker()
    b.observeHookEvent(ev(s.now, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_q1' }), false)
    b.observeHookEvent(ev(s.now + 5, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_q1' }), false)
    expect(b.queueSources().map(x => [x.state, x.answeredBy, x.questions.length])).toEqual([['answered', 'mac', 0]])
  })

  it('an approval the session moved past at the Mac reads answered by the Mac; a COS cancel is not listed', async () => {
    const { s, b } = broker()
    const aid = park(b, await b.admit(bashEnv(s.now)))
    b.observeHookEvent(ev(s.now + 5, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm publish' }, tool_use_id: 'toolu_b1' }), false)
    expect(b.queueSources().map(x => [x.kind, x.state, x.answeredBy])).toEqual([['approval', 'answered', 'mac']])
    void aid
  })

  it('answerSurfaceOf: web is web; the token door names glasses, phone or mac_app when it says so, else cos', () => {
    expect(answerSurfaceOf('web', 'glasses')).toBe('web')
    expect(answerSurfaceOf('app', 'glasses')).toBe('glasses')
    expect(answerSurfaceOf('app', ' Phone ')).toBe('phone')
    expect(answerSurfaceOf('app', 'mac-app')).toBe('mac_app')
    for (const junk of [undefined, '', 'mac', 'web', 'evil', 42]) expect(answerSurfaceOf('app', junk)).toBe('cos')
  })
})

describe('buildQuestionQueue', () => {
  const src = (over: Partial<BrokerQueueSource>): BrokerQueueSource => ({
    key: 'k', sessionId: SESSION, provider: 'claude', kind: 'question', tool: 'AskUserQuestion', questions: [{ question: 'Which env first?', header: '', multiSelect: false, options: [] }],
    approval: null, askedAt: 5_000, where: 'mac', heldId: null, deadlineAt: null, state: 'waiting', answeredBy: null, answeredAt: null, ...over,
  })

  it('oldest first across kinds, with the title, one count of what still waits', () => {
    const out = buildQuestionQueue(input({
      broker: [src({ key: 'q', askedAt: 3_000 }), src({ key: 'a', kind: 'approval', tool: 'Bash', questions: [], approval: { tool: 'Bash', summary: 'npm publish', detail: '' }, askedAt: 1_000, where: 'here', heldId: 'pq_x' }),
        src({ key: 'done', askedAt: 500, state: 'answered', answeredBy: 'glasses', answeredAt: 9_000, questions: [] })],
      turnEnd: [{ sessionId: SESSION, ask: 'Ship slide 4?', choices: ['Yes', 'No'], stoppedAt: 2_000 }],
      titleFor: id => (id === SESSION ? 'Quilt deck' : null),
    }))
    expect(out.queue.map(e => [e.kind, e.line, e.where, e.state])).toEqual([
      ['question', '', 'mac', 'answered'],
      ['approval', 'npm publish', 'here', 'waiting'],
      ['turn_end', 'Ship slide 4?', 'here', 'waiting'],
      ['question', 'Which env first?', 'mac', 'waiting'],
    ])
    expect(out.queueCount).toBe(3)
    expect(out.queue.every(e => e.title === 'Quilt deck')).toBe(true)
    expect(out.queue[2]!.choices).toEqual(['Yes', 'No'])
    expect(out.queue[0]!.answeredBy).toBe('glasses')
  })

  it('words off: a question\'s line is empty; approvals and turn-end asks keep the text their own switches gave', () => {
    const out = buildQuestionQueue(input({ words: false, broker: [src({})], turnEnd: [{ sessionId: SESSION, ask: '', choices: [], stoppedAt: 1 }] }))
    expect(out.queue.map(e => e.line)).toEqual(['', ''])
  })

  it('a line is cleaned and at most 80 characters', () => {
    const long = 'Deploy‮ now?\u0007 ' + 'x'.repeat(200)
    const [e] = buildQuestionQueue(input({ broker: [src({ questions: [{ question: long, header: '', multiSelect: false, options: [] }] })] })).queue
    expect(e!.line.length).toBe(QUEUE_LINE_MAX)
    expect(e!.line.startsWith('Deploy now? xxx')).toBe(true)
  })

  it('a turn-end ask answered within the window replaces its waiting copy', () => {
    const out = buildQuestionQueue(input({
      turnEnd: [{ sessionId: SESSION, ask: 'Ship?', choices: ['Yes'], stoppedAt: 2_000 }],
      turnEndAnswered: [{ sessionId: SESSION, ask: 'Ship?', stoppedAt: 2_000, answeredAt: 3_000, by: 'web' }],
    }))
    expect(out.queue.map(e => [e.state, e.answeredBy])).toEqual([['answered', 'web']])
    expect(out.queueCount).toBe(0)
  })

  it('a title that cannot be read is null; the queue still builds', () => {
    const out = buildQuestionQueue(input({ broker: [src({})], titleFor: () => { throw Error('x') } }))
    expect(out.queue[0]!.title).toBeNull()
  })

  it(`at most ${QUEUE_MAX} entries, dropping answered ones before anything still waiting`, () => {
    const many = Array.from({ length: QUEUE_MAX + 5 }, (_, i) => src({ key: `w${i}`, askedAt: 10_000 + i }))
    const answered = Array.from({ length: 3 }, (_, i) => src({ key: `a${i}`, askedAt: i, state: 'answered', answeredBy: 'mac', answeredAt: 1 }))
    const out = buildQuestionQueue(input({ broker: [...answered, ...many] }))
    expect(out.queue.length).toBe(QUEUE_MAX)
    expect(out.queue.every(e => e.state === 'waiting')).toBe(true)
    expect(out.queueCount).toBe(QUEUE_MAX)
  })
})

describe('turn-end asks in the queue', () => {
  function tracker() {
    const clock = { now: 1_000_000 }
    const t = new TurnEndAskTracker({ now: () => clock.now, enabled: () => true, words: () => true, readDeskIdleSeconds: async () => 300, deskIdleSeconds: () => 90, pollMs: 3_600_000 })
    return { t, clock }
  }
  const SID = '7a1e0c55-1111-4222-8333-0000000000aa'
  const wrap = (ts: number) => ev(ts, 'PostToolUse', { tool_name: WRAP_UP_TOOL, prompt_id: 'p1', tool_input: { ask: 'Ship slide 4?', actions: [{ label: 'Yes' }, { label: 'No' }] } }, SID)
  const stop = (ts: number) => ev(ts, 'Stop', { prompt_id: 'p1' }, SID)

  it('visibleAsks lists what rows show; a reply moves it to recentlyAnswered with where, for two minutes', async () => {
    const { t, clock } = tracker()
    t.observe(wrap(clock.now), false)
    t.observe(stop(clock.now + 100), false)
    await t.tick()
    expect(t.visibleAsks().map(a => [a.sessionId, a.ask, a.choices])).toEqual([[SID, 'Ship slide 4?', ['Yes', 'No']]])
    t.observe(ev(clock.now + 5_000, 'UserPromptSubmit', { prompt: 'Answer sent from COS Control Web through COS, not typed in this session: Yes' }, SID), true)
    expect(t.visibleAsks()).toEqual([])
    expect(t.recentlyAnswered(clock.now + 5_000).map(a => [a.by, a.ask])).toEqual([['web', 'Ship slide 4?']])
    expect(t.recentlyAnswered(clock.now + 5_000 + TURN_ASK_ANSWERED_KEEP_MS + 1)).toEqual([])
    t.stop()
  })

  it('an ask no surface showed yet (desk latch) is not listed as answered when the desk answers it', () => {
    const { t, clock } = tracker()
    t.observe(wrap(clock.now), false)
    t.observe(stop(clock.now + 100), false)
    t.observe(ev(clock.now + 5_000, 'UserPromptSubmit', { prompt: 'Yes' }, SID), false)
    expect(t.recentlyAnswered(clock.now + 5_000)).toEqual([])
    t.stop()
  })

  it('turnAskAnswerSurface reads only the words COS put on the reply', () => {
    expect(turnAskAnswerSurface('Answer sent from COS Control Web through COS, not typed in this session: Yes', false)).toBe('web')
    expect(turnAskAnswerSurface('Answer sent from COS Control on the Mac through COS, not typed in this session: Yes', false)).toBe('mac_app')
    expect(turnAskAnswerSurface('Yes\n[COS-G2 turn ctmux42 ...]', false)).toBe('glasses')
    expect(turnAskAnswerSurface('Yes', true)).toBe('cos')
    expect(turnAskAnswerSurface('Yes', false)).toBe('mac')
    expect(turnAskAnswerSurface(undefined, false)).toBe('mac')
  })
})

describe('the title cache', () => {
  it('keeps the last title listed, by full or short id, bounded', () => {
    noteSessionTitle(SESSION.toUpperCase(), '  Quilt   deck ')
    expect(sessionTitleFor(SESSION)).toBe('Quilt deck')
    expect(sessionTitleFor(SESSION.slice(0, 8))).toBe('Quilt deck')
    expect(sessionTitleFor('ffffffff-0000-4000-8000-000000000000')).toBeNull()
    noteSessionTitle(SESSION, '')
    expect(sessionTitleFor(SESSION)).toBe('Quilt deck')
    for (let i = 0; i <= SESSION_TITLE_CACHE_MAX; i++) noteSessionTitle(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `t${i}`)
    expect(sessionTitleFor(SESSION)).toBeNull()
  })
})
