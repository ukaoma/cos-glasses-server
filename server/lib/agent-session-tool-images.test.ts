/**
 * Images a session looked at (tool results) and images attached to prompts, in the reader. Miles, 11/08: the Claude app
 * shows the image a Read of a PNG returned, labelled "Read" and "1 of 2"; Control Web showed only words. Fixtures are
 * written by hand from the record shapes found on this Mac (shapes only, no real content).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSessionOutputImages, SESSION_OUTPUT_FILE_ID, SESSION_OUTPUT_IMAGE_ID } from './agent-session-output-images.js'
import {
  decodeToolImage, estimateBytes, MAX_TOOL_IMAGE_BYTES, promptImages, SESSION_TOOL_IMAGE_ID, sniffImageType, TOOL_IMAGES_PER_TURN,
  toolLabel, toolResultImages, toolUsesOf,
} from './agent-session-tool-images.js'
import { readRecentSessionTurns } from './agent-session-turns.js'
import { withoutPreviews } from './session-files-setting.js'
import type { AgentProvider } from './agent-session-store.js'

const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png fixture')])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg fixture')])
const GIF = Buffer.from('GIF89a gif fixture')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 fixture')])
const b64 = (b: Buffer) => b.toString('base64')
let n = 0
const at = () => `2026-11-08T10:${String(10 + (n % 40)).padStart(2, '0')}:00Z`
const said = (text: string) => ({ type: 'assistant', uuid: 'a' + ++n, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const use = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'assistant', uuid: 'a' + ++n, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const image = (bytes: Buffer, media = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: media, data: b64(bytes) } })
/** A Read of an image: the message block AND the row's own result record, as Claude Code writes them. */
const readResult = (id: string, bytes: Buffer, media = 'image/png') => ({
  type: 'user', uuid: 'r' + ++n, timestamp: at(), sourceToolAssistantUUID: 'x',
  toolUseResult: { type: 'image', file: { base64: b64(bytes), type: media, originalSize: bytes.length, dimensions: { originalWidth: 2, originalHeight: 2, displayWidth: 2, displayHeight: 2 } } },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [image(bytes, media)] }] },
})
/** A browser or computer-use screenshot: text blocks and an image block in one tool result. */
const shotResult = (id: string, bytes: Buffer, media = 'image/jpeg') => ({
  type: 'user', uuid: 'r' + ++n, timestamp: at(),
  toolUseResult: [{ type: 'text', text: 'Clicked' }, image(bytes, media)],
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'Clicked' }, image(bytes, media), { type: 'text', text: 'tab 1' }] }] },
})
const prompt = (text: string, images: Buffer[], extra: Record<string, unknown> = {}) => ({
  type: 'user', uuid: 'p' + ++n, timestamp: at(), promptId: 'pr' + n, ...extra,
  message: { role: 'user', content: [...images.map(b => image(b)), ...(text ? [{ type: 'text', text }] : [])] },
})
const codex = (payload: Record<string, unknown>) => ({ type: 'response_item', timestamp: at(), payload })
const dataUrl = (b: Buffer, media = 'image/png') => `data:${media};base64,${b64(b)}`

