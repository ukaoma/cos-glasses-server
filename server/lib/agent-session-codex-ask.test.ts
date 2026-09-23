// A Codex session's title, first prompt and DISCUSSION are what the person asked
// (6.52.0), tested by EXECUTION over temp rollouts in the shapes measured on this Mac.
//
// The defect: Codex writes the repo's AGENTS.md as a user message ("# AGENTS.md
// instructions for /Users/…"), the FIRST user row in 469 of this Mac's rollouts, and
// every Codex reader took the first user row as the ask. Content below is invented;
// the record and block shapes are real.

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, afterAll } from 'vitest'
import {
  codexUserText,
  listCodexSessions,
  parseAgentSession,
  peekCodexMeta,
  type AgentSessionRoots,
} from './agent-session-store.js'
import { recentSessionTurns, sessionTurnFromRecord } from './agent-session-turns.js'
import { searchAgentSessions } from './agent-session-search.js'
import { agentSessionsRouter } from '../routes/agent-sessions.js'

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})

const THREAD = '019e1111-2222-7333-8444-555566667777'
const AGENTS_BLOCK = '# AGENTS.md instructions for /Users/example/repo\n\n<INSTRUCTIONS>\nUse zebrafish naming everywhere.\n</INSTRUCTIONS>'
const ENV_BLOCK = '<environment_context>\n  <cwd>/Users/example/repo</cwd>\n</environment_context>'

