// 6.99.27: any file for a Claude or Codex session turn, and files with a fork. The real media routes, the real media
// store and the real turn file store on temp folders; the provider is a fake. Nothing reaches a model or the user's data.
//   - POST /api/media/file with X-COS-Purpose: session-turn keeps a file the media store cannot read as a turn file,
//     under its own safe name; without the header it is refused as before; the 64 MB cap holds either way
//   - a turn file is invisible to the media store (so to an Ask, a Drop, Prep and GET /api/media/:id)
//   - the turn's default store finds media ids and turn file ids; the line names the turn file's real path
//   - turn files: 4 hours until a turn takes one, then 30 days; the sweep removes the rest
//   - a fork carries files exactly as a turn does
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import express from 'express'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { keepsAsTurnFile, mediaBinaryBodyParser, mediaBodyParser, mediaRouter } from './media.js'
import { MediaStore, MediaStoreError, _setMediaStoreForTests } from '../lib/media-store.js'
import { TurnFileStore, safeTurnFileName, _setTurnFileStoreForTests, TURN_FILE_MAX_BYTES, TURN_FILE_STAGED_TTL_MS, TURN_FILE_KEPT_TTL_MS } from '../lib/turn-file-store.js'
import { composeTurnPrompt, defaultTurnAttachmentStore, TURN_ATTACHMENTS_HEADING, TURN_ATTACHMENT_COPY } from '../lib/session-turn-attachments.js'
import { resolveQueryAttachments } from '../lib/query-attachments.js'
import { createAgentSessionBindingsRouter, type AgentSessionBindingsDeps } from './agent-session-bindings.js'

let root = '', server: Server | null = null, base = ''
let prevMedia: MediaStore | null = null, prevFiles: TurnFileStore | null = null
let clock = 1_786_000_000_000
let files: TurnFileStore
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cos-turn-files-'))
  prevMedia = _setMediaStoreForTests(new MediaStore(join(root, 'media')))
  files = new TurnFileStore(join(root, 'turn-files'), () => clock)
  prevFiles = _setTurnFileStoreForTests(files)
  const app = express()
  app.use('/api/media/file', mediaBinaryBodyParser)
  app.use('/api/media', mediaBodyParser)
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', mediaRouter)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(r => server!.once('listening', () => r()))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
})
afterAll(async () => {
  _setMediaStoreForTests(prevMedia); _setTurnFileStoreForTests(prevFiles)
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())) }
  rmSync(root, { recursive: true, force: true })
})

async function upload(name: string, body: Buffer | string, type: string, purpose?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': type, 'X-COS-Filename': encodeURIComponent(name), 'X-COS-Web': '1' }
  if (purpose) headers['X-COS-Purpose'] = purpose
  const res = await fetch(`${base}/api/media/file`, { method: 'POST', headers, body: typeof body === 'string' ? body : new Uint8Array(body) })
  return { status: res.status, body: await res.json() }
}
const ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)])   // an empty zip archive

