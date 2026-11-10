// X1 (2026-11-09): the full hold. A question (COS_QUESTION_FULL_HOLD) or an approval
// (COS_APPROVAL_FULL_HOLD) held for the whole PermissionRequest hook wait on an engine proven to keep
// its own dialog up while the hook waits; the web door's touch and confirm steps while a switch is on;
// the `waiting` list. Every state transition, and every guard, has a test here that names it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionBroker, CONFIRM_ID_RE, MAX_WAITING, WAITING_ANSWERED_KEEP_MS, WAITING_MAX_AGE_MS, type PermissionBrokerDeps } from './permission-broker.js'
import { ASK_INPUT, SESSION, permissionEnvelope, Q1, Q2 } from './__fixtures__/permission-broker.js'
import type { EngineFacts, FullHoldSwitches } from './full-hold.js'
import type { HookEnvelope } from './session-hook-events.js'

const live: PermissionBroker[] = []
afterEach(() => { for (const b of live.splice(0)) b.stop(); vi.useRealTimers() })

const CLI_OK: EngineFacts = { entrypoint: 'cli', version: '2.1.321', host: 'terminal' }
const DESK_OK: EngineFacts = { entrypoint: 'claude-desktop', version: '2.1.317', host: 'desktop-app' }

function harness(opts: { switches?: FullHoldSwitches; engine?: EngineFacts | null; kindTimeout?: { question: number; approval: number } } = {}, extra: Partial<PermissionBrokerDeps> = {}) {
  const s = {
    now: 1_000_000, idle: 0 as number | null, open: true, reads: 0, engineReads: 0, switchReads: 0,
    switches: opts.switches ?? { questions: true, approvals: true },
    engine: opts.engine === undefined ? CLI_OK : opts.engine,
    kindTimeout: opts.kindTimeout ?? { question: 3600, approval: 3600 },
    lines: [] as string[],
    lastPpid: undefined as number | null | undefined,
  }
  let seq = 0
  let cseq = 0
  const deps: PermissionBrokerDeps = {
    now: () => s.now, mode: () => 'all', admissionsOpen: () => s.open,
    // No client is live and nobody was present: today's broker answers every one of these `{}`.
    lastQuestionsPollAt: () => null, lastLegacyPollAt: () => null, lastHoldPollAt: () => null, presenceAgeMs: () => null,
    readDeskIdleSeconds: async () => { s.reads++; return s.idle }, deskIdleSeconds: () => 90,
    timeoutMs: () => 110_000, awayHoldMs: () => 600_000, installedHookTimeoutS: () => 630,
    installedHookTimeoutForKindS: kind => s.kindTimeout[kind],
    fullHold: () => { s.switchReads++; return s.switches },
    engineFor: (_sid: string, ppid: number | null) => { s.engineReads++; s.lastPpid = ppid; return s.engine },
    pollMs: 60_000, newId: () => `pq_${String(++seq).padStart(24, '0')}`,
    newConfirmId: () => `pc_${String(++cseq).padStart(24, '0')}`,
    log: (line: string) => { s.lines.push(line) },
    ...extra,
  }
  const b = new PermissionBroker(deps)
  live.push(b)
  return { s, b, deps }
}

