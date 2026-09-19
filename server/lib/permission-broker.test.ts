// 6.52.0: the permission broker's rules, executed. The HTTP doors and the real hook script
// are in routes/permission-broker.test.ts and cos-session-hook.script.test.ts.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The real redaction, observed: which text reached a regex, and how much of it.
vi.mock('./activity-preview.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./activity-preview.js')>()
  return { ...actual, redactSecretText: vi.fn(actual.redactSecretText) }
})
import {
  APPROVAL_DETAIL_MAX,
  APPROVAL_SUMMARY_MAX,
  BROKER_TIMEOUT_MAX_S,
  CLIENT_LIVE_WINDOW_MS,
  DENY_MESSAGE,
  DESK_IDLE_MIN_S,
  HOOK_CURL_MAX_S,
  MAX_PENDING,
  POLL_FUTURE_SKEW_MS,
  PermissionBroker,
  approvalCard,
  approvalCutMarker,
  approvalHookOutput,
  brokerSignalSink,
  parsePermissionRequestEnvelope,
  parseQuestions,
  permissionBrokerHealthFields,
  permissionBrokerMode,
  permissionBrokerTimeoutMs,
  questionHookOutput,
  readHidIdleSeconds,
  registerPermissionBroker,
  sessionQuestionsCapability,
  validateQuestionAnswers,
  wirePermissionBrokerToSignals,
  type BrokerMode,
  type HookReplyChannel,
  type PermissionBrokerDeps,
} from './permission-broker.js'
import { SessionSignalStore } from './session-signal-store.js'
import { deriveSessionState, derivedRowFields } from './session-state-derive.js'
import { toolFingerprint, type HookEnvelope } from './session-hook-events.js'
import { __resetClientLivenessForTests, lastQuestionsPollAt, noteQuestionsPoll } from './client-liveness.js'
import { REDACTION_SCAN_MAX_CHARS, redactSecretText } from './activity-preview.js'
import { HOOK_SUBSCRIPTIONS } from './claude-hooks-installer.js'
import { PERMISSION_BROKER_HOOK_PATH } from '../routes/permission-broker.js'

import { ASK_INPUT, Q1, Q2, QUESTIONS, SESSION, permissionEnvelope } from './__fixtures__/permission-broker.js'

function hookEvent(event: HookEnvelope['event'], ts: number, payload: Record<string, unknown> = {}): HookEnvelope {
  return { ts, ppid: 4242, event, sessionId: SESSION, payload: { session_id: SESSION, ...payload } }
}

/** A held response that records what it was sent. `open` false models a half-dead socket. */
function fakeChannel(open = true) {
  const sent: Array<Record<string, unknown>> = []
  const channel: HookReplyChannel & { open: boolean } = {
    open,
    writable() { return this.open },
    // A write into a socket that is going away is still ACCEPTED by Node: that is the hazard.
    reply(body) { sent.push(body); return true },
  }
  return { channel, sent }
}

function brokerWith(over: Partial<PermissionBrokerDeps> = {}, state: { now?: number; mode?: BrokerMode; idle?: number | null; seenAt?: number | null } = {}) {
  const clock = { now: state.now ?? 1_000_000 }
  const s = { mode: state.mode ?? 'all' as BrokerMode, idle: state.idle === undefined ? 1_000 : state.idle, seenAt: state.seenAt === undefined ? clock.now : state.seenAt, admissions: true, idleReads: 0 }
  let n = 0
  const broker = new PermissionBroker({
    now: () => clock.now,
    mode: () => s.mode,
    admissionsOpen: () => s.admissions,
    lastQuestionsPollAt: () => s.seenAt,
    readDeskIdleSeconds: async () => { s.idleReads++; return s.idle },
    deskIdleSeconds: () => 90,
    timeoutMs: () => 110_000,
    pollMs: 60_000,
    newId: () => `pq_${String(++n).padStart(24, '0')}`,
    log: () => {},
    ...over,
  })
  return { broker, clock, s }
}

const brokers: PermissionBroker[] = []
afterEach(() => { for (const b of brokers.splice(0)) b.stop(); registerPermissionBroker(null) })

describe('configuration', () => {
  it('COS_PERMISSION_BROKER: 0/false/off is the kill switch, questions narrows, anything else is both; hooks off is off', () => {
    for (const off of ['0', 'false', 'off', ' OFF ']) expect(permissionBrokerMode({ COS_PERMISSION_BROKER: off }, true)).toBe('off')
    expect(permissionBrokerMode({ COS_PERMISSION_BROKER: 'questions' }, true)).toBe('questions')
    for (const on of [undefined, '', '1', 'true', 'on', 'all', 'typo']) expect(permissionBrokerMode({ COS_PERMISSION_BROKER: on }, true)).toBe('all')
    expect(permissionBrokerMode({}, false)).toBe('off')
    expect(permissionBrokerMode({ COS_PERMISSION_BROKER: '1' }, false)).toBe('off')
  })

  it('the deadline defaults to 110 s and is never at or above the hook\'s 125 s', () => {
    expect(permissionBrokerTimeoutMs({})).toBe(110_000)
    for (const junk of ['', '0', '-5', 'abc', 'NaN', 'Infinity']) expect(permissionBrokerTimeoutMs({ COS_PERMISSION_BROKER_TIMEOUT_S: junk })).toBe(110_000)
    expect(permissionBrokerTimeoutMs({ COS_PERMISSION_BROKER_TIMEOUT_S: '30' })).toBe(30_000)
    expect(permissionBrokerTimeoutMs({ COS_PERMISSION_BROKER_TIMEOUT_S: '1' })).toBe(5_000)
    for (const high of ['120', '124.9', '125', '130', '600', '1e9']) {
      const ms = permissionBrokerTimeoutMs({ COS_PERMISSION_BROKER_TIMEOUT_S: high })
      expect(ms).toBe(BROKER_TIMEOUT_MAX_S * 1000)
      expect(ms).toBeLessThan(HOOK_CURL_MAX_S * 1000)
    }
  })
})

