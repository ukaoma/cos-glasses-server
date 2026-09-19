import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionsRouter, withRunning } from './agent-sessions.js'
import { __resetSessionHooksForTests, sessionSignalStore } from '../lib/session-hooks-runtime.js'
import type { OccupiedScan } from '../lib/occupied-threads.js'
import { lockSnapshotStats, resetLockSnapshot } from '../lib/occupancy-probes.js'
import { ACTIVE_RECENTLY_WINDOW_MS } from '../lib/thread-occupancy.js'
import { desktopAliasStats, resetDesktopAliasMemo } from '../lib/agent-session-store.js'
import {
  createdFromCodexFilename,
  idFromCodexFilename,
  listAgentSessions,
  listCodexSessions,
  listCursorSessions,
  loadCodexPinnedIds,
  loadCursorComposerNames,
  type AgentSessionRoots,
} from '../lib/agent-session-store.js'

const marktId = '019e0943-62c4-7643-bcff-1a7be9a52a4c'
const jewelryId = '019dfe42-d4ba-7152-b5ae-60f600a2675a'
const cursorId = 'bbbbbbbb-1111-2222-3333-cccccccccccc'
const listingNow = new Date('2026-08-13T18:00:00Z')

function writeJsonl(path: string, lines: string[]) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`)
}

function touch(path: string, date: Date) {
  utimesSync(path, date, date)
}

function fixtureHome(): { home: string; roots: AgentSessionRoots } {
  const home = mkdtempSync(join(tmpdir(), 'cos-agent-sessions-'))
  const roots: AgentSessionRoots = {
    claudeProjects: join(home, '.claude', 'projects'),
    claudeDesktopConfig: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    claudeCodeSessions: join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    codexSessions: join(home, '.codex', 'sessions'),
    cursorProjects: join(home, '.cursor', 'projects'),
    cursorChats: join(home, '.cursor', 'chats'),
    cursorComposerDb: join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    cursorWorkspaceStorage: join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
  }
  mkdirSync(roots.claudeProjects, { recursive: true })
  mkdirSync(roots.codexSessions, { recursive: true })
  mkdirSync(roots.cursorProjects, { recursive: true })
  mkdirSync(roots.cursorChats, { recursive: true })
  return { home, roots }
}

describe('agent session listing', () => {
  it('lists a Codex thread by last write even when the jsonl still lives in May', async () => {
    const { roots } = fixtureHome()
    const file = join(roots.codexSessions, '2026/05/08', `rollout-2026-05-08T15-24-31-${marktId}.jsonl`)
    writeJsonl(file, [
      `{"timestamp":"2026-05-08T20:24:36.565Z","type":"session_meta","payload":{"id":"${marktId}","cwd":"/Users/ukaoma/Documents/GitHub/MU-Chief-Staff","originator":"Codex Desktop","timestamp":"2026-05-08T20:24:31.684Z"}}`,
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Plan Markt POS case study build"}]}}',
    ])
    touch(file, listingNow)
    writeFileSync(
      join(roots.codexSessions, '..', 'session_index.jsonl'),
      `{"id":"${marktId}","thread_name":"Markt POS 2.0 build","updated_at":"2026-05-13T22:02:18Z"}\n`,
    )
    const listed = await listCodexSessions(roots.codexSessions, listingNow)
    expect(listed.some(row => row.display_label === 'Markt POS 2.0 build' && row.session_id === marktId)).toBe(true)
    expect(createdFromCodexFilename(`rollout-2026-05-08T15-24-31-${marktId}.jsonl`)).toMatch(/^2026-05-08T/)
    expect(idFromCodexFilename(`rollout-2026-05-08T15-24-31-${marktId}.jsonl`)).toBe(marktId)
  })

  it('Opened hides a May Codex thread that was only written today', async () => {
    const { roots } = fixtureHome()
    const file = join(roots.codexSessions, '2026/05/08', `rollout-2026-05-08T15-24-31-${marktId}.jsonl`)
    writeJsonl(file, [
      `{"type":"session_meta","payload":{"id":"${marktId}","cwd":"/repo","timestamp":"2026-05-08T20:24:31.684Z"}}`,
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Plan Markt POS"}]}}',
    ])
    touch(file, listingNow)
    const updated = await listAgentSessions(roots, listingNow, [], 20, 'updated')
    const opened = await listAgentSessions(roots, listingNow, [], 20, 'opened')
    expect(updated.some(row => row.session_id === marktId)).toBe(true)
    expect(opened.some(row => row.session_id === marktId)).toBe(false)
  })

  it('keeps ChatGPT pinned Codex threads even when they are weeks stale', async () => {
    const { roots } = fixtureHome()
    const file = join(roots.codexSessions, '2026/05/06', `rollout-2026-05-06T12-08-05-${jewelryId}.jsonl`)
    writeJsonl(file, [
      `{"type":"session_meta","payload":{"id":"${jewelryId}","cwd":"/repo","timestamp":"2026-05-06T17:08:05.000Z"}}`,
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Jewelry Edge bridge"}]}}',
    ])
    touch(file, new Date('2026-05-06T17:08:05Z'))
    writeFileSync(join(roots.codexSessions, '..', 'session_index.jsonl'), `{"id":"${jewelryId}","thread_name":"Jewelry 2.0 Build"}\n`)
    writeFileSync(join(roots.codexSessions, '..', '.codex-global-state.json'), JSON.stringify({ 'pinned-thread-ids': [jewelryId] }))
    const pinned = await loadCodexPinnedIds(roots.codexSessions)
    expect(pinned.has(jewelryId)).toBe(true)
    const listed = await listCodexSessions(roots.codexSessions, listingNow)
    const row = listed.find(entry => entry.session_id === jewelryId)
    expect(row?.display_label).toBe('Jewelry 2.0 Build')
    expect(row?.pinned).toBe(true)
  })

  it('uses Cursor sidebar names and drops the empty-window copy of the same chat', async () => {
    const { roots } = fixtureHome()
    const query = '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Briefly inform the user about the task result and perform any follow-up actions</user_query>"}]}}'
    const real = join(roots.cursorProjects, 'Users-ukaoma-Documents-GitHub-MU-Chief-Staff', 'agent-transcripts', cursorId, `${cursorId}.jsonl`)
    const ghost = join(roots.cursorProjects, 'empty-window', 'agent-transcripts', cursorId, `${cursorId}.jsonl`)
    writeJsonl(real, [query])
    writeJsonl(ghost, [query])
    touch(real, listingNow)
    touch(ghost, new Date('2026-08-13T04:18:00Z'))
    mkdirSync(dirname(roots.cursorComposerDb), { recursive: true })
    execFileSync('/usr/bin/sqlite3', [
      roots.cursorComposerDb,
      `CREATE TABLE composerHeaders (composerId TEXT, value TEXT);
       INSERT INTO composerHeaders VALUES ('${cursorId}', '{"name":"V2 verification and performance"}');`,
    ])
    const names = await loadCursorComposerNames(roots.cursorComposerDb)
    expect(names.get(cursorId)).toBe('V2 verification and performance')
    const listed = await listCursorSessions(roots.cursorProjects, listingNow, 20, roots.cursorComposerDb)
    expect(listed).toHaveLength(1)
    expect(listed[0].display_label).toBe('V2 verification and performance')
    expect(listed[0].project).toBe('MU-Chief-Staff')
  })

  it('caps Codex list peeks so a 512 KB head does not read the rest of the file', async () => {
    // The source-text assertion that opened this test is gone. The fixture below already
    // proves the behaviour, and reading the module's characters cannot observe whether the
    // head window is respected at runtime -- it only observes that a string is present.
    const { roots } = fixtureHome()
    const file = join(roots.codexSessions, '2026/08/13', 'rollout-2026-08-13T12-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl')
    const meta = '{"type":"session_meta","payload":{"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","cwd":"/repo","timestamp":"2026-08-13T12:00:00.000Z"}}'
    writeJsonl(file, [meta, `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"${'x'.repeat(400_000)}"}]}}`])
    touch(file, listingNow)
    const listed = await listCodexSessions(roots.codexSessions, listingNow)
    expect(listed.some(row => row.session_id === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true)
  })

  it('exposes discussion_summary on list entries', () => {
    const source = readFileSync(new URL('./agent-sessions.ts', import.meta.url), 'utf8')
    expect(source).toMatch('discussion_summary: row.discussion_summary')
    expect(source).toMatch('first_prompt: row.first_prompt || row.display_label')
    expect(source).toMatch('discussion_summary: parsed.discussion_summary')
  })
})

/**
 * The detail payload, fetched over HTTP rather than read as source text.
 *
 * The sibling test above asserts on the file's CHARACTERS, which cannot tell whether
 * a field survives JSON serialization or whether the handler reaches it at all. The
 * bug being fixed here was precisely a field that did not exist on the wire, so the
 * proof has to be the wire.
 */
describe('the newest assistant reply on the detail payload', () => {
  const detailId = 'aaaaaaaa-bbbb-cccc-dddd-777777777777'

  /** Realistic prose of an exact length: a short string cannot reproduce a
   *  truncation bug, and a repeated character cannot show where a cut landed. */
  function replyOfLength(total: number, marker = 'FINAL-WORDS-MARKER'): string {
    const unit = 'The three caps sit in series so raising one alone only moves the ceiling. '
    let body = ''
    while (body.length < total) body += unit
    body = body.slice(0, total - marker.length).replace(/\s+$/, '')
    return body.padEnd(total - marker.length, 'z') + marker
  }

  it('serves an 1821-char reply whole, without disturbing the older fields', async () => {
    const { home, roots } = fixtureHome()
    const reply = replyOfLength(1821)
    writeJsonl(join(roots.claudeProjects, '-repo', `${detailId}.jsonl`), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Why did my reply get cut off?' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } }),
    ])

    const previous = process.env.COS_AGENT_SESSIONS_HOME
    process.env.COS_AGENT_SESSIONS_HOME = home
    try {
      const base = await startSearchServer()
      const res = await fetch(`${base}/api/agent-sessions/claude/${detailId}`)
      expect(res.status).toBe(200)
      const body = await res.json() as {
        latest_reply: string
        discussion_summary: string
        discussion_digest: string
      }

      // Whole, ending included. 160 characters is what used to arrive.
      expect(body.latest_reply).toBe(reply)
      expect(body.latest_reply).toHaveLength(1821)
      expect(body.latest_reply.endsWith('FINAL-WORDS-MARKER')).toBe(true)

      // ADDITIVE. A client that has never heard of `latest_reply` reads these two
      // exactly as it did before, so an older app keeps working against this server.
      expect(body.discussion_summary.length).toBeGreaterThan(0)
      expect(body.discussion_summary.length).toBeLessThanOrEqual(180)
      expect(body.discussion_digest).toContain('Latest:')
      expect(body.discussion_digest).not.toContain('FINAL-WORDS-MARKER')
      expect(body.discussion_digest.length).toBeLessThanOrEqual(2000)
    } finally {
      if (previous === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
      else process.env.COS_AGENT_SESSIONS_HOME = previous
    }
  })
})

const closers: Array<() => Promise<void>> = []

async function startSearchServer(): Promise<string> {
  const app = express()
  app.use('/api', agentSessionsRouter)
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  closers.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

describe('agent session list route reports dropped caps', () => {
  it('puts dropped on the wire even when every count is zero', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cos-agent-list-drops-'))
    const previous = process.env.COS_AGENT_SESSIONS_HOME
    process.env.COS_AGENT_SESSIONS_HOME = home
    // The list now probes the locks directory up front; point it at the fixture so
    // this test never scans the real ~/.codex (a 3 s lsof on a busy Mac).
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = join(home, '.codex')
    try {
      const base = await startSearchServer()
      const res = await fetch(`${base}/api/agent-sessions?limit=20`)
      expect(res.status).toBe(200)
      const body = await res.json() as {
        dropped: { age: number; limit: number; oversized: number }
        sessions: unknown[]
      }
      expect(body.dropped).toEqual({ age: 0, limit: 0, oversized: 0 })
      expect(Array.isArray(body.sessions)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
      else process.env.COS_AGENT_SESSIONS_HOME = previous
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })
})

describe('last activity and last tool on the wire (6.45.5)', () => {
  it('reads them from the transcript records, not the file time, on the list and the detail', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cos-agent-activity-'))
    const previous = process.env.COS_AGENT_SESSIONS_HOME
    process.env.COS_AGENT_SESSIONS_HOME = home
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = join(home, '.codex')
    const id = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
    const now = new Date()
    const day = now.toISOString().slice(0, 10).split('-')
    const file = join(home, '.codex', 'sessions', day[0], day[1], day[2], `rollout-${day.join('-')}T09-00-00-${id}.jsonl`)
    const lastTurn = new Date(now.getTime() - 3 * 60 * 60_000).toISOString()
    writeJsonl(file, [
      JSON.stringify({ timestamp: new Date(now.getTime() - 4 * 60 * 60_000).toISOString(), type: 'session_meta', payload: { id, cwd: '/Users/x/project' } }),
      JSON.stringify({ timestamp: new Date(now.getTime() - 4 * 60 * 60_000).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Tidy the session list' }] } }),
      JSON.stringify({ timestamp: lastTurn, type: 'response_item', payload: { type: 'function_call', name: 'apply_patch' } }),
      JSON.stringify({ timestamp: now.toISOString(), type: 'event_msg', payload: { type: 'token_count' } }),
    ])
    touch(file, now)
    try {
      const base = await startSearchServer()
      const list = await (await fetch(`${base}/api/agent-sessions?limit=20`)).json() as { sessions: Array<Record<string, unknown>> }
      const row = list.sessions.find(entry => entry.session_id === id)
      expect(row, 'the fixture thread is listed').toBeTruthy()
      expect(row!.last_activity_at).toBe(lastTurn)
      expect(row!.last_tool).toBe('apply_patch')
      expect(row!.modified).not.toBe(lastTurn)
      expect(row).not.toHaveProperty('file')
      const detail = await (await fetch(`${base}/api/agent-sessions/codex/${id}`)).json() as Record<string, unknown>
      expect(detail.last_activity_at).toBe(lastTurn)
      expect(detail.last_tool).toBe('apply_patch')
      expect(detail).not.toHaveProperty('file')
    } finally {
      if (previous === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
      else process.env.COS_AGENT_SESSIONS_HOME = previous
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })
})

describe('last activity for a Claude thread after a Desktop relaunch (6.45.5)', () => {
  it('ignores the relaunch bookkeeping on the list and the detail', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cos-agent-activity-claude-'))
    const previous = process.env.COS_AGENT_SESSIONS_HOME
    process.env.COS_AGENT_SESSIONS_HOME = home
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = join(home, '.codex')
    const id = '5f0c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5'
    const now = new Date()
    const proj = join(home, '.claude', 'projects', 'MU-Chief-Staff')
    mkdirSync(proj, { recursive: true })
    const file = join(proj, `${id}.jsonl`)
    const asked = new Date(now.getTime() - 50 * 60 * 60_000).toISOString()
    const answered = new Date(now.getTime() - 49 * 60 * 60_000).toISOString()
    writeJsonl(file, [
      JSON.stringify({ type: 'user', timestamp: asked, message: { role: 'user', content: 'Tidy the sessions list' } }),
      JSON.stringify({ type: 'assistant', timestamp: answered, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: now.toISOString() }),
      JSON.stringify({ type: 'queue-operation', operation: 'dequeue', timestamp: now.toISOString() }),
    ])
    touch(file, now)
    try {
      const base = await startSearchServer()
      const list = await (await fetch(`${base}/api/agent-sessions?limit=20`)).json() as { sessions: Array<Record<string, unknown>> }
      const row = list.sessions.find(entry => entry.session_id === id)
      expect(row, 'the fixture Claude thread is listed').toBeTruthy()
      expect(row!.last_activity_at).toBe(answered)
      expect(row!.last_tool).toBe('Edit')
      expect(row).not.toHaveProperty('file')
      const detail = await (await fetch(`${base}/api/agent-sessions/claude/${id}`)).json() as Record<string, unknown>
      expect(detail.last_activity_at).toBe(answered)
      expect(detail).not.toHaveProperty('file')
    } finally {
      if (previous === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
      else process.env.COS_AGENT_SESSIONS_HOME = previous
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })
})

describe('agent session search route', () => {
  it('registers lookup before the provider detail route', () => {
    const source = readFileSync(new URL('./agent-sessions.ts', import.meta.url), 'utf8')
    expect(source.indexOf("/agent-sessions/search")).toBeGreaterThan(0)
    expect(source.indexOf("/agent-sessions/search")).toBeLessThan(source.indexOf('/agent-sessions/:provider/:sessionId'))
  })

  it('rejects a short query and returns an empty lookup against an empty home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cos-agent-search-route-'))
    const previous = process.env.COS_AGENT_SESSIONS_HOME
    process.env.COS_AGENT_SESSIONS_HOME = home
    try {
      const base = await startSearchServer()
      const tooShort = await fetch(`${base}/api/agent-sessions/search?q=T`)
      expect(tooShort.status).toBe(400)
      expect(await tooShort.json()).toMatchObject({ reason: 'invalid_query' })

      const empty = await fetch(`${base}/api/agent-sessions/search?q=Toast`)
      expect(empty.status).toBe(200)
      const body = await empty.json() as { hits: unknown[]; keywordCount: number }
      expect(body.hits).toEqual([])
      expect(body.keywordCount).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
      else process.env.COS_AGENT_SESSIONS_HOME = previous
    }
  })
})

// The three wire keys the lens reads by exact name. A rename on this side is
// completely silent here and shows up on the glasses as a session that is
// forever merely "open", so the names are pinned by a test rather than by
// whoever last read the route.
describe('the running stamp the lens reads', () => {
  const ID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
  const scanWith = (over: Partial<{ owners: number; foreignOwners: number; activeRecently: boolean }>): OccupiedScan => ({
    occupied: new Map([[ID, { threadId: ID, owners: 1, foreignOwners: 0, activeRecently: false, ...over }]]),
    degraded: false,
  })

  it('reports a thread nobody holds as running:false and NOT active', () => {
    const out = withRunning({ session_id: ID }, { occupied: new Map(), degraded: false })
    expect(out.running).toBe(false)
    expect(out.running_foreign).toBe(false)
    expect(out.running_active).toBe(false)
  })

  it('separates HELD from WORKING: an open window is running but not active', () => {
    // This is the exact case that made the lens lie. A finished session with the
    // Mac window still up keeps its registry record, so running stays true; only
    // running_active clears, and only because the transcript stopped growing.
    const out = withRunning({ session_id: ID }, scanWith({ activeRecently: false }))
    expect(out.running).toBe(true)
    expect(out.running_active).toBe(false)
  })

  it('raises running_active when the transcript is being written', () => {
    const out = withRunning({ session_id: ID }, scanWith({ activeRecently: true }))
    expect(out.running).toBe(true)
    expect(out.running_active).toBe(true)
  })

  it('keeps foreign orthogonal to active: a desktop agent can be working', () => {
    const out = withRunning({ session_id: ID }, scanWith({ foreignOwners: 1, activeRecently: true }))
    expect(out.running_foreign).toBe(true)
    expect(out.running_active).toBe(true)
  })

  it('carries the original row fields through untouched', () => {
    const out = withRunning({ session_id: ID, display_label: 'keep me' }, scanWith({}))
    expect(out.display_label).toBe('keep me')
    expect(out.session_id).toBe(ID)
  })
})

describe('Cursor running_active reaches the wire', () => {
  async function withCursorHome(mtime: Date, run: (base: string, id: string) => Promise<void>) {
    const { home, roots } = fixtureHome()
    const id = cursorId
    const file = join(
      roots.cursorProjects,
      'Users-ukaoma-Documents-GitHub-MU-Chief-Staff',
      'agent-transcripts',
      id,
      `${id}.jsonl`,
    )
    writeJsonl(file, [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Fix session landing</user_query>"}]}}',
    ])
    touch(file, mtime)
    const previous = process.env.COS_AGENT_SESSIONS_HOME
    process.env.COS_AGENT_SESSIONS_HOME = home
    try {
      await run(await startSearchServer(), id)
    } finally {
      if (previous === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
      else process.env.COS_AGENT_SESSIONS_HOME = previous
    }
  }

  it('stamps a just-written Cursor jsonl as working on detail, not the list', async () => {
    await withCursorHome(new Date(), async (base, id) => {
      const listed = await (await fetch(`${base}/api/agent-sessions?limit=20`)).json() as {
        sessions: Array<{ session_id: string; running?: boolean; running_active?: boolean; running_foreign?: boolean }>
      }
      // List occupancy does not invent a Cursor process owner from jsonl mtime.
      expect(listed.sessions.find(s => s.session_id === id)).toMatchObject({
        running: false, running_active: false,
      })
      const detail = await fetch(`${base}/api/agent-sessions/cursor/${id}`)
      expect(detail.status).toBe(200)
      expect(await detail.json()).toMatchObject({
        running: true, running_active: true, running_foreign: false, running_stamped: true,
      })
    })
  })

  it('does not stamp a Cursor jsonl that stopped two minutes ago', async () => {
    await withCursorHome(new Date(Date.now() - 120_000), async (base, id) => {
      const listed = await (await fetch(`${base}/api/agent-sessions?limit=20`)).json() as {
        sessions: Array<{ session_id: string; running?: boolean; running_active?: boolean }>
      }
      expect(listed.sessions.find(s => s.session_id === id)).toMatchObject({
        running: false, running_active: false,
      })
      expect(await (await fetch(`${base}/api/agent-sessions/cursor/${id}`)).json()).toMatchObject({
        running: false, running_active: false, running_stamped: true,
      })
    })
  })
})

// 6.51.0: Cursor runs the COS session hook from ~/.claude/settings.json, so a composer's
// own events reach the signal store under its conversation id. Such a row gets the one
// derivation; a Cursor row nobody has heard from keeps the 6.50 shape.
describe('hook-grounded Cursor state on the wire (6.51.0)', () => {
  const saved = process.env.COS_SESSION_HOOKS
  afterEach(() => {
    if (saved === undefined) delete process.env.COS_SESSION_HOOKS
    else process.env.COS_SESSION_HOOKS = saved
    __resetSessionHooksForTests()
  })
  const envelope = (event: string, ts: number, payload: Record<string, unknown> = {}) =>
    ({ ts, ppid: 1, event, sessionId: cursorId, payload: { session_id: cursorId, conversation_id: cursorId, cursor_version: '3.21.13', ...payload } }) as never

  it('running while the composer\'s turn is open, idle after its Stop, and absent without events', async () => {
    process.env.COS_SESSION_HOOKS = '1'
    __resetSessionHooksForTests()
    const { home, roots } = fixtureHome()
    const file = join(roots.cursorProjects, 'Users-ukaoma-Documents-GitHub-MU-Chief-Staff', 'agent-transcripts', cursorId, `${cursorId}.jsonl`)
    writeJsonl(file, ['{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Wire the queue</user_query>"}]}}'])
    touch(file, new Date(Date.now() - 120_000))
    const previous = process.env.COS_AGENT_SESSIONS_HOME
    process.env.COS_AGENT_SESSIONS_HOME = home
    try {
      const base = await startSearchServer()
      const row = async () => ((await (await fetch(`${base}/api/agent-sessions?limit=20`)).json()) as { sessions: Array<Record<string, unknown>> })
        .sessions.find(s => s.session_id === cursorId)!
      const detail = async () => (await (await fetch(`${base}/api/agent-sessions/cursor/${cursorId}`)).json()) as Record<string, unknown>

      expect(await row()).not.toHaveProperty('agent_state')
      expect(await detail()).not.toHaveProperty('agent_state')

      const now = Date.now()
      sessionSignalStore.apply(envelope('SessionStart', now - 3_000, { model: 'composer' }))
      sessionSignalStore.apply(envelope('UserPromptSubmit', now - 2_000, { prompt: 'Wire the queue' }))
      sessionSignalStore.apply(envelope('PostToolUse', now - 1_000, { tool_name: 'Read', tool_input: { file_path: '/x' } }))
      expect(await row()).toMatchObject({ agent_state: 'running', state_source: 'hook' })
      expect(await detail()).toMatchObject({ agent_state: 'running', state_source: 'hook' })

      sessionSignalStore.apply(envelope('Stop', now, { status: 'completed' }))
      expect(await row()).toMatchObject({ agent_state: 'idle', state_source: 'hook' })
      expect(await detail()).toMatchObject({ agent_state: 'idle', state_source: 'hook' })
    } finally {
      if (previous === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
      else process.env.COS_AGENT_SESSIONS_HOME = previous
    }
  })
})

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Render epoch ms the way `ps -o lstart=` does under TZ=UTC (same helper as the probe suite). */
function psLstartUtc(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

describe('the list pays one alias load and one lock probe per request', () => {
  it('marks held Codex and Claude rows as running from one snapshot and one alias map', async () => {
    const { home, roots } = fixtureHome()
    const claudeId = '7f294432-c6b6-45b5-ba27-3a9b9ce1a33a'
    const file = join(roots.codexSessions, '2026/09/10', `rollout-2026-09-10T08-00-00-${marktId}.jsonl`)
    writeJsonl(file, [
      `{"timestamp":"2026-09-10T13:00:00.000Z","type":"session_meta","payload":{"id":"${marktId}","cwd":"/Users/ukaoma/Documents/GitHub/MU-Chief-Staff","originator":"Codex Desktop","timestamp":"2026-09-10T13:00:00.000Z"}}`,
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hold this thread open"}]}}',
    ])
    writeJsonl(join(roots.claudeProjects, 'repo', `${claudeId}.jsonl`), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'A live Claude window holds this' } }),
    ])
    // A registry record naming THIS process as the live holder of the Claude thread,
    // self-consistent the way the probe suite builds one.
    const sessionsDir = join(home, '.claude', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const socketPath = join(home, '.claude', `${process.pid}.sock`)
    writeFileSync(socketPath, '')
    writeFileSync(join(sessionsDir, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      sessionId: claudeId,
      procStart: psLstartUtc(Date.now() - process.uptime() * 1000),
      messagingSocketPath: socketPath,
      cwd: home,
      kind: 'interactive',
      entrypoint: 'claude-desktop',
    }))
    const locksDir = join(home, '.codex', 'thread-writer-locks')
    mkdirSync(locksDir, { recursive: true })
    const lock = join(locksDir, `${marktId}.lock`)
    writeFileSync(lock, '')
    const fd = openSync(lock, 'r+')
    const saved: Array<[string, string | undefined]> = []
    const setEnv = (key: string, value: string) => { saved.push([key, process.env[key]]); process.env[key] = value }
    setEnv('COS_AGENT_SESSIONS_HOME', home)
    setEnv('CODEX_HOME', join(home, '.codex'))
    setEnv('COS_CLAUDE_SESSIONS_DIR', sessionsDir)
    resetLockSnapshot()
    resetDesktopAliasMemo()
    try {
      const base = await startSearchServer()
      const first = await (await fetch(`${base}/api/agent-sessions?limit=20`)).json() as {
        sessions: Array<{ session_id: string; provider: string; running: boolean; running_foreign: boolean }>
        runningDegraded: boolean
      }
      expect(first.sessions.find(entry => entry.session_id === marktId)).toMatchObject({ running: true, running_foreign: true })
      expect(first.sessions.find(entry => entry.session_id === claudeId)).toMatchObject({ provider: 'claude', running: true })
      expect(first.runningDegraded).toBe(false)
      // One batched probe, no per-lock probe, one alias load — even though a held
      // Claude thread sent the route back through the finder for its mtime.
      expect(lockSnapshotStats).toEqual({ probes: 1, single: 0 })
      expect(desktopAliasStats.loads).toBe(1)
      // A second list inside the snapshot TTL spawns nothing and loads aliases once more.
      const second = await (await fetch(`${base}/api/agent-sessions?limit=20`)).json() as typeof first
      expect(second.sessions.find(entry => entry.session_id === marktId)?.running).toBe(true)
      expect(lockSnapshotStats).toEqual({ probes: 1, single: 0 })
      expect(desktopAliasStats.loads).toBe(2)
      // The detail route reads the same snapshot: no lsof for a thread the list just probed.
      const detail = await (await fetch(`${base}/api/agent-sessions/codex/${marktId}`)).json() as { running: boolean; running_stamped: boolean }
      expect(detail).toMatchObject({ running: true, running_stamped: true })
      expect(lockSnapshotStats).toEqual({ probes: 1, single: 0 })
    } finally {
      closeSync(fd)
      for (const [key, value] of saved.reverse()) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 20_000)
})

describe('working now on a held Claude thread follows the last real record (6.45.5)', () => {
  // A thread this process holds, whose transcript a relaunch's bookkeeping just wrote.
  async function heldClaude(lastRecordMs: number) {
    const { home, roots } = fixtureHome()
    const id = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
    const file = join(roots.claudeProjects, 'repo', `${id}.jsonl`)
    const now = new Date()
    writeJsonl(file, [
      JSON.stringify({ type: 'user', timestamp: new Date(lastRecordMs - 1_000).toISOString(), message: { role: 'user', content: 'Tidy the sessions list' } }),
      JSON.stringify({ type: 'assistant', timestamp: new Date(lastRecordMs).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: now.toISOString() }),
    ])
    touch(file, now)
    const sessionsDir = join(home, '.claude', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const socketPath = join(home, '.claude', `${process.pid}.sock`)
    writeFileSync(socketPath, '')
    writeFileSync(join(sessionsDir, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      sessionId: id,
      procStart: psLstartUtc(Date.now() - process.uptime() * 1000),
      messagingSocketPath: socketPath,
      cwd: home,
      kind: 'interactive',
      entrypoint: 'claude-desktop',
    }))
    const saved: Array<[string, string | undefined]> = []
    const setEnv = (key: string, value: string) => { saved.push([key, process.env[key]]); process.env[key] = value }
    setEnv('COS_AGENT_SESSIONS_HOME', home)
    setEnv('CODEX_HOME', join(home, '.codex'))
    setEnv('COS_CLAUDE_SESSIONS_DIR', sessionsDir)
    resetLockSnapshot()
    resetDesktopAliasMemo()
    try {
      const base = await startSearchServer()
      const list = await (await fetch(`${base}/api/agent-sessions?limit=20`)).json() as { sessions: Array<Record<string, unknown>> }
      const detail = await (await fetch(`${base}/api/agent-sessions/claude/${id}`)).json() as Record<string, unknown>
      return { row: list.sessions.find(entry => entry.session_id === id), detail }
    } finally {
      for (const [key, value] of saved.reverse()) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  it('does not read a relaunch write as work, on the list or the detail', async () => {
    const { row, detail } = await heldClaude(Date.now() - 10 * ACTIVE_RECENTLY_WINDOW_MS)
    expect(row, 'the held thread is listed').toMatchObject({ running: true, running_active: false })
    expect(detail).toMatchObject({ running: true, running_active: false })
  }, 20_000)

  it('still reads a record inside the window as work, so the check above can fail', async () => {
    const { row, detail } = await heldClaude(Date.now() - 2_000)
    expect(row, 'the held thread is listed').toMatchObject({ running: true, running_active: true })
    expect(detail).toMatchObject({ running: true, running_active: true })
  }, 20_000)
})

describe('6.50.0: ?turns=N on the detail route, the recent conversation for the lens', () => {
  const detailId = 'aaaaaaaa-bbbb-cccc-dddd-888888888888'
  const rows = [
    JSON.stringify({ type: 'user', timestamp: '2026-09-16T20:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'The prompt that started the run.' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T20:00:05.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } }),
    JSON.stringify({ type: 'user', toolUseResult: { stdout: 'a' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T20:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Found it. Fixing now.' }] } }),
  ]

  async function detail(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const { home, roots } = fixtureHome()
    writeJsonl(join(roots.claudeProjects, '-repo', `${detailId}.jsonl`), rows)
    const previous = process.env.COS_AGENT_SESSIONS_HOME
    process.env.COS_AGENT_SESSIONS_HOME = home
    try {
      const base = await startSearchServer()
      const res = await fetch(`${base}/api/agent-sessions/claude/${detailId}${query}`)
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    } finally {
      if (previous === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
      else process.env.COS_AGENT_SESSIONS_HOME = previous
    }
  }

  it('is absent unless asked, so the detail poll and every older client get the same payload', async () => {
    const plain = await detail('')
    expect(plain.status).toBe(200)
    expect(plain.body).not.toHaveProperty('recent_turns')
    expect(plain.body).not.toHaveProperty('recent_turns_more')
    const asked = await detail('?turns=20')
    // Every field the plain payload carries, unchanged (timestamps and live state aside).
    for (const key of Object.keys(plain.body)) {
      if (['created', 'modified', 'state_since', 'last_activity_at'].includes(key)) continue
      expect(asked.body[key], key).toEqual(plain.body[key])
    }
  })

  it('returns who spoke and what they said, tools left out, oldest first', async () => {
    const asked = await detail('?turns=20')
    expect(asked.body.recent_turns).toEqual([
      { role: 'user', text: 'The prompt that started the run.', at: '2026-09-16T20:00:00.000Z' },
      { role: 'assistant', text: 'Found it. Fixing now.', at: '2026-09-16T20:00:09.000Z' },
    ])
    expect(asked.body.recent_turns_more).toBe(false)
    const one = await detail('?turns=1')
    expect(one.body.recent_turns).toEqual([{ role: 'assistant', text: 'Found it. Fixing now.', at: '2026-09-16T20:00:09.000Z' }])
    expect(one.body.recent_turns_more).toBe(true)
  })

  it('ignores a malformed ask rather than refusing the detail page', async () => {
    for (const q of ['?turns=0', '?turns=abc', '?turns=1000', '?turns=']) {
      const res = await detail(q)
      expect(res.status, q).toBe(200)
      expect(res.body, q).not.toHaveProperty('recent_turns')
    }
  })
})
