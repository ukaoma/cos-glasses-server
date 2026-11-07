// 6.99.26 (Miles 11/07, "Away rule, like phone"): COS Control Web's touch counts for the away hold only. The broker
// on fake clocks and fake stamps: what a recent or stale web touch admits, what it keeps through the re-check, and
// that it never stands in for a live client. The real route and liveness module: routes/session-questions-web.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import { PermissionBroker, webAwayHoldEnabled, type PermissionBrokerDeps } from './permission-broker.js'
import { ASK_INPUT, permissionEnvelope } from './__fixtures__/permission-broker.js'
import { __resetClientLivenessForTests, lastHoldQuestionsPollAt, lastLegacyQuestionsPollAt, lastQuestionsPollAt, noteWebPresence, presenceAgeMs, webPresenceAgeMs } from './client-liveness.js'

const live: PermissionBroker[] = []
afterEach(() => { for (const b of live.splice(0)) b.stop(); __resetClientLivenessForTests() })

const MIN = 60_000
function harness(extra: Partial<PermissionBrokerDeps> = {}) {
  const s = { now: 1_000_000_000, idle: 1_000 as number | null, legacy: null as number | null, hold: null as number | null, presence: null as number | null, web: null as number | null }
  const lines: string[] = []
  let seq = 0
  const deps: PermissionBrokerDeps = {
    now: () => s.now, mode: () => 'all', admissionsOpen: () => true,
    lastQuestionsPollAt: () => s.legacy, lastLegacyPollAt: () => s.legacy, lastHoldPollAt: () => s.hold,
    presenceAgeMs: () => s.presence, webPresenceAgeMs: () => s.web,
    readDeskIdleSeconds: async () => s.idle, deskIdleSeconds: () => 90, timeoutMs: () => 110_000,
    awayHoldMs: () => 600_000, installedHookTimeoutS: () => 630, awayRecentClientMs: () => 30 * MIN,
    pollMs: 60_000, newId: () => `pq_${String(++seq).padStart(24, '0')}`, log: line => { lines.push(line) }, ...extra,
  }
  const b = new PermissionBroker(deps)
  live.push(b)
  return { s, b, lines }
}
const ask = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) => ({ ...permissionEnvelope('AskUserQuestion', ASK_INPUT, {}, h.s.now), hookWaitS: 630, ...extra })
const bash = (h: ReturnType<typeof harness>) => ({ ...permissionEnvelope('Bash', { command: 'echo harmless' }, {}, h.s.now), hookWaitS: 630 })
async function park(h: ReturnType<typeof harness>, body: unknown) {
  const r = await h.b.admit(body)
  if (!r.ok) throw new Error(r.reason)
  const sent: unknown[] = []
  const id = h.b.park(r.request, { writable: () => true, reply: x => { sent.push(x); return true } })
  return { id, sent, request: r.request }
}
const lastLine = (lines: string[]) => lines.filter(l => l.includes('fast path')).pop()

