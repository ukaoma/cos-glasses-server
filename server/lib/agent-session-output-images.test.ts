import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { AgentSessionOutputImages, assistantImageCandidates, broadWorkspaceRoots, OUTPUT_IMAGES_PER_TURN, OUTPUT_IMAGE_CONCURRENCY, OUTPUT_IMAGE_SCAN_CHARS, SESSION_OUTPUT_IMAGE_ID } from './agent-session-output-images.js'
import { MAX_OUTPUT_ARTIFACT_BYTES } from './image-safety.js'
import { readRecentSessionTurns, recentSessionTurns, SESSION_TURNS_MAX } from './agent-session-turns.js'
import type { AgentProvider } from './agent-session-store.js'

const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
const row = (text: string, provider: AgentProvider = 'claude') => provider === 'claude'
  ? { type: 'assistant', timestamp: '2026-11-07T12:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } }
  : provider === 'codex' ? { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }
    : { role: 'assistant', message: { content: [{ type: 'text', text }] } }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cos-out-'))); roots.push(root)
  const workspace = join(root, 'repo'); mkdirSync(workspace)
  const transcript = join(root, 'session.jsonl'), artifact = join(workspace, 'result image.png')
  writeFileSync(artifact, 'test bytes')
  writeFileSync(transcript, JSON.stringify(row(`![Result](<${artifact}>)`)) + '\n')
  const normalized = join(root, 'normalized.jpg'); writeFileSync(normalized, 'normalized bytes')
  let now = 1
  const ingest = vi.fn(async (_input: unknown) => ({ id: 'm_' + 'a'.repeat(24) }))
  const store = { ingestOutputImage: ingest, getContent: vi.fn(() => ({ status: 'ok' as const, path: normalized, mime: 'image/jpeg' as const, bytes: 16 })) }
  const deps = {
    findSession: async (_p: AgentProvider, id: string) => id === 'session' || id === 'other' ? transcript : null,
    workspace: async () => workspace, secret: Buffer.alloc(32, 7), now: () => now,
    store: () => store as unknown as ReturnType<typeof import('./media-store.js').getMediaStore>,
  }
  const service = new AgentSessionOutputImages(deps)
  const preview = async (provider: AgentProvider = 'claude') => {
    const ctx = await service.context(provider, 'session', transcript)
    return (await readRecentSessionTurns(provider, transcript, 6, undefined, ctx.project)).turns
  }
  return { root, workspace, transcript, artifact, normalized, service, deps, store, ingest, preview, advance: () => { now += 4 * 60 * 60_000 } }
}

