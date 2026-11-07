import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readCodexSubagentDetails } from './codex-subagent-activity.js'

// The Today summary's Codex sub-agents (readCodexSubagentDetails): direct children by name, newest first, at most six.
const now = Date.parse('2026-11-07T13:00:00Z')
const P = '019a0000-1111-2222-3333-444455556666'
const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
const ev = (type: string, offset = 0) => JSON.stringify({ timestamp: new Date(now + offset).toISOString(), type: 'event_msg', payload: { type } })

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cos-child-details-')); roots.push(home)
  const sessions = join(home, 'sessions'); mkdirSync(sessions)
  const db = join(home, 'state_7.sqlite')
  execFileSync('/usr/bin/sqlite3', [db, 'CREATE TABLE threads(id TEXT, rollout_path TEXT, archived INT, agent_nickname TEXT, agent_role TEXT, title TEXT, updated_at_ms INT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT, status TEXT);'])
  const child = (n: number, opts: { nick?: string; role?: string; title?: string; at: number; tail?: string; archived?: number; edge?: string }) => {
    const id = `019a0000-1111-2222-3333-${String(n).padStart(12, '0')}`, file = join(sessions, `rollout-${id}.jsonl`)
    if (opts.tail) writeFileSync(file, opts.tail + '\n')
    const q = (v?: string) => (v === undefined ? 'NULL' : `'${v.replace(/'/g, "''")}'`)
    execFileSync('/usr/bin/sqlite3', [db, `INSERT INTO threads VALUES('${id}','${file}',${opts.archived ?? 0},${q(opts.nick)},${q(opts.role)},${q(opts.title)},${opts.at}); INSERT INTO thread_spawn_edges VALUES('${P}','${id}','${opts.edge ?? 'open'}');`])
  }
  return { sessions, db, child }
}

describe('readCodexSubagentDetails', () => {
  it('names each child by nickname, else role; its task is its title; state from its own rollout; newest first, six at most', async () => {
    const f = fixture()
    // Inserted oldest first, so the order the answer comes in is the query's, not the table's.
    for (let n = 5; n < 12; n++) f.child(n, { nick: 'old' + n, title: 't', at: now - 3_600_000 - n })
    f.child(1, { nick: 'Ada', title: 'Fix the cache', at: now - 60_000, tail: ev('task_started', -30_000) })
    f.child(2, { role: 'reviewer', title: 'Review the diff', at: now - 120_000, tail: ev('task_started', -200_000) + '\n' + ev('task_complete', -120_000) })
    f.child(3, { title: 'Archived one', at: now - 180_000, archived: 1 })
    f.child(4, { nick: 'Closed edge', title: 'x', at: now, edge: 'closed' })
    const out = (await readCodexSubagentDetails([P, 'not-a-uuid'], f.sessions, now)).get(P.toLowerCase())!
    expect(out).toHaveLength(6)
    expect(out.slice(0, 3)).toEqual([
      { name: 'Ada', task: 'Fix the cache', state: 'active', at: now - 60_000 },
      { name: 'reviewer', task: 'Review the diff', state: 'completed', at: now - 120_000 },
      { name: 'agent', task: 'Archived one', state: 'completed', at: now - 180_000 },
    ])
    expect(out.map(d => d.name)).not.toContain('Closed edge')
    expect(JSON.stringify(out)).not.toMatch(/019a0000|rollout|sessions/)
  })
  it('no snapshot or a broken one is an empty answer, never a made-up child', async () => {
    const f = fixture()
    execFileSync('/usr/bin/sqlite3', [f.db, 'DROP TABLE thread_spawn_edges;'])
    expect((await readCodexSubagentDetails([P], f.sessions, now)).size).toBe(0)
    const bare = mkdtempSync(join(tmpdir(), 'cos-child-none-')); roots.push(bare); mkdirSync(join(bare, 'sessions'))
    expect((await readCodexSubagentDetails([P], join(bare, 'sessions'), now)).size).toBe(0)
  })
})
