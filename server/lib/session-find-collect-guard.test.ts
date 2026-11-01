import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

// A transcript removed between the head read and the title read must not fail the whole search.
vi.mock('./agent-session-store.js', async importOriginal => ({ ...await importOriginal<typeof import('./agent-session-store.js')>(), lastCustomTitle: vi.fn(async () => { throw new Error('ENOENT') }) }))

it('falls back to the first line when the custom title cannot be read', async () => {
  const { SessionFindCollector } = await import('./session-find-collect.js')
  const { agentSessionRoots } = await import('./agent-session-store.js')
  const home = mkdtempSync(join(tmpdir(), 'session find guard.'))
  try {
    const dir = join(home, '.claude', 'projects', '-Users-test-proj')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, '00000001-0000-4000-8000-000000000001.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'A prompt whose title read fails' }, timestamp: '2026-10-31T10:00:00.000Z' }) + '\n')
    utimesSync(file, new Date('2026-10-31T10:00:01Z'), new Date('2026-10-31T10:00:01Z'))
    const pool = await new SessionFindCollector().collect({ roots: agentSessionRoots(home), limit: 254 })
    expect(pool.candidates.map(c => c.title)).toEqual(['A prompt whose title read fails'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})
