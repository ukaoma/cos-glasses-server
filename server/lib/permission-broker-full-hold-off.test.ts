// X1: with both full-hold switches off, this branch's broker WIRED for the full hold (switches reader, an
// engine reader that proves every engine, per-kind timeouts) behaves exactly like 7.0.13's own broker,
// frozen at __fixtures__/permission-broker-7.0.13.ts (97402b4) with none of it: same admission, deadline,
// visibility, list views (Q1 F1 would show here), settled codes, hook bodies, and the same answers through
// both doors (app and web), over every combination of the inputs today's rules read. 2,592 cases (Q1 G4).
import { describe, expect, it } from 'vitest'
import { PermissionBroker, type PermissionBrokerDeps } from './permission-broker.js'
import { PermissionBroker as Released } from './__fixtures__/permission-broker-7.0.13.js'
import { ASK_INPUT, permissionEnvelope } from './__fixtures__/permission-broker.js'

type Case = { kind: 'q' | 'a'; stamp: boolean; client: boolean; presence: number | null; idle: number | null; away: number; installed: number | null; wait: number | null; web: number | null }
const cases: Case[] = []
for (const kind of ['q', 'a'] as const) for (const stamp of [true, false]) for (const client of [true, false])
  for (const presence of [10_000, 3_600_000, null]) for (const idle of [0, 95, null]) for (const away of [600_000, 0])
    for (const installed of [630, 130, null]) for (const wait of [630, null, 3600]) for (const web of [5_000, null])
      cases.push({ kind, stamp, client, presence, idle, away, installed, wait, web })

async function run(c: Case, wired: boolean) {
  const now = 1_000_000
  const deps: PermissionBrokerDeps = {
    now: () => now, mode: () => 'all', admissionsOpen: () => true,
    lastQuestionsPollAt: () => (c.client ? now - 1_000 : null), lastLegacyPollAt: () => (c.client ? now - 1_000 : null), lastHoldPollAt: () => null,
    presenceAgeMs: () => c.presence, webPresenceAgeMs: () => c.web, awayRecentClientMs: () => 1_800_000,
    readDeskIdleSeconds: async () => c.idle, deskIdleSeconds: () => 90, timeoutMs: () => 110_000,
    awayHoldMs: () => c.away, installedHookTimeoutS: () => c.installed, pollMs: 60_000,
    newId: () => 'pq_000000000000000000000001', log: () => {},
    ...(wired ? {
      fullHold: () => ({ questions: false, approvals: false }),
      engineFor: () => ({ entrypoint: 'cli', version: '9.9.9', host: 'terminal' as const }),
      installedHookTimeoutForKindS: () => 3600,
    } : {}),
  }
  const b = wired ? new PermissionBroker(deps) : new Released(deps as never) as unknown as PermissionBroker
  const body = c.kind === 'q'
    ? { ...permissionEnvelope('AskUserQuestion', ASK_INPUT, { tool_use_id: 'toolu_x' }, now), ...(c.wait !== null ? { hookWaitS: c.wait } : {}), ...(c.stamp ? { askHold: 1 } : {}) }
    : { ...permissionEnvelope('Bash', { command: 'ls' }, { tool_use_id: 'toolu_y' }, now), ...(c.wait !== null ? { hookWaitS: c.wait } : {}) }
  const r = await b.admit(body)
  const out: unknown[] = [r]
  if (r.ok) {
    const sent: unknown[] = []
    b.park(r.request, { writable: () => true, reply: x => { sent.push(x); return true } })
    await b.tick()
    out.push(b.list(), b.settledList().map(s => s.resolution), [...sent])
    // Both doors, on a fresh copy each: an answer, a web answer with nothing new in it, a hand-back.
    const answer = c.kind === 'q' ? { answers: [{ labels: ['Bump'] }, { labels: ['Blue'] }] } : { decision: 'allow' }
    out.push(b.answer('pq_000000000000000000000001', { clientAnswerId: 'web-1', ...answer }, 'web'))
    out.push(b.answer('pq_000000000000000000000001', { clientAnswerId: 'app-1', ...answer }, 'app'), [...sent])
  }
  b.stop()
  return JSON.stringify(out)
}

describe('switches off: this branch equals 7.0.13', () => {
  it(`${cases.length} admission, tick and answer cases against 7.0.13`, async () => {
    let admitted = 0
    for (const c of cases) {
      const plain = await run(c, false)
      const wired = await run(c, true)
      if (plain !== wired) throw new Error(`differs for ${JSON.stringify(c)}:\n${plain}\n${wired}`)
      if (plain.startsWith('[{"ok":true')) admitted++
    }
    // The matrix must exercise both outcomes, or it proves nothing.
    expect(admitted).toBeGreaterThan(100)
    expect(cases.length - admitted).toBeGreaterThan(100)
  })
})
