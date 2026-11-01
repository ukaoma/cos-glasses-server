import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRoots } from './agent-session-store.js'
import {
  FIND_HEAD_BYTES, FIND_REPEAT_TITLE_LIMIT, SessionFindCollector, isAbortError, listCodexRolloutFiles, rolloutFileId, unwrapPrompt, zstdDecompressor,
} from './session-find-collect.js'

// A fake home the collector reads: Claude projects and Desktop records, Codex rollouts (plain and zstd), Cursor transcripts.
let home = ''
const roots = () => agentSessionRoots(home)
const hasZstd = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function'
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const DAY = 86_400_000
const NOW = Date.parse('2026-11-01T12:00:00Z')

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'session find collect.')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function touch(file: string, whenMs: number) { utimesSync(file, new Date(whenMs), new Date(whenMs)) }
function line(o: unknown) { return JSON.stringify(o) + '\n' }
const iso = (ms: number) => new Date(ms).toISOString()

interface ClaudeOpts { prompt?: string; at?: number; mtime?: number; extra?: string; folder?: string; wrapperFirst?: boolean; custom?: string; sidechainFirst?: string }
function claude(n: number, o: ClaudeOpts = {}) {
  const dir = join(home, '.claude', 'projects', o.folder ?? '-Users-test-proj')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${uuid(n)}.jsonl`)
  const at = o.at ?? NOW - DAY
  let body = ''
  if (o.sidechainFirst) body += line({ type: 'user', isSidechain: true, message: { role: 'user', content: o.sidechainFirst }, timestamp: iso(at) })
  if (o.wrapperFirst) body += line({ type: 'user', message: { role: 'user', content: '<system-reminder>machine text</system-reminder>' }, timestamp: iso(at) })
  if (o.prompt !== undefined) body += line({ type: 'user', message: { role: 'user', content: o.prompt }, timestamp: iso(at) })
  body += line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: iso(at + 1000) })
  if (o.custom) body += line({ type: 'custom-title', customTitle: o.custom })
  body += o.extra ?? ''
  writeFileSync(file, body)
  touch(file, o.mtime ?? at + 1000)
  return file
}
function desktop(cli: string, extra: Record<string, unknown> & { title?: string }) {
  const dir = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'ws')
  mkdirSync(dir, { recursive: true })
  const id = `local_${uuid(900 + Math.floor(Math.random() * 90000))}`
  const { title, ...rest } = extra
  // The Desktop record keeps its title near the top and its flags where they fall.
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: cli, cwd: '/x', isArchived: false, title, ...rest }))
}
interface CodexOpts { prompt?: string; at?: number; metaId?: string; subagent?: boolean; zst?: boolean; name?: string; mtime?: number; leading?: string }
function codex(n: number, o: CodexOpts = {}, rootDir = join(home, '.codex', 'sessions')) {
  const at = o.at ?? NOW - 2 * DAY
  const day = new Date(at).toISOString().slice(0, 10).split('-')
  const dir = join(rootDir, day[0]!, day[1]!, day[2]!)
  mkdirSync(dir, { recursive: true })
  const name = `rollout-${iso(at).slice(0, 19).replace(/:/g, '-')}-${uuid(n)}.jsonl${o.zst ? '.zst' : ''}`
  const file = join(dir, o.name ?? name)
  let body = line({ timestamp: iso(at), type: 'session_meta', payload: { id: o.metaId ?? uuid(n), cwd: '/Users/test/codexproj', timestamp: iso(at), ...(o.subagent ? { thread_source: 'subagent' } : {}) } })
  body += o.leading ?? ''
  if (o.prompt !== undefined) body += line({ timestamp: iso(at + 500), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: o.prompt }] } })
  body += line({ timestamp: iso(at + 5000), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } })
  writeFileSync(file, o.zst ? (zlib as unknown as { zstdCompressSync(b: Buffer): Buffer }).zstdCompressSync(Buffer.from(body)) : body)
  touch(file, o.mtime ?? at + 5000)
  return file
}
function cursor(id: string, prompt: string, at = NOW - DAY) {
  const dir = join(home, '.cursor', 'projects', 'proj-a', 'agent-transcripts', id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, line({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${prompt}\n</user_query>` }] } }) + line({ role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }))
  touch(file, at)
  return file
}