describe('POST /api/media/file: any file for a session turn', () => {
  it('a .zip for a session turn is kept as a turn file under its own name; the answer names no path', async () => {
    const r = await upload('logs from staging.zip', ZIP, 'application/zip', 'session-turn')
    expect(r.status).toBe(200)
    expect(r.body.attachment).toMatchObject({ kind: 'session_file', mime: 'application/zip', bytes: ZIP.length, label: 'logs from staging.zip' })
    expect(r.body.attachment.id).toMatch(/^m_[a-f0-9]{24}$/)
    expect(JSON.stringify(r.body)).not.toContain(root)
    const { path } = files.resolveUsable(r.body.attachment.id)
    expect(basename(path)).toBe('logs from staging.zip')
    expect(dirname(path)).toBe(join(root, 'turn-files', r.body.attachment.id, 'file'))
    expect(readFileSync(path)).toEqual(ZIP)
  })

  it('without the purpose the same file is refused as before, and nothing is kept', async () => {
    const before = existsSync(join(root, 'turn-files')) ? readdirSync(join(root, 'turn-files')).length : 0
    const r = await upload('logs.zip', ZIP, 'application/zip')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('unsupported_attachment_format')
    expect(existsSync(join(root, 'turn-files')) ? readdirSync(join(root, 'turn-files')).length : 0).toBe(before)
  })

  it('a file the media store reads still goes to the media store, purpose or not', async () => {
    const r = await upload('notes.md', '# Notes\n', 'text/markdown', 'session-turn')
    expect(r.status).toBe(200)
    expect(r.body.attachment).toMatchObject({ kind: 'user_document', mime: 'text/markdown' })
    expect(files.has(r.body.attachment.id)).toBe(false)
  })

  it('the cap is the media store’s own for a file that is not a video: 64 MB', async () => {
    expect(TURN_FILE_MAX_BYTES).toBe(64 * 1024 * 1024)
    const big = Buffer.alloc(TURN_FILE_MAX_BYTES + 1, 0x41)
    const r = await upload('huge.bin', big, 'application/octet-stream', 'session-turn')
    expect(r.status).toBe(413)
    expect(r.body.error).toBe('attachment_too_large')
  }, 30_000)

  it('a turn file is not media: the media store, an Ask and GET /api/media/:id cannot find it', async () => {
    const r = await upload('deck.key', ZIP, 'application/x-iwork-keynote-sffkey', 'session-turn')
    const id = r.body.attachment.id
    expect(() => (_setMediaStoreForTests(null), 0)).not.toThrow()
    _setMediaStoreForTests(new MediaStore(join(root, 'media')))
    await expect(resolveQueryAttachments({ attachmentIds: [id] })).rejects.toMatchObject({ code: 'media_not_found', status: 404 })
    const got = await fetch(`${base}/api/media/${id}/content`)
    expect(got.status).toBe(404)
  })

  it('the turn’s store finds both kinds, and the line names the turn file’s real path', async () => {
    const md = await upload('plan.md', '# Plan\n', 'text/markdown', 'session-turn')
    const zip = await upload('build.zip', ZIP, 'application/zip', 'session-turn')
    const out = await composeTurnPrompt('look at both', [md.body.attachment.id, zip.body.attachment.id], { maxChars: 32_000, store: defaultTurnAttachmentStore() })
    expect(out.ok).toBe(true)
    const lines = (out as { prompt: string }).prompt.split('\n')
    expect(lines.slice(0, 4)).toEqual(['look at both', '', ...TURN_ATTACHMENTS_HEADING.split('\n')])
    expect(lines[4]).toMatch(/^- File "plan\.md" \(text\/markdown, 1 KB\): "\/.+\/media\/assets\/m_[a-f0-9]{24}\/.+"$/)
    expect(lines[5]).toBe(`- File "build.zip" (application/zip, 1 KB): ${JSON.stringify(join(root, 'turn-files', zip.body.attachment.id, 'file', 'build.zip'))}`)
  })
})

describe('which refusals become a turn file', () => {
  it('only a format the media store cannot read, and only for a session turn', () => {
    expect(keepsAsTurnFile('session-turn', 'unsupported_attachment_format')).toBe(true)
    expect(keepsAsTurnFile('session-turn', 'corrupt_attachment')).toBe(true)
    for (const code of ['attachment_too_large', 'video_too_long', 'attachment_processing_unavailable', 'attachment_processing_failed', undefined]) expect(keepsAsTurnFile('session-turn', code), String(code)).toBe(false)
    expect(keepsAsTurnFile(undefined, 'unsupported_attachment_format')).toBe(false)
    expect(keepsAsTurnFile('chat', 'unsupported_attachment_format')).toBe(false)
  })
})