const ask = (now = 1_000_000, extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => {
  const env = permissionEnvelope('AskUserQuestion', ASK_INPUT, { tool_use_id: 'toolu_q1', ...payload }, now)
  return { ...env, hookWaitS: 3600, askHold: 1, ...extra }
}
const approval = (now = 1_000_000, extra: Record<string, unknown> = {}) => ({ ...permissionEnvelope('Bash', { command: 'git push origin main' }, { tool_use_id: 'toolu_b1' }, now), hookWaitS: 3600, ...extra })
const ev = (ts: number, name: HookEnvelope['event'], payload: Record<string, unknown> = {}): HookEnvelope =>
  ({ ts, ppid: 4242, sessionId: SESSION, event: name, payload: { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_q1', ...payload } })
const ANSWER = { answers: [{ labels: ['Bump'] }, { labels: ['Blue'] }] }

function park(h: ReturnType<typeof harness>, r: Awaited<ReturnType<PermissionBroker['admit']>>, writable = true) {
  if (!r.ok) throw Error(r.reason)
  const sent: Record<string, unknown>[] = []
  const id = h.b.park(r.request, { writable: () => writable, reply: body => { if (!writable) return false; sent.push(body); return true } })
  return { id, sent }
}

describe('full hold: admission', () => {
  it('holds a question with no client, no presence and the desk in use, for the whole hook wait, hidden until the desk is idle', async () => {
    const h = harness()
    const r = await h.b.admit(ask())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.request.fullHold).toBe(true)
    // holdCeilingS(3600, 3600) = 3590 s from the hook's own start.
    expect(r.request.deadlineAt).toBe(1_000_000 + 3_590_000)
    expect(r.request.lensVisible).toBe(false)
    expect(r.request.hold?.fullHold).toBe(true)
  })

  it('with the question switch off it is exactly today: no client means the Mac at once', async () => {
    const h = harness({ switches: { questions: false, approvals: true } })
    expect(await h.b.admit(ask())).toEqual({ ok: false, reason: 'no_client' })
  })

  it('never reads the registry with the switches off, and reads it only for the kind whose switch is on', async () => {
    const h = harness({ switches: { questions: false, approvals: false } })
    await h.b.admit(ask())
    await h.b.admit(approval())
    expect(h.s.engineReads).toBe(0)
    const q = harness({ switches: { questions: true, approvals: false } })
    q.s.idle = 200
    await q.b.admit(approval())
    expect(q.s.engineReads).toBe(0)
  })

  it.each([
    ['no registry record', null],
    ['a print run (sdk-cli)', { entrypoint: 'sdk-cli', version: '2.1.330', host: 'other' }],
    ['a print run labelled claude-desktop (started from a tab\'s shell)', { entrypoint: 'claude-desktop', version: '2.1.322', host: 'other' }],
    ['a print run labelled cli (no terminal)', { entrypoint: 'cli', version: '2.1.322', host: 'other' }],
    ['a desktop label in a terminal', { entrypoint: 'claude-desktop', version: '2.1.322', host: 'terminal' }],
    ['a CLI below the proven version', { entrypoint: 'cli', version: '2.1.320', host: 'terminal' }],
    ['a desktop engine below the proven version', { entrypoint: 'claude-desktop', version: '2.1.316', host: 'desktop-app' }],
    ['no version', { entrypoint: 'cli', version: null, host: 'terminal' }],
    ['a version that is not one', { entrypoint: 'cli', version: '2.1.x', host: 'terminal' }],
    ['an unknown entrypoint', { entrypoint: 'vscode', version: '9.9.9', host: 'terminal' }],
  ])('keeps today\'s rule for %s', async (_name, engine) => {
    const h = harness({ engine: engine as EngineFacts | null })
    expect(await h.b.admit(ask())).toEqual({ ok: false, reason: 'no_client' })
  })

  it('admits the proven desktop engine and a newer CLI', async () => {
    for (const engine of [DESK_OK, { entrypoint: 'cli', version: '2.2.0', host: 'terminal' as const }]) {
      const h = harness({ engine })
      expect((await h.b.admit(ask())).ok).toBe(true)
    }
  })

  it('keeps today\'s rule for an unstamped question (hook-ask-hold 0), a hook without its wait stamp, a background run and Codex', async () => {
    const cases: Record<string, unknown>[] = [
      { ...ask(), askHold: undefined },
      { ...ask(), hookWaitS: undefined },
      { ...ask(), provider: 'codex' },
    ]
    for (const body of cases) {
      const h = harness()
      expect(await h.b.admit(body)).toEqual({ ok: false, reason: 'no_client' })
    }
    const bg = harness({}, { isBackgroundRequest: () => true })
    expect((await bg.b.admit(ask())).ok).toBe(false)
  })

  it('times a question from the question block and an approval from its own block', async () => {
    const h = harness({ kindTimeout: { question: 3600, approval: 630 } })
    h.s.idle = 200
    const q = await h.b.admit(ask())
    const a = await h.b.admit(approval(1_000_000, { hookWaitS: 630 }))
    expect(q.ok && q.request.deadlineAt).toBe(1_000_000 + 3_590_000)
    expect(a.ok && a.request.deadlineAt).toBe(1_000_000 + 620_000)
  })

  it('never holds past the stamp this invocation carries (an older block still installed)', async () => {
    const h = harness()
    const r = await h.b.admit(ask(1_000_000, { hookWaitS: 630 }))
    expect(r.ok && r.request.deadlineAt).toBe(1_000_000 + 620_000)
  })

  it('a hook already past its whole wait is stale, not held', async () => {
    const h = harness()
    h.s.now = 1_000_000 + 3_600_000
    expect(await h.b.admit(ask(1_000_000))).toEqual({ ok: false, reason: 'stale_hook' })
  })

  it('an approval keeps the desk rules: an active or unreadable desk is the Mac at once', async () => {
    const h = harness()
    h.s.idle = 10
    expect(await h.b.admit(approval())).toEqual({ ok: false, reason: 'desk_active' })
    h.s.idle = null
    expect(await h.b.admit(approval())).toEqual({ ok: false, reason: 'desk_unknown' })
    h.s.idle = 200
    const r = await h.b.admit(approval())
    expect(r.ok && r.request.fullHold && r.request.lensVisible).toBe(true)
  })

  it('never brokers ExitPlanMode, and approvals stay off under COS_PERMISSION_BROKER=questions', async () => {
    const h = harness()
    h.s.idle = 200
    expect(await h.b.admit({ ...permissionEnvelope('ExitPlanMode', { plan: 'x' }), hookWaitS: 3600 })).toEqual({ ok: false, reason: 'unsupported_tool' })
    const q = harness({}, { mode: () => 'questions' })
    q.s.idle = 200
    expect(await q.b.admit(approval())).toEqual({ ok: false, reason: 'approvals_off' })
  })

  it('an approval with only the question switch on keeps today\'s rule', async () => {
    const h = harness({ switches: { questions: true, approvals: false } })
    h.s.idle = 200
    expect(await h.b.admit(approval())).toEqual({ ok: false, reason: 'no_client' })
  })
})

describe('Q1 review fixes', () => {
  it('O2: the engine probe gets the hook\'s own ppid', async () => {
    const h = harness()
    await h.b.admit(ask())
    expect(h.s.lastPpid).toBe(4242)
    const none = harness()
    await none.b.admit({ ...ask(), ppid: 'x' })
    expect(none.s.lastPpid).toBeNull()
  })

  it('F1: with both hold switches off a listed item has no toolUseId; with one on it does', async () => {
    for (const on of [false, true]) {
      const h = harness({ switches: { questions: false, approvals: on } }, { lastLegacyPollAt: () => 1_000_000, lastQuestionsPollAt: () => 1_000_000 })
      h.s.idle = 200
      park(h, await h.b.admit(ask(1_000_000, { hookWaitS: 630 })))
      const [view] = h.b.list()
      expect('toolUseId' in view!).toBe(on)
      expect('fullHold' in view!).toBe(false)
    }
  })

  it('F2: with both switches off /confirm is 404 and mints nothing', async () => {
    const h = harness({ switches: { questions: false, approvals: false } }, { lastLegacyPollAt: () => 1_000_000, lastQuestionsPollAt: () => 1_000_000 })
    h.s.idle = 200
    const { id } = park(h, await h.b.admit(approval(1_000_000, { hookWaitS: 630 })))
    expect(h.b.confirm(id, { decision: 'allow', presenceAgeMs: 0 }, 'web')).toEqual({ status: 404, body: { error: 'not_found' } })
    expect((h.b as unknown as { confirms: Map<string, unknown> }).confirms.size).toBe(0)
  })

  it('O1: an item no device is shown yet cannot be answered by id (any door); a hand-back can; after the latch it answers', async () => {
    const h = harness()
    const { id } = park(h, await h.b.admit(ask()))
    expect(h.b.answer(id, { clientAnswerId: 'app', ...ANSWER }, 'app')).toEqual({ status: 409, body: { error: 'not_shown' } })
    expect(h.b.answer(id, { clientAnswerId: 'web', ...ANSWER, presenceAgeMs: 1 }, 'web')).toEqual({ status: 409, body: { error: 'not_shown' } })
    expect(h.b.pendingCount()).toBe(1)
    h.s.idle = 95
    await h.b.tick()
    expect(h.b.answer(id, { clientAnswerId: 'app', ...ANSWER }, 'app').status).toBe(200)
    const other = harness()
    const second = park(other, await other.b.admit(ask()))
    expect(other.b.answer(second.id, { clientAnswerId: 'leave', handBack: true }, 'app').status).toBe(200)
    expect(second.sent).toEqual([{}])
  })

  it('G1: a confirm id is gone the moment it is used (single use, seen in the store itself)', async () => {
    const h = harness()
    h.s.idle = 200
    const { id } = park(h, await h.b.admit(approval()))
    const c = String(h.b.confirm(id, { decision: 'allow', presenceAgeMs: 0 }, 'web').body.confirmId)
    const store = (h.b as unknown as { confirms: Map<string, unknown> }).confirms
    expect(store.has(c)).toBe(true)
    expect(h.b.answer(id, { clientAnswerId: 'w', decision: 'allow', confirmId: c, presenceAgeMs: 0 }, 'web').status).toBe(200)
    expect(store.has(c)).toBe(false)
  })

  it('G3: a web approval with a valid confirm id still needs its own fresh touch at answer time, and the refusal does not spend the id', async () => {
    const h = harness()
    h.s.idle = 200
    const { id } = park(h, await h.b.admit(approval()))
    const c = h.b.confirm(id, { decision: 'deny', presenceAgeMs: 0 }, 'web').body.confirmId
    for (const presenceAgeMs of [undefined, 60_001]) {
      expect(h.b.answer(id, { clientAnswerId: 'w', decision: 'deny', confirmId: c, presenceAgeMs }, 'web')).toEqual({ status: 403, body: { error: 'web_touch_required' } })
    }
    expect(h.b.answer(id, { clientAnswerId: 'w', decision: 'deny', confirmId: c, presenceAgeMs: 3 }, 'web').status).toBe(200)
  })
})

describe('full hold: while held', () => {
  it('a question stays answerable with no client and an active desk, and its card appears once the desk is idle', async () => {
    const h = harness()
    const { id } = park(h, await h.b.admit(ask()))
    for (let i = 0; i < 5; i++) { h.s.now += 60_000; h.s.idle = 5; await h.b.tick() }
    expect(h.b.pendingCount()).toBe(1)
    expect(h.b.list()).toEqual([])
    h.s.idle = 95
    await h.b.tick()
    expect(h.b.list().map(v => [v.id, v.fullHold, v.toolUseId])).toEqual([[id, true, 'toolu_q1']])
  })

  it('an approval stays held with no client while the desk is idle, and goes back to the Mac when the desk is used', async () => {
    const h = harness()
    h.s.idle = 200
    const { sent } = park(h, await h.b.admit(approval()))
    h.s.now += 300_000
    await h.b.tick()
    expect(h.b.pendingCount()).toBe(1)
    h.s.idle = 3
    await h.b.tick()
    expect(h.b.pendingCount()).toBe(0)
    expect(sent).toEqual([{}])
    expect(h.b.settledList()[0]).toMatchObject({ resolution: 'handed_to_desk', waitingAtMac: true })
  })

  it('kill switch: a switch read off on the next tick hands back that kind at once, and only that kind', async () => {
    const h = harness()
    h.s.idle = 200
    const q = park(h, await h.b.admit(ask()))
    const a = park(h, await h.b.admit(approval()))
    h.s.switches = { questions: false, approvals: true }
    await h.b.tick()
    expect(q.sent).toEqual([{}])
    expect(a.sent).toEqual([])
    h.s.switches = { questions: false, approvals: false }
    await h.b.tick()
    expect(a.sent).toEqual([{}])
    expect(h.b.pendingCount()).toBe(0)
  })

  it('expires at the deadline with {} (the Mac dialog stays), and a late answer reads expired', async () => {
    vi.useFakeTimers()
    const h = harness()
    const { id, sent } = park(h, await h.b.admit(ask()))
    h.s.now += 3_590_000
    vi.advanceTimersByTime(3_590_000)
    expect(sent).toEqual([{}])
    expect(h.b.answer(id, { clientAnswerId: 'late', ...ANSWER }).body).toEqual({ error: 'expired' })
  })

  it('a drain or a server stop hands every held item back to the Mac', async () => {
    for (const how of ['drain', 'stop']) {
      const h = harness()
      h.s.idle = 200
      const q = park(h, await h.b.admit(ask()))
      const a = park(h, await h.b.admit(approval()))
      if (how === 'drain') { h.s.open = false; await h.b.tick() } else h.b.stop()
      expect([q.sent, a.sent]).toEqual([[{}], [{}]])
    }
  })

  it('first answer wins: a COS answer writes the hook once; the desk answering first closes the card', async () => {
    const h = harness()
    h.s.idle = 200
    const first = park(h, await h.b.admit(ask()))
    expect(h.b.answer(first.id, { clientAnswerId: 'lens', ...ANSWER }).status).toBe(200)
    expect(first.sent).toHaveLength(1)
    expect(h.b.answer(first.id, { clientAnswerId: 'other', ...ANSWER }).status).toBe(409)
    const desk = harness()
    desk.s.idle = 200
    const second = park(desk, await desk.b.admit(ask()))
    desk.b.observeHookEvent(ev(desk.s.now + 5, 'PostToolUse'), false)
    expect(desk.b.pendingCount()).toBe(0)
    expect(desk.b.answer(second.id, { clientAnswerId: 'lens', ...ANSWER }).status).toBe(409)
  })

  it('a session row that ends retracts a held approval too', async () => {
    const h = harness()
    h.s.idle = 200
    const { sent } = park(h, await h.b.admit(approval()))
    expect(h.b.sessionRowEnded(SESSION)).toBe(1)
    expect(sent).toEqual([{}])
  })

  it('a recent web touch never makes a full-hold question web-only: the desk does not take it back', async () => {
    const h = harness({}, { webPresenceAgeMs: () => 1_000, awayRecentClientMs: () => 1_800_000 })
    h.s.idle = 200
    const r = await h.b.admit(ask())
    expect(r.ok && r.request.webOnly).toBeFalsy()
    park(h, r)
    h.s.idle = 2
    await h.b.tick()
    expect(h.b.pendingCount()).toBe(1)
  })

  it('a hook that left is hook_gone, and an answer to it reads 410', async () => {
    const h = harness()
    h.s.idle = 200
    const { id } = park(h, await h.b.admit(ask()), false)
    expect(h.b.answer(id, { clientAnswerId: 'lens', ...ANSWER }).status).toBe(410)
  })
})

describe('full hold: the web door', () => {
  async function heldApproval(switches: FullHoldSwitches = { questions: true, approvals: true }) {
    const h = harness({ switches })
    h.s.idle = 200
    const p = park(h, await h.b.admit({ ...approval(), ...(switches.approvals ? {} : {}) }))
    return { h, ...p }
  }

  it('needs a fresh touch on every web answer and hand-back while a switch is on', async () => {
    const h = harness()
    h.s.idle = 200
    const { id } = park(h, await h.b.admit(ask()))
    for (const presenceAgeMs of [undefined, -1, 60_001, 1.5, '10']) {
      expect(h.b.answer(id, { clientAnswerId: 'w', ...ANSWER, presenceAgeMs }, 'web')).toEqual({ status: 403, body: { error: 'web_touch_required' } })
      expect(h.b.answer(id, { clientAnswerId: 'w', handBack: true, presenceAgeMs }, 'web').status).toBe(403)
    }
    expect(h.b.answer(id, { clientAnswerId: 'w', ...ANSWER, presenceAgeMs: 60_000 }, 'web').status).toBe(200)
  })

  it('a web hand-back with a fresh touch gives the question back to the Mac ({}), and is listed waiting at the Mac', async () => {
    const h = harness()
    const { id, sent } = park(h, await h.b.admit(ask()))
    expect(h.b.answer(id, { clientAnswerId: 'leave', handBack: true, presenceAgeMs: 10 }, 'web').body).toEqual({ ok: true, id, kind: 'question', handedBack: true })
    expect(sent).toEqual([{}])
    expect(h.b.settledList()[0]).toMatchObject({ resolution: 'handed_to_desk', waitingAtMac: true })
  })

  it('the token door (glasses, phone app, Control through its helper) needs neither step', async () => {
    const h = harness()
    h.s.idle = 200
    const q = park(h, await h.b.admit(ask()))
    const a = park(h, await h.b.admit(approval()))
    expect(h.b.answer(q.id, { clientAnswerId: 'app', ...ANSWER }, 'app').status).toBe(200)
    expect(h.b.answer(a.id, { clientAnswerId: 'app', decision: 'allow' }, 'app').status).toBe(200)
  })

  it('a web approval needs a confirm id this server issued for that item and that decision, once', async () => {
    const { h, id, sent } = await heldApproval()
    const touch = { presenceAgeMs: 100 }
    expect(h.b.answer(id, { clientAnswerId: 'w1', decision: 'allow', ...touch }, 'web').body).toEqual({ error: 'confirm_required' })
    expect(h.b.answer(id, { clientAnswerId: 'w1', decision: 'allow', confirmId: 'nope', ...touch }, 'web').body).toEqual({ error: 'confirm_invalid' })
    const deny = h.b.confirm(id, { decision: 'deny', ...touch }, 'web')
    expect(deny.status).toBe(200)
    expect(String(deny.body.confirmId)).toMatch(CONFIRM_ID_RE)
    // A confirm for deny never approves.
    expect(h.b.answer(id, { clientAnswerId: 'w1', decision: 'allow', confirmId: deny.body.confirmId, ...touch }, 'web').body).toEqual({ error: 'confirm_invalid' })
    const allow = h.b.confirm(id, { decision: 'allow', ...touch }, 'web')
    expect(h.b.answer(id, { clientAnswerId: 'w1', decision: 'allow', confirmId: allow.body.confirmId, ...touch }, 'web').status).toBe(200)
    expect(sent).toEqual([{ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }])
  })

  it('a confirm id is single use, expires, and belongs to one item', async () => {
    const { h, id } = await heldApproval()
    const other = park(h, await h.b.admit(approval(h.s.now, { payload: { ...approval().payload, tool_use_id: 'toolu_b2', tool_input: { command: 'ls' } } })))
    const touch = { presenceAgeMs: 0 }
    const c = h.b.confirm(id, { decision: 'deny', ...touch }, 'web').body.confirmId
    expect(h.b.answer(other.id, { clientAnswerId: 'x', decision: 'deny', confirmId: c, ...touch }, 'web').body).toEqual({ error: 'confirm_invalid' })
    const late = h.b.confirm(other.id, { decision: 'deny', ...touch }, 'web').body.confirmId
    h.s.now += 60_000
    expect(h.b.answer(other.id, { clientAnswerId: 'x', decision: 'deny', confirmId: late, ...touch }, 'web').body).toEqual({ error: 'confirm_invalid' })
    const fresh = h.b.confirm(id, { decision: 'deny', ...touch }, 'web').body.confirmId
    expect(h.b.answer(id, { clientAnswerId: 'y', decision: 'deny', confirmId: fresh, ...touch }, 'web').status).toBe(200)
    // Spent: the same id cannot answer anything again (the item is settled, so this reads its settled code first).
    const third = park(h, await h.b.admit(approval(h.s.now, { payload: { ...approval().payload, tool_use_id: 'toolu_b3', tool_input: { command: 'pwd' } } })))
    expect(h.b.answer(third.id, { clientAnswerId: 'z', decision: 'deny', confirmId: fresh, ...touch }, 'web').body).toEqual({ error: 'confirm_invalid' })
  })

  it('the confirm route: approvals only, a real decision, the web door only, a fresh touch, a live item', async () => {
    const { h, id } = await heldApproval()
    const q = park(h, await h.b.admit(ask()))
    expect(h.b.confirm('pq_nope', { decision: 'allow', presenceAgeMs: 0 }, 'web').status).toBe(404)
    expect(h.b.confirm(q.id, { decision: 'allow', presenceAgeMs: 0 }, 'web').body).toEqual({ error: 'invalid_confirm', reason: 'kind' })
    expect(h.b.confirm(id, { decision: 'maybe', presenceAgeMs: 0 }, 'web').body).toEqual({ error: 'invalid_confirm', reason: 'decision' })
    expect(h.b.confirm(id, { decision: 'allow', presenceAgeMs: 0 }, 'app').body).toEqual({ error: 'invalid_confirm', reason: 'surface' })
    expect(h.b.confirm(id, { decision: 'allow' }, 'web').body).toEqual({ error: 'web_touch_required' })
    expect(h.b.answer(id, { clientAnswerId: 'app', decision: 'deny' }, 'app').status).toBe(200)
    expect(h.b.confirm(id, { decision: 'allow', presenceAgeMs: 0 }, 'web').status).toBe(409)
  })

  it('with both switches off the web door is exactly today\'s: no touch, no confirm', async () => {
    const h = harness({ switches: { questions: false, approvals: false } }, { lastLegacyPollAt: () => 1_000_000, lastQuestionsPollAt: () => 1_000_000 })
    h.s.idle = 200
    const a = park(h, await h.b.admit(approval(1_000_000, { hookWaitS: 630 })))
    expect(h.b.answer(a.id, { clientAnswerId: 'w', decision: 'allow' }, 'web').status).toBe(200)
    expect(h.b.webAnswerRules()).toEqual({ touchRequired: false, touchMaxMs: 60_000, confirmApprovals: false })
  })
})

describe('the waiting list', () => {
  it('is empty with every switch off, and the route then adds nothing', () => {
    const h = harness({ switches: { questions: false, approvals: false } })
    h.b.observeHookEvent(ev(h.s.now, 'PreToolUse'), false)
    expect(h.b.extendedQuestionsView()).toBe(false)
    expect(h.b.waitingList()).toEqual([])
  })

  it('either hold switch alone turns it on', () => {
    for (const switches of [{ questions: true, approvals: false }, { questions: false, approvals: true }]) {
      const h = harness({ switches })
      h.b.observeHookEvent(ev(h.s.now, 'PreToolUse'), false)
      expect(h.b.waitingList().map(w => w.state)).toEqual(['at_mac'])
    }
  })

  it('walks at_mac, held, answered (by COS), and is dropped after the keep window', async () => {
    const h = harness()
    h.b.observeHookEvent(ev(h.s.now, 'PreToolUse'), false)
    const [atMac] = h.b.waitingList()
    expect(atMac).toMatchObject({ key: `${SESSION}:toolu_q1`, state: 'at_mac', answerable: false, heldId: null, deadlineAt: null, answeredBy: null })
    expect(atMac!.questions.map(q => q.question)).toEqual([Q1, Q2])
    h.s.idle = 200
    const { id } = park(h, await h.b.admit(ask()))
    expect(h.b.waitingList()).toEqual([expect.objectContaining({ state: 'held', answerable: true, heldId: id, deadlineAt: new Date(1_000_000 + 3_590_000).toISOString() })])
    expect(h.b.answer(id, { clientAnswerId: 'lens', ...ANSWER }).status).toBe(200)
    h.b.observeHookEvent(ev(h.s.now + 10, 'PostToolUse'), false)
    expect(h.b.waitingList()).toEqual([expect.objectContaining({ state: 'answered', answerable: false, questions: [], answeredBy: 'cos' })])
    // Dropped on settle: the words are gone from memory, not only from the view.
    const kept = [...(h.b as unknown as { waiting: Map<string, { questions: unknown }> }).waiting.values()]
    expect(kept.map(e => e.questions)).toEqual([null])
    h.s.now += WAITING_ANSWERED_KEEP_MS + 11
    expect(h.b.waitingList()).toEqual([])
  })

  it('answered at the Mac reads answeredBy mac', () => {
    const h = harness()
    h.b.observeHookEvent(ev(h.s.now, 'PreToolUse'), false)
    h.b.observeHookEvent(ev(h.s.now + 1, 'PostToolUse'), false)
    expect(h.b.waitingList()[0]).toMatchObject({ state: 'answered', answeredBy: 'mac' })
  })

  it('two questions in one session: only the one with the held tool_use id reads held', async () => {
    const h = harness()
    h.s.idle = 200
    h.b.observeHookEvent(ev(h.s.now, 'PreToolUse', { tool_use_id: 'toolu_other' }), false)
    h.b.observeHookEvent(ev(h.s.now + 1, 'PreToolUse'), false)
    park(h, await h.b.admit(ask()))
    expect(h.b.waitingList().map(w => [w.toolUseId, w.state])).toEqual([['toolu_other', 'at_mac'], ['toolu_q1', 'held']])
  })

  it('a held question behind the desk latch reads at_mac', async () => {
    const h = harness()
    h.b.observeHookEvent(ev(h.s.now, 'PreToolUse'), false)
    park(h, await h.b.admit(ask()))
    expect(h.b.waitingList()[0]!.state).toBe('at_mac')
  })

  it('a held question whose PreToolUse has not arrived is still listed, held', async () => {
    const h = harness()
    h.s.idle = 200
    const { id } = park(h, await h.b.admit(ask()))
    expect(h.b.waitingList()).toEqual([expect.objectContaining({ key: `${SESSION}:toolu_q1`, state: 'held', heldId: id })])
  })

  it('a failure, a denial, a turn end, an interrupt or a new session drops it; a child event and a replayed projection add nothing', () => {
    for (const name of ['PostToolUseFailure', 'PermissionDenied', 'Stop', 'Interrupt', 'SessionStart', 'UserPromptSubmit'] as const) {
      const h = harness()
      h.b.observeHookEvent(ev(h.s.now, 'PreToolUse'), false)
      h.b.observeHookEvent(ev(h.s.now + 1, name, name === 'SessionStart' ? { source: 'startup' } : {}), false)
      expect(h.b.waitingList()).toEqual([])
    }
    const h = harness()
    h.b.observeHookEvent(ev(h.s.now, 'PreToolUse'), true)
    h.b.observeHookEvent(ev(h.s.now, 'PreToolUse', { agent_id: 'sub' }), false)
    h.b.observeHookEvent({ ...ev(h.s.now, 'PreToolUse'), payload: { tool_name: 'AskUserQuestion', tool_target: 'x', tool_use_id: 'toolu_q9' } }, false)
    expect(h.b.waitingList()).toEqual([])
    h.b.observeHookEvent(ev(h.s.now, 'PreToolUse'), false)
    h.b.observeHookEvent(ev(h.s.now + 1, 'SessionStart', { source: 'compact' }), false)
    expect(h.b.waitingList()).toHaveLength(1)
  })

  it('a session row that ends drops its entries', () => {
    const h = harness()
    h.b.observeHookEvent(ev(h.s.now, 'PreToolUse'), false)
    h.b.sessionRowEnded(SESSION)
    expect(h.b.waitingList()).toEqual([])
  })

  it('is bounded: at most MAX_WAITING entries, none older than a day', () => {
    const h = harness()
    for (let i = 0; i < MAX_WAITING + 5; i++) h.b.observeHookEvent(ev(h.s.now + i, 'PreToolUse', { tool_use_id: `toolu_${i}` }), false)
    const listed = h.b.waitingList()
    expect(listed).toHaveLength(MAX_WAITING)
    expect(listed[0]!.toolUseId).toBe('toolu_5')
    h.s.now += WAITING_MAX_AGE_MS + MAX_WAITING + 10
    expect(h.b.waitingList()).toEqual([])
  })

  it('never logs a question\'s words', async () => {
    const h = harness()
    h.s.idle = 200
    h.b.observeHookEvent(ev(h.s.now, 'PreToolUse'), false)
    const { id } = park(h, await h.b.admit(ask()))
    h.b.waitingList()
    h.b.answer(id, { clientAnswerId: 'w', ...ANSWER, presenceAgeMs: 5 }, 'web')
    const all = h.s.lines.join('\n')
    expect(all).not.toContain('release steps')
    expect(all).not.toContain('Pick a color')
  })
})