const collect = (c: SessionFindCollector, limit = 254, extra: Record<string, unknown> = {}) => c.collect({ roots: roots(), limit, ...extra })
const ids = (pool: { candidates: Array<{ session_id: string }> }) => pool.candidates.map(x => x.session_id)

describe('the pool filter', () => {
  it('keeps sessions with a typed first prompt and drops the rest, each for its own reason', async () => {
    claude(1, { prompt: 'Why does the build fail on the lens page' })
    claude(2) // no user turn at all
    claude(3, { wrapperFirst: true }) // only a harness wrapper
    claude(4, { prompt: '<system-reminder>only machine text</system-reminder>' }) // wrapper that opens with a tag
    claude(5, { sidechainFirst: 'a subagent turn', prompt: 'A real question after a sidechain row' })
    codex(6, { prompt: 'Codex typed prompt about the sync', zst: false })
    codex(7, { prompt: 'a subagent rollout prompt', subagent: true })
    cursor('c0000000-0000-4000-8000-000000000001', 'Cursor typed prompt about the overlay')
    const pool = await collect(new SessionFindCollector())
    expect(pool.candidates.map(x => x.session_id).sort()).toEqual([uuid(1), uuid(5), uuid(6), 'c0000000-0000-4000-8000-000000000001'].sort())
    const five = pool.candidates.find(x => x.session_id === uuid(5))!
    expect(five.typed).toBe('A real question after a sidechain row')
  })

  it('drops a title seen 5 or more times and keeps one seen 4 times', async () => {
    for (let i = 0; i < FIND_REPEAT_TITLE_LIMIT - 1; i++) claude(10 + i, { prompt: 'Repeated routine title that appears four times' })
    for (let i = 0; i < FIND_REPEAT_TITLE_LIMIT; i++) claude(30 + i, { prompt: 'Machine title that appears five times' })
    const pool = await collect(new SessionFindCollector())
    expect(pool.candidates.filter(x => x.title.startsWith('Repeated')).length).toBe(FIND_REPEAT_TITLE_LIMIT - 1)
    expect(pool.candidates.filter(x => x.title.startsWith('Machine')).length).toBe(0)
  })

  it('drops a scheduled Desktop task and an archived one, and keeps a plain Desktop session (titled by the Desktop record)', async () => {
    claude(41, { prompt: 'scheduled prompt text here' }); desktop(uuid(41), { title: 'Scheduled run', scheduledTaskId: 'task-1' })
    claude(42, { prompt: 'archived prompt text here' }); desktop(uuid(42), { title: 'Archived chat', isArchived: true })
    claude(43, { prompt: 'plain prompt text here' }); desktop(uuid(43), { title: 'Desktop title wins' })
    const pool = await collect(new SessionFindCollector())
    expect(ids(pool)).toEqual([uuid(43)])
    expect(pool.candidates[0]!.title).toBe('Desktop title wins')
  })

  it('drops a Desktop session whose record cannot be read as a flag source (it fails toward not sending)', async () => {
    claude(44, { prompt: 'prompt for a huge desktop record' })
    const dir = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'ws')
    mkdirSync(dir, { recursive: true })
    // Over the 8 MB cap the record is not scanned at all.
    writeFileSync(join(dir, `local_${uuid(777)}.json`), JSON.stringify({ sessionId: `local_${uuid(777)}`, cliSessionId: uuid(44), cwd: '/x', title: 'Huge', pad: 'x'.repeat(8 * 1024 * 1024 + 10) }))
    expect(ids(await collect(new SessionFindCollector()))).toEqual([])
  })

  it('drops keep-warm titles and anything that ran on a key (a Claude session, a Codex thread, a Cursor session)', async () => {
    claude(51, { prompt: 'Ready' })
    claude(52, { prompt: 'a keyed claude prompt here' })
    codex(53, { prompt: 'a keyed codex prompt here' })
    cursor('c0000000-0000-4000-8000-000000000054', 'a keyed cursor prompt here')
    claude(55, { prompt: 'an ordinary claude prompt here' })
    const pool = await collect(new SessionFindCollector(), 254, { keyedIds: new Set([uuid(52), uuid(53), 'c0000000-0000-4000-8000-000000000054']) })
    expect(ids(pool)).toEqual([uuid(55)])
  })

  it('never reads a keyed Codex home: only the server home is scanned', async () => {
    codex(61, { prompt: 'server home prompt here' })
    codex(62, { prompt: 'keyed home prompt here' }, join(home, 'keyed-home', 'sessions'))
    const r = { ...roots(), codexProfileSessions: [join(home, 'keyed-home', 'sessions')] }
    const pool = await new SessionFindCollector().collect({ roots: r, limit: 254 })
    expect(ids(pool)).toEqual([uuid(61)])
  })

  it('titles a session the way the list does: Desktop record, then custom title, then the first line of the first prompt', async () => {
    claude(71, { prompt: 'First line of the first prompt\nsecond line', custom: 'My custom title' })
    claude(72, { prompt: 'First line of the first prompt two\nsecond line' })
    const pool = await collect(new SessionFindCollector())
    expect(pool.candidates.find(x => x.session_id === uuid(71))!.title).toBe('My custom title')
    expect(pool.candidates.find(x => x.session_id === uuid(72))!.title).toBe('First line of the first prompt two')
    expect(pool.candidates.find(x => x.session_id === uuid(72))!.listFirstLine).toBe('First line of the first prompt two')
  })
})