describe('a touch on COS Control Web and the away hold (6.99.26)', () => {
  it('recent and away: a question or an approval is away-held, though no client is live', async () => {
    for (const body of [ask, bash]) {
      const h = harness()
      h.s.web = 2 * MIN
      const { request } = await park(h, body(h))
      expect(request.awayHold).toBe(true)
      expect(request.deadlineAt - h.s.now).toBe(600_000)
      expect(request.hold).toMatchObject({ clientLive: false, notAwayReason: null, webOnly: true, webPresenceAgeMs: 2 * MIN })
      expect(request.webOnly).toBe(true)
      expect(h.b.list()).toHaveLength(1)
    }
  })

  it('at the desk: an unstamped question or an approval goes to the Mac at once', async () => {
    for (const body of [ask, bash]) {
      const h = harness()
      h.s.web = 1_000; h.s.idle = 5
      expect(await h.b.admit(body(h))).toEqual({ ok: false, reason: 'desk_active' })
    }
  })

  it('QA round 1: at the desk, a web touch admits no stamped question; the Mac answers it at once', async () => {
    const h = harness()
    h.s.web = 1_000; h.s.idle = 5
    expect(await h.b.admit(ask(h, { askHold: 1 }))).toEqual({ ok: false, reason: 'desk_active' })
    h.s.idle = null
    expect(await h.b.admit(ask(h, { askHold: 1 })), 'an unreadable desk is not idle').toEqual({ ok: false, reason: 'desk_unknown' })
    h.s.idle = 90
    const { request } = await park(h, ask(h, { askHold: 1 }))
    expect(request).toMatchObject({ askHold: true, awayHold: true, webOnly: true, lensVisible: true })
    expect(h.b.list()).toHaveLength(1)
  })

  it('QA round 1: a web-only stamped question goes back to the Mac the moment the desk is used, or cannot be read twice', async () => {
    for (const desk of [2, null]) {
      const h = harness()
      h.s.web = 1_000
      const { sent } = await park(h, ask(h, { askHold: 1 }))
      h.s.idle = desk
      await h.b.tick()
      if (desk === null) { expect(h.b.pendingCount(), 'one unreadable read is not the desk').toBe(1); await h.b.tick() }
      expect(h.b.pendingCount(), String(desk)).toBe(0)
      expect(h.b.settledList()[0]).toMatchObject({ resolution: 'handed_to_desk', waitingAtMac: true })
      expect(sent).toEqual([{}])
    }
  })

  it('QA round 1: a web-only stamped question also ends when the touch goes stale with no client', async () => {
    const h = harness()
    h.s.web = 29 * MIN
    const { sent } = await park(h, ask(h, { askHold: 1 }))
    h.s.now += 2 * MIN; h.s.web = 31 * MIN
    await h.b.tick()
    expect(h.b.settledList()[0]).toMatchObject({ resolution: 'no_client', waitingAtMac: true })
    expect(sent).toEqual([{}])
  })

  it('stale (over 30 minutes): no hold, stamped or not, and the line says why', async () => {
    for (const body of [ask, (h: ReturnType<typeof harness>) => ask(h, { askHold: 1 }), bash]) {
      const h = harness()
      h.s.web = 30 * MIN + 1
      expect(await h.b.admit(body(h))).toEqual({ ok: false, reason: 'no_client' })
    }
    const h = harness()
    h.s.web = 31 * MIN
    await h.b.admit(ask(h))
    // The reason is the glasses and phone one, as in 6.99.25; the web's age rides beside it.
    expect(lastLine(h.lines)).toBe(`[permission-broker] fast path no_client not_away=no_hold_client presenceAgeMs=null windowMs=1800000 webPresenceAgeMs=${31 * MIN} clientLive=false`)
  })

  it('never a live client: with the away hold off or a hook that waits 130 s, a recent touch holds nothing', async () => {
    for (const extra of [{ awayHoldMs: () => 0 }, { installedHookTimeoutS: () => 130 }]) {
      for (const stamp of [{}, { askHold: 1 }]) {
        const h = harness(extra)
        h.s.web = 1_000
        const r = await h.b.admit({ ...ask(h, stamp), hookWaitS: extra.installedHookTimeoutS ? 130 : 630 })
        expect(r, JSON.stringify(stamp)).toEqual({ ok: false, reason: 'no_client' })
      }
    }
  })

  it('never makes a connected phone or lens live: its own presence still has to be recent', async () => {
    // A hold=1 client polls (connected) but its wearer has not touched it: with the away hold off, the web's touch
    // must not stand in for that presence.
    for (const presence of [null, 31 * MIN]) {
      const h = harness({ awayHoldMs: () => 0 })
      h.s.hold = h.s.now; h.s.presence = presence; h.s.web = 1_000
      expect(await h.b.admit(ask(h)), String(presence)).toEqual({ ok: false, reason: 'no_client' })
      expect(await h.b.admit(bash(h)), String(presence)).toEqual({ ok: false, reason: 'no_client' })
    }
  })

  it('the re-check: an away-held request stays while the touch is recent, then goes to the Mac', async () => {
    const h = harness()
    h.s.web = 1_000
    const { sent } = await park(h, ask(h))
    h.s.now += 20 * MIN; h.s.web = 20 * MIN
    await h.b.tick()
    expect(h.b.pendingCount()).toBe(1)
    h.s.now += 10 * MIN + 1; h.s.web = 30 * MIN + 1
    await h.b.tick()
    expect(h.b.pendingCount()).toBe(0)
    expect(h.b.settledList()[0]).toMatchObject({ resolution: 'no_client', waitingAtMac: true })
    expect(sent).toEqual([{}])
  })

  it('the re-check: a touch never keeps a request held for a live phone alone, once the phone goes quiet', async () => {
    const h = harness({ awayHoldMs: () => 0 })
    h.s.legacy = h.s.now
    h.s.web = 1_000
    const { request, sent } = await park(h, ask(h))
    expect(request.awayHold).toBe(false)
    h.s.now += 31_000
    await h.b.tick()
    expect(h.b.pendingCount()).toBe(0)
    expect(sent).toEqual([{}])
  })

  it('the desk coming back hands an away-held request to the Mac, touch or not', async () => {
    const h = harness()
    h.s.web = 1_000
    const { sent } = await park(h, bash(h))
    h.s.idle = 2
    await h.b.tick()
    expect(h.b.settledList()[0]).toMatchObject({ resolution: 'handed_to_desk', waitingAtMac: true })
    expect(sent).toEqual([{}])
  })

  it('a phone or glasses presence still works as before when the web never reported one, and the line is unchanged', async () => {
    const h = harness()
    h.s.presence = 31 * MIN
    await h.b.admit(ask(h))
    expect(lastLine(h.lines)).toBe(`[permission-broker] fast path no_client not_away=stale_presence presenceAgeMs=${31 * MIN} windowMs=1800000 clientLive=false`)
    h.s.presence = 2 * MIN
    const { request } = await park(h, ask(h))
    expect(request.awayHold).toBe(true)
    expect(request.hold).not.toHaveProperty('webPresenceAgeMs')
  })

  it('QA round 1: COS_WEB_AWAY_HOLD=0 turns the web part off alone; glasses and phone keep theirs', async () => {
    expect(['', '1', 'on', 'yes'].map(v => webAwayHoldEnabled({ COS_WEB_AWAY_HOLD: v }))).toEqual([true, true, true, true])
    expect(['0', 'false', 'OFF', ' off '].map(v => webAwayHoldEnabled({ COS_WEB_AWAY_HOLD: v }))).toEqual([false, false, false, false])
    expect(webAwayHoldEnabled({})).toBe(true)
    let on = false
    const h = harness({ webAwayHold: () => on })
    h.s.web = 1_000
    expect(await h.b.admit(ask(h))).toEqual({ ok: false, reason: 'no_client' })
    expect(lastLine(h.lines), 'off: the web age is not even read').toBe('[permission-broker] fast path no_client not_away=no_hold_client presenceAgeMs=null windowMs=1800000 clientLive=false')
    h.s.presence = 2 * MIN
    expect((await h.b.admit(ask(h))).ok, 'the glasses and phone hold still works').toBe(true)
    // Switched off while one is held: it goes to the Mac at the next check.
    on = true; h.s.presence = null
    const { sent } = await park(h, ask(h))
    on = false
    await h.b.tick()
    expect(sent).toEqual([{}])
    const thrown = harness({ webAwayHold: () => { throw new Error('boom') } })
    thrown.s.web = 1_000
    expect(await thrown.b.admit(ask(thrown)), 'an unreadable switch is off').toEqual({ ok: false, reason: 'no_client' })
  })

  it('QA round 1: the web touch never changes a glasses or phone hold, at admission or at the re-check', async () => {
    // A phone polling as a live client (no presence): its request keeps the base hold, never the web's 10 minutes.
    const phone = harness()
    phone.s.legacy = phone.s.now; phone.s.web = 1_000
    const r = await park(phone, ask(phone))
    expect(r.request).toMatchObject({ awayHold: false, deadlineAt: phone.s.now + 110_000 })
    expect(r.request).not.toHaveProperty('webOnly')
    expect(r.request.hold).not.toHaveProperty('webPresenceAgeMs')
    // A lens touched 2 minutes ago: away-held; once its own touch is stale and nothing polls, it goes to the Mac even
    // though the web was touched a moment ago.
    const lens = harness()
    lens.s.presence = 2 * MIN; lens.s.web = 1_000
    const l = await park(lens, ask(lens))
    expect(l.request).toMatchObject({ awayHold: true })
    expect(l.request).not.toHaveProperty('webOnly')
    lens.s.now += 29 * MIN; lens.s.presence = 31 * MIN; lens.s.web = 1_000
    await lens.b.tick()
    expect(lens.b.settledList()[0]).toMatchObject({ resolution: 'no_client' })
    expect(l.sent).toEqual([{}])
  })

  it('QA round 1: for every glasses and phone case, a web touch, recent or stale, changes nothing the device decides', async () => {
    let rows = 0, settledRows = 0, keptRows = 0
    for (const tool of ['ask', 'stamped', 'bash']) for (const idle of [0, 100, null]) for (const client of ['none', 'legacy', 'hold', 'recent', 'stale'])
      for (const ceiling of [130, 630]) for (const away of [0, 600_000]) {
        const make = (web: number | null) => {
          const h = harness({ installedHookTimeoutS: () => ceiling, awayHoldMs: () => away })
          h.s.idle = idle; h.s.web = web
          h.s.legacy = client === 'legacy' ? h.s.now : null
          h.s.hold = client === 'hold' || client === 'recent' || client === 'stale' ? h.s.now : null
          h.s.presence = client === 'recent' ? 2 * MIN : client === 'stale' ? 31 * MIN : null
          return h
        }
        const bodyOf = (h: ReturnType<typeof harness>) => tool === 'bash' ? bash(h) : ask(h, tool === 'stamped' ? { askHold: 1 } : {})
        const base = make(null), stale = make(31 * MIN), recent = make(1_000)
        const a = await base.b.admit(bodyOf(base)), b = await stale.b.admit(bodyOf(stale)), c = await recent.b.admit(bodyOf(recent))
        const tag = `${tool}/${idle}/${client}/${ceiling}/${away}`
        expect(b, 'stale web: ' + tag).toEqual(a)
        if (a.ok && c.ok) {
          expect(c, 'recent web on a device-admitted request: ' + tag).toEqual(a)
          // And the re-check: the device's presence lapses and nothing polls; the web was touched a moment ago.
          for (const h of [base, recent]) {
            h.b.park(h === base ? a.request : c.request, { writable: () => true, reply: () => true })
            h.s.now += 40_000; h.s.legacy = null; h.s.hold = null; h.s.presence = h.s.presence === null ? null : 31 * MIN
            await h.b.tick()
          }
          expect(recent.b.settledList().map(x => x.resolution), 're-check: ' + tag).toEqual(base.b.settledList().map(x => x.resolution))
          expect(recent.b.pendingCount(), 're-check: ' + tag).toBe(base.b.pendingCount())
          if (base.b.settledList().length) settledRows++; else keptRows++
        } else if (a.ok) expect(c, 'recent web on a device-admitted request: ' + tag).toEqual(a)
        else if (c.ok) expect(c.request.webOnly, 'only the web admitted it: ' + tag).toBe(true)
        else expect(c.reason === a.reason || c.reason === 'desk_active' || c.reason === 'desk_unknown', tag).toBe(true)
        rows++
      }
    expect(rows).toBe(180)
    // The re-check comparison ran both ways: some device holds ended, some were kept.
    expect(settledRows).toBeGreaterThan(5)
    expect(keptRows).toBeGreaterThan(5)
  })

  it('a web age that is not a number is no presence', async () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const h = harness()
      h.s.web = bad
      expect(await h.b.admit(ask(h)), String(bad)).toEqual({ ok: false, reason: 'no_client' })
    }
    const h = harness({ webPresenceAgeMs: () => { throw new Error('boom') } })
    expect(await h.b.admit(ask(h))).toEqual({ ok: false, reason: 'no_client' })
  })
})

