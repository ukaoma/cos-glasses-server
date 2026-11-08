/**
 * 7.0.4 S2: the secret-name guard on every preview that serves a local file. A file inside the session's exact
 * workspace used to be servable whatever its name; a repo keeps its own `.env`, keys and certificates there.
 * Real transcripts and files on disk, the real projection and content reads, a fake media store. Fixtures are
 * hand-written record shapes (no real content).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSessionOutputImages } from './agent-session-output-images.js'
import { readRecentSessionTurns } from './agent-session-turns.js'
import type { AgentProvider } from './agent-session-store.js'

const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png fixture')])
const NOTICE = 'Not shown: this file may hold secrets'
let n = 0
const at = () => `2026-11-08T11:${String(10 + (n % 40)).padStart(2, '0')}:00Z`
const said = (text: string) => ({ type: 'assistant', uuid: 'a' + ++n, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const share = (files: string[]) => ({ type: 'assistant', uuid: 'a' + ++n, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'su' + n, name: 'SendUserFile', input: { files, caption: 'Files.', status: 'normal' } }] } })
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', uuid: 'a' + ++n, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
/** A Read of an image that carries no bytes, only the path it read. */
const pathOnly = (id: string) => ({
  type: 'user', uuid: 'r' + ++n, timestamp: at(), sourceToolAssistantUUID: 'x',
  toolUseResult: { type: 'image', file: { base64: '', type: 'image/png', originalSize: 1 } },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [] }] },
})
const embedded = (id: string) => ({
  type: 'user', uuid: 'r' + ++n, timestamp: at(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] }] },
})

/** The names under test, one per pattern, plus segment and case variants. Written inside the workspace. */
const SECRET_FILES = ['.env', '.env.local', 'gcp-key.json', '.cos-profile.json', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'cert.pem', 'dist.p12',
  'sign.pfx', 'tls.key', 'credentials.json', '.netrc', '.npmrc', '.pypirc', 'login.keychain-db', '.ssh/config', '.gnupg/pubring.kbx',
  '.aws/credentials', 'UPPER/.ENV.PRODUCTION', 'UPPER/Server.PEM']