describe('ordering and reach', () => {
  it('orders by the last record, not the file write time (a relaunch touches old transcripts)', async () => {
    claude(81, { prompt: 'old work touched recently', at: NOW - 30 * DAY, mtime: NOW - 1000 })
    claude(82, { prompt: 'newer work with an old write time', at: NOW - 2 * DAY, mtime: NOW - 2 * DAY })
    const pool = await collect(new SessionFindCollector())
    expect(ids(pool)).toEqual([uuid(82), uuid(81)])
    expect(pool.candidates[1]!.clockMs).toBe(NOW - 30 * DAY + 1000)
    expect(pool.candidates[1]!.mtimeMs).toBe(NOW - 1000)
  })

  it('stops opening files once nothing unopened can displace the pool', async () => {
    claude(91, { prompt: 'newest prompt a', at: NOW - 1 * DAY })
    claude(92, { prompt: 'newest prompt b', at: NOW - 2 * DAY })
    for (let i = 0; i < 40; i++) claude(100 + i, { prompt: `old unopened prompt ${i} with distinct words ${i * 7}`, at: NOW - (60 + i) * DAY })
    const pool = await collect(new SessionFindCollector(), 2)
    expect(ids(pool)).toEqual([uuid(91), uuid(92)])
    // One batch of files is read before the rule is checked; the other old files are never opened.
    expect(pool.opened).toBeLessThanOrEqual(32)
    expect(pool.opened).toBeLessThan(pool.considered)
  })

  it('caps the pool at the limit asked for', async () => {
    for (let i = 0; i < 6; i++) claude(120 + i, { prompt: `prompt number ${i} with unique words ${i * 13}`, at: NOW - (i + 1) * DAY })
    expect((await collect(new SessionFindCollector(), 4)).candidates.length).toBe(4)
  })
})

