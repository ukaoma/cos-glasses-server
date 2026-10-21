// 6.83.0 Work orchestrator: tags, redaction, pick-up notes, the log index, discovery and the planner rows, by execution
// over a fake home in the log shapes canary C2/C3 measured (docs/work-orchestrator.md).
import { describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tagForWorkID, statusLines, isHandoffPrompt, tagsIn } from './tags.js'
import { redactNote } from './redact.js'
import { readTail, turnsFrom } from './session-log.js'
import { pickupFromTurns, pickupNote, PICKUP_MAX_CHARS } from './pickup.js'
import { TagIndex, classifyRow } from './tag-index.js'
import { discoverCardSessions } from './discovery.js'
import { buildOrchestratorInput, ORCHESTRATOR_MAX_ROWS } from './input.js'
import { parseSnapshot, isGuardianRow, type ControlSnapshot } from './snapshot.js'
import { fakeHome, claudeLog, appendClaude, codexLog, cursorLog, uuid, TEMPLATE_LINE } from './__fixtures__/fake-home.js'

const CARD = 'task:quilt:420a0114f1a9', TAG = '420a0114f1a9'
const OTHER = 'task:quilt:108ec5747992', OTHER_TAG = '108ec5747992'
const NOW = Date.parse('2026-10-20T22:30:00Z')
const snap = (over: Partial<ControlSnapshot> = {}): ControlSnapshot => ({
  version: 1, controlVersion: '0.5.333', sentAt: NOW / 1000, receivedAt: NOW / 1000, links: [], receipts: [], live: { checkedAt: NOW / 1000 - 10, rows: [] }, ...over })
const receipt = (over: Record<string, unknown>) => ({ id: 'r', workID: CARD, mode: 'continueSession', provider: 'claude', sessionID: null, sourceSessionID: null, forkChildID: null, status: 'delivered', createdAt: NOW / 1000 - 3600, ...over }) as any
const liveRow = (id: string, over: Record<string, unknown> = {}) => ({ id, title: 'Title ' + id.slice(7, 11), status: 'idle', updatedAt: new Date(NOW - 60_000).toISOString(), busy: false, waitingOnUser: false, appOwned: false, summary: '', ...over })

describe('tags', () => {
  it('a task card tags with its identity, any other card with a SHA-256 prefix (Control WorkProgress.tag)', () => {
    expect(tagForWorkID(CARD)).toBe(TAG)
    expect(tagForWorkID('meeting:ops:quilt:2026-10:x')).toMatch(/^[a-f0-9]{12}$/)
    expect(tagForWorkID('meeting:ops:quilt:2026-10:x')).not.toBe(tagForWorkID('meeting:ops:quilt:2026-10:y'))
  })
  it('reads status lines through Markdown, refuses the template and blank evidence', () => {
    expect(statusLines(`**COS-WORK ${TAG}: done: shipped the brief**`)).toEqual([{ tag: TAG, status: 'done', evidence: 'shipped the brief' }])
    expect(statusLines(`- COS-WORK ${TAG}: needs input — which table?`)[0]?.status).toBe('needs input')
    expect(statusLines(`COS-WORK ${TAG}: <done, needs input or blocked>: <one sentence of evidence>`)).toEqual([])
    expect(statusLines(`COS-WORK ${TAG}: done: ok`)).toEqual([])
    expect(statusLines(`See COS-WORK ${TAG}: done: inline mention mid sentence`)).toEqual([])
  })
  it('a handoff prompt is the template after this exact tag', () => {
    expect(isHandoffPrompt('do it' + TEMPLATE_LINE(TAG), TAG)).toBe(true)
    expect(isHandoffPrompt('do it' + TEMPLATE_LINE(TAG), OTHER_TAG)).toBe(false)
    expect(isHandoffPrompt(`COS-WORK ${TAG}: done: x`, TAG)).toBe(false)
    expect(tagsIn(`COS-WORK ${TAG.toUpperCase()} and COS-WORK ${OTHER_TAG}`)).toEqual([TAG, OTHER_TAG])
  })
})

