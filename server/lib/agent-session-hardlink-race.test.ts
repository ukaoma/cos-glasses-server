/**
 * 7.0.4 QA: a sent file that becomes a hard link between the listing and the read is still refused. The listing inside
 * every content read already refuses a file with more than one link; this pins the second check on the OPEN file, by
 * making the link at the moment the file is opened (the race the second check exists for).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const onOpen = vi.hoisted(() => ({ fn: null as null | ((path: string) => void) }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, open: async (path: Parameters<typeof real.open>[0], ...rest: unknown[]) => { onOpen.fn?.(String(path)); return (real.open as (...a: unknown[]) => unknown)(path, ...rest) } }
})
const { AgentSessionOutputImages } = await import('./agent-session-output-images.js')
const { readRecentSessionTurns } = await import('./agent-session-turns.js')

const roots: string[] = []
afterEach(() => { onOpen.fn = null; for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })

describe('sent files: a hard link made at read time', () => {
  it('is refused by the open-file check', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cos-hardlink-race-'))); roots.push(root)
    const ws = join(root, 'repo'); mkdirSync(join(ws, 'out'), { recursive: true })
    const file = join(ws, 'out', 'notes.txt'); writeFileSync(file, 'plain notes')
    const transcript = join(root, 'session.jsonl')
    const row = { type: 'assistant', uuid: 'a1', timestamp: '2026-11-08T11:10:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'su1', name: 'SendUserFile', input: { files: [file], caption: 'Files.', status: 'normal' } }] } }
    writeFileSync(transcript, JSON.stringify(row) + '\n')
    const service = new AgentSessionOutputImages({
      findSession: async (_p, id) => (id === 'session' ? transcript : null),
      workspace: async () => ws, secret: Buffer.alloc(32, 5), now: () => 1,
      store: () => ({ ingestOutputImage: vi.fn(), getContent: vi.fn() }) as never,
      home: () => join(root, 'home'),
    })
    const ctx = await service.context('claude', 'session', transcript)
    const sent = (await readRecentSessionTurns('claude', transcript, 40, undefined, ctx.project)).turns.flatMap(t => t.outputFiles ?? [])
    expect(sent.map(f => f.state)).toEqual(['available'])
    expect(await service.fileContent('claude', 'session', sent[0]!.id)).toMatchObject({ status: 'ok' })
    onOpen.fn = path => { if (path === file) linkSync(file, join(root, 'elsewhere.txt')) }
    expect(await service.fileContent('claude', 'session', sent[0]!.id)).toEqual({ status: 'secret' })
  })
})
