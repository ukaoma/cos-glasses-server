/**
 * Preview engine phase 1: link cards in the session detail, the preview resolver's re-authorization, the Settings
 * extra folders for sent files, and SendUserFile `files` sent as a JSON string. Real transcripts on disk (Claude and
 * Codex shapes), the real projection, a fake media store. The fixture root has a space and a dot component.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSessionOutputImages, sentUserFiles } from './agent-session-output-images.js'
import { readRecentSessionTurns } from './agent-session-turns.js'
import { withoutPreviews } from './session-files-setting.js'
import { LINK_CARDS_PER_TURN } from './session-links.js'
import type { AgentProvider } from './agent-session-store.js'

const made: string[] = []
afterEach(() => { for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true }) })

const claudeSaid = (text: string, cwd?: string) => ({ type: 'assistant', timestamp: '2026-11-08T14:00:00Z', ...(cwd ? { cwd } : {}), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const codexSaid = (text: string) => ({ type: 'response_item', timestamp: '2026-11-08T14:00:00Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })

function fixture(rows: (t: { repo: string; home: string; extra: string; sub: string }) => unknown[], opts: { extra?: boolean } = {}) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'cos links-'))); made.push(top)
  const home = join(top, 'home')
  const repo = join(home, 'Ukaoma Chief Of Staff', 'MU-Chief-Staff')
  const sub = join(repo, 'operations', 'personal', 'wk45_2026')
  const extra = join(home, 'cos-release-candidates', 'preview-p1')
  for (const d of [sub, extra, join(repo, '.cos-data'), join(home, 'elsewhere')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(sub, 'PLAN.md'), '# Plan\n\nline 3\n')
  writeFileSync(join(sub, 'data.csv'), 'a,b\n1,2\n')
  writeFileSync(join(sub, 'report.html'), '<h1>Report</h1>')
  writeFileSync(join(repo, 'server.ts'), 'export const x = 1\n')
  writeFileSync(join(repo, '.env'), 'SECRET=1')
  writeFileSync(join(extra, 'EVIDENCE.md'), '# Evidence')
  writeFileSync(join(home, 'elsewhere', 'private.md'), 'outside')
  const transcript = join(top, 'session.jsonl')
  writeFileSync(transcript, rows({ repo, home, extra, sub }).map(r => JSON.stringify(r)).join('\n') + '\n')
  const normalized = join(top, 'normalized.jpg'); writeFileSync(normalized, 'jpeg')
  const store = { ingestOutputImage: vi.fn(async () => ({ id: 'm_' + 'b'.repeat(24) })), getContent: vi.fn(() => ({ status: 'ok' as const, path: normalized, mime: 'image/jpeg' as const, bytes: 4 })) }
  let extraRoots: string[] = opts.extra ? [extra] : []
  let clock = 1
  const service = new AgentSessionOutputImages({
    findSession: async (_p: AgentProvider, id: string) => (id === 'session' ? transcript : null),
    workspace: async () => repo, secret: Buffer.alloc(32, 7), now: () => clock,
    store: () => store as unknown as ReturnType<typeof import('./media-store.js').getMediaStore>,
    home: () => home,
    extraRoots: () => extraRoots,
  })
  const turns = async (provider: AgentProvider = 'claude') => {
    const ctx = await service.context(provider, 'session', transcript)
    return (await readRecentSessionTurns(provider, transcript, 10, undefined, ctx.project)).turns
  }
  return { top, home, repo, sub, extra, transcript, service, turns, setExtra: (r: string[]) => { extraRoots = r }, setNow: (n: number) => { clock = n } }
}

/** No absolute path of the fixture, and no Mac path shape, anywhere in what the browser would get. */
function expectNoPaths(value: unknown, top: string) {
  const json = JSON.stringify(value)
  expect(json).not.toContain(top)
  expect(json).not.toMatch(/\/Users\/|\/private\/|\/var\/folders\/|\/Volumes\//)
  expect(json).not.toContain('~/')
}

describe('link cards in the session detail', () => {
  it('Claude: each local link becomes a card where it sits; the text keeps the words, never the path', async () => {
    const f = fixture(t => [claudeSaid([
      'Plan: [the plan](operations/personal/wk45_2026/PLAN.md), code [server.ts:2](server.ts:2), table [data](data.csv).',
      `Absolute [${join(t.sub, 'report.html')}](${join(t.sub, 'report.html')}) and web [docs](https://example.com) and [top](#top).`,
      `Outside [mine](${join(t.home, 'elsewhere', 'private.md')}), gone [gone](gone.md), secret [env](.env).`,
      'Again [the plan again](operations/personal/wk45_2026/PLAN.md).',
      '`[inert](server.ts)`',
    ].join('\n'), t.sub)])
    const [turn] = await f.turns()
    expectNoPaths(turn, f.top)
    expect(turn.text).toContain('Plan: [the plan](cos-file:0), code [server.ts:2](cos-file:1), table [data](cos-file:2).')
    expect(turn.text).toContain('Absolute [report.html](cos-file:3) and web [docs](https://example.com) and [top](#top).')
    expect(turn.text).toContain('Outside [mine](cos-file:4), gone [gone](cos-file:5), secret [env](cos-file:6).')
    expect(turn.text, 'the same target is one card').toContain('Again [the plan again](cos-file:0).')
    expect(turn.text).toContain('`[inert](server.ts)`')
    const cards = turn.outputLinks!
    expect(cards.map(c => [c.name, c.kind, c.state, c.reason ?? '', c.line ?? 0])).toEqual([
      ['PLAN.md', 'markdown', 'available', '', 0],
      ['server.ts', 'code', 'available', '', 2],
      ['data.csv', 'table', 'available', '', 0],
      ['report.html', 'html', 'available', '', 0],
      ['private.md', 'markdown', 'unavailable', 'outside_workspace', 0],
      ['gone.md', 'markdown', 'unavailable', 'missing', 0],
      ['.env', 'file', 'unavailable', 'secret_file', 0],
    ])
    for (const c of cards) expect(c.id).toMatch(/^al_[a-f0-9]{64}$/)
    expect(cards[0].size).toBe(Buffer.byteLength("# Plan\n\nline 3\n"))
  })
  it('Codex: absolute links outside the session folder open only from a Settings extra folder; cwd comes from turn_context', async () => {
    const rows = (t: { repo: string; extra: string; sub: string }) => [
      { type: 'session_meta', payload: { id: 'session', cwd: t.repo } },
      { type: 'turn_context', payload: { cwd: t.sub } },
      codexSaid(`Evidence: [EVIDENCE.md](${join(t.extra, 'EVIDENCE.md')}). Local: [PLAN.md](PLAN.md).`),
    ]
    const off = fixture(rows)
    const [a] = await off.turns('codex')
    expectNoPaths(a, off.top)
    expect(a.outputLinks!.map(c => [c.name, c.state, c.reason ?? ''])).toEqual([['EVIDENCE.md', 'unavailable', 'outside_workspace'], ['PLAN.md', 'available', '']])
    const on = fixture(rows, { extra: true })
    const [b] = await on.turns('codex')
    expect(b.outputLinks!.map(c => c.state)).toEqual(['available', 'available'])
    expect(b.text).toBe('Evidence: [EVIDENCE.md](cos-file:0). Local: [PLAN.md](cos-file:1).')
  })
  it(`caps at ${LINK_CARDS_PER_TURN} cards a turn and counts the rest in words; past the cap the words stay and the path goes`, async () => {
    const f = fixture(t => [claudeSaid(Array.from({ length: 23 }, (_, i) => `[f${i}](${join(t.sub, `f${i}.md`)})`).join(' '))])
    const [turn] = await f.turns()
    expect(turn.outputLinks).toHaveLength(LINK_CARDS_PER_TURN)
    expect(turn.text).toContain('[f19](cos-file:19) f20 f21 f22')
    expect(turn.text).toContain('3 more linked files are not shown as cards.')
    expectNoPaths(turn, f.top)
  })
  it('previews off: no cards, no ids, no markers; the words stay', async () => {
    const f = fixture(() => [claudeSaid('See [the plan](operations/personal/wk45_2026/PLAN.md).')])
    const [off] = withoutPreviews(await f.turns())
    expect(off.outputLinks).toBeUndefined()
    expect(off.previewsOff).toBe(true)
    expect(off.text).toBe('See the plan.')
    expect(JSON.stringify(off)).not.toMatch(/al_|cos-file/)
  })
  it('a turn with no local link is unchanged (no outputImages or outputLinks added)', async () => {
    const f = fixture(() => [claudeSaid('Web only: [docs](https://example.com).')])
    const [turn] = await f.turns()
    expect(turn).toEqual({ role: 'assistant', text: 'Web only: [docs](https://example.com).', at: '2026-11-08T14:00:00Z' })
  })
})

describe('previewFile re-authorizes every id', () => {
  it('serves an available card, and refuses an id that is not in the newest turns', async () => {
    const f = fixture(() => [claudeSaid('[plan](operations/personal/wk45_2026/PLAN.md:3)')])
    const [turn] = await f.turns()
    const got = await f.service.previewFile('claude', 'session', turn.outputLinks![0].id)
    expect(got).toMatchObject({ status: 'ok', name: 'PLAN.md', kind: 'markdown', line: 3 })
    if (got.status === 'ok') expect(got.bytes.toString()).toBe('# Plan\n\nline 3\n')
    expect(await f.service.previewFile('claude', 'session', 'al_' + 'f'.repeat(64))).toEqual({ status: 'not_found' })
    expect(await f.service.previewFile('claude', 'other', turn.outputLinks![0].id)).toEqual({ status: 'not_found' })
    expect(await f.service.previewFile('claude', 'session', 'zz_' + 'f'.repeat(64))).toEqual({ status: 'not_found' })
  })
  it('a denied name answers blocked; outside and missing answer unavailable', async () => {
    const f = fixture(t => [claudeSaid(`[env](.env) [out](${join(t.home, 'elsewhere', 'private.md')}) [gone](gone.md)`, t.repo)])
    const [turn] = await f.turns()
    const ids = turn.outputLinks!.map(l => l.id)
    expect((await f.service.previewFile('claude', 'session', ids[0])).status).toBe('secret')
    expect((await f.service.previewFile('claude', 'session', ids[1])).status).toBe('unavailable')
    expect((await f.service.previewFile('claude', 'session', ids[2])).status).toBe('unavailable')
  })
  it('removing an extra folder in Settings takes effect on the next read', async () => {
    const f = fixture(t => [codexSaid(`[ev](${join(t.extra, 'EVIDENCE.md')})`)], { extra: true })
    const [turn] = await f.turns('codex')
    const id = turn.outputLinks![0].id
    expect((await f.service.previewFile('codex', 'session', id)).status).toBe('ok')
    f.setExtra([])
    expect((await f.service.previewFile('codex', 'session', id)).status).toBe('unavailable')
  })
  it('a file swapped for a link after the card was made is refused', async () => {
    const f = fixture(() => [claudeSaid('[plan](operations/personal/wk45_2026/PLAN.md)')])
    const [turn] = await f.turns()
    const id = turn.outputLinks![0].id
    unlinkSync(join(f.sub, 'PLAN.md')); symlinkSync(join(f.home, 'elsewhere', 'private.md'), join(f.sub, 'PLAN.md'))
    expect((await f.service.previewFile('claude', 'session', id)).status).not.toBe('ok')
  })
  it('a folder card has no content', async () => {
    const f = fixture(() => [claudeSaid('[week](operations/personal/wk45_2026)')])
    const [turn] = await f.turns()
    expect(turn.outputLinks![0]).toMatchObject({ kind: 'folder', type: 'Folder', state: 'available', name: 'wk45_2026' })
    expect((await f.service.previewFile('claude', 'session', turn.outputLinks![0].id)).status).toBe('folder')
  })
})

describe('load (PLAN 7, section 11): 20 cards in one reader', () => {
  it('one transcript parse per 30 s while the transcript stands; a changed transcript or an old projection parses again', async () => {
    const f = fixture(t => [claudeSaid(Array.from({ length: 20 }, (_, i) => `[f${i}](f${i}.md)`).join(' '), t.sub)])
    for (let i = 0; i < 20; i++) writeFileSync(join(f.sub, `f${i}.md`), '# ' + i)
    const [turn] = await f.turns()
    const ids = turn.outputLinks!.map(l => l.id)
    expect(ids).toHaveLength(20)
    // The web asks two at a time (reader-media.js's shared request budget).
    for (let i = 0; i < ids.length; i += 2) {
      const pair = await Promise.all([f.service.previewFile('claude', 'session', ids[i], true), f.service.previewFile('claude', 'session', ids[i + 1], true)])
      expect(pair.map(p => p.status)).toEqual(['ok', 'ok'])
    }
    expect(f.service.previewParses).toBe(1)
    f.setNow(1 + 29_999)
    await f.service.previewFile('claude', 'session', ids[0], true)
    expect(f.service.previewParses).toBe(1)
    f.setNow(1 + 30_000)
    await f.service.previewFile('claude', 'session', ids[0], true)
    expect(f.service.previewParses).toBe(2)
    appendFileSync(f.transcript, JSON.stringify(claudeSaid('more words')) + '\n')
    await f.service.previewFile('claude', 'session', ids[0], true)
    expect(f.service.previewParses).toBe(3)
  })
  it('never more than 2 preview reads at once: a third is told to come back, nothing queues unbounded', async () => {
    const f = fixture(t => [claudeSaid('[a](a.md) [b](b.md) [c](c.md)', t.sub)])
    for (const n of ['a', 'b', 'c']) writeFileSync(join(f.sub, n + '.md'), n)
    const [turn] = await f.turns()
    const ids = turn.outputLinks!.map(l => l.id)
    const all = await Promise.all(ids.map(id => f.service.previewFile('claude', 'session', id)))
    expect(all.map(r => r.status).sort(), 'the third is busy (503 previews_busy), which the web retries').toEqual(['busy', 'ok', 'ok'])
  })
})

describe('sent files: JSON-string files and the Settings extra folders', () => {
  const share = (files: unknown) => ({ type: 'assistant', timestamp: '2026-11-08T14:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'SendUserFile', input: { files, status: 'normal' } }] } })
  it('accepts `files` sent as a JSON string, with the same checks; anything else stays dropped', () => {
    expect(sentUserFiles('claude', share(JSON.stringify(['a.md', '/x/b.pdf'])))).toEqual({ caption: '', files: ['a.md', '/x/b.pdf'] })
    expect(sentUserFiles('claude', share('not json'))).toBeNull()
    expect(sentUserFiles('claude', share('"a.md"'))).toBeNull()
    expect(sentUserFiles('claude', share(JSON.stringify([1, '', 'a\u0000b'])))).toBeNull()
  })
  it('a JSON-string share shows its cards, and a file in an extra folder is available only with the folder named', async () => {
    const rows = (t: { extra: string; sub: string }) => [share(JSON.stringify([join(t.sub, 'PLAN.md'), join(t.extra, 'EVIDENCE.md')]))]
    const off = fixture(rows)
    const [a] = await off.turns()
    expect(a.outputFiles!.map(x => [x.name, x.state, x.reason ?? ''])).toEqual([['PLAN.md', 'available', ''], ['EVIDENCE.md', 'unavailable', 'outside_workspace']])
    const on = fixture(rows, { extra: true })
    const [b] = await on.turns()
    expect(b.outputFiles!.map(x => x.state)).toEqual(['available', 'available'])
    const got = await on.service.previewFile('claude', 'session', b.outputFiles![1].id)
    expect(got).toMatchObject({ status: 'ok', name: 'EVIDENCE.md', kind: 'markdown' })
    // The existing output-files route reads it under the same root.
    expect((await on.service.fileContent('claude', 'session', b.outputFiles![1].id)).status).toBe('ok')
  })
})

describe('7.0.4 QA hard-link rule, for link cards too', () => {
  it('a file with another hard link is a secret card and its id answers secret; a picture is exempt', async () => {
    const f = fixture(t => [claudeSaid('[notes](notes.md) [shot](shot.png)', t.sub)])
    writeFileSync(join(f.repo, '.env.hidden-copy'), 'x'); linkSync(join(f.repo, '.env'), join(f.sub, 'notes.md'))
    writeFileSync(join(f.sub, 'shot.png'), 'png'); linkSync(join(f.sub, 'shot.png'), join(f.home, 'elsewhere', 'shot-link.png'))
    const [turn] = await f.turns()
    expect(turn.outputLinks!.map(l => [l.name, l.state, l.reason ?? ''])).toEqual([['notes.md', 'unavailable', 'secret_file'], ['shot.png', 'available', '']])
    expect(turn.outputLinks![0].notice).toBe('Not shown: this file may hold secrets')
  })
  it('a file that gains a hard link after its card was made is refused when opened', async () => {
    const f = fixture(() => [claudeSaid('[plan](operations/personal/wk45_2026/PLAN.md)')])
    const [turn] = await f.turns()
    const id = turn.outputLinks![0].id
    expect((await f.service.previewFile('claude', 'session', id)).status).toBe('ok')
    linkSync(join(f.sub, 'PLAN.md'), join(f.home, 'elsewhere', 'PLAN-copy.md'))
    expect((await f.service.previewFile('claude', 'session', id)).status).toBe('secret')
  })
})