describe('redaction (secrets and customer identifiers)', () => {
  it('removes secrets, emails, phones, URL paths, money and long ids; keeps hosts and code', () => {
    const home = '/Users/someone'
    const out = redactNote('token=abcdefghijklmnop1234 sk-ant-api03-xyzxyzxyzxyz mail jane.doe@bottle.example call (512) 555-0134 ' +
      'see https://www.bottlepos.com/proposals/acme-liquor-fees?x=1 for $1,250.00 order 48151623 in /Users/someone/.cos-glasses/.env and process.env.X', home)
    expect(out).not.toMatch(/abcdefghijklmnop1234|xyzxyz|jane\.doe|555-0134|acme-liquor|1,250|48151623|\/Users\/someone/)
    expect(out).toContain('https://www.bottlepos.com/[path]')
    expect(out).toContain('[email]'); expect(out).toContain('[phone]'); expect(out).toContain('[amount]'); expect(out).toContain('[id]')
    expect(out).toContain('[env file]')
    expect(out).toContain('process.env.X')
  })
})

describe('pick-up notes', () => {
  it('reads only the tail of a large log, starting at a whole line', async () => {
    const h = fakeHome()
    const path = claudeLog(h, 'p', uuid(1), [{ role: 'user', text: 'old ask '.repeat(50), at: '2026-10-19T10:00:00Z' }])
    for (let i = 0; i < 400; i++) appendClaude(path, uuid(1), 'assistant', `filler ${i} `.repeat(40), '2026-10-19T11:00:00Z')
    appendClaude(path, uuid(1), 'user', 'Unpublish the HubDB table behind the proposal pages', '2026-10-20T21:00:00Z')
    appendClaude(path, uuid(1), 'assistant', 'Plan: confirm the table, then unpublish. Should I also check the other domains?', '2026-10-20T21:01:00Z')
    const tail = await readTail(path, 20_000)
    expect(tail.truncated).toBe(true)
    expect(tail.text.length).toBeLessThanOrEqual(20_000)
    const turns = turnsFrom(tail.text, 'claude', uuid(1))
    expect(turns.every(t => t.text.length > 0)).toBe(true)
    expect(turns.some(t => t.text.includes('old ask'))).toBe(false)
    const note = pickupFromTurns(turns)
    expect(note.note).toContain('Last ask: Unpublish the HubDB table')
    expect(note.note).toContain('Open questions: Should I also check the other domains?')
    expect(note.state).toBe('finished')
    expect(statSync(path).size).toBeGreaterThan(20_000)
  })
  it('skips harness notices, overlays the live busy flag, stays within 1,500 characters', () => {
    const turns = [
      { role: 'user' as const, text: 'Build the countdown module', at: '2026-10-20T10:00:00Z' },
      { role: 'assistant' as const, text: 'Built it. ' + 'detail '.repeat(400), at: '2026-10-20T10:05:00Z' },
      { role: 'user' as const, text: '<task-notification> subagent finished', at: '2026-10-20T10:06:00Z' },
      { role: 'user' as const, text: 'Perform any necessary follow-up actions', at: '2026-10-20T10:07:00Z' },
    ]
    const idle = pickupFromTurns(turns)
    expect(idle.note).toContain('Last ask: Build the countdown module')
    expect(idle.note.length).toBeLessThanOrEqual(PICKUP_MAX_CHARS)
    const busy = pickupFromTurns(turns, { live: { busy: true } })
    expect(busy.state).toBe('running')
    expect(busy.note).toContain('Still running')
  })
  it('a mid-turn stop and open todos are named; Cursor uses the file time', async () => {
    const h = fakeHome()
    const path = cursorLog(h, 'proj', uuid(5), [{ role: 'user', text: 'Audit the Jedi pack' }, { role: 'assistant', text: 'Found the saber clip.' }, { role: 'user', text: 'Fix the blaster dashes' }])
    const note = await pickupNote(path, 'cursor', uuid(5))
    expect(note.state).toBe('mid_turn')
    expect(note.note).toContain('(file time)')
    expect(pickupFromTurns([{ role: 'user', text: 'go', at: null }, { role: 'assistant', text: 'ok', at: null },
      { role: 'todo', text: JSON.stringify([{ content: 'ship', status: 'pending' }, { content: 'done one', status: 'completed' }]), at: null }]).note).toContain('Open todos: pending: ship')
  })
  it('a resumed Claude file credits only its own rows', () => {
    const text = [JSON.stringify({ type: 'user', sessionId: uuid(9), timestamp: 'x', message: { role: 'user', content: 'replayed older ask' } }),
      JSON.stringify({ type: 'user', sessionId: uuid(1), timestamp: 'y', message: { role: 'user', content: 'my own ask' } })].join('\n')
    expect(turnsFrom(text, 'claude', uuid(1)).map(t => t.text)).toEqual(['my own ask'])
  })
})