describe('timeout parity: broker deadline < the script\'s curl < Claude Code\'s hook timeout', () => {
  it('reads the real script and the real installer, and orders the three', () => {
    const script = readFileSync(new URL('../../bin/hooks/cos-session-hook', import.meta.url), 'utf8')
    // The curl that posts the PermissionRequest to the broker (the script's other curl is
    // the Cursor Stop one, with its own 3 s).
    const curl = new RegExp(String.raw`--max-time (\d+)[^\n]*\\\n[^\n]*"http://127\.0\.0\.1:\$PORT` + PERMISSION_BROKER_HOOK_PATH.replace(/\//g, '\\/') + '"').exec(script)
    expect(curl, 'the PermissionRequest curl line').not.toBeNull()
    const curlMaxS = Number(curl![1])
    expect(curlMaxS).toBe(HOOK_CURL_MAX_S)

    const installer = readFileSync(new URL('./claude-hooks-installer.ts', import.meta.url), 'utf8')
    const entry = /\{ event: 'PermissionRequest', async: false, timeout: (\d+) \}/.exec(installer)
    expect(entry, 'the PermissionRequest subscription').not.toBeNull()
    const installerS = Number(entry![1])
    expect(installerS).toBe(HOOK_SUBSCRIPTIONS.find(sub => sub.event === 'PermissionRequest')!.timeout)

    // The broker always answers before curl gives up, and curl before Claude Code does.
    expect(permissionBrokerTimeoutMs({ COS_PERMISSION_BROKER_TIMEOUT_S: '1e9' })).toBe(BROKER_TIMEOUT_MAX_S * 1000)
    expect(BROKER_TIMEOUT_MAX_S).toBeLessThan(curlMaxS)
    expect(curlMaxS).toBeLessThan(installerS)
  })
})

describe('the liveness signal (lib/client-liveness)', () => {
  it('records the newest questions poll and never moves backwards', () => {
    __resetClientLivenessForTests()
    expect(lastQuestionsPollAt()).toBeNull()
    noteQuestionsPoll(Number.NaN)
    expect(lastQuestionsPollAt()).toBeNull()
    noteQuestionsPoll(5_000)
    noteQuestionsPoll(4_000) // a slower request answered later with an older stamp
    expect(lastQuestionsPollAt()).toBe(5_000)
    noteQuestionsPoll(6_000)
    expect(lastQuestionsPollAt()).toBe(6_000)
    // A clock that stepped back is followed, or no poll would count until it caught up.
    noteQuestionsPoll(6_000 - 5_001)
    expect(lastQuestionsPollAt()).toBe(999)
    __resetClientLivenessForTests()
  })

  it('a stamp more than 5 s in the future is stale, not live forever', async () => {
    const { broker, s, clock } = brokerWith()
    brokers.push(broker)
    s.seenAt = clock.now + POLL_FUTURE_SKEW_MS
    expect((await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).ok).toBe(true)
    s.seenAt = clock.now + POLL_FUTURE_SKEW_MS + 1
    expect(await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).toEqual({ ok: false, reason: 'no_client' })
  })

  it('a poll exactly 30 s old still counts; one millisecond more does not', async () => {
    expect(CLIENT_LIVE_WINDOW_MS).toBe(30_000)
    const { broker, s, clock } = brokerWith()
    brokers.push(broker)
    s.seenAt = clock.now - CLIENT_LIVE_WINDOW_MS
    expect((await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).ok).toBe(true)
    s.seenAt = clock.now - CLIENT_LIVE_WINDOW_MS - 1
    expect(await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    s.seenAt = null
    expect(await broker.admit(permissionEnvelope('AskUserQuestion', ASK_INPUT, {}, clock.now))).toEqual({ ok: false, reason: 'no_client' })
  })
})

describe('reading the envelope', () => {
  it('reads a Claude PermissionRequest, the tool input verbatim, and the reducer\'s fingerprint', () => {
    const verdict = parsePermissionRequestEnvelope(permissionEnvelope('AskUserQuestion', ASK_INPUT, {}, 5_000))
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.facts).toEqual({ sessionId: SESSION, toolName: 'AskUserQuestion', toolInput: ASK_INPUT, fingerprint: toolFingerprint('AskUserQuestion', ASK_INPUT), hookStartedAtMs: 5_000 })
  })

  it('a Cursor payload is Cursor in any form; junk is malformed', () => {
    for (const v of ['3.21.13', '', null, 3]) {
      expect(parsePermissionRequestEnvelope(permissionEnvelope('Bash', { command: 'ls' }, { cursor_version: v }))).toEqual({ ok: false, reason: 'cursor' })
    }
    const bad = [
      null, 'x', [], {}, { event: 'PermissionRequest' }, { ...permissionEnvelope('Bash', { command: 'ls' }), event: 'Stop' },
      permissionEnvelope('Bash', { command: 'ls' }, { session_id: '../x' }),
      permissionEnvelope('', { command: 'ls' }),
      permissionEnvelope('Bash', { command: 'ls' }, { tool_input: 'ls' }),
    ]
    for (const b of bad) expect(parsePermissionRequestEnvelope(b)).toEqual({ ok: false, reason: 'malformed' })
    const unstamped = parsePermissionRequestEnvelope(permissionEnvelope('Bash', { command: 'ls' }, {}, 'soon'))
    expect(unstamped.ok && unstamped.facts.hookStartedAtMs).toBeNull()
  })

  it('reads the question card strictly', () => {
    expect(parseQuestions(ASK_INPUT)).toEqual(QUESTIONS)
    expect(parseQuestions({ questions: [{ question: 'Q?', options: [{ label: 'A' }] }] })).toEqual([{ question: 'Q?', header: '', multiSelect: false, options: [{ label: 'A', description: '' }] }])
    for (const bad of [
      {}, { questions: [] }, { questions: 'x' },
      { questions: [{ question: '', options: [{ label: 'A' }] }] },
      { questions: [{ question: 'Q', options: [] }] },
      { questions: [{ question: 'Q', options: [{ label: '' }] }] },
      { questions: [{ question: 'Q', options: [{ label: 'A' }] }, { question: 'Q', options: [{ label: 'B' }] }] },
    ]) expect(parseQuestions(bad as Record<string, unknown>)).toBeNull()
  })
})

describe('answers', () => {
  it('keys each list by the ORIGINAL question text, labels in option order, Other verbatim and last', () => {
    const v = validateQuestionAnswers(QUESTIONS, [{ labels: ['Publish', 'Bump'], other: '  also notify Gina ' }, { labels: ['Blue'] }])
    expect(v).toEqual({ ok: true, answers: { [Q1]: ['Bump', 'Publish', '  also notify Gina '], [Q2]: ['Blue'] } })
    // Other alone answers a single-select question.
    expect(validateQuestionAnswers(QUESTIONS, [{ labels: ['Tag'] }, { other: 'Green' }])).toEqual({ ok: true, answers: { [Q1]: ['Tag'], [Q2]: ['Green'] } })
  })

  it('free text with a comma is quoted, so the model reads it as ONE answer (canary 2026-09-19)', () => {
    const colors = [{ question: 'Colors?', header: 'Colors', multiSelect: true, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }, { label: 'Green, dark', description: '' }] }]
    // Claude Code joins the list with commas: "Red,Blue,Purple, but only on weekends" lost its clause.
    expect(validateQuestionAnswers(colors, [{ labels: ['Red', 'Blue'], other: 'Purple, but only on weekends' }]))
      .toEqual({ ok: true, answers: { 'Colors?': ['Red', 'Blue', '"Purple, but only on weekends"'] } })
    // A label is never touched, even one with a comma; free text without a comma is as written.
    expect(validateQuestionAnswers(colors, [{ labels: ['Green, dark'], other: 'Purple' }]))
      .toEqual({ ok: true, answers: { 'Colors?': ['Green, dark', 'Purple'] } })
  })

  it('refuses what cannot be sent', () => {
    const cases: Array<[unknown, string, number | undefined]> = [
      [undefined, 'answers_shape', undefined],
      [[{ labels: ['Bump'] }], 'answers_shape', undefined],
      [[{ labels: 'Bump' }, { labels: ['Blue'] }], 'answers_shape', 0],
      [[{ labels: ['Bump'] }, 'Blue'], 'answers_shape', 1],
      [[{ labels: ['Bump'] }, { labels: [], other: 7 }], 'answers_shape', 1],
      [[{ labels: ['bump'] }, { labels: ['Blue'] }], 'unknown_label', 0],
      [[{ labels: ['Bump', 'Bump'] }, { labels: ['Blue'] }], 'duplicate_label', 0],
      [[{ labels: ['Bump'] }, { labels: [] }], 'unanswered', 1],
      [[{ labels: ['Bump'] }, { other: '   ' }], 'unanswered', 1],
      [[{ labels: ['Bump'] }, { labels: ['Blue', 'Red'] }], 'too_many', 1],
      [[{ labels: ['Bump'] }, { labels: ['Blue'], other: 'Green' }], 'too_many', 1],
      [[{ labels: ['Bump'] }, { other: 'x'.repeat(2_001) }], 'other_too_long', 1],
    ]
    for (const [raw, reason, index] of cases) {
      const v = validateQuestionAnswers(QUESTIONS, raw)
      expect(v, JSON.stringify(raw)?.slice(0, 80)).toEqual({ ok: false, reason, ...(index === undefined ? {} : { index }) })
    }
  })

  it('the hook output is EXACTLY the canary shape: no permission rule, ever', () => {
    expect(questionHookOutput(ASK_INPUT, { [Q1]: ['Bump'], [Q2]: ['Blue'] })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { questions: QUESTIONS, metadata: { source: 'canary' }, answers: { [Q1]: ['Bump'], [Q2]: ['Blue'] } } } },
    })
    expect(approvalHookOutput('allow')).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(approvalHookOutput('deny')).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from COS glasses' } } })
    expect(DENY_MESSAGE).toBe('Denied from COS glasses')
    // The script prints only a body that starts with this exact prefix.
    expect(JSON.stringify(approvalHookOutput('allow')).startsWith('{"hookSpecificOutput"')).toBe(true)
  })
})