describe('explicit assistant output image extraction', () => {
  it.each<AgentProvider>(['claude', 'codex', 'cursor'])('extracts only Markdown images from %s assistant records', provider => {
    expect(assistantImageCandidates(provider, row('Text ![Result](<output image.png>) ![Chart](charts/a(1).png)', provider))).toEqual([
      { source: 'output image.png', label: 'Result' }, { source: 'charts/a(1).png', label: 'Chart' },
    ])
  })
  it('does not scan user, tool, sidechain, meta, HTML, code, arbitrary links or remote bytes', () => {
    expect(assistantImageCandidates('claude', { ...row('![x](secret.png)'), type: 'user' })).toEqual([])
    expect(assistantImageCandidates('claude', { ...row('![x](secret.png)'), isSidechain: true })).toEqual([])
    expect(assistantImageCandidates('claude', { ...row('![x](secret.png)'), isMeta: true })).toEqual([])
    expect(assistantImageCandidates('codex', { type: 'response_item', payload: { type: 'function_call_output', output: '![x](secret.png)' } })).toEqual([])
    const raw = '[file](secret.png) secret.png <img src="secret.png">\n`![x](secret.png)`\n```md\n![x](secret.png)\n```\n![a](https://example.com/a.png) ![b](data:image/png;base64,aaa) ![c](file:///secret.png) ![d](//host/a.png)'
    expect(assistantImageCandidates('claude', row(raw))).toEqual([])
  })
  it.each<AgentProvider>(['claude', 'codex', 'cursor'])('keeps indented examples and HTML comments inert for %s', provider => {
    const raw = [
      '    ![Example](private-example.png)', '\t![Example](tab-example.png)',
      '  \t![Example](mixed-example.png)', '<!-- ![Hidden](private-comment.png)',
      '![Hidden](multiline-comment.png) -->', '![Visible](visible.png)',
      '<!-- unclosed ![Hidden](unclosed.png)',
    ].join('\n')
    expect(assistantImageCandidates(provider, row(raw, provider))).toEqual([{ source: 'visible.png', label: 'Visible' }])
  })
  it('preserves code indentation across text blocks and string payloads', () => {
    const content = [{ type: 'text', text: 'Introduction' }, { type: 'text', text: '    ![Example](private.png)' }]
    expect(assistantImageCandidates('claude', { type: 'assistant', message: { content } })).toEqual([])
    expect(assistantImageCandidates('claude', { type: 'assistant', message: { content: '\t![Example](private.png)' } })).toEqual([])
  })
  it('honors the scan boundary without interpreting incomplete image syntax', () => {
    const token = '![End](end.png)'
    expect(assistantImageCandidates('claude', row('x'.repeat(OUTPUT_IMAGE_SCAN_CHARS - token.length) + token))).toEqual([{ source: 'end.png', label: 'End' }])
    expect(assistantImageCandidates('claude', row('x'.repeat(OUTPUT_IMAGE_SCAN_CHARS - token.length + 1) + token))).toEqual([])
  })
  it('bounds image count and accepts escaped syntax as literal', () => {
    expect(assistantImageCandidates('claude', row('\\![literal](secret.png)'))).toEqual([])
    expect(assistantImageCandidates('claude', row(Array.from({ length: OUTPUT_IMAGES_PER_TURN + 4 }, (_, i) => `![x](${i}.png)`).join(' ')))).toHaveLength(OUTPUT_IMAGES_PER_TURN)
  })
})

