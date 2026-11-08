/**
 * 7.0.5 preview engine: the preview resolver's read-time guards that only a changing filesystem can reach.
 *   - same file: a file that grows or is replaced while it is read is never served (identity before and after).
 *   - no link: a FOLDER on the path swapped for a link after the card was made is refused (O_NOFOLLOW guards only the
 *     last component; the realpath equality is what catches a parent).
 * `open` is wrapped so the file changes between the first stat and the read, the way a session writing its own report
 * would. The fixture root has a space and a dot component.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hook: { onRead: null | (() => void); opened: string[] } = { onRead: null, opened: [] }
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      hook.opened.push(String(args[0]))
      const read = handle.read.bind(handle)
      // The first read of the previewed file (not the transcript) is where a writer can slip in between the stat and the bytes.
      if (!String(args[0]).endsWith('PLAN.md')) return handle
      ;(handle as unknown as { read: unknown }).read = async (...a: unknown[]) => { const h = hook.onRead; hook.onRead = null; h?.(); return (read as (...x: unknown[]) => unknown)(...a) }
      return handle
    },
  }
})

const { AgentSessionOutputImages } = await import('./agent-session-output-images.js')
const { readRecentSessionTurns } = await import('./agent-session-turns.js')

const made: string[] = []
afterEach(() => { hook.onRead = null; hook.opened = []; for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true }) })

function fixture(text: string) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'cos identity-'))); made.push(top)
  const repo = join(top, 'home', 'Ukaoma Chief Of Staff', '.cos-repo')
  const sub = join(repo, 'wk45_2026')
  const elsewhere = join(top, 'home', 'elsewhere', 'wk45_2026')
  for (const d of [sub, elsewhere]) mkdirSync(d, { recursive: true })
  writeFileSync(join(sub, 'PLAN.md'), '# Plan\n')
  writeFileSync(join(elsewhere, 'PLAN.md'), '# Not the plan\n')
  const transcript = join(top, 'session.jsonl')
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-11-08T14:00:00Z', cwd: repo, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n')
  const service = new AgentSessionOutputImages({
    findSession: async (_p, id) => (id === 'session' ? transcript : null), workspace: async () => repo,
    secret: Buffer.alloc(32, 3), now: () => 1, home: () => join(top, 'home'), extraRoots: () => [],
    store: () => ({ ingestOutputImage: async () => ({ id: 'x' }), getContent: () => ({ status: 'unavailable' }) }) as never,
  })
  const firstId = async () => {
    const ctx = await service.context('claude', 'session', transcript)
    return (await readRecentSessionTurns('claude', transcript, 10, undefined, ctx.project)).turns[0].outputLinks![0].id
  }
  return { repo, sub, elsewhere, service, firstId }
}

describe('preview reads: the same file before and after', () => {
  it('a file that grows while it is read is not served; read again once it is still, it is', async () => {
    const f = fixture('[plan](wk45_2026/PLAN.md)')
    const id = await f.firstId()
    let fired = 0
    hook.onRead = () => { fired++; appendFileSync(join(f.sub, 'PLAN.md'), 'more words\n') }
    const r = await f.service.previewFile('claude', 'session', id)
    expect(fired, 'the writer ran between the stat and the read').toBe(1)
    expect(r.status).toBe('unavailable')
    const again = await f.service.previewFile('claude', 'session', id)
    expect(again.status).toBe('ok')
    if (again.status === 'ok') expect(again.bytes.toString()).toBe('# Plan\nmore words\n')
  })
  it('a file replaced by another (a new inode at the path) while it is read is not served', async () => {
    const f = fixture('[plan](wk45_2026/PLAN.md)')
    const id = await f.firstId()
    hook.onRead = () => { writeFileSync(join(f.sub, 'next.md'), '# Plan\n'); renameSync(join(f.sub, 'next.md'), join(f.sub, 'PLAN.md')) }
    expect((await f.service.previewFile('claude', 'session', id)).status).toBe('unavailable')
  })
})

describe('preview reads: no link anywhere on the path', () => {
  it('a parent folder swapped for a link to another folder after the card was made is refused', async () => {
    const f = fixture('[plan](wk45_2026/PLAN.md)')
    const id = await f.firstId()
    expect((await f.service.previewFile('claude', 'session', id)).status).toBe('ok')
    rmSync(f.sub, { recursive: true }); symlinkSync(f.elsewhere, f.sub)
    hook.opened = []
    const got = await f.service.previewFile('claude', 'session', id)
    expect(got.status).toBe('unavailable')
    // Refused before the file is even opened: not one byte of the other folder's file is read.
    expect(hook.opened.filter(p => p.endsWith('PLAN.md'))).toEqual([])
  })
})