describe('the memo and the single flight', () => {
  it('reads a file once: a second walk opens nothing, a changed file is read again, a removed one is forgotten', async () => {
    const f = claude(131, { prompt: 'memo prompt one here', at: NOW - DAY })
    claude(132, { prompt: 'memo prompt two here', at: NOW - 2 * DAY })
    const c = new SessionFindCollector()
    expect((await collect(c)).opened).toBe(2)
    expect((await collect(c)).opened).toBe(0)
    appendFileSync(f, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'more' }] }, timestamp: iso(NOW) }))
    touch(f, NOW)
    const after = await collect(c)
    expect(after.opened).toBe(1)
    expect(after.candidates[0]!.clockMs).toBe(NOW)
    rmSync(f)
    await collect(c)
    expect(c.memoSize()).toBe(1)
  })

  it('shares one walk between concurrent callers', async () => {
    for (let i = 0; i < 5; i++) claude(140 + i, { prompt: `shared walk prompt ${i} ${i * 11}`, at: NOW - (i + 1) * DAY })
    const c = new SessionFindCollector()
    const [a, b] = await Promise.all([collect(c), collect(c)])
    expect(a).toBe(b)
    expect(a.opened).toBe(5)
  })

  it('stops a walk when its last caller has gone, keeps what it read, and the next caller starts fresh', async () => {
    for (let i = 0; i < 200; i++) claude(200 + i, { prompt: `abandoned walk prompt ${i} with words ${i * 3}`, at: NOW - (i + 1) * 3600_000 })
    const c = new SessionFindCollector()
    const gone = new AbortController()
    const first = collect(c, 254, { signal: gone.signal })
    gone.abort()
    await expect(first).rejects.toSatisfy(isAbortError)
    const second = await collect(c)
    expect(second.candidates.length).toBe(200)
    // Some of the 200 may have been read before the stop; none is read twice.
    expect(second.opened).toBeLessThanOrEqual(200)
    expect((await collect(c)).opened).toBe(0)
  })

  it('keeps a shared walk running while one of two callers leaves', async () => {
    for (let i = 0; i < 20; i++) claude(500 + i, { prompt: `two callers prompt ${i} words ${i * 5}`, at: NOW - (i + 1) * 3600_000 })
    const c = new SessionFindCollector()
    const leaving = new AbortController()
    const a = collect(c, 254, { signal: leaving.signal })
    const b = collect(c)
    leaving.abort()
    await expect(a).rejects.toSatisfy(isAbortError)
    expect((await b).candidates.length).toBe(20)
  })

  it('answers an already-cancelled call without a walk', async () => {
    claude(600, { prompt: 'never walked prompt' })
    const gone = new AbortController(); gone.abort()
    await expect(collect(new SessionFindCollector(), 254, { signal: gone.signal })).rejects.toSatisfy(isAbortError)
  })
})

describe('Codex', () => {
  it('lists plain and compressed rollouts and nothing else', async () => {
    const plain = codex(300, { prompt: 'plain codex prompt' })
    const zst = hasZstd ? codex(301, { prompt: 'compressed codex prompt', zst: true }) : null
    writeFileSync(join(plain, '..', 'notes.txt'), 'x')
    writeFileSync(join(plain, '..', 'rollout-x.jsonl.bak'), 'x')
    const listed = (await listCodexRolloutFiles(join(home, '.codex', 'sessions'))).map(x => `${x.file === plain ? 'plain' : 'zst'}:${x.compressed}`).sort()
    expect(listed).toEqual(zst ? ['plain:false', 'zst:true'] : ['plain:false'])
  })

  it('parses the id from both file kinds and refuses names that are not rollouts', () => {
    const id = uuid(5)
    expect(rolloutFileId(`rollout-2026-10-30T12-00-00-${id}.jsonl`)).toBe(id)
    expect(rolloutFileId(`rollout-2026-10-30T12-00-00-${id}.jsonl.zst`)).toBe(id)
    expect(rolloutFileId(`rollout-2026-10-30T12-00-00-${id}.json`)).toBeNull()
    expect(rolloutFileId('rollout-short.jsonl')).toBeNull()
  })

  it('lets the filename win over a cloned thread that carries its parent id', async () => {
    codex(310, { prompt: 'a cloned thread prompt here', metaId: uuid(311) })
    const pool = await collect(new SessionFindCollector())
    expect(ids(pool)).toEqual([uuid(310)])
  })

  it.runIf(hasZstd)('reads a compressed rollout head, marks it compressed and orders it by its write time', async () => {
    codex(320, { prompt: 'compressed prompt of the older rollout', zst: true, at: NOW - 20 * DAY, mtime: NOW - 20 * DAY })
    codex(321, { prompt: 'plain prompt of the newer rollout', at: NOW - 3 * DAY })
    const pool = await collect(new SessionFindCollector())
    expect(pool.candidates.map(x => [x.session_id, x.compressed])).toEqual([[uuid(321), false], [uuid(320), true]])
    expect(pool.candidates[1]!.typed).toBe('compressed prompt of the older rollout')
    expect(pool.skippedNoDecoder + pool.skippedUnreadable).toBe(0)
  })

  it.runIf(hasZstd)('counts a damaged compressed file as unreadable and carries on with the rest', async () => {
    const bad = codex(330, { prompt: 'will be damaged', zst: true })
    writeFileSync(bad, Buffer.from('this is not zstd data at all'))
    touch(bad, NOW - DAY)
    claude(331, { prompt: 'a healthy session beside it' })
    const pool = await collect(new SessionFindCollector())
    expect(ids(pool)).toEqual([uuid(331)])
    expect(pool.skippedUnreadable).toBe(1)
    expect(pool.skippedNoDecoder).toBe(0)
  })

  it.runIf(hasZstd)('finds the first prompt within the head, and not beyond it', async () => {
    const filler = line({ timestamp: iso(NOW), type: 'event_msg', payload: { type: 'token_count', pad: 'p'.repeat(200_000) } })
    codex(340, { prompt: 'prompt inside the first megabyte', leading: filler.repeat(3), zst: true })
    codex(341, { prompt: 'prompt beyond the first megabyte', leading: filler.repeat(Math.ceil(FIND_HEAD_BYTES / filler.length) + 2), zst: true })
    codex(342, { prompt: 'plain prompt beyond the first megabyte', leading: filler.repeat(Math.ceil(FIND_HEAD_BYTES / filler.length) + 2) })
    const pool = await collect(new SessionFindCollector())
    expect(ids(pool)).toEqual([uuid(340)])
  })
})