function fixture(rows: (ws: string, root: string) => unknown[], opts: { provider?: AgentProvider; workspace?: (ws: string, root: string) => string | null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cos-tool-img-'))); roots.push(root)
  const workspace = join(root, 'repo'); mkdirSync(join(workspace, 'out'), { recursive: true })
  writeFileSync(join(workspace, 'out', 'shot.png'), PNG)
  writeFileSync(join(workspace, 'out', 'report.pdf'), '%PDF-1.7 bytes')
  writeFileSync(join(root, 'secret.png'), PNG)
  const transcript = join(root, 'session.jsonl')
  writeFileSync(transcript, rows(workspace, root).map(r => JSON.stringify(r)).join('\n') + '\n')
  const normalized = join(root, 'normalized.jpg'); writeFileSync(normalized, 'jpeg')
  const ingest = vi.fn(async (_input: unknown) => ({ id: 'm_' + 'b'.repeat(24) }))
  const store = { ingestOutputImage: ingest, getContent: vi.fn(() => ({ status: 'ok' as const, path: normalized, mime: 'image/jpeg' as const, bytes: 4 })) }
  const lookups: string[] = []
  const service = new AgentSessionOutputImages({
    findSession: async (_p: AgentProvider, id: string) => { lookups.push(id); return id === 'session' ? transcript : null },
    workspace: async () => (opts.workspace ? opts.workspace(workspace, root) : workspace), secret: Buffer.alloc(32, 7), now: () => 1,
    store: () => store as unknown as ReturnType<typeof import('./media-store.js').getMediaStore>,
    home: () => join(root, 'home'),
  })
  const provider = opts.provider ?? 'claude'
  const turns = async (limit = 10) => {
    const ctx = await service.context(provider, 'session', transcript)
    return { turns: (await readRecentSessionTurns(provider, transcript, limit, undefined, ctx.project)).turns, ctx }
  }
  return { root, workspace, transcript, service, store, ingest, turns, lookups, provider }
}

describe('finding the images in the record shapes', () => {
  it('a Read of a PNG and a browser screenshot are tool-result images; labels follow the Claude app', () => {
    const uses = new Map(toolUsesOf('claude', use('t1', 'Read', { file_path: '/x/a.png' })).concat(toolUsesOf('claude', use('t2', 'mcp__Claude_Browser__computer'))))
    expect(uses.get('t1')).toEqual({ name: 'Read', path: '/x/a.png' })
    expect(toolResultImages('claude', readResult('t1', PNG), uses).map(f => [f.tool, f.ref.kind])).toEqual([['Read', 'embedded']])
    expect(toolResultImages('claude', shotResult('t2', JPEG), uses).map(f => [f.tool, f.ref.kind, (f.ref as any).mediaType])).toEqual([['Screenshot', 'embedded', 'image/jpeg']])
    for (const name of ['mcp__claude-in-chrome__browser_batch', 'mcp__computer-use__app_screenshot', 'mcp__Claude_Preview__preview_screenshot', 'mcp__computer-use__app_zoom']) expect(toolLabel(name), name).toBe('Screenshot')
    expect(toolLabel('Bash')).toBe('Image'); expect(toolLabel(undefined)).toBe('Image')
  })
  it('a sub-agent result, an unsafe declared type, a remote URL and a prompt row are not tool-result images', () => {
    const uses = new Map([['t1', { name: 'Read' }]])
    expect(toolResultImages('claude', { ...readResult('t1', PNG), isSidechain: true }, uses)).toEqual([])
    const svg = shotResult('t1', PNG); (svg.message.content[0].content[1] as any).source.media_type = 'image/svg+xml'
    expect(toolResultImages('claude', svg, uses)).toEqual([])
    expect(toolResultImages('claude', prompt('hi', [PNG]), uses)).toEqual([])
    expect(toolResultImages('codex', codex({ type: 'function_call_output', call_id: 'c', output: [{ type: 'input_image', image_url: 'https://evil.invalid/a.png' }] }), uses)).toEqual([])
  })
  it('a Read whose message block has no bytes falls back to its own result record, then to its path, then says missing', () => {
    const uses = new Map([['t1', { name: 'Read', path: '/w/out/shot.png' }]])
    const row = readResult('t1', PNG); row.message.content[0].content = []
    expect(toolResultImages('claude', row, uses)[0].ref).toMatchObject({ kind: 'embedded', mediaType: 'image/png' })
    ;(row.toolUseResult.file as any).base64 = ''
    expect(toolResultImages('claude', row, uses)[0].ref).toEqual({ kind: 'path', path: '/w/out/shot.png' })
    expect(toolResultImages('claude', row, new Map([['t1', { name: 'Read', path: '/w/out/notes.md' }]]))[0].ref).toEqual({ kind: 'missing' })
    expect(toolResultImages('claude', { ...row, message: { role: 'user', content: [{ ...row.message.content[0], is_error: true }] } }, uses), 'a failed Read').toEqual([])
  })
  it('prompt attachments: Claude base64 blocks and Codex input_image data URLs; never a meta, sidechain or tool-result row', () => {
    expect(promptImages('claude', prompt('look', [PNG, JPEG])).length).toBe(2)
    expect(promptImages('claude', prompt('look', [PNG], { isMeta: true }))).toEqual([])
    expect(promptImages('claude', prompt('look', [PNG], { isSidechain: true }))).toEqual([])
    expect(promptImages('claude', readResult('t1', PNG))).toEqual([])
    const user = codex({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: dataUrl(PNG), detail: 'high' }] })
    expect(promptImages('codex', user)).toEqual([{ kind: 'embedded', mediaType: 'image/png', data: b64(PNG) }])
  })
  it('sniffing decides the served type, never the declared one; the cap is checked before decoding', () => {
    expect([PNG, JPEG, GIF, WEBP].map(sniffImageType)).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    expect(sniffImageType(Buffer.from('<svg onload=alert(1)>'))).toBeNull()
    expect(decodeToolImage({ mediaType: 'image/png', data: b64(JPEG) })).toMatchObject({ status: 'ok', type: 'image/jpeg' })
    expect(decodeToolImage({ mediaType: 'image/png', data: b64(Buffer.from('<html>')) })).toEqual({ status: 'unavailable' })
    const from = vi.spyOn(Buffer, 'from')
    const big = 'A'.repeat(Math.ceil((MAX_TOOL_IMAGE_BYTES + 3) / 3) * 4)
    expect(estimateBytes(big)).toBeGreaterThan(MAX_TOOL_IMAGE_BYTES)
    expect(decodeToolImage({ mediaType: 'image/png', data: big })).toEqual({ status: 'too_large' })
    expect(from.mock.calls.some(c => c[0] === big), 'an over-cap image is never decoded').toBe(false)
    from.mockRestore()
  })
})