describe('TurnFileStore', () => {
  const stage = (bytes = 'hello') => { const p = join(root, 'stage-' + Math.random().toString(36).slice(2)); writeFileSync(p, bytes); return p }
  it('names: never a path, never a control character, never hidden', () => {
    expect(safeTurnFileName('../../etc/passwd')).toBe('etc passwd')
    expect(safeTurnFileName('a\u0000b\nc\u001b[2J.txt')).toBe('a b c [2J.txt')
    expect(safeTurnFileName('.env')).toBe('env')
    expect(safeTurnFileName('meta.json'), 'the file sits in its own folder, so its name is its own').toBe('meta.json')
    expect(safeTurnFileName('')).toBe('file')
    expect(safeTurnFileName('x'.repeat(300) + '.docx')).toMatch(/^x{115}\.docx$/)
    // QA 6.99.27: a bidi override never reaches the name on disk, so the path the agent reads shows as what it is.
    expect(safeTurnFileName('invoice\u202efdp.exe')).toBe('invoicefdp.exe')
    expect(safeTurnFileName('\u2066a\u2069\u200f.txt')).toBe('a.txt')
  })
  // QA 6.99.27: the record and the file shared one folder, and only a lowercase "meta.json" was renamed. On the default
  // case-insensitive macOS disk a file named META.JSON was the record: the record write replaced the file's bytes.
  it('a file named META.JSON, Meta.Json or meta.json keeps its bytes and the record keeps its own, after a turn takes it too', async () => {
    const s = new TurnFileStore(join(root, 'case'), () => clock)
    for (const label of ['META.JSON', 'Meta.Json', 'meta.json']) {
      const body = 'the payload of ' + label
      const ref = s.ingestFromFile({ sourcePath: stage(body), byteLength: body.length, label })
      const first = s.resolveUsable(ref.id)
      expect(basename(first.path), label).toBe(label)
      expect(readFileSync(first.path, 'utf8'), label + ' after the upload').toBe(body)
      await s.associate([ref.id], { runId: 'session-turn:ct-case-0001' })
      const after = s.resolveUsable(ref.id)
      expect(readFileSync(after.path, 'utf8'), label + ' after the turn took it').toBe(body)
      expect(after.record.ref.label).toBe(label)
    }
  })
  it('past 64 MB is refused at the store too (a video-headed file can pass the upload parser up to 100 MB)', () => {
    const s = new TurnFileStore(join(root, 'cap'), () => clock)
    expect(() => s.ingestFromFile({ sourcePath: stage(), byteLength: TURN_FILE_MAX_BYTES + 1, label: 'big.mov' })).toThrow(/byte limit/)
    expect(s.ingestFromFile({ sourcePath: stage(), byteLength: TURN_FILE_MAX_BYTES, label: 'ok.bin' }).bytes).toBe(TURN_FILE_MAX_BYTES)
  })
  it('a photo sent as taken is called a photo in the turn, a video a video', async () => {
    const s = new TurnFileStore(join(root, 'kinds'), () => clock)
    const heic = s.ingestFromFile({ sourcePath: stage(), byteLength: 3_100_000, label: 'IMG_2041.HEIC', declaredMime: 'image/heic' })
    const webm = s.ingestFromFile({ sourcePath: stage(), byteLength: 2048, label: 'clip.webm', declaredMime: 'video/webm' })
    const out = await composeTurnPrompt('see', [heic.id, webm.id], { maxChars: 32_000, store: s })
    const lines = (out as { prompt: string }).prompt.split('\n')
    expect(lines[4]).toMatch(/^- Photo "IMG_2041\.HEIC" \(image\/heic, 3\.0 MB\): /)
    expect(lines[5]).toMatch(/^- Video "clip\.webm" \(video\/webm, 2 KB\): /)
  })
  it('4 hours until a turn takes it; then 30 days; the sweep removes what has gone', async () => {
    const s = new TurnFileStore(join(root, 'ttl'), () => clock)
    const a = s.ingestFromFile({ sourcePath: stage(), byteLength: 5, label: 'a.log' })
    const b = s.ingestFromFile({ sourcePath: stage(), byteLength: 5, label: 'b.log' })
    await s.associate([b.id], { runId: 'session-turn:ct-ttl-0001' })
    clock += TURN_FILE_STAGED_TTL_MS + 1
    expect(() => s.resolveUsable(a.id)).toThrow(MediaStoreError)
    expect(s.resolveUsable(b.id).path).toContain('b.log')
    expect(s.sweep()).toBe(1)
    expect(s.has(a.id)).toBe(false)
    clock += TURN_FILE_KEPT_TTL_MS
    expect(() => s.resolveUsable(b.id)).toThrow(/expired/)
    expect(s.sweep()).toBe(1)
    expect(s.has(b.id)).toBe(false)
  })
  // QA 6.99.27 (Skeptic W2): only a new upload swept, so a Mac that took one file and no more kept it forever.
  it('startSweep sweeps at once and then on the interval, without waiting for a new upload; stopSweep stops it', async () => {
    let now = clock
    const s = new TurnFileStore(join(root, 'boot'), () => now)
    const a = s.ingestFromFile({ sourcePath: stage(), byteLength: 5, label: 'a.log' })
    now += TURN_FILE_STAGED_TTL_MS + 1
    const b = s.ingestFromFile({ sourcePath: stage(), byteLength: 5, label: 'b.log' })   // sweeps a, as before
    expect(s.has(a.id)).toBe(false)
    const c = s.ingestFromFile({ sourcePath: stage(), byteLength: 5, label: 'c.log' })
    now += TURN_FILE_STAGED_TTL_MS + 1
    // A restart: a new store over the same folder, nothing uploaded. The boot sweep removes both at once.
    const booted = new TurnFileStore(join(root, 'boot'), () => now)
    try {
      booted.startSweep(20)
      expect([booted.has(b.id), booted.has(c.id)], 'the boot sweep').toEqual([false, false])
      const d = booted.ingestFromFile({ sourcePath: stage(), byteLength: 5, label: 'd.log' })
      now += TURN_FILE_STAGED_TTL_MS + 1
      await new Promise(r => setTimeout(r, 80))
      expect(booted.has(d.id), 'the interval sweep, with no upload').toBe(false)
      booted.stopSweep()
      const e = booted.ingestFromFile({ sourcePath: stage(), byteLength: 5, label: 'e.log' })
      now += TURN_FILE_STAGED_TTL_MS + 1
      await new Promise(r => setTimeout(r, 80))
      expect(booted.has(e.id), 'stopped: nothing swept').toBe(true)
    } finally { booted.stopSweep() }
  })
  it('the server starts the turn file sweep beside the media store’s GC (index.ts)', () => {
    const index = readFileSync(join(dirname(dirname(new URL(import.meta.url).pathname)), 'index.ts'), 'utf8')
    expect(index).toMatch(/getMediaStore\(\)\.startGC\(\)\n(?:\s*\/\/[^\n]*\n)*\s*getTurnFileStore\(\)\.startSweep\(\)/)
  })
  it('a folder that is not a turn file is swept once it is old; a fresh one is left', () => {
    const s = new TurnFileStore(join(root, 'junk'), () => Date.now() + TURN_FILE_STAGED_TTL_MS * 2)
    mkdirSync(join(root, 'junk', 'not-ours'), { recursive: true })
    expect(s.sweep()).toBe(1)
  })
  it('an unknown or malformed id is not found; the meta must name its own folder', () => {
    const s = new TurnFileStore(join(root, 'ids'), () => clock)
    expect(() => s.resolveUsable('m_' + 'f'.repeat(24))).toThrow(/not found/)
    expect(() => s.resolveUsable('../x')).toThrow(/not found/)
    const a = s.ingestFromFile({ sourcePath: stage(), byteLength: 5, label: 'a.log' })
    const meta = JSON.parse(readFileSync(join(root, 'ids', a.id, 'meta.json'), 'utf8'))
    writeFileSync(join(root, 'ids', a.id, 'meta.json'), JSON.stringify({ ...meta, name: '../../outside' }))
    expect(() => s.resolveUsable(a.id)).toThrow(/not found/)
  })
})