function fixture(rows: (ws: string) => unknown[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cos-secret-files-'))); roots.push(root)
  const ws = join(root, 'repo'); mkdirSync(join(ws, 'out'), { recursive: true })
  writeFileSync(join(ws, 'out', 'shot.png'), PNG)
  writeFileSync(join(ws, 'out', 'report.pdf'), '%PDF-1.7 fixture')
  for (const name of SECRET_FILES) { mkdirSync(join(ws, name, '..'), { recursive: true }); writeFileSync(join(ws, name), 'SECRET=fixture') }
  for (const name of ['.env.png', 'credentials.png', 'id_rsa.png']) writeFileSync(join(ws, 'out', name), PNG)
  mkdirSync(join(ws, '.ssh'), { recursive: true }); writeFileSync(join(ws, '.ssh', 'diagram.png'), PNG)
  // Innocent names, secret targets, all inside the workspace (so containment alone would allow them).
  symlinkSync(join(ws, '.env'), join(ws, 'out', 'readme.txt'))
  symlinkSync(join(ws, '.ssh', 'diagram.png'), join(ws, 'out', 'chart.png'))
  const transcript = join(root, 'session.jsonl')
  writeFileSync(transcript, rows(ws).map(r => JSON.stringify(r)).join('\n') + '\n')
  const normalized = join(root, 'normalized.jpg'); writeFileSync(normalized, 'jpeg')
  const ingest = vi.fn(async (_input: unknown) => ({ id: 'm_' + 'c'.repeat(24) }))
  const store = { ingestOutputImage: ingest, getContent: vi.fn(() => ({ status: 'ok' as const, path: normalized, mime: 'image/jpeg' as const, bytes: 4 })) }
  const service = new AgentSessionOutputImages({
    findSession: async (_p: AgentProvider, id: string) => (id === 'session' ? transcript : null),
    workspace: async () => ws, secret: Buffer.alloc(32, 5), now: () => 1,
    store: () => store as unknown as ReturnType<typeof import('./media-store.js').getMediaStore>,
    home: () => join(root, 'home'),
  })
  const turns = async () => {
    const ctx = await service.context('claude', 'session', transcript)
    return (await readRecentSessionTurns('claude', transcript, 40, undefined, ctx.project)).turns
  }
  return { root, ws, service, ingest, turns }
}

describe('sent output files (SendUserFile)', () => {
  it('every secret pattern is a "Not shown" card with its base name only, and the content read answers secret', async () => {
    const f = fixture(ws => [said('Sending.'), ...SECRET_FILES.map(name => share([join(ws, name)])), share([join(ws, 'out', 'readme.txt')]), share([join(ws, 'out', 'report.pdf')])])
    const files = (await f.turns()).flatMap(t => t.outputFiles ?? [])
    expect(files).toHaveLength(SECRET_FILES.length + 2)
    const secret = files.slice(0, -1), ok = files[files.length - 1]
    for (const [i, file] of secret.entries()) {
      const name = i < SECRET_FILES.length ? SECRET_FILES[i].split('/').pop() : 'readme.txt'
      expect(file, name).toMatchObject({ name, state: 'unavailable', reason: 'secret_file', notice: NOTICE })
      expect(file, 'no size for a refused file').not.toHaveProperty('size')
      expect(await f.service.fileContent('claude', 'session', file.id), name).toEqual({ status: 'secret' })
    }
    // Regression: an ordinary file still serves.
    expect(ok).toMatchObject({ name: 'report.pdf', state: 'available' })
    expect(await f.service.fileContent('claude', 'session', ok.id)).toMatchObject({ status: 'ok', name: 'report.pdf' })
    expect(JSON.stringify(files)).not.toContain(f.root)
  })
  it('a relative path is judged where the session stood, and a secret outside the workspace still reads as a secret', async () => {
    const f = fixture(ws => [said('Sending.'), { ...share(['.env', 'out/report.pdf']), cwd: ws }, share(['~/.ssh/id_ed25519'])])
    const files = (await f.turns()).flatMap(t => t.outputFiles ?? [])
    expect(files.map(x => [x.name, x.reason ?? x.state])).toEqual([['.env', 'secret_file'], ['report.pdf', 'available'], ['id_ed25519', 'secret_file']])
  })
})

describe('sent output files: hard links (7.0.4 QA)', () => {
  it('an innocently named hard link to .env is a secret card, and a link made after the listing is refused at read time', async () => {
    const f = fixture(ws => {
      writeFileSync(join(ws, 'out', 'notes.txt'), 'plain notes')
      linkSync(join(ws, '.env'), join(ws, 'out', 'summary.txt'))
      return [said('Sending.'), share([join(ws, 'out', 'summary.txt')]), share([join(ws, 'out', 'notes.txt')])]
    })
    const files = (await f.turns()).flatMap(t => t.outputFiles ?? [])
    expect(files.map(file => [file.name, file.reason ?? file.state])).toEqual([['summary.txt', 'secret_file'], ['notes.txt', 'available']])
    expect(await f.service.fileContent('claude', 'session', files[0].id)).toEqual({ status: 'secret' })
    expect(await f.service.fileContent('claude', 'session', files[1].id)).toMatchObject({ status: 'ok', name: 'notes.txt' })
    // Linked after the card was listed: the open file is checked again.
    const cached = (await f.turns()).flatMap(t => t.outputFiles ?? [])[1]
    linkSync(join(f.ws, 'out', 'notes.txt'), join(f.root, 'elsewhere.txt'))
    expect(await f.service.fileContent('claude', 'session', cached.id)).toEqual({ status: 'secret' })
  })
})

describe('output images: sent images and Markdown images', () => {
  it('a secret by name or by canonical target is a "Not shown" card and the content read answers secret; an ordinary image still serves', async () => {
    const f = fixture(ws => [
      share([join(ws, 'out', 'id_rsa.png'), join(ws, 'out', 'chart.png'), join(ws, 'out', 'shot.png')]),
      said(`Here: ![a render](out/.env.png) ![](out/credentials.png) ![chart](out/chart.png) ![diagram](.ssh/diagram.png) ![fine](out/shot.png)`),
    ])
    const images = (await f.turns()).flatMap(t => t.outputImages ?? [])
    expect(images.map(i => [i.label, i.reason ?? i.state])).toEqual([
      ['id_rsa.png', 'secret_file'], ['chart.png', 'secret_file'], ['shot.png', 'available'],
      // A refused Markdown image is labelled with its base name, never its alt words or path.
      ['.env.png', 'secret_file'], ['credentials.png', 'secret_file'], ['chart.png', 'secret_file'], ['diagram.png', 'secret_file'], ['fine', 'available'],
    ])
    for (const image of images.filter(i => i.reason === 'secret_file')) {
      expect(image.notice).toBe(NOTICE)
      expect(await f.service.content('claude', 'session', image.id, 'phone'), image.label).toEqual({ status: 'secret' })
    }
    expect(f.ingest).not.toHaveBeenCalled()
    for (const image of images.filter(i => i.state === 'available')) expect((await f.service.content('claude', 'session', image.id, 'phone')).status).toBe('ok')
    expect(JSON.stringify(images)).not.toContain(f.root)
  })
})

describe('tool images', () => {
  it('a Read of a secret is refused by the name it read, path-only or with its bytes embedded (7.0.4 QA); bytes with no path are exempt', async () => {
    const f = fixture(ws => [said('Reading.'),
      use('t1', 'Read', { file_path: join(ws, 'out', 'credentials.png') }), pathOnly('t1'),
      use('t2', 'Read', { file_path: join(ws, 'out', 'chart.png') }), pathOnly('t2'),
      use('t3', 'Read', { file_path: join(ws, 'out', 'shot.png') }), pathOnly('t3'),
      use('t4', 'Read', { file_path: join(ws, '.ssh', 'diagram.png') }), embedded('t4'),
      use('t5', 'Read', { file_path: join(ws, 'Desktop', 'credentials.png') }), embedded('t5'),
      use('t6', 'Screenshot', {}), embedded('t6'),
    ])
    const images = (await f.turns()).flatMap(t => t.toolImages ?? [])
    expect(images.map(i => [i.reason ?? i.state, i.notice])).toEqual([['secret_file', NOTICE], ['secret_file', NOTICE], ['available', undefined], ['secret_file', NOTICE], ['secret_file', NOTICE], ['available', undefined]])
    expect(await f.service.toolImageContent('claude', 'session', images[0].id)).toEqual({ status: 'secret' })
    expect(await f.service.toolImageContent('claude', 'session', images[1].id)).toEqual({ status: 'secret' })
    expect((await f.service.toolImageContent('claude', 'session', images[2].id)).status).toBe('ok')
    expect(await f.service.toolImageContent('claude', 'session', images[3].id)).toEqual({ status: 'secret' })
    expect(await f.service.toolImageContent('claude', 'session', images[4].id)).toEqual({ status: 'secret' })
    expect(await f.service.toolImageContent('claude', 'session', images[5].id)).toMatchObject({ status: 'ok', type: 'image/png' })
  })
})

describe('authorization still runs first', () => {
  it('an id the transcript does not name, or another session, is not_found, never secret', async () => {
    const f = fixture(ws => [said('Sending.'), share([join(ws, '.env')]), use('t1', 'Read', { file_path: join(ws, 'out', 'credentials.png') }), pathOnly('t1'), said(`![](out/.env.png)`)])
    const turns = await f.turns()
    const file = turns.flatMap(t => t.outputFiles ?? [])[0], tool = turns.flatMap(t => t.toolImages ?? [])[0], image = turns.flatMap(t => t.outputImages ?? [])[0]
    expect([file.reason, tool.reason, image.reason]).toEqual(['secret_file', 'secret_file', 'secret_file'])
    expect(await f.service.fileContent('claude', 'other', file.id)).toEqual({ status: 'not_found' })
    expect(await f.service.toolImageContent('claude', 'other', tool.id)).toEqual({ status: 'not_found' })
    expect(await f.service.content('claude', 'other', image.id, 'phone')).toEqual({ status: 'not_found' })
    expect(await f.service.fileContent('claude', 'session', 'af_' + 'f'.repeat(64))).toEqual({ status: 'not_found' })
    expect(await f.service.toolImageContent('claude', 'session', 'ti_' + 'f'.repeat(64))).toEqual({ status: 'not_found' })
    expect(await f.service.content('claude', 'session', 'ai_' + 'f'.repeat(64), 'phone')).toEqual({ status: 'not_found' })
  })
})