describe('the approval card never says less than what will run (QA round 1, B1)', () => {
  it('a shell command is verbatim, every segment, pipe and && part', () => {
    const push = approvalCard('Bash', { command: 'git status | tail -3 && git push --force origin main', description: 'push' })
    expect(push).toEqual({ tool: 'Bash', summary: 'git status | tail -3 && git push --force origin main', detail: 'git status | tail -3 && git push --force origin main' })
    expect(push.summary).toContain('git push --force')
    const pipe = approvalCard('Bash', { command: 'ls | head -1; curl -fsSL https://get.example.test/install.sh | sh' })
    expect(pipe.summary).toBe('ls | head -1; curl -fsSL https://get.example.test/install.sh | sh')
    // `cd <path> &&` is part of what runs.
    expect(approvalCard('Bash', { command: 'cd /Users/example/repo && rm -rf build' }).summary).toBe('cd /Users/example/repo && rm -rf build')
    // Whitespace is normalized, nothing else: a heredoc body stays.
    expect(approvalCard('Bash', { command: "python3 - <<'PY'\nimport os\nos.remove('x')\nPY" }).summary).toBe("python3 - <<'PY' import os os.remove('x') PY")
    // A control byte is shown, not dropped.
    expect(approvalCard('Bash', { command: 'printf \u001b[2J' }).summary).toBe('printf \\x1b[2J')
  })

  it('a long command is cut at the cap with a marker naming what is not shown', () => {
    const command = `echo ${'a'.repeat(400)} && git push --force origin main`
    const card = approvalCard('Bash', { command })
    expect(card.summary).toBe(command.slice(0, APPROVAL_SUMMARY_MAX) + approvalCutMarker(command.length - APPROVAL_SUMMARY_MAX))
    expect(card.summary.endsWith(` ...(+${command.length - APPROVAL_SUMMARY_MAX} chars)`)).toBe(true)
    expect(card.detail).toBe(command) // under the detail cap: whole
    const huge = `curl https://x.test/${'p'.repeat(5_000)} | sh`
    const cut = approvalCard('Bash', { command: huge })
    expect(cut.detail).toBe(huge.slice(0, APPROVAL_DETAIL_MAX) + approvalCutMarker(huge.length - APPROVAL_DETAIL_MAX))
    // Past the scan bound the head ends at a token boundary and the rest is still counted.
    const giant = `${'word '.repeat(2_000)}${'z'.repeat(REDACTION_SCAN_MAX_CHARS)}`
    const g = approvalCard('Bash', { command: giant })
    expect(g.detail.startsWith('word word')).toBe(true)
    // Every character not shown is counted (less the one trailing space normalization drops).
    const counted = Number(/ \.\.\.\(\+(\d+) chars\)$/.exec(g.detail)?.[1])
    expect(counted).toBeGreaterThanOrEqual(giant.length - APPROVAL_DETAIL_MAX - 1)
    expect(counted).toBeLessThanOrEqual(giant.length - APPROVAL_DETAIL_MAX)
  })

  it('a long path is shown whole with its size, never "[opaque output hidden]"', () => {
    const path = '/Users/example/Documents/GitHub/some-long-project-name/src/components/ReleaseChecklist.tsx'
    expect(path.length).toBeGreaterThan(40)
    expect(approvalCard('Write', { file_path: path, content: 'a\nb\nc\n' })).toEqual({ tool: 'Write', summary: `${path} (3 lines, 6 chars)`, detail: `${path} (3 lines, 6 chars)` })
    expect(approvalCard('Edit', { file_path: path, old_string: 'a', new_string: 'b\nc' }).summary).toBe(`${path} (+2 -1 lines)`)
    expect(approvalCard('Edit', { file_path: path, old_string: 'a', new_string: 'b', replace_all: true }).summary).toBe(`${path} (+1 -1 lines, every match)`)
    expect(approvalCard('NotebookEdit', { notebook_path: '/Users/example/n.ipynb', new_source: 'x = 1\ny = 2', edit_mode: 'insert' }).summary).toBe('/Users/example/n.ipynb (insert, 2 lines)')
    // A hash-like argument is shown too: only secrets are taken out.
    const sha = '3f1c9a7e5b2d4c6a8e0f1b3d5c7a9e2f4b6d8c0a'
    expect(approvalCard('Bash', { command: `git checkout ${sha}` }).summary).toBe(`git checkout ${sha}`)
  })

  it('WebFetch shows the URL, WebSearch the query, anything else its keys and values', () => {
    expect(approvalCard('WebFetch', { url: 'https://docs.example.test/page', prompt: 'summarize it' })).toMatchObject({ summary: 'https://docs.example.test/page' })
    expect(approvalCard('WebFetch', { url: 'https://user:pw@example.com/x', prompt: 'x' }).summary).not.toContain('user:pw')
    expect(approvalCard('WebSearch', { query: 'claude code hooks' }).summary).toBe('claude code hooks')
    const mcp = approvalCard('mcp__slack__send_message', { channel: 'C0123', text: 'Ship it', thread: { ts: '1.2' } })
    expect(mcp).toEqual({ tool: 'mcp__slack__send_message', summary: 'channel=C0123 text=Ship it thread={"ts":"1.2"}', detail: 'channel=C0123 text=Ship it thread={"ts":"1.2"}' })
    const many = approvalCard('SomeTool', Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key${i}`, 'v'.repeat(20)])))
    expect(many.summary.startsWith('key0=vvvv')).toBe(true)
    expect(many.summary).toMatch(/ \.\.\.\(\+\d+ chars\)$/)
  })

  it('redacts secrets (and only secrets) before it cuts: never half shown', () => {
    const card = approvalCard('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://x.test/api?token=s3cr3tvalue | head -5' })
    expect(card.summary).toContain('curl -H')
    expect(card.summary).toContain('| head -5')
    for (const secret of ['abcdefghijklmnop', 's3cr3tvalue']) {
      expect(card.summary).not.toContain(secret)
      expect(card.detail).not.toContain(secret)
    }
    // A key straddling the summary cap is redacted whole, not cut into a prefix.
    const straddle = approvalCard('Bash', { command: `echo ${'x'.repeat(APPROVAL_SUMMARY_MAX - 10)} AKIAABCDEFGHIJKLMNOP` })
    expect(straddle.summary).not.toMatch(/AKIA[A-Z]/)
    expect(straddle.detail).toContain('[redacted-aws-key]')
  })
})

describe('the broker, driven directly', () => {
  it('an answer is accepted only while the hook can take it: a socket that cannot is hook_gone, and nothing is written', async () => {
    const { broker } = brokerWith()
    brokers.push(broker)
    const admission = await broker.admit(permissionEnvelope('Bash', { command: 'touch x' }, {}, 1_000_000))
    expect(admission.ok).toBe(true)
    if (!admission.ok) return
    const { channel, sent } = fakeChannel(true)
    const id = broker.park(admission.request, channel)
    channel.open = false // the hook left; the close has not been processed yet
    expect(broker.answer(id, { clientAnswerId: 'a1', decision: 'allow' })).toEqual({ status: 410, body: { error: 'hook_gone' } })
    expect(sent).toEqual([])
    expect(broker.health().counters).toMatchObject({ answered: 0, hookGone: 1 })
  })

  it('first answer wins; the same clientAnswerId replays; a close after the answer changes nothing', async () => {
    const { broker } = brokerWith()
    brokers.push(broker)
    const admission = await broker.admit(permissionEnvelope('Bash', { command: 'touch x' }, {}, 1_000_000))
    if (!admission.ok) throw new Error('not admitted')
    const { channel, sent } = fakeChannel(true)
    const id = broker.park(admission.request, channel)
    expect(broker.answer(id, { clientAnswerId: 'first', decision: 'deny' })).toEqual({ status: 200, body: { ok: true, id, kind: 'approval', decision: 'deny' } })
    broker.hookClosed(id) // the response finished, then the socket closed
    expect(broker.answer(id, { clientAnswerId: 'second', decision: 'allow' })).toEqual({ status: 409, body: { error: 'already_answered', decision: 'deny' } })
    expect(broker.answer(id, { clientAnswerId: 'first', decision: 'allow' })).toEqual({ status: 200, body: { ok: true, id, kind: 'approval', replay: true, decision: 'deny' } })
    expect(sent).toEqual([approvalHookOutput('deny')])
    expect(broker.health().counters).toMatchObject({ parked: 1, answered: 1, hookGone: 0 })
  })

  it('every gate is counted by why, and the cheap ones never read the desk', async () => {
    const { broker, s, clock } = brokerWith()
    brokers.push(broker)
    s.mode = 'off'
    expect(await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).toEqual({ ok: false, reason: 'broker_off' })
    s.mode = 'all'
    s.admissions = false
    expect(await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).toEqual({ ok: false, reason: 'draining' })
    s.admissions = true
    expect((await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, { cursor_version: '3.21' }, clock.now)))).toEqual({ ok: false, reason: 'cursor' })
    s.mode = 'questions'
    expect(await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).toEqual({ ok: false, reason: 'approvals_off' })
    s.mode = 'all'
    expect(await broker.admit(permissionEnvelope('ExitPlanMode', { plan: 'x' }, {}, clock.now))).toEqual({ ok: false, reason: 'unsupported_tool' })
    s.seenAt = null
    expect(await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    // Unparseable questions are only looked at once every cheap gate passed.
    expect(await broker.admit(permissionEnvelope('AskUserQuestion', { questions: [] }, {}, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    s.seenAt = clock.now - CLIENT_LIVE_WINDOW_MS - 1
    expect(await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    s.seenAt = clock.now - CLIENT_LIVE_WINDOW_MS
    // A hook that started a deadline ago is about to give up: nothing to hold.
    expect(await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now - 110_000))).toEqual({ ok: false, reason: 'stale_hook' })
    expect(s.idleReads).toBe(0)
    s.idle = null
    expect(await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).toEqual({ ok: false, reason: 'desk_unknown' })
    s.idle = 89
    expect(await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).toEqual({ ok: false, reason: 'desk_active' })
    s.idle = 90
    expect(await broker.admit(permissionEnvelope('AskUserQuestion', { questions: [] }, {}, clock.now))).toEqual({ ok: false, reason: 'unsupported_input' })
    expect((await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).ok).toBe(true)
    expect(broker.health().counters.fastPath).toEqual({ brokerOff: 1, draining: 1, cursor: 1, approvalsOff: 1, unsupportedTool: 1, noClient: 3, staleHook: 1, deskUnknown: 1, deskActive: 1, unsupportedInput: 1 })
    expect(broker.health().counters.parked).toBe(0)
  })

  it('builds nothing from the input before the cheap gates pass: a 900 KB Write with no client is {} fast', async () => {
    const { broker, s, clock } = brokerWith()
    brokers.push(broker)
    s.seenAt = null
    const content = 'const x = 1\n'.repeat(75_000) // ~900 KB
    vi.mocked(redactSecretText).mockClear()
    const started = performance.now()
    expect(await broker.admit(permissionEnvelope('Write', { file_path: '/Users/example/big.ts', content }, {}, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    expect(performance.now() - started).toBeLessThan(20)
    expect(s.idleReads).toBe(0)
    // No card was built: not one redaction ran.
    expect(vi.mocked(redactSecretText)).not.toHaveBeenCalled()
  })

  it('no regex is ever handed more than the scan bound, whatever the input', () => {
    vi.mocked(redactSecretText).mockClear()
    const huge = `curl https://x.test/ ${'data '.repeat(200_000)}`
    approvalCard('Bash', { command: huge })
    approvalCard('mcp__x__y', { blob: 'q '.repeat(300_000), nested: { deep: 'z '.repeat(300_000) } })
    approvalCard('Write', { file_path: `/tmp/${'d/'.repeat(10_000)}f.ts`, content: 'x' })
    const lengths = vi.mocked(redactSecretText).mock.calls.map(([text]) => text.length)
    expect(lengths.length).toBeGreaterThan(0)
    expect(Math.max(...lengths)).toBeLessThanOrEqual(REDACTION_SCAN_MAX_CHARS)
  })

  it('capacity holds after the desk read: requests admitted during it count', async () => {
    const releases: Array<(v: number) => void> = []
    const { broker, clock } = brokerWith({ readDeskIdleSeconds: () => new Promise<number>(r => { releases.push(r) }) })
    brokers.push(broker)
    // MAX_PENDING - 1 already held.
    for (let i = 0; i < MAX_PENDING - 1; i++) {
      const pending = broker.admit(permissionEnvelope('Bash', { command: `echo ${i}` }, {}, clock.now))
      releases.shift()!(1_000)
      const a = await pending
      if (!a.ok) throw new Error(a.reason)
      broker.park(a.request, fakeChannel(true).channel)
    }
    // Two requests pass the first capacity check together, then read the desk.
    const one = broker.admit(permissionEnvelope('Bash', { command: 'echo one' }, {}, clock.now))
    const two = broker.admit(permissionEnvelope('Bash', { command: 'echo two' }, {}, clock.now))
    await new Promise(r => setTimeout(r, 0))
    expect(releases).toHaveLength(2)
    releases.shift()!(1_000)
    const first = await one
    if (!first.ok) throw new Error(first.reason)
    broker.park(first.request, fakeChannel(true).channel)
    releases.shift()!(1_000)
    expect(await two).toEqual({ ok: false, reason: 'capacity' })
    expect(broker.pendingCount()).toBe(MAX_PENDING)
  })

  it('the desk-idle setting never goes below 30 s', async () => {
    const { broker, s, clock } = brokerWith({ deskIdleSeconds: () => 5 })
    brokers.push(broker)
    expect(DESK_IDLE_MIN_S).toBe(30)
    s.idle = 29
    expect(await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))).toEqual({ ok: false, reason: 'desk_active' })
    s.idle = 30
    const a = await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))
    if (!a.ok) throw new Error(a.reason)
    const { channel, sent } = fakeChannel(true)
    broker.park(a.request, channel)
    // Held: 20 s idle is below the floor, so it reads as the desk.
    s.idle = 20
    await broker.tick()
    expect(sent).toEqual([{}])
  })

  it('the switch or a drain arriving DURING the desk read still answers {}', async () => {
    let release: (v: number) => void = () => {}
    const { broker, s, clock } = brokerWith({ readDeskIdleSeconds: () => new Promise<number>(r => { release = r }) })
    brokers.push(broker)
    const pending = broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))
    s.mode = 'off'
    release(1_000)
    expect(await pending).toEqual({ ok: false, reason: 'broker_off' })
    s.mode = 'all'
    const second = broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))
    s.admissions = false
    release(1_000)
    expect(await second).toEqual({ ok: false, reason: 'draining' })
    // Approvals turned off during the read: a question would still be held, a tool is not.
    s.admissions = true
    const third = broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))
    s.mode = 'questions'
    release(1_000)
    expect(await third).toEqual({ ok: false, reason: 'approvals_off' })
    const question = broker.admit(permissionEnvelope('AskUserQuestion', ASK_INPUT, {}, clock.now))
    release(1_000)
    expect((await question).ok).toBe(true)
  })

  it('the deadline counts from the hook\'s own start, and a timer settles it', async () => {
    const { broker, clock } = brokerWith({ timeoutMs: () => 110_000 })
    brokers.push(broker)
    const admission = await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now - 4_000))
    if (!admission.ok) throw new Error('not admitted')
    expect(admission.request.deadlineAt).toBe(clock.now - 4_000 + 110_000)
    // A stamp from the future is not trusted: the deadline counts from now.
    const future = await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now + 60_000))
    if (!future.ok) throw new Error('not admitted')
    expect(future.request.deadlineAt).toBe(clock.now + 110_000)
    // A deadline the timer has not reached yet still expires the item on the next read.
    const { channel, sent } = fakeChannel(true)
    const id = broker.park(admission.request, channel)
    clock.now += 106_000
    expect(broker.answer(id, { clientAnswerId: 'late', decision: 'allow' })).toEqual({ status: 409, body: { error: 'expired' } })
    expect(sent).toEqual([{}])
  })

  it('retracts on the session moving on without us, and only then', async () => {
    const { broker, clock } = brokerWith()
    brokers.push(broker)
    const bash = { command: 'touch par-a' }
    const park = async (tool: string, input: Record<string, unknown>) => {
      const a = await broker.admit(permissionEnvelope(tool, input, {}, clock.now))
      if (!a.ok) throw new Error(a.reason)
      const c = fakeChannel(true)
      return { id: broker.park(a.request, c.channel), sent: c.sent }
    }
    const approval = await park('Bash', bash)
    // A parallel auto-allowed tool, another command, a child, or history: none of them.
    broker.observeHookEvent(hookEvent('PostToolUse', clock.now + 1, { tool_name: 'Read', tool_input: { file_path: '/x' } }), false)
    broker.observeHookEvent(hookEvent('PostToolUse', clock.now + 1, { tool_name: 'Bash', tool_input: { command: 'ls' } }), false)
    broker.observeHookEvent(hookEvent('PostToolUse', clock.now + 1, { tool_name: 'Bash', tool_input: bash }), true)
    broker.observeHookEvent(hookEvent('PostToolUse', clock.now - 5, { tool_name: 'Bash', tool_input: bash }), false)
    broker.observeHookEvent(hookEvent('SessionStart', clock.now + 1, { source: 'compact' }), false)
    expect(approval.sent).toEqual([])
    // Its own tool ran: the native dialog was answered at the desk.
    broker.observeHookEvent(hookEvent('PostToolUse', clock.now + 2, { tool_name: 'Bash', tool_input: bash }), false)
    expect(approval.sent).toEqual([{}])
    expect(broker.answer(approval.id, { clientAnswerId: 'x', decision: 'allow' })).toEqual({ status: 409, body: { error: 'handed_to_desk', reason: 'retracted' } })

    const denied = await park('Bash', { command: 'rm -rf build' })
    broker.observeHookEvent(hookEvent('PermissionDenied', clock.now + 3, { tool_name: 'Bash', tool_input: { command: 'rm -rf build ' } }), false)
    expect(denied.sent).toEqual([{}])

    const question = await park('AskUserQuestion', ASK_INPUT)
    broker.observeHookEvent(hookEvent('PostToolUse', clock.now + 4, { tool_name: 'AskUserQuestion', tool_input: { ...ASK_INPUT, answers: { [Q1]: ['Tag'] } } }), false)
    expect(question.sent).toEqual([{}])

    for (const [event, payload] of [['Stop', {}], ['StopFailure', {}], ['SessionEnd', { reason: 'other' }], ['UserPromptSubmit', { prompt: 'x' }], ['SessionStart', { source: 'resume' }]] as const) {
      const held = await park('Bash', { command: `echo ${event}` })
      broker.observeHookEvent(hookEvent(event, clock.now + 5, payload), false)
      expect(held.sent, event).toEqual([{}])
    }
    expect(broker.health().counters.retracted).toBe(8)
    expect(broker.pendingCount()).toBe(0)
  })

  it('desk return and a drain hand every held item back, and a desk unreadable TWICE in a row counts as the desk', async () => {
    const { broker, s, clock } = brokerWith()
    brokers.push(broker)
    const park = async () => {
      const a = await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))
      if (!a.ok) throw new Error(a.reason)
      const c = fakeChannel(true)
      return { id: broker.park(a.request, c.channel), sent: c.sent }
    }
    const one = await park()
    await broker.tick()
    expect(one.sent).toEqual([]) // still away
    s.idle = 3
    await broker.tick()
    expect(one.sent).toEqual([{}])
    s.idle = 1_000
    const two = await park()
    s.admissions = false
    await broker.tick()
    expect(two.sent).toEqual([{}])
    expect(broker.answer(two.id, { clientAnswerId: 'x', decision: 'allow' })).toEqual({ status: 409, body: { error: 'handed_to_desk', reason: 'drained' } })
    s.admissions = true
    const three = await park()
    // One failed read is not the desk: a single ioreg that timed out under load.
    s.idle = null
    await broker.tick()
    expect(three.sent).toEqual([])
    // A good read in between resets the count.
    s.idle = 1_000
    await broker.tick()
    s.idle = null
    await broker.tick()
    expect(three.sent).toEqual([])
    // The second failure IN A ROW hands it back.
    await broker.tick()
    expect(three.sent).toEqual([{}])
    expect(broker.health().counters).toMatchObject({ handedToDesk: 2, drained: 1, deskUnreadable: 3 })
  })

  it('the answering client going quiet hands every held item back (no_client, its own counter)', async () => {
    const { broker, s, clock } = brokerWith()
    brokers.push(broker)
    const a = await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))
    if (!a.ok) throw new Error(a.reason)
    const { channel, sent } = fakeChannel(true)
    const id = broker.park(a.request, channel)
    clock.now += CLIENT_LIVE_WINDOW_MS // exactly the window: still live
    await broker.tick()
    expect(sent).toEqual([])
    clock.now += 1
    await broker.tick()
    expect(sent).toEqual([{}])
    expect(broker.answer(id, { clientAnswerId: 'late', decision: 'allow' })).toEqual({ status: 409, body: { error: 'handed_to_desk', reason: 'no_client' } })
    // A stamp from the future is stale while held, too.
    s.seenAt = clock.now + POLL_FUTURE_SKEW_MS + 1
    const b = await (async () => { s.seenAt = clock.now; return broker.admit(permissionEnvelope('Bash', { command: 'ls -a' }, {}, clock.now)) })()
    if (!b.ok) throw new Error(b.reason)
    const second = fakeChannel(true)
    broker.park(b.request, second.channel)
    s.seenAt = clock.now + POLL_FUTURE_SKEW_MS + 1
    await broker.tick()
    expect(second.sent).toEqual([{}])
    expect(broker.health().counters).toMatchObject({ noClient: 2, handedToDesk: 0 })
  })

  it('a settled item keeps codes and what was chosen, never the questions or the card', async () => {
    const { broker, clock } = brokerWith()
    brokers.push(broker)
    const internals = (id: string) => (broker as unknown as { items: Map<string, { questions: unknown; approval: unknown; toolInput: unknown; answer: unknown }> }).items.get(id)!
    const q = await broker.admit(permissionEnvelope('AskUserQuestion', ASK_INPUT, {}, clock.now))
    if (!q.ok) throw new Error(q.reason)
    const qid = broker.park(q.request, fakeChannel(true).channel)
    expect(internals(qid).questions).not.toBeNull()
    expect(broker.answer(qid, { clientAnswerId: 'c1', answers: [{ labels: ['Bump'] }, { labels: ['Blue'] }] }).status).toBe(200)
    expect(internals(qid)).toMatchObject({ questions: null, approval: null, toolInput: {}, answer: { clientAnswerId: 'c1', chosen: { answers: { [Q1]: ['Bump'], [Q2]: ['Blue'] } } } })
    const b = await broker.admit(permissionEnvelope('Bash', { command: 'echo secret-plan' }, {}, clock.now))
    if (!b.ok) throw new Error(b.reason)
    const bid = broker.park(b.request, fakeChannel(true).channel)
    expect(internals(bid).approval).not.toBeNull()
    broker.hookClosed(bid)
    expect(internals(bid)).toMatchObject({ questions: null, approval: null, toolInput: {} })
    expect(JSON.stringify(internals(bid))).not.toContain('secret-plan')
  })

  it('counts every refused answer', async () => {
    const { broker, clock } = brokerWith()
    brokers.push(broker)
    const a = await broker.admit(permissionEnvelope('AskUserQuestion', ASK_INPUT, {}, clock.now))
    if (!a.ok) throw new Error(a.reason)
    const id = broker.park(a.request, fakeChannel(true).channel)
    expect(broker.answer(id, { answers: [] }).status).toBe(400)
    expect(broker.answer(id, { clientAnswerId: 'c', answers: [{ labels: ['Nope'] }, { labels: ['Blue'] }] }).status).toBe(400)
    const b = await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, {}, clock.now))
    if (!b.ok) throw new Error(b.reason)
    const bid = broker.park(b.request, fakeChannel(true).channel)
    expect(broker.answer(bid, { clientAnswerId: 'c', decision: 'maybe' }).status).toBe(400)
    expect(broker.health().counters.invalidAnswer).toBe(3)
  })
})