describe('noteWebPresence (lib/client-liveness, 6.99.26)', () => {
  it('records the web on its own clocks and moves none of the other stamps', () => {
    __resetClientLivenessForTests()
    noteWebPresence(1_000_000, 5_000, 50_000)
    expect(webPresenceAgeMs(50_000, 1_000_000)).toBe(5_000)
    expect([lastQuestionsPollAt(), lastLegacyQuestionsPollAt(), lastHoldQuestionsPollAt(), presenceAgeMs(50_000, 1_000_000)]).toEqual([null, null, null, null])
  })

  it('forward-only: a slower poll with an older touch never moves it back; nonsense records nothing', () => {
    __resetClientLivenessForTests()
    noteWebPresence(1_000_000, 1_000, 50_000)
    noteWebPresence(1_000_100, 60_000, 50_100)
    expect(webPresenceAgeMs(50_100, 1_000_100)).toBe(1_100)
    __resetClientLivenessForTests()
    for (const bad of [-1, 1.5, 86_400_001, Number.NaN]) noteWebPresence(1_000_000, bad, 50_000)
    noteWebPresence(Number.NaN, 1_000, 50_000)
    noteWebPresence(1_000_000, 1_000, Number.NaN)
    expect(webPresenceAgeMs(50_000, 1_000_000)).toBeNull()
  })

  it('a Mac that slept reads the touch older, never younger (the larger of the two clocks)', () => {
    __resetClientLivenessForTests()
    noteWebPresence(1_000_000, 1_000, 50_000)
    // The monotonic clock paused for an hour of sleep; the wall clock did not.
    expect(webPresenceAgeMs(51_000, 1_000_000 + 3_600_000)).toBe(3_601_000)
  })
})
