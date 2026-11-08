/**
 * 6.99.35 hotfix: files a Claude session sent with SendUserFile show in the reader. Real transcripts on disk, the real
 * projection and content routes, a fake media store. Miles, 11/07: "I can see the previews from claude but not from the
 * COS control."
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'
import {
  AgentSessionOutputImages, MAX_SHARED_FILE_BYTES, SESSION_OUTPUT_FILE_ID, SESSION_OUTPUT_IMAGE_ID, SHARED_FILES_PER_TURN,
  sentUserFiles, sharedFileHeaders, sharedFileKind,
} from './agent-session-output-images.js'
import { readRecentSessionTurns } from './agent-session-turns.js'
import type { AgentProvider } from './agent-session-store.js'

const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })

const share = (files: unknown[], extra: Record<string, unknown> = {}, input: Record<string, unknown> = {}) => ({
  type: 'assistant', timestamp: '2026-11-07T20:00:00Z', cwd: undefined as string | undefined, ...extra,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'SendUserFile', input: { files, caption: 'Here are the renders.', status: 'normal', display: 'render', ...input } }] },
})
const said = (text: string) => ({ type: 'assistant', timestamp: '2026-11-07T19:59:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } })

function fixture(rows: (ws: string, root: string) => unknown[], opts: { workspace?: (ws: string, root: string) => string | null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cos-sent-'))); roots.push(root)
  const workspace = join(root, 'repo'); mkdirSync(join(workspace, 'out'), { recursive: true })
  writeFileSync(join(workspace, 'out', 'shot.png'), 'png bytes')
  writeFileSync(join(workspace, 'out', 'report.pdf'), '%PDF-1.7 bytes')
  writeFileSync(join(workspace, 'out', 'page.html'), '<script>alert(1)</script><h1>Hi</h1>')
  writeFileSync(join(workspace, 'out', 'notes.md'), '# Notes')
  writeFileSync(join(root, 'secret.pdf'), '%PDF outside')
  const transcript = join(root, 'session.jsonl')
  writeFileSync(transcript, rows(workspace, root).map(r => JSON.stringify(r)).join('\n') + '\n')
  const normalized = join(root, 'normalized.jpg'); writeFileSync(normalized, 'jpeg')
  const ingest = vi.fn(async (_input: unknown) => ({ id: 'm_' + 'b'.repeat(24) }))
  const store = { ingestOutputImage: ingest, getContent: vi.fn(() => ({ status: 'ok' as const, path: normalized, mime: 'image/jpeg' as const, bytes: 4 })) }
  const service = new AgentSessionOutputImages({
    findSession: async (_p: AgentProvider, id: string) => id === 'session' ? transcript : null,
    workspace: async () => (opts.workspace ? opts.workspace(workspace, root) : workspace), secret: Buffer.alloc(32, 9), now: () => 1,
    store: () => store as unknown as ReturnType<typeof import('./media-store.js').getMediaStore>,
    home: () => join(root, 'home'),
  })
  const turns = async (provider: AgentProvider = 'claude') => {
    const ctx = await service.context(provider, 'session', transcript)
    return (await readRecentSessionTurns(provider, transcript, 10, undefined, ctx.project)).turns
  }
  return { root, workspace, transcript, service, store, ingest, turns }
}

describe('SendUserFile records', () => {
  it('reads the files and caption of a Claude assistant row, and nothing from anyone else', () => {
    expect(sentUserFiles('claude', share(['a.png', '/x/b.pdf']))).toEqual({ caption: 'Here are the renders.', files: ['a.png', '/x/b.pdf'] })
    expect(sentUserFiles('claude', { ...share(['a.png']), isSidechain: true }), 'a sub-agent').toBeNull()
    expect(sentUserFiles('claude', { ...share(['a.png']), isMeta: true }), 'an injected row').toBeNull()
    expect(sentUserFiles('claude', { ...share(['a.png']), type: 'user' }), 'a user row').toBeNull()
    expect(sentUserFiles('codex', share(['a.png'])), 'Codex has no SendUserFile').toBeNull()
    const other = share(['a.png']); (other.message.content[0] as any).name = 'Read'
    expect(sentUserFiles('claude', other), 'another tool').toBeNull()
    expect(sentUserFiles('claude', share([1, '', 'a\u0000b', 'x'.repeat(4097)])), 'no usable path').toBeNull()
  })
  it('kinds: a PDF opens inline, HTML is its own kind, text kinds are words, SVG is source, unknown is a download', () => {
    expect(sharedFileKind('r.PDF')).toEqual({ kind: 'pdf', type: 'PDF' })
    expect(sharedFileKind('p.htm').kind).toBe('html')
    expect(sharedFileKind('n.md')).toEqual({ kind: 'text', type: 'Markdown' })
    expect(sharedFileKind('d.csv').kind).toBe('text')
    expect(sharedFileKind('i.svg')).toEqual({ kind: 'text', type: 'SVG source' })
    expect(sharedFileKind('a.gif').kind).toBe('image')
    expect(sharedFileKind('w.docx')).toEqual({ kind: 'file', type: 'Word document' })
    expect(sharedFileKind('x.ehpk').type).toBe('EHPK package')
    expect(sharedFileKind('noext')).toEqual({ kind: 'file', type: 'File' })
  })
})

describe('the reader shows sent files at their point in the conversation', () => {
  it('an image becomes a preview, other files become cards with name, type and size; never a Mac path', async () => {
    const f = fixture(ws => [said('Before.'), share([join(ws, 'out', 'shot.png'), 'out/report.pdf', join(ws, 'out', 'page.html')], { cwd: ws }), said('After.')])
    const turns = await f.turns()
    expect(turns.map(t => t.text)).toEqual(['Before.', 'Here are the renders.', 'After.'])
    const t = turns[1]
    expect(t.role).toBe('assistant')
    expect(t.at).toBe('2026-11-07T20:00:00Z')
    expect(t.outputImages).toHaveLength(1)
    expect(t.outputImages![0]).toMatchObject({ label: 'shot.png', state: 'available' })
    expect(SESSION_OUTPUT_IMAGE_ID.test(t.outputImages![0].id)).toBe(true)
    expect(t.outputFiles!.map(x => [x.name, x.kind, x.type, x.size, x.state])).toEqual([
      ['report.pdf', 'pdf', 'PDF', 14, 'available'], ['page.html', 'html', 'HTML page', 36, 'available'],
    ])
    for (const x of t.outputFiles!) expect(SESSION_OUTPUT_FILE_ID.test(x.id)).toBe(true)
    expect(JSON.stringify(turns), 'no path reaches the client').not.toContain(f.root)
  })
  it('relative paths resolve against the row cwd, not the workspace root', async () => {
    const f = fixture(ws => [share(['report.pdf'], { cwd: join(ws, 'out') })])
    const [t] = await f.turns()
    expect(t.outputFiles![0]).toMatchObject({ name: 'report.pdf', state: 'available' })
  })
  it('outside the workspace, through a link out, missing, a URL or a broad root: "not available", no bytes', async () => {
    const f = fixture((ws, root) => {
      symlinkSync(join(root, 'secret.pdf'), join(ws, 'out', 'link.pdf'))
      return [share([join(root, 'secret.pdf'), join(ws, 'out', 'link.pdf'), 'out/gone.pdf', 'https://example.com/a.pdf', '~/a.pdf', '//host/a.pdf'], { cwd: ws })]
    })
    const [t] = await f.turns()
    expect(t.outputFiles!.map(x => [x.name, x.state, x.reason])).toEqual([
      ['secret.pdf', 'unavailable', 'outside_workspace'], ['link.pdf', 'unavailable', 'outside_workspace'],
      ['gone.pdf', 'unavailable', 'missing'], ['a.pdf', 'unavailable', 'outside_workspace'],
      ['a.pdf', 'unavailable', 'outside_workspace'], ['a.pdf', 'unavailable', 'outside_workspace'],
    ])
    for (const x of t.outputFiles!) expect(x.size, x.name).toBeUndefined()
    for (const x of t.outputFiles!) expect((await f.service.fileContent('claude', 'session', x.id)).status).toBe('unavailable')
    const broad = fixture(ws => [share(['out/report.pdf'], { cwd: ws })], { workspace: (_ws, root) => join(root, 'home') })
    mkdirSync(join(broad.root, 'home'))
    const [b] = await broad.turns()
    expect(b.outputFiles![0]).toMatchObject({ state: 'unavailable', reason: 'outside_workspace' })
  })
  it('a directory is not a file: "not available"', async () => {
    const f = fixture(ws => [share(['out'], { cwd: ws })])
    const [t] = await f.turns()
    expect(t.outputFiles![0]).toMatchObject({ name: 'out', state: 'unavailable', reason: 'missing' })
  })
  it('a missing image is a "not on this Mac" preview, not a broken one', async () => {
    const f = fixture(ws => [share(['out/none.png'], { cwd: ws })])
    const [t] = await f.turns()
    expect(t.outputImages![0]).toMatchObject({ label: 'none.png', state: 'unavailable', reason: 'missing' })
  })
  it('a caption never shows an image path; past the cap the rest are counted in words', async () => {
    const many = Array.from({ length: SHARED_FILES_PER_TURN + 2 }, (_, i) => `out/f${i}.md`)
    const f = fixture((ws, root) => [share(many, { cwd: ws }, { caption: `See ![x](${join(root, 'secret.png')})` })])
    const [t] = await f.turns()
    expect(t.text).toBe('See [Output image]\n\n2 more files were sent and are not listed here.')
    expect(t.outputFiles).toHaveLength(SHARED_FILES_PER_TURN)
  })
  it('sub-agent shares and other providers stay out', async () => {
    const f = fixture(ws => [{ ...share(['out/report.pdf'], { cwd: ws }), isSidechain: true }])
    expect(await f.turns()).toEqual([])
  })
})

describe('serving a sent file', () => {
  it('serves the exact bytes only for an id in the newest turns; an unknown or malformed id is not found', async () => {
    const f = fixture(ws => [share(['out/report.pdf', 'out/notes.md'], { cwd: ws })])
    const [t] = await f.turns()
    const got = await f.service.fileContent('claude', 'session', t.outputFiles![0].id)
    expect(got).toMatchObject({ status: 'ok', name: 'report.pdf', kind: 'pdf' })
    expect((got as any).bytes.toString()).toBe('%PDF-1.7 bytes')
    expect((await f.service.fileContent('claude', 'session', 'af_' + 'c'.repeat(64))).status).toBe('not_found')
    expect((await f.service.fileContent('claude', 'session', 'ai_' + 'c'.repeat(64))).status).toBe('not_found')
    expect((await f.service.fileContent('claude', 'nope', t.outputFiles![0].id)).status).toBe('not_found')
  })
  it('a file swapped for a link after it was listed is refused', async () => {
    const f = fixture(ws => [share(['out/notes.md'], { cwd: ws })])
    const [t] = await f.turns()
    rmSync(join(f.workspace, 'out', 'notes.md'))
    symlinkSync(join(f.root, 'secret.pdf'), join(f.workspace, 'out', 'notes.md'))
    expect((await f.service.fileContent('claude', 'session', t.outputFiles![0].id)).status).not.toBe('ok')
  })
  it('a file over the cap is too large, not read', async () => {
    const f = fixture(ws => { writeFileSync(join(ws, 'out', 'big.csv'), Buffer.alloc(MAX_SHARED_FILE_BYTES + 1)); return [share(['out/big.csv'], { cwd: ws })] })
    const [t] = await f.turns()
    expect((await f.service.fileContent('claude', 'session', t.outputFiles![0].id)).status).toBe('too_large')
  })
  it('a sent image goes through the normalizing image route, from its canonical path', async () => {
    const f = fixture(ws => [share([join(ws, 'out', 'shot.png')], { cwd: ws })])
    const [t] = await f.turns()
    expect((await f.service.content('claude', 'session', t.outputImages![0].id, 'thumb')).status).toBe('ok')
    expect((f.ingest.mock.calls[0][0] as any).bytes.toString()).toBe('png bytes')
  })
})

describe('headers: HTML is never served as a page of this origin', () => {
  it('HTML: octet-stream, attachment, sandbox CSP; PDF: inline PDF; text: plain; every response nosniff and no-store', () => {
    const html = sharedFileHeaders('page.html', 'html')
    expect(html['Content-Type']).toBe('application/octet-stream')
    expect(html['Content-Disposition']).toMatch(/^attachment; filename="page.html"/)
    expect(html['Content-Security-Policy']).toBe("sandbox; default-src 'none'")
    const pdf = sharedFileHeaders('report.pdf', 'pdf')
    expect(pdf['Content-Type']).toBe('application/pdf')
    expect(pdf['Content-Disposition']).toMatch(/^inline; /)
    expect(sharedFileHeaders('n.md', 'text')['Content-Type']).toBe('text/plain; charset=utf-8')
    expect(sharedFileHeaders('a.gif', 'image')['Content-Type']).toBe('image/gif')
    expect(sharedFileHeaders('s.svg', 'text')['Content-Type']).toBe('text/plain; charset=utf-8')
    for (const h of [html, pdf]) { expect(h['X-Content-Type-Options']).toBe('nosniff'); expect(h['Cache-Control']).toBe('private, no-store') }
  })
  it('a filename cannot break the header: quotes, newlines and non-ASCII are replaced, the real name rides in filename*', () => {
    const h = sharedFileHeaders('a"b\r\nX: y é.pdf', 'pdf')['Content-Disposition']
    expect(h).not.toMatch(/[\r\n]/)
    expect(h).toContain('filename="a_b__X_ y _.pdf"')
    expect(h).toContain("filename*=UTF-8''" + encodeURIComponent('a"b\r\nX: y é.pdf'))
  })
  it('the route sends those headers and the bytes', async () => {
    const f = fixture(ws => [share(['out/page.html'], { cwd: ws })])
    const [t] = await f.turns()
    const mod = await import('./agent-session-output-images.js')
    const spy = vi.spyOn(mod.agentSessionOutputImages, 'fileContent').mockImplementation((p, s, id) => f.service.fileContent(p, s, id))
    const { agentSessionsRouter } = await import('../routes/agent-sessions.js')
    const app = express(); app.use('/api', agentSessionsRouter)
    const server = app.listen(0, '127.0.0.1')
    try {
      await new Promise(r => server.once('listening', r))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-sessions/claude/session/output-files/`
      const res = await fetch(base + t.outputFiles![0].id + '/content')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
      expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
      expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await res.text()).toBe('<script>alert(1)</script><h1>Hi</h1>')
      expect((await fetch(base + 'af_' + 'd'.repeat(64) + '/content')).status).toBe(404)
      expect((await fetch(base.replace('/claude/', '/nobody/') + t.outputFiles![0].id + '/content')).status).toBe(404)
    } finally { server.close(); spy.mockRestore() }
  })
})