// ── a fork takes files as a turn does ───────────────────
describe('POST .../fork with attachmentIds', () => {
  let fserver: Server | null = null, fbase = ''
  afterEach(async () => { if (fserver) { fserver.closeAllConnections(); await new Promise<void>(r => fserver!.close(() => r())) } fserver = null })
  const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
  async function startFork(prompts: string[], workspace: () => Promise<string | null> = async () => '/tmp/project') {
    const d = {
      probes: { isAlive: () => true, processStartMs: () => clock, fileExists: () => true, dirExists: () => true, readDir: () => [], readFile: () => '{}', lockHolders: () => [], cosSpawnedPids: () => new Map(), cursorAgentSession: () => null },
      dirs: { claudeSessionsDir: '/x/.claude/sessions', codexLocksDir: '/x/.codex', cursorChatsDir: '/x/.cursor' },
      now: () => clock, bindings: { list: () => [], available: () => true } as any, attachEnabled: true, occupancy: () => ({ attachable: true, owners: [], reason: null }),
      resolveForkWorkspace: workspace,
      forkThread: async (req: { prompt: string }) => { prompts.push(req.prompt); return { forked: true, forkRef: 'claude:fork-1', sourceIntegrity: 'verified', orphanPossible: false } },
      newId: () => 'nid',
    } as unknown as AgentSessionBindingsDeps
    const app = express(); app.use(express.json()); app.use('/api', createAgentSessionBindingsRouter(d))
    fserver = app.listen(0, '127.0.0.1')
    await new Promise<void>(r => fserver!.once('listening', () => r()))
    fbase = `http://127.0.0.1:${(fserver!.address() as AddressInfo).port}`
  }
  const fork = async (body: Record<string, unknown>) => {
    const res = await fetch(`${fbase}/api/agent-sessions/claude/${SID}/fork`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cosSessionId: 'cos-1', prompt: 'try it in a copy', ...body }) })
    return { status: res.status, body: await res.json() as any }
  }
  it('the copy’s first turn gets the words, then where each file is; without files the words alone', async () => {
    const prompts: string[] = []
    await startFork(prompts)
    const zip = await upload('trace.zip', ZIP, 'application/zip', 'session-turn')
    // What the fake copy answers is beside the point here; the prompt it was handed is the point.
    await fork({ attachmentIds: [zip.body.attachment.id] })
    await fork({})
    expect(prompts).toEqual([
      `try it in a copy\n\n${TURN_ATTACHMENTS_HEADING}\n- File "trace.zip" (application/zip, 1 KB): ${JSON.stringify(join(root, 'turn-files', zip.body.attachment.id, 'file', 'trace.zip'))}`,
      'try it in a copy',
    ])
  })
  // QA 6.99.27 (Skeptic W2): a fork kept its files before its workspace check and its claim.
  it('a fork refused at a gate keeps nothing; one that goes keeps its files', async () => {
    const prompts: string[] = []
    const metaOf = (id: string) => JSON.parse(readFileSync(join(root, 'turn-files', id, 'meta.json'), 'utf8'))
    await startFork(prompts, async () => null)
    const zip = await upload('gate.zip', ZIP, 'application/zip', 'session-turn')
    const id = zip.body.attachment.id as string
    const refused = await fork({ attachmentIds: [id] })
    expect(refused.body).toMatchObject({ forked: false, reason: 'fork_workspace_unresolvable' })
    expect(metaOf(id).associatedAtMs, 'refused at the workspace gate: still only staged').toBeUndefined()
    if (fserver) { fserver.closeAllConnections(); await new Promise<void>(r => fserver!.close(() => r())) }
    await startFork(prompts)
    await fork({ attachmentIds: [id] })
    expect(prompts).toHaveLength(1)
    expect(typeof metaOf(id).associatedAtMs).toBe('number')
    expect(metaOf(id).runId).toMatch(/^session-fork:/)
  })
  it('a bad list or a file that has gone refuses before anything is copied', async () => {
    const prompts: string[] = []
    await startFork(prompts)
    expect((await fork({ attachmentIds: ['nope'] })).status).toBe(400)
    const gone = await fork({ attachmentIds: ['m_' + 'e'.repeat(24)] })
    expect(gone.body).toMatchObject({ forked: false, attachmentError: 'media_not_found', reasonCopy: TURN_ATTACHMENT_COPY.media_not_found })
    expect(prompts).toEqual([])
  })
})