describe('the rows (session signal store seams)', () => {
  const T0 = 1_000_000
  const derived = (store: SessionSignalStore, now: number, registry?: Parameters<typeof deriveSessionState>[0]['registry']) =>
    derivedRowFields(deriveSessionState({ signal: store.get(SESSION), registry, transcript: undefined, now }))

  it('an AskUserQuestion stays a QUESTION through its PermissionRequest and clears when the answered tool runs', () => {
    const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
    store.apply(hookEvent('UserPromptSubmit', T0, { prompt: 'ship it' }))
    store.apply(hookEvent('PreToolUse', T0 + 10, { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT }))
    store.apply(hookEvent('PermissionRequest', T0 + 20, { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT }))
    expect(derived(store, T0 + 30)).toMatchObject({ agent_state: 'waiting', waiting_kind: 'question' })
    // The input the tool ran with carries `answers`, so its fingerprint differs: the tool name clears it.
    store.apply(hookEvent('PostToolUse', T0 + 40, { tool_name: 'AskUserQuestion', tool_input: { ...ASK_INPUT, answers: { [Q1]: ['Bump'], [Q2]: ['Blue'] } } }))
    expect(derived(store, T0 + 50)).toMatchObject({ agent_state: 'running' })
    expect(derived(store, T0 + 50)).not.toHaveProperty('waiting_kind')
    // Any other tool's request is still a permission.
    store.apply(hookEvent('PermissionRequest', T0 + 60, { tool_name: 'Bash', tool_input: { command: 'ls' } }))
    expect(derived(store, T0 + 70)).toMatchObject({ waiting_kind: 'permission' })
  })

  it('a parked question carries pending_question_id, an approval pending_permission_id; the answer clears the wait', async () => {
    const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
    const { broker, clock } = brokerWith({ signals: brokerSignalSink(store) }, { now: T0 + 100 })
    brokers.push(broker)
    wirePermissionBrokerToSignals(broker, store)
    store.apply(hookEvent('UserPromptSubmit', T0, { prompt: 'ship it' }))
    store.apply(hookEvent('PreToolUse', T0 + 10, { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT }))
    store.apply(hookEvent('PermissionRequest', T0 + 20, { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT }))
    const a = await broker.admit(permissionEnvelope('AskUserQuestion', ASK_INPUT, {}, T0 + 20))
    if (!a.ok) throw new Error(a.reason)
    const { channel } = fakeChannel(true)
    const id = broker.park(a.request, channel)
    const row = derived(store, clock.now)
    expect(row).toMatchObject({ agent_state: 'waiting', waiting_kind: 'question', pending_question_id: id })
    expect(row).not.toHaveProperty('pending_permission_id')
    // The async PreToolUse landing late re-announces the same request: the id stays.
    store.apply(hookEvent('PreToolUse', T0 + 25, { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT }))
    expect(derived(store, clock.now)).toMatchObject({ pending_question_id: id })
    // A registry that moved after the wait (Claude writes its record while the hook is
    // held) does not end a wait the broker positively holds.
    const moved = { alive: true, status: 'busy', waitingFor: null, statusUpdatedAt: T0 + 50, lastActiveAt: T0 + 50 }
    expect(derived(store, clock.now, moved)).toMatchObject({ agent_state: 'waiting', pending_question_id: id })
    expect(broker.answer(id, { clientAnswerId: 'c1', answers: [{ labels: ['Bump'] }, { labels: ['Blue'] }] }).status).toBe(200)
    expect(derived(store, clock.now)).toMatchObject({ agent_state: 'running' })
    // A late copy of the PermissionRequest (stamped before the answer) must not strand the row.
    store.apply(hookEvent('PermissionRequest', T0 + 20, { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT }))
    expect(derived(store, clock.now)).toMatchObject({ agent_state: 'running' })
    // The SAME question asked again later is a new wait.
    clock.now += 1_000
    store.apply(hookEvent('PreToolUse', clock.now, { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT }))
    expect(derived(store, clock.now)).toMatchObject({ agent_state: 'waiting', waiting_kind: 'question' })
    expect(derived(store, clock.now)).not.toHaveProperty('pending_question_id')

    store.apply(hookEvent('Stop', clock.now + 1))
    store.apply(hookEvent('UserPromptSubmit', clock.now + 2, { prompt: 'next' }))
    store.apply(hookEvent('PermissionRequest', clock.now + 3, { tool_name: 'Bash', tool_input: { command: 'touch x' } }))
    const b = await broker.admit(permissionEnvelope('Bash', { command: 'touch x' }, {}, clock.now + 3))
    if (!b.ok) throw new Error(b.reason)
    const approvalId = broker.park(b.request, fakeChannel(true).channel)
    expect(derived(store, clock.now + 4)).toMatchObject({ waiting_kind: 'permission', pending_permission_id: approvalId })
    expect(derived(store, clock.now + 4)).not.toHaveProperty('pending_question_id')
    // Handed back to the desk: the wait stands (the native dialog is up), without the id.
    broker.observeHookEvent(hookEvent('UserPromptSubmit', clock.now + 5, { prompt: 'x' }), false)
    expect(derived(store, clock.now + 6)).not.toHaveProperty('pending_permission_id')
  })

  it('the reducer itself keeps the id across a re-announcement of the same request, and only that one', () => {
    // No broker listener here: the store alone must not drop the id the rows carry.
    const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
    store.apply(hookEvent('UserPromptSubmit', T0, { prompt: 'ship it' }))
    store.apply(hookEvent('PermissionRequest', T0 + 10, { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT }))
    expect(store.attachPermissionRequestId(SESSION, 'pq_000000000000000000000001', toolFingerprint('AskUserQuestion', ASK_INPUT))).toBe(true)
    store.apply(hookEvent('PreToolUse', T0 + 20, { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT }))
    expect(derived(store, T0 + 30)).toMatchObject({ waiting_kind: 'question', pending_question_id: 'pq_000000000000000000000001' })
    store.apply(hookEvent('PermissionRequest', T0 + 40, { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT }))
    expect(derived(store, T0 + 50)).toMatchObject({ pending_question_id: 'pq_000000000000000000000001' })
    // A different request is a different wait: no borrowed id.
    store.apply(hookEvent('PermissionRequest', T0 + 60, { tool_name: 'Bash', tool_input: { command: 'ls' } }))
    expect(derived(store, T0 + 70)).toMatchObject({ waiting_kind: 'permission' })
    expect(derived(store, T0 + 70)).not.toHaveProperty('pending_permission_id')
  })

  it('parked before the spool delivered its PermissionRequest: the event attaches the id when it lands', async () => {
    const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
    const { broker, clock } = brokerWith({ signals: brokerSignalSink(store) }, { now: T0 + 100 })
    brokers.push(broker)
    wirePermissionBrokerToSignals(broker, store)
    store.apply(hookEvent('UserPromptSubmit', T0, { prompt: 'ship it' }))
    const a = await broker.admit(permissionEnvelope('Bash', { command: 'touch x' }, {}, T0 + 20))
    if (!a.ok) throw new Error(a.reason)
    const id = broker.park(a.request, fakeChannel(true).channel)
    expect(derived(store, clock.now)).not.toHaveProperty('pending_permission_id')
    store.apply(hookEvent('PermissionRequest', T0 + 20, { tool_name: 'Bash', tool_input: { command: 'touch x' } }))
    expect(derived(store, clock.now)).toMatchObject({ agent_state: 'waiting', pending_permission_id: id })
    // A different dialog standing never takes another request's id, and a decision about
    // another request never clears it.
    expect(store.attachPermissionRequestId(SESSION, 'pq_other', toolFingerprint('Bash', { command: 'ls' }))).toBe(false)
    store.resolveWaiting(SESSION, { requestId: 'pq_other', fingerprint: toolFingerprint('Bash', { command: 'ls' }) })
    expect(derived(store, clock.now)).toMatchObject({ agent_state: 'waiting', pending_permission_id: id })
    store.detachPermissionRequestId(SESSION, 'pq_other')
    expect(derived(store, clock.now)).toMatchObject({ pending_permission_id: id })
    store.detachPermissionRequestId(SESSION, id)
    expect(derived(store, clock.now)).toMatchObject({ agent_state: 'waiting' })
    expect(derived(store, clock.now)).not.toHaveProperty('pending_permission_id')
    store.resolveWaiting(SESSION, { requestId: id, fingerprint: toolFingerprint('Bash', { command: 'touch x' }) })
    expect(derived(store, clock.now)).toMatchObject({ agent_state: 'running' })
  })

  it('health carries counts and the mode, never an id or text', async () => {
    const { broker, clock } = brokerWith()
    brokers.push(broker)
    registerPermissionBroker(broker)
    const a = await broker.admit(permissionEnvelope('AskUserQuestion', ASK_INPUT, {}, clock.now))
    if (!a.ok) throw new Error(a.reason)
    const id = broker.park(a.request, fakeChannel(true).channel)
    const { permissionBroker } = permissionBrokerHealthFields()
    expect(permissionBroker).toEqual({
      enabled: true, mode: 'all', lastFastPath: null, lastFastPathAt: null,
      lastQuestionsPollAt: new Date(clock.now).toISOString(),
      counters: { parked: 1, answered: 0, handedToDesk: 0, expired: 0, hookGone: 0, retracted: 0, drained: 0, noClient: 0, invalidAnswer: 0, deskUnreadable: 0, fastPath: {} },
    })
    // How many are held is on the authenticated questions route, never the public health.
    expect(permissionBroker).not.toHaveProperty('pending')
    const text = JSON.stringify(permissionBroker)
    expect(text).not.toContain(id)
    expect(text).not.toContain('release')
    // One key style across the block, the reason codes included.
    const keys = (value: unknown): string[] => value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)]) : []
    await broker.admit(permissionEnvelope('Bash', { command: 'ls' }, { cursor_version: '1' }, clock.now))
    for (const key of keys(broker.health())) expect(key, key).toMatch(/^[a-z][A-Za-z]*$/)
    expect(broker.health()).toMatchObject({ lastFastPath: 'cursor', lastFastPathAt: new Date(clock.now).toISOString() })
    expect(sessionQuestionsCapability()).toEqual({ enabled: true, mode: 'all', protocolVersion: 1, pollIntervalMs: 10_000, liveWindowMs: 30_000 })
    registerPermissionBroker(null)
    expect(permissionBrokerHealthFields()).toEqual({ permissionBroker: null })
    expect(sessionQuestionsCapability()).toEqual({ enabled: false, mode: 'off', protocolVersion: 1, pollIntervalMs: 10_000, liveWindowMs: 30_000 })
  })
})

describe.skipIf(process.platform !== 'darwin')('the desk, read for real', () => {
  it('ioreg answers a whole number of idle seconds, fast', async () => {
    const started = performance.now()
    const idle = await readHidIdleSeconds()
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(Number.isInteger(idle)).toBe(true)
    expect(idle!).toBeGreaterThanOrEqual(0)
  })
})