describe('the reader shows them at the step where they happened', () => {
  it('growing transcript windows keep an opening tool image on the first reply and authorize its content', async () => {
    const f = fixture(() => [use('opening-read', 'Read'), readResult('opening-read', PNG), said('First reply.'),
      { type: 'progress', padding: 'x'.repeat(2 * 1024 * 1024 + 1024) }, said('Last reply.')])
    const { turns } = await f.turns()
    expect(turns.map(t => t.text)).toEqual(['First reply.', 'Last reply.'])
    expect(turns[0].toolImages, 'the small pass must not retain Last reply as the image target').toHaveLength(1)
    expect(turns[0].toolImages![0].before).toBe(true)
    expect(turns[1].toolImages).toBeUndefined()
    const id = turns[0].toolImages![0].id
    expect(await f.service.toolImageContent('claude', 'session', id)).toMatchObject({ status: 'ok' })
  })
  it('a step of a Read and a screenshot rides on the words before it: Read 1 of 2, Screenshot 2 of 2; no path or bytes travel', async () => {
    const f = fixture(ws => [prompt('Check the render', []), said('Looking at it.'), use('t1', 'Read', { file_path: join(ws, 'out', 'shot.png') }), readResult('t1', PNG),
      use('t2', 'mcp__Claude_Browser__computer'), shotResult('t2', JPEG), said('It looks right.')])
    const { turns } = await f.turns()
    expect(turns.map(t => [t.role, t.text])).toEqual([['user', 'Check the render'], ['assistant', 'Looking at it.'], ['assistant', 'It looks right.']])
    const step = turns[1].toolImages!
    expect(step.map(i => [i.tool, i.index, i.total, i.state, i.before])).toEqual([['Read', 1, 2, 'available', undefined], ['Screenshot', 2, 2, 'available', undefined]])
    for (const i of step) expect(SESSION_TOOL_IMAGE_ID.test(i.id)).toBe(true)
    expect(turns[2].toolImages).toBeUndefined()
    const json = JSON.stringify(turns)
    expect(json, 'no Mac path').not.toContain(f.root)
    expect(json, 'no base64').not.toContain(b64(PNG)); expect(json).not.toContain(b64(JPEG))
  })
  it('a reply that opens with tool calls: the step waits for its words and is marked before', async () => {
    const f = fixture(() => [prompt('Look', []), use('t1', 'Read', { file_path: '/x/a.png' }), readResult('t1', PNG), said('Here is what I saw.')])
    const { turns } = await f.turns()
    expect(turns[1].toolImages!.map(i => [i.tool, i.index, i.total, i.before])).toEqual([['Read', 1, 1, true]])
  })
  it('a step that never got words before the next prompt is not pinned on the person', async () => {
    const f = fixture(() => [prompt('Look', []), use('t1', 'Read'), readResult('t1', PNG), prompt('Stop', []), said('Stopped.')])
    const { turns } = await f.turns()
    expect(turns.map(t => t.text)).toEqual(['Look', 'Stop', 'Stopped.'])
    expect(turns.every(t => !t.toolImages), 'nor carried past the prompt onto the next reply').toBe(true)
  })
  it('a long step: the first six get thumbnails, the rest are counted as more; totals count them all', async () => {
    const f = fixture(() => [said('Checking.'), ...Array.from({ length: TOOL_IMAGES_PER_TURN + 3 }, (_, i) => [use('s' + i, 'mcp__claude-in-chrome__computer'), shotResult('s' + i, JPEG)]).flat()])
    const { turns } = await f.turns()
    expect(turns[0].toolImages).toHaveLength(TOOL_IMAGES_PER_TURN)
    expect(turns[0].toolImagesMore).toBe(3)
    expect(turns[0].toolImages!.map(i => `${i.index} of ${i.total}`)).toEqual(['1 of 9', '2 of 9', '3 of 9', '4 of 9', '5 of 9', '6 of 9'])
  })
  it('images attached to a prompt show on the YOU turn as Attached; an image-only prompt reads [Image]', async () => {
    const f = fixture(() => [prompt('What is wrong here?', [PNG, JPEG]), said('The margin.'), prompt('', [PNG])])
    const { turns } = await f.turns()
    expect(turns[0].toolImages!.map(i => [i.tool, i.index, i.total])).toEqual([['Attached', 1, 2], ['Attached', 2, 2]])
    expect(turns[2]).toMatchObject({ role: 'user', text: '[Image]' })
    expect(turns[2].toolImages).toHaveLength(1)
    // A filtered prompt (a wrapper or an interrupt marker) stays filtered even with an image in it.
    const g = fixture(() => [prompt('[Request interrupted by user]', [PNG])])
    expect((await g.turns()).turns).toEqual([])
  })
  it('an over-cap image is listed as too large and never decoded or held', async () => {
    const big = Buffer.alloc(MAX_TOOL_IMAGE_BYTES + 16, 0x41)
    const f = fixture(() => [said('Big one.'), use('t1', 'Read', { file_path: '/x/big.png' }), readResult('t1', big)])
    const { turns } = await f.turns()
    expect(turns[0].toolImages![0]).toMatchObject({ state: 'unavailable', reason: 'too_large' })
    expect((await f.service.toolImageContent('claude', 'session', turns[0].toolImages![0].id)).status).toBe('too_large')
  })
  it('a path-only Read: inside the workspace it is served through the normalizer; outside or a broad root, not available; missing bytes say so', async () => {
    const pathOnly = (id: string) => { const r = readResult(id, PNG); r.message.content[0].content = []; (r.toolUseResult.file as any).base64 = ''; return r }
    const f = fixture((ws, root) => [said('Reading.'), use('t1', 'Read', { file_path: join(ws, 'out', 'shot.png') }), pathOnly('t1'),
      use('t2', 'Read', { file_path: join(root, 'secret.png') }), pathOnly('t2'), use('t3', 'Read', { file_path: join(ws, 'out', 'notes.txt') }), pathOnly('t3')])
    const { turns } = await f.turns()
    expect(turns[0].toolImages!.map(i => [i.state, i.reason])).toEqual([['available', undefined], ['unavailable', 'outside_workspace'], ['unavailable', 'missing']])
    const served = await f.service.toolImageContent('claude', 'session', turns[0].toolImages![0].id)
    expect(served).toMatchObject({ status: 'ok', mime: 'image/jpeg' })
    expect((f.ingest.mock.calls[0][0] as any).bytes.equals(PNG)).toBe(true)
    for (const i of turns[0].toolImages!.slice(1)) expect((await f.service.toolImageContent('claude', 'session', i.id)).status).toBe('unavailable')
    expect(JSON.stringify(turns)).not.toContain(f.root)
    // A link inside the workspace that leaves it, and a path that is gone, read honestly before any fetch.
    const linked = fixture((ws, root) => { symlinkSync(join(root, 'secret.png'), join(ws, 'out', 'link.png')); return [said('Reading.'),
      use('t1', 'Read', { file_path: join(ws, 'out', 'link.png') }), pathOnly('t1'), use('t2', 'Read', { file_path: join(ws, 'out', 'gone.png') }), pathOnly('t2')] })
    // A path outside the workspace that is not there reads as outside, never as missing: whether it exists is not told.
    const gone = fixture((_ws, root) => [said('Reading.'), use('t1', 'Read', { file_path: join(root, 'nothere.png') }), pathOnly('t1')])
    expect((await gone.turns()).turns[0].toolImages![0]).toMatchObject({ state: 'unavailable', reason: 'outside_workspace' })
    const lt = (await linked.turns()).turns[0].toolImages!
    expect(lt.map(i => [i.state, i.reason])).toEqual([['unavailable', 'outside_workspace'], ['unavailable', 'missing']])
    for (const i of lt) expect((await linked.service.toolImageContent('claude', 'session', i.id)).status).toBe('unavailable')
    expect(linked.ingest).not.toHaveBeenCalled()
    // Swapped for a link after it was listed: the content read refuses it.
    const swapped = fixture(ws => [said('Reading.'), use('t1', 'Read', { file_path: join(ws, 'out', 'shot.png') }), pathOnly('t1')])
    const sid = (await swapped.turns()).turns[0].toolImages![0].id
    rmSync(join(swapped.workspace, 'out', 'shot.png')); symlinkSync(join(swapped.root, 'secret.png'), join(swapped.workspace, 'out', 'shot.png'))
    expect((await swapped.service.toolImageContent('claude', 'session', sid)).status).toBe('unavailable')
    expect(swapped.ingest).not.toHaveBeenCalled()
    // A link inside the workspace to a file inside it was always fine: it is read from its canonical path.
    const ok = fixture(ws => { symlinkSync(join(ws, 'out', 'shot.png'), join(ws, 'out', 'alias.png')); return [said('Reading.'), use('t1', 'Read', { file_path: join(ws, 'out', 'alias.png') }), pathOnly('t1')] })
    const oid = (await ok.turns()).turns[0].toolImages![0]
    expect(oid.state).toBe('available'); expect((await ok.service.toolImageContent('claude', 'session', oid.id)).status).toBe('ok')
    const broad = fixture(ws => [said('Reading.'), use('t1', 'Read', { file_path: join(ws, 'out', 'shot.png') }), pathOnly('t1')], { workspace: (_ws, root) => join(root, 'home') })
    mkdirSync(join(broad.root, 'home'))
    expect((await broad.turns()).turns[0].toolImages![0]).toMatchObject({ state: 'unavailable', reason: 'outside_workspace' })
  })
  it('Codex: an exec output image and a prompt image project the same way', async () => {
    const f = fixture(() => [
      codex({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix this' }, { type: 'input_image', image_url: dataUrl(JPEG, 'image/jpeg'), detail: 'high' }] }),
      codex({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Taking a screenshot.' }] }),
      codex({ type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'x' }),
      codex({ type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'ok' }, { type: 'input_image', image_url: dataUrl(PNG), detail: 'original' }] }),
      codex({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }),
    ], { provider: 'codex' })
    const { turns } = await f.turns()
    expect(turns.map(t => [t.role, t.toolImages?.map(i => i.tool)])).toEqual([['user', ['Attached']], ['assistant', ['Image']], ['assistant', undefined]])
    const got = await f.service.toolImageContent('codex', 'session', turns[1].toolImages![0].id)
    expect(got).toMatchObject({ status: 'ok', type: 'image/png' }); expect((got as any).bytes.equals(PNG)).toBe(true)
  })
})

describe('performance: base64 is held only for the one image asked for', () => {
  it('a detail read keeps no embedded bytes; a content read keeps exactly the one it names', async () => {
    const f = fixture(() => [said('Shots.'), ...['a', 'b', 'c'].flatMap(k => [use(k, 'mcp__Claude_Browser__computer'), shotResult(k, JPEG)])])
    const { turns, ctx } = await f.turns()
    expect([...ctx.toolSources.values()].filter(s => s.kind === 'embedded')).toHaveLength(0)
    const want = turns[0].toolImages![1].id
    const ctx2 = await f.service.context('claude', 'session', f.transcript, want)
    await readRecentSessionTurns('claude', f.transcript, 10, undefined, ctx2.project)
    expect([...ctx2.toolSources.keys()]).toEqual([want])
  })
})

describe('serving a tool image', () => {
  it('serves the decoded bytes, typed by what they are, only for an id in the newest turns', async () => {
    const f = fixture(() => [said('Four kinds.'), ...[[PNG, 'image/png'], [JPEG, 'image/jpeg'], [GIF, 'image/gif'], [WEBP, 'image/webp']].flatMap(([b, m], i) => [use('k' + i, 'Read'), readResult('k' + i, b as Buffer, m as string)])])
    const { turns } = await f.turns()
    const types = []
    for (const i of turns[0].toolImages!) { const got = await f.service.toolImageContent('claude', 'session', i.id); types.push((got as any).type) }
    expect(types).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    const before = f.lookups.length
    for (const bad of ['ai_' + 'c'.repeat(64), 'af_' + 'c'.repeat(64), '../../etc/passwd', 'ti_' + 'C'.repeat(64)]) expect((await f.service.toolImageContent('claude', 'session', bad)).status).toBe('not_found')
    expect(f.lookups.length, 'a malformed id never reaches the transcript').toBe(before)
    expect((await f.service.toolImageContent('claude', 'session', 'ti_' + 'c'.repeat(64))).status).toBe('not_found')
    expect((await f.service.toolImageContent('claude', 'nope', turns[0].toolImages![0].id)).status).toBe('not_found')
  })
  it('an image whose turn has scrolled out of the newest forty is no longer served', async () => {
    const f = fixture(() => [said('Old.'), use('t0', 'Read'), readResult('t0', PNG)])
    const { turns } = await f.turns()
    const id = turns[0].toolImages![0].id
    expect((await f.service.toolImageContent('claude', 'session', id)).status).toBe('ok')
    const { appendFileSync } = await import('node:fs')
    appendFileSync(f.transcript, Array.from({ length: 41 }, (_, i) => JSON.stringify(said('Turn ' + i))).join('\n') + '\n')
    expect((await f.service.toolImageContent('claude', 'session', id)).status).toBe('not_found')
  })
  it('regressions: reply-text images (6.99.28) and SendUserFile cards (6.99.35) still project beside tool images', async () => {
    const f = fixture(ws => [
      said('See ![render](out/shot.png)'),
      { type: 'assistant', uuid: 'su1', timestamp: at(), cwd: ws, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'su', name: 'SendUserFile', input: { files: ['out/report.pdf', join(ws, 'out', 'shot.png')], caption: 'Files.', status: 'normal' } }] } },
      use('t1', 'Read'), readResult('t1', PNG),
    ])
    const { turns } = await f.turns()
    expect(turns[0].outputImages!.map(i => i.label)).toEqual(['render']); expect(SESSION_OUTPUT_IMAGE_ID.test(turns[0].outputImages![0].id)).toBe(true)
    expect(turns[1].outputFiles!.map(x => x.name)).toEqual(['report.pdf']); expect(SESSION_OUTPUT_FILE_ID.test(turns[1].outputFiles![0].id)).toBe(true)
    expect(turns[1].outputImages!.map(i => i.label)).toEqual(['shot.png'])
    expect(turns[1].toolImages!.map(i => i.tool)).toEqual(['Read'])
    expect((await f.service.content('claude', 'session', turns[0].outputImages![0].id, 'thumb')).status).toBe('ok')
    expect((await f.service.fileContent('claude', 'session', turns[1].outputFiles![0].id)).status).toBe('ok')
    expect(JSON.stringify(turns)).not.toContain(f.root)
  })
})

