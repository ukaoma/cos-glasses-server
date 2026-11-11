// Sessions chat-style layout, step 2a: the list keeps COS pins and folder members past the window, the cap and the
// limit (ghost report item 1), and /older answers the rest of 30 days as short rows (S1_CONTRACT_step2a.md B1, B2).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_SESSION_PER_PROVIDER_LIMIT, agentSessionRoots, emptySessionListDropped, listAgentSessions } from './agent-session-store.js'
import { __resetOlderTitleMemoForTests, listOlderSessions, olderTitleStats } from './agent-session-older.js'

const roots: string[] = []
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
beforeEach(() => __resetOlderTitleMemoForTests())

const NOW = new Date('2026-11-10T23:00:00Z')
const DAY = 24 * 3600 * 1000
const uuid = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'cos-step2a-')); roots.push(h); return h
}
function claude(h: string, n: number, ageMs: number, title = `Session ${n}`, folder = 'MU-Chief-Staff'): string {
  const dir = join(h, '.claude', 'projects', folder)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${uuid(n)}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: title })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: `ask ${n}` } })}\n`)
  const at = (NOW.getTime() - ageMs) / 1000
  utimesSync(file, at, at)
  return uuid(n)
}

function codex(h: string, id: string, ageMs: number, title = `Codex ${id.slice(0, 8)}`): string {
  const dir = join(h, '.codex', 'sessions', '2026', '11', '01')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-11-01T10-00-00-${id}.jsonl`)
  writeFileSync(file, [
    { timestamp: '2026-11-01T10:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/x/MU-Chief-Staff', timestamp: '2026-11-01T10:00:00.000Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n')
  const at = (NOW.getTime() - ageMs) / 1000
  utimesSync(file, at, at)
  return id
}

describe('the main list keeps COS pins and folder members (B1)', () => {
  it('with no keep set it is exactly today: 7 days, 20 per agent', async () => {
    const h = home()
    for (let i = 0; i < 25; i++) claude(h, i, i * 3600_000)
    claude(h, 99, 10 * DAY)
    const dropped = emptySessionListDropped()
    const rows = await listAgentSessions(agentSessionRoots(h), NOW, [], 80, 'updated', dropped)
    expect(rows).toHaveLength(AGENT_SESSION_PER_PROVIDER_LIMIT)
    expect(dropped).toMatchObject({ age: 1, limit: 5 })
  })

  it('a kept session is listed at any age, outside the per-agent cap and outside `limit`, and is not marked pinned', async () => {
    const h = home()
    for (let i = 0; i < 25; i++) claude(h, i, i * 3600_000)
    const old = claude(h, 99, 40 * DAY, 'October release notes')
    const capped = uuid(24) // the 25th newest: dropped by the cap without the keep set
    const keep = { claude: new Set([old, capped]) }
    const rows = await listAgentSessions(agentSessionRoots(h), NOW, [], 5, 'updated', emptySessionListDropped(), undefined, keep)
    const ids = rows.map(r => r.session_id)
    expect(ids).toContain(old)
    expect(ids).toContain(capped)
    expect(rows.filter(r => !keep.claude.has(r.session_id))).toHaveLength(5) // `limit` still applies to the rest
    expect(rows.find(r => r.session_id === old)).toMatchObject({ display_label: 'October release notes', pinned: false })
  })

  it('a kept session stays on the Opened clock too, whatever its start date', async () => {
    const h = home()
    claude(h, 1, 3600_000)
    const old = claude(h, 2, 40 * DAY)
    const rows = await listAgentSessions(agentSessionRoots(h), NOW, [], 80, 'opened', emptySessionListDropped(), undefined, { claude: new Set([old]) })
    expect(rows.map(r => r.session_id)).toContain(old)
  })
})

describe('older sessions as short rows (B2)', () => {
  it('answers days 8 to 30 and the capped rows, short, newest first, and counts what is older', async () => {
    const h = home()
    for (let i = 0; i < 22; i++) claude(h, i, i * 3600_000)      // 22 in 7 days: 2 past the cap
    claude(h, 50, 9 * DAY, 'Nine days old')
    claude(h, 51, 29 * DAY, 'Twenty-nine days old')
    claude(h, 52, 31 * DAY, 'Past the window')
    claude(h, 53, 40 * DAY, 'Way past')
    const { rows, nextBefore, olderThanWindow } = await listOlderSessions(agentSessionRoots(h), NOW, { days: 30, limit: 200 })
    expect(rows.map(r => r.display_label)).toContain('Nine days old')
    expect(rows.map(r => r.display_label)).toContain('Twenty-nine days old')
    expect(rows.map(r => r.display_label)).not.toContain('Past the window')
    expect(rows.map(r => r.session_id)).toContain(uuid(21)) // a capped 7-day row is reachable here
    expect(olderThanWindow).toBe(2)
    expect(nextBefore).toBeNull()
    for (const r of rows) {
      expect(r.form).toBe('short')
      expect(Object.keys(r).sort()).toEqual(['created', 'display_label', 'form', 'modified', 'project', 'provider', 'session_id'])
    }
    const times = rows.map(r => Date.parse(r.modified))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('pages by `before` with no row repeated or skipped', async () => {
    const h = home()
    for (let i = 0; i < 12; i++) claude(h, i, (i + 1) * DAY)
    const seen: string[] = []
    let before: number | undefined
    for (let page = 0; page < 10; page++) {
      const r = await listOlderSessions(agentSessionRoots(h), NOW, { days: 30, limit: 5, ...(before ? { before } : {}) })
      seen.push(...r.rows.map(x => x.session_id))
      if (!r.nextBefore) break
      before = Date.parse(r.nextBefore)
    }
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => uuid(i)))
  })

  it('leaves out excluded (live, COS-kept) ids, the agent’s own pins and keep-warm sessions', async () => {
    const h = home()
    const kept = claude(h, 1, 9 * DAY)
    const starred = claude(h, 2, 9 * DAY)
    claude(h, 3, 9 * DAY, 'ready')
    claude(h, 4, 9 * DAY, 'An ordinary one')
    const config = join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    mkdirSync(join(config, '..'), { recursive: true })
    writeFileSync(config, JSON.stringify({ preferences: { epitaxyPrefs: { 'starred-local-code-sessions': [`local_${starred}`] } } }))
    const { rows } = await listOlderSessions(agentSessionRoots(h), NOW, { exclude: { claude: new Set([kept]) } })
    expect(rows.map(r => r.display_label)).toEqual(['An ordinary one'])
  })

  it('kept ids come back at any age, outside `days`, and are not counted as older (lead ruling: never silently dropped)', async () => {
    const h = home()
    const pinned = claude(h, 1, 90 * DAY, 'Pinned in July')
    claude(h, 2, 90 * DAY, 'Just old')
    const { rows, olderThanWindow } = await listOlderSessions(agentSessionRoots(h), NOW, { days: 30, keep: { claude: new Set([pinned]) } })
    expect(rows.map(r => r.display_label)).toEqual(['Pinned in July'])
    expect(olderThanWindow).toBe(1)
  })

  it('a repeat call reads no title again (memo on mtime and size)', async () => {
    const h = home()
    for (let i = 0; i < 6; i++) claude(h, i, (i + 8) * DAY)
    await listOlderSessions(agentSessionRoots(h), NOW, {})
    const reads = olderTitleStats.reads
    expect(reads).toBe(6)
    await listOlderSessions(agentSessionRoots(h), NOW, {})
    expect(olderTitleStats.reads).toBe(reads)
  })
})

// Q1 FIX 1 (2026-11-10 23:06): kept rows are bounded, ranked, and counted when cut; native pins keep today's rule.
describe('the keep ceiling (Q1 FIX 1)', () => {
  it('at most KEPT_LIST_MAX kept rows, COS pins and folders before COS-started, the rest counted in dropped.kept', async () => {
    const { KEPT_LIST_MAX } = await import('./agent-session-store.js')
    const h = home()
    const pinnedIds: string[] = []
    for (let i = 0; i < KEPT_LIST_MAX; i++) pinnedIds.push(claude(h, 100 + i, (20 + i) * DAY))   // old: 20+ days
    const startedId = claude(h, 300, 2 * DAY) // newer than every pin, but ranked after them
    const dropped = emptySessionListDropped()
    const rows = await listAgentSessions(agentSessionRoots(h), NOW, [], 60, 'updated', dropped, undefined,
      { claude: new Set(pinnedIds) }, { claude: new Set([startedId]) })
    const ids = rows.map(r => r.session_id)
    expect(pinnedIds.every(id => ids.includes(id))).toBe(true)
    expect(ids).not.toContain(startedId)
    expect(dropped.kept).toBe(1)
  })

  it('across agents: the ceiling holds at the merge, pins win over newer COS-started rows, and the cut is counted', async () => {
    // 30 Claude pins and 30 Codex COS-started sessions: each agent alone is under the ceiling, so only the merge cuts.
    const { KEPT_LIST_MAX } = await import('./agent-session-store.js')
    const h = home()
    const pins: string[] = []
    for (let i = 0; i < 30; i++) pins.push(claude(h, 600 + i, (20 + i) * DAY))
    const started: string[] = []
    for (let i = 0; i < 30; i++) started.push(codex(h, uuid(700 + i).replace('aaaa', 'c0de'), (2 * DAY) + i * 60_000))
    const dropped = emptySessionListDropped()
    const rows = await listAgentSessions(agentSessionRoots(h), NOW, [], 60, 'updated', dropped, undefined,
      { claude: new Set(pins) }, { codex: new Set(started) })
    const ids = new Set(rows.map(r => r.session_id))
    expect(rows).toHaveLength(KEPT_LIST_MAX)
    expect(pins.every(id => ids.has(id))).toBe(true)
    expect(started.filter(id => ids.has(id))).toEqual(started.slice(0, KEPT_LIST_MAX - 30)) // the newest ten
    expect(dropped.kept).toBe(60 - KEPT_LIST_MAX)
  })

  it('with nothing cut, dropped carries no `kept` key (an older reader sees the shape it knows)', async () => {
    const h = home()
    const id = claude(h, 1, 20 * DAY)
    const dropped = emptySessionListDropped()
    await listAgentSessions(agentSessionRoots(h), NOW, [], 60, 'updated', dropped, undefined, { claude: new Set([id]) })
    expect(Object.keys(dropped).sort()).toEqual(['age', 'limit', 'oversized'])
  })

  it('native pins stay inside `limit`, as before step 2a', async () => {
    const h = home()
    const config = join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    mkdirSync(join(config, '..'), { recursive: true })
    const stars: string[] = []
    for (let i = 0; i < 6; i++) stars.push(`local_${claude(h, 400 + i, (10 + i) * DAY)}`)
    writeFileSync(config, JSON.stringify({ preferences: { epitaxyPrefs: { 'starred-local-code-sessions': stars } } }))
    const rows = await listAgentSessions(agentSessionRoots(h), NOW, [], 3, 'updated', emptySessionListDropped())
    expect(rows).toHaveLength(3)
  })
})