describe('workspace-scoped native image projection and serving', () => {
  it('preserves image-only turns, redacts local image paths, and leaves default parser callers unchanged', async () => {
    const f = fixture(), turns = await f.preview()
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe('[Output image]')
    expect(turns[0].outputImages?.[0]).toMatchObject({ label: 'Result', state: 'available' })
    expect(turns[0].outputImages?.[0].id).toMatch(SESSION_OUTPUT_IMAGE_ID)
    expect(JSON.stringify(turns)).not.toContain(f.workspace)
    expect(recentSessionTurns('claude', [JSON.stringify(row(`![x](${f.artifact})`))], 1)[0]).not.toHaveProperty('outputImages')
  })
  it('redacts every explicit local image after the preview cap without granting extra image ids', async () => {
    const f = fixture()
    const sources = Array.from({ length: OUTPUT_IMAGES_PER_TURN + 4 }, (_, i) => join(f.workspace, `private-${i}.png`))
    const ctx = await f.service.context('claude', 'session', f.transcript)
    const projected = ctx.project('claude', row(sources.map(path => `![Result](<${path}>)`).join(' ')), null)!
    expect(projected.outputImages).toHaveLength(OUTPUT_IMAGES_PER_TURN)
    expect(ctx.sources.size).toBe(OUTPUT_IMAGES_PER_TURN)
    expect(projected.text).toBe(sources.map(() => '[Output image]').join(' '))
    for (const path of sources) expect(JSON.stringify(projected)).not.toContain(path)
  })
  it.each(['whitespace', 'fenced'])('never displays an unscanned image after a %s prefix', async kind => {
    const f = fixture(), ctx = await f.service.context('claude', 'session', f.transcript)
    const prefix = kind === 'whitespace' ? '\n'.repeat(OUTPUT_IMAGE_SCAN_CHARS)
      : '![Visible](visible.png)\n```\n' + 'code\n'.repeat(Math.ceil(OUTPUT_IMAGE_SCAN_CHARS / 5)) + '```\n'
    const raw = prefix + `![Private](<${f.artifact}>)`
    const parsed = recentSessionTurns('claude', [JSON.stringify(row(raw))], 1)[0]
    const projected = ctx.project('claude', row(raw), parsed)!
    expect(projected.text).toContain('[Reply shortened at the image preview scan limit.]')
    expect(JSON.stringify(projected)).not.toContain(f.artifact)
    expect(projected.outputImages).toHaveLength(kind === 'fenced' ? 1 : 0)
  })
  it('drops the entire boundary line, including a partially scanned destination, and marks plain prose truncation', async () => {
    const f = fixture(), ctx = await f.service.context('claude', 'session', f.transcript)
    const before = 'Complete line\n' + 'x'.repeat(OUTPUT_IMAGE_SCAN_CHARS - 30)
    const raw = before + '![Private](/private/very-long-sensitive-destination.png)'
    const projected = ctx.project('claude', row(raw), null)!
    expect(projected.text).toBe('Complete line\n[Reply shortened at the image preview scan limit.]')
    expect(projected.outputImages).toHaveLength(0)
    const plain = ctx.project('claude', row('p'.repeat(OUTPUT_IMAGE_SCAN_CHARS + 1)), null)!
    expect(plain.text).toBe('[Reply shortened at the image preview scan limit.]')
    const exact = ctx.project('claude', row('p'.repeat(OUTPUT_IMAGE_SCAN_CHARS)), { role: 'assistant', text: 'ordinary shaped prose' })!
    expect(exact.text).toBe('ordinary shaped prose')
  })
  it('redacts image destinations before the normal text truncation boundary', async () => {
    const f = fixture()
    writeFileSync(f.transcript, JSON.stringify(row('x'.repeat(3980) + `![Result](<${f.artifact}>)`)) + '\n')
    const turns = await f.preview()
    expect(JSON.stringify(turns)).not.toContain(f.workspace)
    expect(turns[0].outputImages).toHaveLength(1)
  })
  it('does not block on a FIFO and does not serve an image after it leaves the recent window', async () => {
    const f = fixture()
    const fifo = join(f.workspace, 'fifo.png'); execFileSync('/usr/bin/mkfifo', [fifo])
    writeFileSync(f.transcript, JSON.stringify(row('![x](fifo.png)')) + '\n')
    const id = (await f.preview())[0].outputImages![0].id
    expect((await f.service.content('claude', 'session', id, 'phone')).status).toBe('unavailable')
    writeFileSync(f.transcript, [JSON.stringify(row('![x](fifo.png)')), ...Array.from({ length: SESSION_TURNS_MAX }, (_, i) => JSON.stringify(row('Later ' + i)))].join('\n') + '\n')
    expect((await f.service.content('claude', 'session', id, 'phone')).status).toBe('not_found')
    expect(f.ingest).not.toHaveBeenCalled()
  })
  it('normalizes selected bytes once for thumb/full and never invents COS association', async () => {
    const f = fixture(), id = (await f.preview())[0].outputImages![0].id
    const first = await f.service.content('claude', 'session', id, 'thumb')
    const next = await f.service.content('claude', 'session', id, 'phone')
    expect(first.status).toBe('ok'); expect(next.status).toBe('ok')
    expect(f.ingest).toHaveBeenCalledTimes(1)
    expect(f.ingest.mock.calls[0][0]).toEqual({ bytes: Buffer.from('test bytes'), kind: 'generated_visual', label: 'Result' })
    f.advance()
    await f.service.content('claude', 'session', id, 'phone')
    expect(f.ingest).toHaveBeenCalledTimes(2)
  })
  it('reauthorizes exact session/provider/record membership and process-scoped ids', async () => {
    const f = fixture(), id = (await f.preview())[0].outputImages![0].id
    expect((await f.service.content('claude', 'other', id, 'phone')).status).toBe('not_found')
    expect((await f.service.content('codex', 'session', id, 'phone')).status).toBe('not_found')
    expect((await f.service.content('claude', 'session', 'ai_' + '0'.repeat(64), 'phone')).status).toBe('not_found')
    const restarted = new AgentSessionOutputImages({ ...f.deps, secret: Buffer.alloc(32, 8) })
    expect((await restarted.content('claude', 'session', id, 'phone')).status).toBe('not_found')
    writeFileSync(f.transcript, JSON.stringify(row('No longer selected')) + '\n')
    expect((await f.service.content('claude', 'session', id, 'phone')).status).toBe('not_found')
    expect(f.ingest).not.toHaveBeenCalled()
  })
  it('refuses traversal, symlinks, missing files, and broad or missing workspaces', async () => {
    const f = fixture(), outside = join(f.root, 'private.png'); writeFileSync(outside, 'private')
    for (const source of ['../private.png', outside]) {
      writeFileSync(f.transcript, JSON.stringify(row(`![x](${source})`)) + '\n')
      const image = (await f.preview())[0].outputImages![0]
      expect(image.state).toBe('unavailable')
      expect((await f.service.content('claude', 'session', image.id, 'phone')).status).toBe('unavailable')
    }
    symlinkSync(outside, join(f.workspace, 'link.png'))
    for (const source of ['link.png', 'missing.png']) {
      writeFileSync(f.transcript, JSON.stringify(row(`![x](${source})`)) + '\n')
      const image = (await f.preview())[0].outputImages![0]
      expect((await f.service.content('claude', 'session', image.id, 'phone')).status).toBe('unavailable')
    }
    for (const root of ['/', homedir(), null]) {
      const service = new AgentSessionOutputImages({ ...f.deps, workspace: async () => root })
      const ctx = await service.context('claude', 'session', f.transcript)
      const t = ctx.project('claude', row('![x](a.png)'), null)
      expect(t?.outputImages?.[0].state).toBe('unavailable')
    }
    expect(f.ingest).not.toHaveBeenCalled()
  })
  it('denies exact broad roots (home, ~/Documents, ~/Library, ~/.cos-glasses, /Volumes) but allows their subfolders', async () => {
    const f = fixture(), home = join(f.root, 'home')
    const project = join(home, 'Documents', 'GitHub', 'x')
    for (const dir of [join(home, 'Library'), join(home, '.cos-glasses'), join(home, 'Desktop'), project]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(project, 'a.png'), 'project bytes')
    const descriptor = async (root: string | null) => {
      const service = new AgentSessionOutputImages({ ...f.deps, workspace: async () => root, home: () => home })
      const ctx = await service.context('claude', 'session', f.transcript)
      return ctx.project('claude', row('![x](a.png)'), null)?.outputImages?.[0]
    }
    const denied = [home, join(home, 'Documents'), join(home, 'Library'), join(home, '.cos-glasses'), '/', ...(existsSync('/Volumes') ? ['/Volumes'] : [])]
    for (const root of denied) {
      expect(broadWorkspaceRoots(home).has(realpathSync(root))).toBe(true)
      expect(await descriptor(root)).toMatchObject({ state: 'unavailable', reason: 'outside_workspace' })
    }
    // Exact-root denial only: a project inside ~/Documents, and an unlisted sibling, stay eligible.
    expect(await descriptor(project)).toMatchObject({ state: 'available' })
    expect((await descriptor(project))?.reason).toBeUndefined()
    expect(await descriptor(join(home, 'Desktop'))).toMatchObject({ state: 'available' })
    expect(broadWorkspaceRoots(home).has(join(home, 'Documents', 'GitHub'))).toBe(false)
  })
  it('a failed workspace lookup is temporarily unavailable (retryable), not outside the workspace', async () => {
    const f = fixture()
    for (const workspace of [async () => null, async () => { throw new Error('lookup failed') }, async () => join(f.root, 'gone')]) {
      const service = new AgentSessionOutputImages({ ...f.deps, workspace })
      const ctx = await service.context('claude', 'session', f.transcript)
      expect(ctx.project('claude', row('![x](a.png)'), null)?.outputImages?.[0]).toMatchObject({ state: 'unavailable', reason: 'unavailable' })
    }
  })
  it('bounds reads before normalization and fails closed on the normalizer error', async () => {
    const f = fixture(), id = (await f.preview())[0].outputImages![0].id
    truncateSync(f.artifact, MAX_OUTPUT_ARTIFACT_BYTES + 1)
    expect((await f.service.content('claude', 'session', id, 'phone')).status).toBe('unavailable')
    expect(f.ingest).not.toHaveBeenCalled()
    writeFileSync(f.artifact, 'not an image')
    f.ingest.mockRejectedValueOnce(new Error('unsupported_format private source path'))
    expect(await f.service.content('claude', 'session', id, 'phone')).toEqual({ status: 'unavailable' })
  })
  it('admits requests before session discovery and releases admission on lookup failure', async () => {
    const f = fixture(), id = (await f.preview())[0].outputImages![0].id
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const findSession = vi.fn(async () => { await blocked; return null as string | null })
    const workspace = vi.fn(f.deps.workspace)
    const service = new AgentSessionOutputImages({ ...f.deps, findSession, workspace })
    const requests = Array.from({ length: OUTPUT_IMAGE_CONCURRENCY }, () => service.content('claude', 'session', id, 'thumb'))
    expect(findSession).toHaveBeenCalledTimes(OUTPUT_IMAGE_CONCURRENCY)
    expect(await service.content('claude', 'session', id, 'phone')).toEqual({ status: 'busy' }) // 7.0.4 QA: a full reader is busy, not unavailable
    expect(findSession).toHaveBeenCalledTimes(OUTPUT_IMAGE_CONCURRENCY)
    expect(workspace).not.toHaveBeenCalled()
    release()
    expect((await Promise.all(requests)).every(result => result.status === 'not_found')).toBe(true)
    findSession.mockRejectedValueOnce(new Error('lookup failed'))
    expect(await service.content('claude', 'session', id, 'phone')).toEqual({ status: 'unavailable' })
    findSession.mockResolvedValue(f.transcript)
    expect((await service.content('claude', 'session', id, 'phone')).status).toBe('ok')
    expect(workspace).toHaveBeenCalledTimes(1)
  })
  it('deduplicates concurrent normalization and invalidates cached bytes when source changes', async () => {
    const f = fixture(), id = (await f.preview())[0].outputImages![0].id
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    f.ingest.mockImplementationOnce(async () => { await blocked; return { id: 'm_' + 'a'.repeat(24) } })
    const a = f.service.content('claude', 'session', id, 'thumb'), b = f.service.content('claude', 'session', id, 'phone')
    await vi.waitFor(() => expect(f.ingest).toHaveBeenCalledTimes(1))
    // Two source reads/normalization requests are the process-wide memory ceiling.
    expect((await f.service.content('claude', 'session', id, 'phone')).status).toBe('busy')
    release(); expect((await a).status).toBe('ok'); expect((await b).status).toBe('ok')
    writeFileSync(f.artifact, 'different bytes')
    await f.service.content('claude', 'session', id, 'phone')
    expect(f.ingest).toHaveBeenCalledTimes(2)
  })
})

// QA 7.0.5: a preview read that threw answers why as a code the route logs, never the error's message (it carries a path).
describe('7.0.5 QA: previewFile failures carry a code', () => {
  it('a thrown read is unavailable with reason error_<code>, and the message never comes back', async () => {
    const f = fixture()
    const findSession = vi.fn(async () => { throw Object.assign(new Error(`EACCES: permission denied, open '${f.transcript}'`), { code: 'EACCES' }) })
    const service = new AgentSessionOutputImages({ ...f.deps, findSession })
    const got = await service.previewFile('claude', 'session', 'al_' + 'a'.repeat(64))
    expect(got).toEqual({ status: 'unavailable', reason: 'error_EACCES' })
    expect(JSON.stringify(got)).not.toContain(f.root)
  })
})