describe('the workspace read the previews share (moved into workspaceImage, 11/08)', () => {
  it('a reply-text image named through a link is refused, even a link to a file inside the workspace (no link in any component)', async () => {
    const f = fixture(ws => { symlinkSync(join(ws, 'out', 'shot.png'), join(ws, 'out', 'alias.png')); return [said('See ![a](out/alias.png) and ![b](out/shot.png)')] })
    const { turns } = await f.turns()
    const [alias, direct] = turns[0].outputImages!
    expect(alias.state).toBe('available')
    expect((await f.service.content('claude', 'session', alias.id, 'thumb')).status).toBe('unavailable')
    expect(f.ingest).not.toHaveBeenCalled()
    expect((await f.service.content('claude', 'session', direct.id, 'thumb')).status).toBe('ok')
  })
})

describe('previews off', () => {
  it('strips tool and prompt images and the count of more, and marks the turn, so not even a label reaches the browser', () => {
    const turns = withoutPreviews([
      { role: 'assistant', text: 'a', toolImages: [{ id: 'ti_' + 'a'.repeat(64), tool: 'Read', index: 1, total: 1, state: 'available' }] },
      { role: 'assistant', text: 'b', toolImagesMore: 3 },
      { role: 'user', text: 'c' },
    ])
    expect(turns).toEqual([{ role: 'assistant', text: 'a', previewsOff: true }, { role: 'assistant', text: 'b', previewsOff: true }, { role: 'user', text: 'c' }])
  })
})
