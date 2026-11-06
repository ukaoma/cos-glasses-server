/**
 * 6.99.16: the COS thread store (lib/cos-thread.ts). Real files in a temp dir, an injected clock, a fake projects
 * dir holding Claude Code session logs, and a fake drop reader.
 */
import { describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildDigest, claudeContextReader, contextTokensFromLog, cosThreadCapTokens, CosThread, describeDropFiling, DIGEST_HEADER,
  DIGEST_MAX_CHARS, parseTurnInput, type DigestDrop,
} from './cos-thread.js'

const T0 = Date.parse('2026-11-05T22:00:00.000Z')
function usageLine(input: number, creation: number, read: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: 50 } }, ...extra })
}

function harness(opts: { cap?: number; drops?: DigestDrop[]; live?: Set<string>; native?: Record<string, string>; answers?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cos-thread-'))
  const dir = join(root, 'data', 'cos-thread')
  const projects = join(root, 'projects')
  mkdirSync(join(projects, '-Users-x-proj'), { recursive: true })
  let now = T0
  let ids = 0
  const live = opts.live ?? null
  const dropCalls: Array<{ since: string; limit: number }> = []
  const make = () => new CosThread({
    dir,
    now: () => now,
    capTokens: () => opts.cap ?? 150_000,
    newId: () => `th_${String(++ids).padStart(4, '0')}`,
    context: claudeContextReader({
      projectsDir: () => projects,
      sessionExists: live ? id => live.has(id) : undefined,
      nativeFor: id => opts.native?.[id],
    }),
    nativeFor: id => opts.native?.[id],
    drops: (since, limit) => { dropCalls.push({ since, limit }); return (opts.drops ?? []).filter(d => d.createdAt >= since).slice(0, limit) },
    answerFor: (sessionId, clientId) => opts.answers?.[`${sessionId}:${clientId}`],
  })
  const writeLog = (id: string, lines: string[]) => writeFileSync(join(projects, '-Users-x-proj', `${id}.jsonl`), lines.join('\n') + '\n')
  const tick = (ms = 60_000) => { now += ms }
  return { root, dir, projects, make, writeLog, tick, dropCalls, setNow: (v: number) => { now = v } }
}
const turn = (n: number, sessionId: string, extra: Record<string, unknown> = {}) =>
  ({ clientId: `client-${String(n).padStart(4, '0')}`, sessionId, query: `question ${n}`, answer: `answer ${n}`, messageNo: 400 + n, ...extra })

describe('cap and context reading', () => {
  it('COS_THREAD_CAP_TOKENS takes 20000..1000000, anything else is 150000', () => {
    expect(cosThreadCapTokens({})).toBe(150_000)
    expect(cosThreadCapTokens({ COS_THREAD_CAP_TOKENS: '20000' })).toBe(20_000)
    expect(cosThreadCapTokens({ COS_THREAD_CAP_TOKENS: '1000000' })).toBe(1_000_000)
    expect(cosThreadCapTokens({ COS_THREAD_CAP_TOKENS: '19999' })).toBe(150_000)
    expect(cosThreadCapTokens({ COS_THREAD_CAP_TOKENS: '1000001' })).toBe(150_000)
    expect(cosThreadCapTokens({ COS_THREAD_CAP_TOKENS: '9e4' })).toBe(150_000)
    expect(cosThreadCapTokens({ COS_THREAD_CAP_TOKENS: '-50000' })).toBe(150_000)
  })

  it('sums the three input counters of the LAST assistant message, skipping sidechain rows', () => {
    const h = harness()
    h.writeLog('abcd1234-0000', [
      usageLine(10, 20, 30),
      JSON.stringify({ type: 'user', message: { content: 'x' } }),
      usageLine(3, 1_000, 101_720),
      usageLine(9, 9, 9, { isSidechain: true }),
      JSON.stringify({ type: 'user', message: { content: 'tool result' } }),
    ])
    expect(contextTokensFromLog(join(h.projects, '-Users-x-proj', 'abcd1234-0000.jsonl'))).toBe(102_723)
  })

  it('reads only the tail: a first line cut by the 512 KB window is skipped, the last usage still counts', () => {
    const h = harness()
    const file = join(h.projects, '-Users-x-proj', 'tail0001.jsonl')
    writeFileSync(file, usageLine(1, 1, 1) + '\n' + JSON.stringify({ type: 'user', pad: 'x'.repeat(600 * 1024) }) + '\n' + usageLine(5, 6, 7) + '\n')
    expect(contextTokensFromLog(file)).toBe(18)
    // A usage row only inside the cut part of the file is out of reach: unknown, not zero.
    writeFileSync(file, usageLine(1, 1, 1) + '\n' + JSON.stringify({ type: 'user', pad: 'x'.repeat(600 * 1024) }) + '\n')
    expect(contextTokensFromLog(file)).toBeNull()
  })

  it('finds the log through the live CLI session first, then the one recorded, then the COS id', () => {
    const h = harness()
    h.writeLog('native-live-1', [usageLine(1, 0, 0)])
    h.writeLog('native-old-1', [usageLine(2, 0, 0)])
    const read = claudeContextReader({ projectsDir: () => h.projects, nativeFor: () => 'native-live-1' })
    expect(read('cos00001', 'native-old-1')).toEqual({ found: true, tokens: 1 })
    expect(claudeContextReader({ projectsDir: () => h.projects })('cos00001', 'native-old-1')).toEqual({ found: true, tokens: 2 })
    expect(claudeContextReader({ projectsDir: () => h.projects })('cos00001', null)).toEqual({ found: false, tokens: null })
    // The COS conversation is gone (archived at midnight): missing, whatever logs exist.
    expect(claudeContextReader({ projectsDir: () => h.projects, sessionExists: () => false })('cos00001', 'native-old-1')).toEqual({ found: false, tokens: null })
  })
})

describe('GET: every reason', () => {
  it('empty: a new store has one thread and no session, and says fresh with nothing to carry', () => {
    const h = harness()
    const v = h.make().view()
    expect(v).toMatchObject({ protocol: 1, capTokens: 150_000, thread: { id: 'th_0001', startedAt: new Date(T0).toISOString(), lastAskAt: null, asks: 0, segments: 0, sessionId: null, provider: null, contextTokens: null } })
    expect(v.next).toEqual({ mode: 'fresh', sessionId: null, reason: 'empty', digest: null })
  })

  it('continue: the session is known and under the cap; exactly at the cap still continues; one over is size', () => {
    const h = harness({ cap: 150_000 })
    const t = h.make()
    t.recordTurn(turn(1, 'sess0001', { provider: 'claude' }))
    h.writeLog('sess0001', [usageLine(0, 50_000, 100_000)])
    let v = t.view()
    expect(v.thread).toMatchObject({ asks: 1, segments: 1, sessionId: 'sess0001', provider: 'claude', contextTokens: 150_000 })
    expect(v.next).toEqual({ mode: 'continue', sessionId: 'sess0001', reason: 'continue', digest: null })
    h.writeLog('sess0001', [usageLine(1, 50_000, 100_000)])
    v = t.view()
    expect(v.thread.contextTokens).toBe(150_001)
    expect(v.next.mode).toBe('fresh')
    expect(v.next.reason).toBe('size')
    expect(v.next.sessionId).toBeNull()
    expect(v.next.digest).toContain(DIGEST_HEADER)
    expect(v.next.digest).toContain('#401 You asked: question 1')
    expect(v.next.digest).toContain('COS answered: answer 1')
  })

  it('a log with no readable usage continues with contextTokens null', () => {
    const h = harness()
    const t = h.make()
    t.recordTurn(turn(1, 'sess0001'))
    h.writeLog('sess0001', [JSON.stringify({ type: 'user', message: { content: 'hi' } })])
    expect(t.view().next).toEqual({ mode: 'continue', sessionId: 'sess0001', reason: 'continue', digest: null })
    expect(t.view().thread.contextTokens).toBeNull()
  })

  it('missing_session: the session is set but its log cannot be found, or the conversation is gone', () => {
    const h = harness()
    const t = h.make()
    t.recordTurn(turn(1, 'sess0001'))
    const v = t.view()
    expect(v.next).toMatchObject({ mode: 'fresh', sessionId: null, reason: 'missing_session' })
    expect(v.next.digest).toContain('question 1')
    const live = new Set<string>()
    const h2 = harness({ live })
    const t2 = h2.make()
    t2.recordTurn(turn(1, 'sess0002'))
    h2.writeLog('sess0002', [usageLine(1, 1, 1)])
    expect(t2.view().next.reason).toBe('missing_session')
    live.add('sess0002')
    expect(t2.view().next.reason).toBe('continue')
  })

  it('manual: right after New thread, carrying the closed thread\'s turns; an empty thread\'s New passes them on', () => {
    const h = harness()
    const t = h.make()
    t.recordTurn(turn(1, 'sess0001'))
    h.writeLog('sess0001', [usageLine(1, 1, 1)])
    const n = t.startNew()
    expect(n.thread).toMatchObject({ id: 'th_0002', asks: 0, segments: 0, sessionId: null })
    expect(n.next).toMatchObject({ mode: 'fresh', sessionId: null, reason: 'manual' })
    expect(n.next.digest).toContain('question 1')
    expect(t.view().next).toEqual(n.next)
    const again = t.startNew()
    expect(again.thread.id).toBe('th_0003')
    expect(again.next.digest).toContain('question 1')
  })
})

describe('turns', () => {
  it('adopts the first session, is idempotent on clientId, and keeps only the first 2000 characters of an answer', () => {
    const h = harness()
    const t = h.make()
    const first = t.recordTurn({ ...turn(1, 'sess0001'), answer: 'a'.repeat(5000) })
    expect(first.thread).toMatchObject({ asks: 1, segments: 1, sessionId: 'sess0001', lastAskAt: new Date(T0).toISOString() })
    const before = readFileSync(join(h.dir, 'ledger.jsonl'), 'utf8')
    h.tick()
    const repeat = t.recordTurn({ ...turn(1, 'sess9999'), query: 'different words' })
    expect(repeat.thread).toEqual(first.thread)
    expect(readFileSync(join(h.dir, 'ledger.jsonl'), 'utf8')).toBe(before)
    const rows = before.trim().split('\n').map(l => JSON.parse(l))
    expect(rows.map(r => r.kind)).toEqual(['thread', 'turn'])
    expect(rows[1].answerHead).toHaveLength(2000)
    expect(rows[1]).toMatchObject({ threadId: 'th_0001', segment: 1, sessionId: 'sess0001', clientId: 'client-0001', query: 'question 1', messageNo: 401, provider: null })
  })

  it('the same session again is one more ask on the same segment, and no rollover', () => {
    const h = harness()
    const t = h.make()
    t.recordTurn(turn(1, 'sess0001'))
    h.tick()
    const v = t.recordTurn(turn(2, 'sess0001'))
    expect(v.thread).toMatchObject({ asks: 2, segments: 1, sessionId: 'sess0001', lastAskAt: new Date(T0 + 60_000).toISOString() })
    const kinds = readFileSync(join(h.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).kind)
    expect(kinds).toEqual(['thread', 'turn', 'turn'])
  })

  it('a different session is a rollover: a rollover row with the reason and the digest, then a new segment, same thread', () => {
    const h = harness({ cap: 20_000 })
    const t = h.make()
    t.recordTurn(turn(1, 'sess0001'))
    h.writeLog('sess0001', [usageLine(0, 0, 20_001)])
    h.tick()
    const v = t.recordTurn(turn(2, 'sess0002'))
    expect(v.thread).toMatchObject({ id: 'th_0001', asks: 2, segments: 2, sessionId: 'sess0002' })
    const rows = readFileSync(join(h.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(rows.map(r => r.kind)).toEqual(['thread', 'turn', 'rollover', 'turn'])
    expect(rows[2]).toMatchObject({ kind: 'rollover', threadId: 'th_0001', reason: 'size', fromSessionId: 'sess0001' })
    expect(rows[2].digest).toContain('question 1')
    expect(rows[3]).toMatchObject({ segment: 2, sessionId: 'sess0002' })
    // The second rollover reason: the old session's log is gone.
    h.tick()
    t.recordTurn(turn(3, 'sess0003'))
    const last = readFileSync(join(h.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(last.filter(r => r.kind === 'rollover').map(r => r.reason)).toEqual(['size', 'missing_session'])
    expect(t.view().thread.segments).toBe(3)
  })

  it('records the CLI session, so a restart that forgot it still finds the log', () => {
    const native: Record<string, string> = { sess0001: 'aaaaaaaa-1111-2222-3333-444444444444' }
    const h = harness({ native })
    h.make().recordTurn(turn(1, 'sess0001'))
    h.writeLog('aaaaaaaa-1111-2222-3333-444444444444', [usageLine(1, 2, 3)])
    delete native.sess0001
    const v = h.make().view()
    expect(v.thread.contextTokens).toBe(6)
    expect(v.next.reason).toBe('continue')
  })

  it('validation: the contract\'s bounds, and nothing else in the body', () => {
    const ok = { clientId: 'abcd-1234', sessionId: 'sess0001', query: 'q' }
    expect(parseTurnInput(ok)).toEqual(ok)
    expect(parseTurnInput({ ...ok, answer: 'a', messageNo: 7, provider: 'claude' })).toEqual({ ...ok, answer: 'a', messageNo: 7, provider: 'claude' })
    const bad: unknown[] = [
      null, [], 'x', { ...ok, extra: 1 },
      { ...ok, clientId: 'short' }, { ...ok, clientId: 'x'.repeat(81) }, { ...ok, clientId: 'has space1' },
      { ...ok, sessionId: 'sess001' }, { ...ok, sessionId: 'sess_0001' }, { ...ok, sessionId: 's'.repeat(81) },
      { ...ok, query: '' }, { ...ok, query: '   ' }, { ...ok, query: 'q'.repeat(20_001) }, { ...ok, query: 5 },
      { ...ok, answer: 'a'.repeat(40_001) }, { ...ok, answer: 5 },
      { ...ok, messageNo: 0 }, { ...ok, messageNo: 1.5 }, { ...ok, messageNo: '7' }, { ...ok, messageNo: 2 ** 53 },
      { ...ok, provider: 'Claude' }, { ...ok, provider: 'x'.repeat(33) },
    ]
    for (const b of bad) expect(parseTurnInput(b), JSON.stringify(b)?.slice(0, 80)).toBeNull()
    expect(parseTurnInput({ ...ok, clientId: 'c:job_1-xx', query: 'q'.repeat(20_000), answer: 'a'.repeat(40_000) })).not.toBeNull()
  })
})

describe('the digest', () => {
  it('the last 8 turns oldest first, query 200 and answer 300 characters, message numbers when known, then drops', () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ query: `q${i} ` + 'w'.repeat(400), answerHead: `a${i} ` + 'v'.repeat(400), messageNo: i % 2 ? 500 + i : null }))
    const text = buildDigest(turns, [{ text: 'call the bank', createdAt: '2026-11-05T21:00:00.000Z', filed: 'filed as a new Work card: Bank' }])!
    expect(text.startsWith(DIGEST_HEADER + '\n')).toBe(true)
    expect(text).not.toContain('q0 ')
    expect(text).not.toContain('q1 ')
    expect(text.indexOf('q2 ')).toBeLessThan(text.indexOf('q9 '))
    expect(text).toContain('- #503 You asked: q3')
    expect(text).toContain('- You asked: q2')
    const askLine = text.split('\n').find(l => l.includes('You asked: q2'))!
    expect(askLine.replace('- You asked: ', '')).toHaveLength(200)
    const answerLine = text.split('\n').find(l => l.includes('COS answered: a2'))!
    expect(answerLine.replace('  COS answered: ', '')).toHaveLength(300)
    expect(text).toContain('- call the bank (filed as a new Work card: Bank)')
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
  })

  it('never passes 6000 characters, and is null with nothing to carry', () => {
    const turns = Array.from({ length: 8 }, (_, i) => ({ query: 'q'.repeat(400) + i, answerHead: 'a'.repeat(400), messageNo: 1000 + i }))
    const drops = Array.from({ length: 12 }, (_, i) => ({ text: 'd'.repeat(400) + i, createdAt: '2026-11-05T21:00:00.000Z', filed: 'f'.repeat(200) }))
    const text = buildDigest(turns, drops)!
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    expect(text).toContain('#1007')  // the newest turn survives the trim
    expect(buildDigest([], [])).toBeNull()
  })

  it('takes drops since the thread started or in the last 24 h, whichever is earlier, at most 12, oldest first', () => {
    const drops: DigestDrop[] = Array.from({ length: 15 }, (_, i) => ({ text: `drop ${i}`, createdAt: new Date(T0 - i * 3_600_000).toISOString(), filed: 'saved as a note' }))
    const h = harness({ drops })
    const t = h.make()
    const v = t.view()
    expect(h.dropCalls.at(-1)).toEqual({ since: new Date(T0 - 24 * 3_600_000).toISOString(), limit: 12 })
    expect(v.next.digest).toContain('drop 0')
    expect(v.next.digest).toContain('drop 11')
    expect(v.next.digest).not.toContain('drop 12')
    expect(v.next.digest!.indexOf('drop 11')).toBeLessThan(v.next.digest!.indexOf('drop 0'))
    // Three days on, the thread started earlier than 24 h ago: its start is the window.
    h.setNow(T0 + 3 * 24 * 3_600_000)
    t.view()
    expect(h.dropCalls.at(-1)!.since).toBe(new Date(T0).toISOString())
  })

  it('a turn recorded without its answer takes it from the live conversation', () => {
    const h = harness({ answers: { 'sess0001:client-0001': 'the live answer' } })
    const t = h.make()
    t.recordTurn({ clientId: 'client-0001', sessionId: 'sess0001', query: 'question 1' })
    expect(t.view().next.digest).toContain('COS answered: the live answer')
  })

  it('says where a drop went', () => {
    expect(describeDropFiling({ state: 'filed', dest: 'new_card', links: [{ label: 'Bank call' }] })).toBe('filed as a new Work card: Bank call')
    expect(describeDropFiling({ state: 'filed', dest: 'memory', links: [] })).toBe('saved to memory')
    expect(describeDropFiling({ state: 'routing', dest: null })).toBe('still being filed')
    expect(describeDropFiling({ state: 'asking', dest: null })).toBe('waiting on a choice')
  })
})

describe('storage: recover and search', () => {
  it('directory 0700, ledger and state 0600', () => {
    const h = harness()
    h.make().recordTurn(turn(1, 'sess0001'))
    expect(statSync(h.dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(h.dir, 'ledger.jsonl')).mode & 0o777).toBe(0o600)
    expect(statSync(join(h.dir, 'state.json')).mode & 0o777).toBe(0o600)
  })

  it('rebuilds the state from the ledger when state.json is missing, corrupt or behind the ledger', () => {
    const native = { sess0002: 'native-0002-abcdef' }
    const h = harness({ native, cap: 20_000 })
    const t = h.make()
    t.recordTurn(turn(1, 'sess0001', { provider: 'codex' }))
    h.tick(); t.recordTurn(turn(2, 'sess0002'))
    h.tick(); t.startNew()
    h.tick(); t.recordTurn(turn(3, 'sess0003', { provider: 'claude' }))
    h.writeLog('sess0003', [usageLine(1, 1, 1)])
    const live = t.view()
    const expectState = (v: ReturnType<CosThread['view']>) => {
      expect(v.thread).toEqual(live.thread)
      expect(v.next).toEqual(live.next)
    }
    const stateFile = join(h.dir, 'state.json')
    rmSync(stateFile)
    expectState(h.make().view())
    expect(existsSync(stateFile)).toBe(true)
    writeFileSync(stateFile, '{"schema":1,"ledg')
    expectState(h.make().view())
    // A snapshot written before the last ledger rows (a crash between the two writes) is not trusted.
    writeFileSync(stateFile, JSON.stringify({ schema: 1, ledgerRows: 2, current: { id: 'th_0001', startedAt: 'x', lastAskAt: null, asks: 99, segments: 9, sessionId: 'sessXXXX', nativeSessionId: null, provider: null, from: null } }))
    expectState(h.make().view())
    const rebuilt = h.make()
    expect(rebuilt.list(10).threads.map(s => [s.id, s.asks, s.segments, s.endedAt !== null])).toEqual([['th_0002', 1, 1, false], ['th_0001', 2, 2, true]])
    // Idempotency survives the rebuild.
    const ledger = readFileSync(join(h.dir, 'ledger.jsonl'), 'utf8')
    rebuilt.recordTurn(turn(2, 'sess0002'))
    expect(readFileSync(join(h.dir, 'ledger.jsonl'), 'utf8')).toBe(ledger)
  })

  it('a torn last ledger row is skipped and never swallows the next one', () => {
    const h = harness()
    h.make().recordTurn(turn(1, 'sess0001'))
    appendFileSync(join(h.dir, 'ledger.jsonl'), '{"kind":"turn","threadId":"th_0')
    const t = h.make()
    expect(t.view().thread.asks).toBe(1)
    t.recordTurn(turn(2, 'sess0001'))
    expect(h.make().view().thread.asks).toBe(2)
  })

  it('search: case-insensitive over query and answer head, newest first, with a limit and the count scanned', () => {
    const h = harness()
    const t = h.make()
    t.recordTurn({ ...turn(1, 'sess0001'), query: 'What did Silas say about the BUDGET?' })
    h.tick(); t.recordTurn({ ...turn(2, 'sess0001'), query: 'unrelated', answer: 'The budget is flat.' })
    h.tick(); t.recordTurn({ ...turn(3, 'sess0001'), query: 'other', messageNo: undefined })
    const r = t.search('budget', 20)
    expect(r.scanned).toBe(3)
    expect(r.hits.map(x => x.query)).toEqual(['unrelated', 'What did Silas say about the BUDGET?'])
    expect(r.hits[0]).toEqual({ threadId: 'th_0001', sessionId: 'sess0001', at: new Date(T0 + 60_000).toISOString(), query: 'unrelated', answerHead: 'The budget is flat.', messageNo: 402 })
    expect(t.search('budget', 1).hits).toHaveLength(1)
    expect(t.search('other', 5).hits[0]!.messageNo).toBeNull()
    expect(t.search('nothing here', 5)).toEqual({ hits: [], scanned: 3 })
  })

  it('threads list: newest first, title is the first query cut to 80, empty closed threads left out', () => {
    const h = harness()
    const t = h.make()
    t.recordTurn({ ...turn(1, 'sess0001'), query: 'A first question that is quite long '.repeat(5) })
    h.tick(); t.startNew()
    h.tick(); t.startNew()
    const list = t.list(20).threads
    expect(list.map(x => x.id)).toEqual(['th_0003', 'th_0001'])
    expect(list[1]!.title.length).toBeLessThanOrEqual(80)
    expect(list[1]).toMatchObject({ asks: 1, segments: 1, endedAt: new Date(T0 + 60_000).toISOString() })
    expect(list[0]).toMatchObject({ asks: 0, endedAt: null, title: '' })
    expect(t.list(1).threads).toHaveLength(1)
  })
})