describe('a Node without zstd', () => {
  it('skips and counts compressed files when the decoder is absent, and still returns everything else', async () => {
    if (hasZstd) codex(400, { prompt: 'compressed one', zst: true })
    else { const f = codex(400, { prompt: 'compressed one' }); writeFileSync(f.replace(/\.jsonl$/, '.jsonl.zst'), 'x'); rmSync(f) }
    claude(401, { prompt: 'a claude session that still works' })
    const pool = await collect(new SessionFindCollector(), 254, { zstd: () => null })
    expect(ids(pool)).toEqual([uuid(401)])
    expect(pool.skippedNoDecoder).toBe(1)
    expect(pool.skippedUnreadable).toBe(0)
  })

  it('resolves the decoder at the call: removing it from node:zlib reads as absent, and the walk counts the skip', async () => {
    const make = (zlib as { createZstdDecompress?: unknown }).createZstdDecompress
    expect(typeof make === 'function' ? 'present' : 'absent').toBe(hasZstd ? 'present' : 'absent')
    if (hasZstd) codex(410, { prompt: 'compressed two', zst: true })
    else { const f = codex(410, { prompt: 'compressed two' }); writeFileSync(f.replace(/\.jsonl$/, '.jsonl.zst'), 'x'); rmSync(f) }
    const z = zlib as { createZstdDecompress?: unknown }
    try {
      delete z.createZstdDecompress
      expect(zstdDecompressor()).toBeNull()
      const pool = await collect(new SessionFindCollector())
      expect(pool.skippedNoDecoder).toBe(1)
      expect(pool.skippedUnreadable).toBe(0)
    } finally { if (hasZstd) z.createZstdDecompress = make }
  })

  it('loads when node:zlib has no zstd export at all (a named import would not boot)', async () => {
    vi.resetModules()
    vi.doMock('node:zlib', async () => {
      const real = await vi.importActual<typeof import('node:zlib')>('node:zlib')
      const copy: Record<string, unknown> = { ...real }
      delete copy.createZstdDecompress
      delete copy.zstdCompressSync
      return { ...copy, default: copy }
    })
    try {
      const fresh = await import('./session-find-collect.js')
      expect(fresh.zstdDecompressor()).toBeNull()
      expect(typeof fresh.SessionFindCollector).toBe('function')
    } finally { vi.doUnmock('node:zlib'); vi.resetModules() }
  })
})

describe('unwrapPrompt', () => {
  it('takes the Cursor query, removes harness blocks and puts the rest on one line', () => {
    expect(unwrapPrompt('<user_query>\nFix   the\nlens</user_query>')).toBe('Fix the lens')
    expect(unwrapPrompt('Keep this <system-reminder>drop\nthis</system-reminder> and this')).toBe('Keep this and this')
    expect(unwrapPrompt('<ide_opened_file x="1">gone</ide_opened_file>typed words')).toBe('typed words')
  })
  it('does not lose the words around an unclosed tag, and stays fast on a long unclosed run', () => {
    const long = '<system-reminder>'.repeat(2_000) + 'typed'
    const started = performance.now()
    const out = unwrapPrompt(long)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(typeof out).toBe('string')
    expect(unwrapPrompt('plain <b>text</b> kept')).toBe('plain <b>text</b> kept')
  })
})
