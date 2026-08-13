import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionsRouter } from './agent-sessions.js'
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
    cursorComposerDb: join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    cursorWorkspaceStorage: join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
  }
  mkdirSync(roots.claudeProjects, { recursive: true })
  mkdirSync(roots.codexSessions, { recursive: true })
  mkdirSync(roots.cursorProjects, { recursive: true })
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
    const store = readFileSync(new URL('../lib/agent-session-store.ts', import.meta.url), 'utf8')
    expect(store).toMatch('end = HEAD_BYTES - 1')
    const { roots } = fixtureHome()
    const file = join(roots.codexSessions, '2026/08/13', 'rollout-2026-08-13T12-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl')
    const meta = '{"type":"session_meta","payload":{"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","cwd":"/repo","timestamp":"2026-08-13T12:00:00.000Z"}}'
    writeJsonl(file, [meta, `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"${'x'.repeat(400_000)}"}]}}`])
    touch(file, listingNow)
    const listed = await listCodexSessions(roots.codexSessions, listingNow)
    expect(listed.some(row => row.session_id === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true)
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