function userRow(...texts: string[]) {
  return JSON.stringify({ timestamp: '2026-09-19T16:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: texts.map(text => ({ type: 'input_text', text })) } })
}
function assistantRow(text: string) {
  return JSON.stringify({ timestamp: '2026-09-19T16:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], phase: 'final_answer' } })
}
const META = JSON.stringify({ timestamp: '2026-09-19T16:00:00.000Z', type: 'session_meta', payload: { id: THREAD, cwd: '/Users/example/repo', cli_version: '0.155.0-alpha.9.2', history_mode: 'paginated', timestamp: '2026-09-19T16:00:00.000Z' } })

/** A rollout that opens the way 469 of this Mac's do: AGENTS.md first, then the ask. */
const ROLLOUT = [
  META,
  userRow(AGENTS_BLOCK, ENV_BLOCK),
  userRow('Prep the LightRAG index update'),
  assistantRow('Queue has 12 pending meetings. Starting batch 1.'),
  userRow('<image name=[Image #1]>', '</image>', 'Why is this chunk failing?'),
  assistantRow('The chunk exceeds the token limit.'),
  userRow('# Files mentioned by the user:\n\n## plan.md: /Users/example/plan.md\n\n## My request for Codex:\nFollow the plan in this file'),
  assistantRow('Following the plan.'),
]

function writeRollout(home: string, lines: string[], day = new Date()): string {
  const [y, m, d] = day.toISOString().slice(0, 10).split('-')
  const file = join(home, '.codex', 'sessions', y, m, d, `rollout-${y}-${m}-${d}T09-00-00-${THREAD}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
  utimesSync(file, day, day)
  return file
}

function roots(home: string): AgentSessionRoots {
  return {
    claudeProjects: join(home, '.claude', 'projects'),
    claudeDesktopConfig: join(home, 'claude_desktop_config.json'),
    claudeCodeSessions: join(home, 'claude-code-sessions'),
    codexSessions: join(home, '.codex', 'sessions'),
    cursorProjects: join(home, '.cursor', 'projects'),
    cursorChats: join(home, '.cursor', 'chats'),
    cursorComposerDb: join(home, 'state.vscdb'),
    cursorWorkspaceStorage: join(home, 'workspaceStorage'),
  }
}

describe('codexUserText', () => {
  it('reads a user row block by block', () => {
    expect(codexUserText(JSON.parse(userRow(AGENTS_BLOCK, ENV_BLOCK)).payload)).toBeNull()
    expect(codexUserText(JSON.parse(userRow('<image name=[Image #1]>', '</image>', 'Look at this')).payload)).toBe('Look at this')
    expect(codexUserText({ content: 'plain string content' })).toBe('plain string content')
    expect(codexUserText({ content: [{ type: 'input_image', image_url: 'data:x' }, { type: 'output_text', text: 'not a user block' }] })).toBeNull()
    expect(codexUserText({ content: 42 })).toBeNull()
  })
})

describe('parseAgentSession for Codex', () => {
  it('never titles, first-prompts or discusses the AGENTS.md block', async () => {
    const home = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-codex-ask-')))
    const file = writeRollout(home, ROLLOUT)
    const detail = await parseAgentSession('codex', file)
    expect(detail.display_label).toBe('Prep the LightRAG index update')
    expect(detail.first_prompt).toBe('Prep the LightRAG index update')
    expect(detail.discussion_digest).not.toMatch(/AGENTS\.md|zebrafish|environment_context/)
    expect(detail.discussion_digest).toContain('Why is this chunk failing?')
    expect(detail.discussion_digest).toContain('Follow the plan in this file')
    expect(detail.discussion_digest).not.toContain('# Files mentioned by the user')
    expect(detail.user_message_count).toBe(3)
    expect(detail.assistant_message_count).toBe(3)
  })

  it('takes the Codex thread name as the title when it has one, and keeps the ask as first_prompt', async () => {
    const home = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-codex-ask-')))
    const file = writeRollout(home, ROLLOUT)
    const detail = await parseAgentSession('codex', file, { codexThreadName: '  Prep LightRAG index update ' })
    expect(detail.display_label).toBe('Prep LightRAG index update')
    expect(detail.first_prompt).toBe('Prep the LightRAG index update')
    expect(detail.discussion_summary.startsWith('Prep the LightRAG index update')).toBe(true)
  })

  it('a thread name never reaches a Claude or Cursor detail', async () => {
    const home = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-codex-ask-')))
    const file = join(home, 'claude.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'user', sessionId: 's1', message: { role: 'user', content: 'Real Claude ask' } })}\n`)
    const detail = await parseAgentSession('claude', file, { codexThreadName: 'Wrong name' })
    expect(detail.display_label).toBe('Real Claude ask')
  })
})

describe('the Codex list row and search', () => {
  it('peekCodexMeta titles by the ask, so the list row DISCUSSION does not open with AGENTS.md', async () => {
    const home = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-codex-ask-')))
    const file = writeRollout(home, ROLLOUT)
    expect((await peekCodexMeta(file))?.title).toBe('Prep the LightRAG index update')
    const rows = await listCodexSessions(roots(home).codexSessions, new Date())
    const row = rows.find(r => r.session_id === THREAD)
    expect(row?.display_label).toBe('Prep the LightRAG index update')
    expect(row?.first_prompt).toBe('Prep the LightRAG index update')
    expect(row?.discussion_summary ?? '').not.toMatch(/AGENTS\.md/)
  })

  it('search does not match the AGENTS.md text nobody typed, and still matches the ask', async () => {
    const home = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-codex-ask-')))
    writeRollout(home, ROLLOUT)
    const noEmbed = async () => ({ reason: 'no_session_embeddings' as const })
    // The haystack keeps the FIRST line of each user row, so the line that leaked was the
    // block's heading: "# AGENTS.md instructions for /Users/example/repo".
    for (const query of ['AGENTS.md instructions', 'zebrafish']) {
      const byRules = await searchAgentSessions({ query, roots: roots(home), now: new Date(), embedTexts: noEmbed })
      expect(byRules.hits.some(hit => hit.session_id === THREAD), query).toBe(false)
    }
    const byAsk = await searchAgentSessions({ query: 'LightRAG index', roots: roots(home), now: new Date(), embedTexts: noEmbed })
    expect(byAsk.hits.some(hit => hit.session_id === THREAD)).toBe(true)
  })
})

describe('recent turns for Codex', () => {
  it('reads the ask after an image and out of an attached-file message', () => {
    const turns = recentSessionTurns('codex', ROLLOUT, 10)
    expect(turns.filter(t => t.role === 'user').map(t => t.text)).toEqual([
      'Prep the LightRAG index update',
      'Why is this chunk failing?',
      'Follow the plan in this file',
    ])
    expect(sessionTurnFromRecord('codex', JSON.parse(userRow(AGENTS_BLOCK, ENV_BLOCK)))).toBeNull()
  })
})

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

describe('the detail route titles a Codex thread by its own name (6.52.0)', () => {
  it('uses session_index.jsonl keyed by the rollout filename, and falls back to the ask', async () => {
    const home = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-codex-ask-route-')))
    const previous = process.env.COS_AGENT_SESSIONS_HOME
    const previousCodexHome = process.env.CODEX_HOME
    process.env.COS_AGENT_SESSIONS_HOME = home
    process.env.CODEX_HOME = join(home, '.codex')
    // A CLONE: the meta carries its parent's id; the filename carries its own.
    const parent = '019e9999-2222-7333-8444-555566667777'
    writeRollout(home, [META.replace(THREAD, parent), ...ROLLOUT.slice(1)])
    try {
      const app = express()
      app.use('/api', agentSessionsRouter)
      const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
      })
      closers.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      const unnamed = await (await fetch(`${base}/api/agent-sessions/codex/${THREAD}`)).json() as Record<string, unknown>
      expect(unnamed.display_label).toBe('Prep the LightRAG index update')
      expect(unnamed.first_prompt).toBe('Prep the LightRAG index update')

      writeFileSync(join(home, '.codex', 'session_index.jsonl'), [
        JSON.stringify({ id: parent, thread_name: 'Parent thread name' }),
        JSON.stringify({ id: THREAD, thread_name: 'Prep LightRAG index update', updated_at: '2026-09-19T16:00:00Z' }),
      ].join('\n') + '\n')
      const named = await (await fetch(`${base}/api/agent-sessions/codex/${THREAD}`)).json() as Record<string, unknown>
      expect(named.display_label).toBe('Prep LightRAG index update')
      expect(named.custom_title).toBe('Prep LightRAG index update')
      expect(named.first_prompt).toBe('Prep the LightRAG index update')
      expect(String(named.discussion_digest)).not.toMatch(/AGENTS\.md/)
      // A short id finds the rollout by filename; the name is keyed by the filename's id.
      const short = await (await fetch(`${base}/api/agent-sessions/codex/${THREAD.slice(0, 13)}`)).json() as Record<string, unknown>
      expect(short.display_label).toBe('Prep LightRAG index update')
    } finally {
      if (previous === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
      else process.env.COS_AGENT_SESSIONS_HOME = previous
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })
})