describe('the log index', () => {
  it('finds prompts and status lines, credits rows by sessionId, skips guardian threads and spawn children, scans only new bytes', async () => {
    const h = fakeHome()
    const a = uuid(0xa), b = uuid(0xb), resumed = uuid(0xc), guard = uuid(0xd), spawned = uuid(0xe), codex = uuid(0xf)
    const pathA = claudeLog(h, 'p', a, [{ role: 'user', text: 'Review the toadstone plan' + TEMPLATE_LINE(TAG), at: '2026-10-20T20:00:00Z' },
      { role: 'assistant', text: `COS-WORK ${TAG}: done: posted the review`, at: '2026-10-20T20:30:00Z' }])
    // A resumed file replays session a's prompt under a's sessionId; it must not make the resumed session a card session.
    claudeLog(h, 'p', resumed, [{ session: a, role: 'user', text: 'Review the toadstone plan' + TEMPLATE_LINE(TAG), at: '2026-10-20T20:00:00Z' },
      { role: 'user', text: 'quoting: COS-WORK ' + TAG + ' from elsewhere', at: '2026-10-20T21:00:00Z' }])
    // A subagent transcript is never scanned.
    mkdirSync(join(h.roots.claudeProjects, 'p', b, 'subagents'), { recursive: true })
    writeFileSync(join(h.roots.claudeProjects, 'p', b, 'subagents', 'agent-1.jsonl'), JSON.stringify({ type: 'user', sessionId: b, message: { role: 'user', content: 'x' + TEMPLATE_LINE(TAG) } }) + '\n')
    codexLog(h, codex, [{ role: 'user', text: 'Growth system dive' + TEMPLATE_LINE(TAG), at: '2026-10-14T10:00:00Z' }])
    codexLog(h, guard, [{ role: 'user', text: 'The following is the Codex agent history whose request action you are assessing.' + TEMPLATE_LINE(TAG), at: '2026-10-20T12:00:00Z' }], { subagent: { other: 'guardian' } })
    codexLog(h, spawned, [{ role: 'user', text: 'child copy' + TEMPLATE_LINE(TAG), at: '2026-10-20T12:00:00Z' }], { subagent: { thread_spawn: { parent_thread_id: codex, depth: 1 } } })
    const index = new TagIndex({ roots: h.roots, path: join(h.dataDir, 'work-orchestrator', 'tag-index.json') })
    const first = await index.refresh()
    expect(first.complete).toBe(true)
    const hits = index.hits()
    const of = (sid: string) => hits.filter(x => x.sid === sid).map(x => x.kind).sort()
    expect(of('claude:' + a)).toEqual(['prompt', 'status'])
    expect(of('claude:' + resumed)).toEqual(['mention'])
    expect(of('claude:' + b)).toEqual([])
    expect(of('codex:' + codex)).toEqual(['prompt'])
    expect(of('codex:' + guard)).toEqual([])
    expect(of('codex:' + spawned)).toEqual([])
    expect(index.skippedSessions()).toEqual(new Set(['codex:' + guard, 'codex:' + spawned]))
    expect(index.pathOf('claude:' + a)).toBe(pathA)
    // Incremental: an appended partial line is not read until it is whole, and nothing already read is read again.
    const unchanged = await index.refresh()
    expect(unchanged.scannedFiles).toBe(0)
    appendFileSync(pathA, JSON.stringify({ type: 'assistant', sessionId: a, timestamp: '2026-10-20T22:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: `COS-WORK ${OTHER_TAG}: blocked: needs a key` }] } }).slice(0, 40))
    const partial = await index.refresh()
    expect(partial.scannedFiles).toBe(1)
    expect(partial.scannedBytes).toBeLessThan(200)
    expect(index.hits().some(x => x.tag === OTHER_TAG)).toBe(false)
    appendFileSync(pathA, JSON.stringify({ type: 'assistant', sessionId: a, timestamp: '2026-10-20T22:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: `COS-WORK ${OTHER_TAG}: blocked: needs a key` }] } }).slice(40) + '\n')
    await index.refresh()
    expect(index.hits().some(x => x.tag === OTHER_TAG && x.kind === 'status' && x.sid === 'claude:' + a)).toBe(true)
    // The saved index is read back by a new instance (a restart) without rescanning.
    const again = new TagIndex({ roots: h.roots, path: join(h.dataDir, 'work-orchestrator', 'tag-index.json') })
    expect((await again.refresh()).scannedFiles).toBe(0)
    expect(again.hits().length).toBe(index.hits().length)
  })
  it('classifies tool output, quoted handoffs and mentions as never-membership kinds', () => {
    const sid = 'claude:' + uuid(1)
    const tool = classifyRow({ type: 'user', sessionId: uuid(1), message: { role: 'user', content: [{ type: 'tool_result', content: 'COS-WORK ' + TAG }] } }, 'claude', sid, null)
    const quoted = classifyRow({ type: 'user', sessionId: uuid(1), message: { role: 'user', content: 'pasted: COS-WORK ' + OTHER_TAG + ': <done, needs input or blocked>' + ' and COS-WORK ' + TAG } }, 'claude', sid, null)
    expect(tool.map(x => x.kind)).toEqual(['tool'])
    expect(quoted.find(x => x.tag === TAG)?.kind).toBe('quoted')
    expect(classifyRow({ type: 'assistant', isSidechain: true, sessionId: uuid(1), message: { role: 'assistant', content: 'COS-WORK ' + TAG + ': done: x y z' } }, 'claude', sid, null)).toEqual([])
  })
})

describe('discovery (rules 1 to 8 and the precision fixes)', () => {
  const S = (n: number, p = 'claude') => `${p}:${uuid(n)}`
  it('ranks Control records, log prompts and suggestions; a fork child is the card session, its source is not', () => {
    const s = snap({
      links: [{ sessionID: S(1), workID: CARD, at: NOW / 1000 - 7200 }],
      receipts: [
        receipt({ mode: 'newSession', sessionID: S(2), createdAt: NOW / 1000 - 6000 }),
        receipt({ mode: 'fork', sessionID: S(3), sourceSessionID: S(3), forkChildID: S(4) }),
        receipt({ mode: 'fork', sessionID: S(5), sourceSessionID: S(6) }),
        receipt({ mode: 'continueSession', sessionID: S(7, 'codex'), provider: 'codex' }),
        receipt({ mode: 'fork', sessionID: S(8), sourceSessionID: S(8), workID: OTHER }),
      ],
    })
    const hits = [
      { tag: TAG, kind: 'prompt' as const, sid: S(9), at: NOW - 5000 },
      { tag: TAG, kind: 'status' as const, sid: S(10), at: NOW - 4000 },
      { tag: TAG, kind: 'tool' as const, sid: S(11), at: NOW - 3000 },
      { tag: TAG, kind: 'mention' as const, sid: S(12), at: NOW - 3000 },
      { tag: 'aaaaaaaaaaaa', kind: 'status' as const, sid: S(1), at: NOW },
    ]
    const found = new Map(discoverCardSessions(CARD, s, hits).map(x => [x.id, x]))
    expect(found.get(S(1))).toMatchObject({ discoveredBy: ['link'], member: true, linked: true })
    expect(found.get(S(2))?.discoveredBy).toEqual(['created'])
    expect(found.get(S(4))?.discoveredBy).toEqual(['forked'])
    expect(found.has(S(3))).toBe(false)
    expect(found.get(S(5))?.discoveredBy).toEqual(['forked'])
    expect(found.has(S(6))).toBe(false)
    expect(found.get(S(7, 'codex'))?.discoveredBy).toEqual(['continued'])
    expect(found.get(S(9))?.discoveredBy).toEqual(['prompt'])
    expect(found.get(S(10))).toMatchObject({ discoveredBy: ['status'], member: false })
    expect(found.has(S(11))).toBe(false)
    expect(found.has(S(12))).toBe(false)
    expect(found.has(S(8))).toBe(false)
  })
  it('newest strong evidence decides which card a session works on', () => {
    const s = snap({ links: [{ sessionID: S(1), workID: CARD, at: NOW / 1000 - 86400 * 5 }],
      receipts: [receipt({ workID: OTHER, sessionID: S(1), createdAt: NOW / 1000 - 3600 })] })
    const here = discoverCardSessions(CARD, s, [])
    expect(here.find(x => x.id === S(1))?.onAnotherCard).toBe(true)
    const there = discoverCardSessions(OTHER, s, [])
    expect(there.find(x => x.id === S(1))?.onAnotherCard).toBe(false)
  })
  it('a placeholder tag is ignored, a tag a real handoff carried is known', () => {
    const hits = [{ tag: '0123456789ab', kind: 'status' as const, sid: S(1), at: NOW }, { tag: OTHER_TAG, kind: 'prompt' as const, sid: S(2), at: NOW },
      { tag: OTHER_TAG, kind: 'prompt' as const, sid: S(1), at: NOW }]
    const s = snap({ links: [{ sessionID: S(1), workID: CARD, at: NOW / 1000 - 600 }] })
    expect(discoverCardSessions(CARD, s, hits).find(x => x.id === S(1))?.onAnotherCard).toBe(true)
    expect(discoverCardSessions(CARD, s, hits.slice(0, 1)).find(x => x.id === S(1))?.onAnotherCard).toBe(false)
  })
  it('a session that worked the card\'s source meeting is suggested with that reason', () => {
    const meeting = 'meeting:ops:quilt:2026-09:2026-09-28_Retail_Liquor_Summit'
    const s = snap({ receipts: [receipt({ workID: meeting, sessionID: S(3) })] })
    const found = discoverCardSessions(CARD, s, [], [meeting])
    expect(found).toEqual([expect.objectContaining({ id: S(3), discoveredBy: ['meeting'], member: false, onAnotherCard: false })])
    expect(discoverCardSessions(CARD, s, [], [])).toEqual([])
  })
  it('the live row summary confirms (rule 7) but alone only suggests', () => {
    const s = snap({ live: { checkedAt: NOW / 1000, rows: [liveRow(S(4), { summary: `COS-WORK ${TAG}: done: x` })] } })
    expect(discoverCardSessions(CARD, s, [])).toEqual([expect.objectContaining({ id: S(4), discoveredBy: ['listed'], member: false })])
  })
})

describe('the planner rows', () => {
  const S = (n: number, p = 'claude') => `${p}:${uuid(n)}`
  const usage = (codex: 'ok' | 'exhausted' = 'ok') => [
    { provider: 'claude' as const, state: 'ok' as const, headroomPct: 45, resetsAt: null, ageSec: 30, source: 'probe', plan: 'max', stale: false, note: '' },
    { provider: 'codex' as const, state: codex, headroomPct: codex === 'ok' ? 60 : 0, resetsAt: null, ageSec: 30, source: 'probe', plan: 'prolite', stale: false, note: '' },
    { provider: 'cursor' as const, state: 'unknown' as const, headroomPct: null, resetsAt: null, ageSec: null, source: 'none', plan: null, stale: true, note: 'not read' }]
  it('says why each session can or cannot take a Continue, and marks what can fork', async () => {
    const h = fakeHome()
    const path = claudeLog(h, 'p', uuid(1), [{ role: 'user', text: 'Do the review', at: '2026-10-20T20:00:00Z' }, { role: 'assistant', text: 'Done. Next: post it.', at: '2026-10-20T20:10:00Z' }])
    const codexPath = codexLog(h, uuid(2), [{ role: 'user', text: 'Growth dive', at: '2026-10-14T10:00:00Z' }])
    const s = snap({
      links: [{ sessionID: S(1), workID: CARD, at: NOW / 1000 - 3600 }],
      receipts: [receipt({ sessionID: S(2, 'codex'), provider: 'codex' }), receipt({ sessionID: S(3, 'cursor'), provider: 'cursor' }),
        receipt({ sessionID: S(4) }), receipt({ sessionID: S(6) }), receipt({ sessionID: S(6), workID: OTHER, createdAt: NOW / 1000 - 60 })],
      live: { checkedAt: NOW / 1000 - 20, rows: [liveRow(S(1)), liveRow(S(2, 'codex')), liveRow(S(3, 'cursor')), liveRow(S(4), { appOwned: true }), liveRow(S(6))] },
    })
    const paths: Record<string, string> = { [S(1)]: path, [S(2, 'codex')]: codexPath }
    const input = await buildOrchestratorInput(CARD, [], { snapshot: s, hits: [], usage: usage('exhausted'), pathOf: async sid => paths[sid] ?? null, now: NOW })
    const by = new Map(input.rows.map(r => [r.id, r]))
    expect(by.get(S(1))).toMatchObject({ available: true, live: true, linked: true, forkable: true })
    expect(by.get(S(1))?.pickup).toContain('Last ask: Do the review')
    expect(by.get(S(2, 'codex'))).toMatchObject({ available: false, reason: 'plan_limit', forkable: false })
    expect(by.get(S(3, 'cursor'))).toMatchObject({ available: false, reason: 'cursor', forkable: false })
    expect(by.get(S(4))).toMatchObject({ available: false, reason: 'app_owned', forkable: false })
    expect(by.get(S(6))).toMatchObject({ available: false, reason: 'on_another_card' })
    expect(input.now).toBe(new Date(NOW).toISOString())
    expect(input.usage).toHaveLength(3)
    const stale = await buildOrchestratorInput(CARD, [], { snapshot: { ...s, live: { ...s.live!, checkedAt: NOW / 1000 - 3600 } }, hits: [], usage: usage(), pathOf: async sid => paths[sid] ?? null, now: NOW })
    expect(stale.rows.find(r => r.id === S(1))).toMatchObject({ live: false, available: false, reason: 'not_in_session_list', forkable: true })
    expect(stale.liveListAgeSec).toBe(3600)
  })
  it('keeps at most 12 rows, members first, and says what it left out', async () => {
    const links = Array.from({ length: 14 }, (_, i) => ({ sessionID: S(100 + i), workID: CARD, at: NOW / 1000 - 1000 + i }))
    const input = await buildOrchestratorInput(CARD, [], { snapshot: snap({ links }), hits: [{ tag: TAG, kind: 'status', sid: S(300), at: NOW }], usage: usage(), pathOf: async () => null, now: NOW })
    expect(input.rows).toHaveLength(ORCHESTRATOR_MAX_ROWS)
    expect(input.rows.every(r => r.member)).toBe(true)
    expect(input.rows[0]!.id).toBe(S(113))
    expect(input.leftOut.map(l => l.reason)).toEqual(Array(3).fill('more than 12 sessions on this card'))
    expect(input.discovered).toBe(15)
  })
  it('a guardian thread is left out with its reason', async () => {
    const input = await buildOrchestratorInput(CARD, [], { snapshot: snap({ receipts: [receipt({ sessionID: S(7, 'codex'), provider: 'codex' })] }), hits: [], usage: usage(),
      pathOf: async () => null, skipped: new Set([S(7, 'codex')]), now: NOW })
    expect(input.rows).toEqual([])
    expect(input.leftOut).toEqual([{ id: S(7, 'codex'), title: '', reason: 'codex child thread (guardian or subagent)' }])
  })
})

describe('the snapshot contract', () => {
  it('parses a bounded snapshot, moves Swift reference-date times onto 1970, drops guardian rows', () => {
    const p = parseSnapshot({ version: 1, controlVersion: '0.5.333', sentAt: NOW / 1000,
      links: [{ sessionID: 'CLAUDE:' + uuid(1).toUpperCase(), workID: CARD, at: NOW / 1000 - 978_307_200 }],
      receipts: [{ id: 'x', workID: 'meeting:ops:quilt:2026-10:2026-10-02_Push_Back_on_Facebook (draft)', mode: 'fork', provider: 'claude', sessionID: null, sourceSessionID: 'claude:' + uuid(2), forkChildID: 'claude:' + uuid(3), status: 'delivered', createdAt: NOW / 1000 }],
      live: { checkedAt: NOW / 1000, rows: [{ id: 'codex:' + uuid(4), title: 'Guardian review', status: '', summary: '' }, { id: 'claude:' + uuid(5), title: 'Real', status: 'busy', busy: true, summary: '' }] } }, NOW)
    expect(p.links[0]).toEqual({ sessionID: 'claude:' + uuid(1), workID: CARD, at: NOW / 1000 })
    expect(p.receipts[0]!.forkChildID).toBe('claude:' + uuid(3))
    expect(p.live!.rows.map(r => r.id)).toEqual(['claude:' + uuid(5)])
    expect(isGuardianRow('codex:' + uuid(4), 'x', 'The following is the Codex agent history whose request')).toBe(true)
    expect(() => parseSnapshot({ version: 2, controlVersion: 'x', links: [], receipts: [] })).toThrow('invalid_snapshot')
    expect(() => parseSnapshot({ version: 1, controlVersion: 'x', links: [{ sessionID: 'claude:nope', workID: CARD, at: 1 }], receipts: [] })).toThrow('invalid_link')
    expect(() => parseSnapshot({ version: 1, controlVersion: 'x', links: [], receipts: [{ ...p.receipts[0], mode: 'teleport' }] })).toThrow('invalid_receipt')
  })
})
