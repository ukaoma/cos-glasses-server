import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  agentSessionRoots,
  composeDiscussionSummary,
  isKeepWarmSessionTitle,
  isScratchCursorProject,
  latestAssistantFromWindow,
  listAgentSessions,
  listClaudeSessions,
  listCodexSessions,
  listCursorSessions,
  loadClaudeStarredIds,
  loadCursorComposerNames,
  loadCursorPinnedIds,
} from './agent-session-store.js'

function touch(path: string, at: Date): void {
  const epoch = at.getTime() / 1000
  utimesSync(path, epoch, epoch)
}

function writeJsonl(path: string, lines: string[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, lines.join('\n') + '\n')
}

describe('scratch Cursor folders', () => {
  it('drops empty-window and temp clones', () => {
    expect(isScratchCursorProject('empty-window')).toBe(true)
    expect(isScratchCursorProject('var-folders-xyz')).toBe(true)
    expect(isScratchCursorProject('Users-ukaoma-Documents-GitHub-MU-Chief-Staff')).toBe(false)
  })
})

describe('Codex pins survive a May folder', () => {
  it('lists a stale pinned thread and a bulky file pinged today', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cos-agent-codex-'))
    const day = join(home, '.codex', 'sessions', '2026', '05', '08')
    mkdirSync(day, { recursive: true })
    const id = '019e0943-62c4-7643-bcff-1a7be9a52a4c'
    const file = join(day, `rollout-2026-05-08T15-24-31-${id}.jsonl`)
    const head = JSON.stringify({
      timestamp: '2026-05-08T20:24:36.565Z',
      type: 'session_meta',
      payload: {
        id,
        cwd: '/Users/ukaoma/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff',
        originator: 'Codex Desktop',
        timestamp: '2026-05-08T20:24:31.684Z',
      },
    })
    writeFileSync(file, `${head}\n${'x'.repeat(400 * 1024)}\n`)
    const listingNow = new Date('2026-08-13T18:48:00Z')
    touch(file, listingNow)
    writeFileSync(
      join(home, '.codex', 'session_index.jsonl'),
      `${JSON.stringify({ id, thread_name: 'Markt POS 2.0 build' })}\n`,
    )
    const jewelryId = '0196aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const jewelryDay = join(home, '.codex', 'sessions', '2026', '05', '06')
    mkdirSync(jewelryDay, { recursive: true })
    const jewelryFile = join(jewelryDay, `rollout-2026-05-06T12-00-00-${jewelryId}.jsonl`)
    writeFileSync(jewelryFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: jewelryId, cwd: '/repo', timestamp: '2026-05-06T12:00:00Z' },
    })}\n`)
    touch(jewelryFile, new Date('2026-05-06T12:00:00Z'))
    writeFileSync(
      join(home, '.codex', '.codex-global-state.json'),
      JSON.stringify({ 'pinned-thread-ids': [jewelryId, id] }),
    )
    writeFileSync(
      join(home, '.codex', 'session_index.jsonl'),
      [
        JSON.stringify({ id, thread_name: 'Markt POS 2.0 build' }),
        JSON.stringify({ id: jewelryId, thread_name: 'Jewelry 2.0 Build' }),
      ].join('\n') + '\n',
    )

    const updated = await listCodexSessions(join(home, '.codex', 'sessions'), listingNow)
    expect(updated.some(row => row.display_label === 'Markt POS 2.0 build')).toBe(true)
    expect(updated.some(row => row.display_label === 'Jewelry 2.0 Build' && row.pinned)).toBe(true)

    const opened = await listAgentSessions(
      agentSessionRoots(home),
      listingNow,
      [],
      20,
      'opened',
    )
    expect(opened.some(row => row.display_label === 'Markt POS 2.0 build')).toBe(false)
    expect(opened.some(row => row.display_label === 'Jewelry 2.0 Build')).toBe(false)

    const store = await readFile(new URL('./agent-session-store.ts', import.meta.url), 'utf8')
    const codexList = store.slice(
      store.indexOf('export async function listCodexSessions'),
      store.indexOf('export async function listCursorSessions'),
    )
    expect(codexList).not.toMatch('AGENT_SESSION_MAX_FILE_BYTES')
    expect(store).toMatch('end = HEAD_BYTES - 1')
  })
})

describe('Cursor sidebar names beat the last user_query', () => {
  it('skips empty-window and uses composerHeaders.name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cos-agent-cursor-'))
    const id = 'a488f8e0-d7e9-40e5-a1d5-61f0938fa790'
    const realDir = join(home, '.cursor', 'projects', 'Users-ukaoma-Documents-GitHub-MU-Chief-Staff', 'agent-transcripts', id)
    const scratchDir = join(home, '.cursor', 'projects', 'empty-window', 'agent-transcripts', id)
    const query = '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Briefly inform the user about the task result and perform any follow-up actions</user_query>"}]}}'
    writeJsonl(join(realDir, `${id}.jsonl`), [query])
    writeJsonl(join(scratchDir, `${id}.jsonl`), [query])
    const now = new Date('2026-08-13T19:10:00Z')
    touch(join(realDir, `${id}.jsonl`), now)
    touch(join(scratchDir, `${id}.jsonl`), new Date('2026-08-13T14:43:00Z'))

    const dbDir = join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')
    mkdirSync(dbDir, { recursive: true })
    const db = join(dbDir, 'state.vscdb')
    execFileSync('/usr/bin/sqlite3', [db, `
      CREATE TABLE composerHeaders (composerId TEXT, value TEXT);
      INSERT INTO composerHeaders VALUES ('${id}', '${JSON.stringify({ name: 'V2 verification and performance' })}');
    `])

    const unnamed = await listCursorSessions(join(home, '.cursor', 'projects'), now)
    expect(unnamed).toHaveLength(1)
    expect(unnamed[0].project).toBe('MU-Chief-Staff')
    expect(unnamed[0].display_label).toContain('Briefly inform the user')

    const named = await listCursorSessions(
      join(home, '.cursor', 'projects'),
      now,
      20,
      db,
    )
    expect(named).toHaveLength(1)
    expect(named[0].display_label).toBe('V2 verification and performance')

    const loaded = await loadCursorComposerNames(db)
    expect(loaded.get(id)).toBe('V2 verification and performance')
  })
})

describe('Claude Desktop stars and Cursor pinnedComposers', () => {
  it('lists a stale Claude star from Desktop even without project jsonl', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cos-agent-claude-pin-'))
    const starredId = 'f92b10f3-413a-461a-bee9-19d269355b15'
    const jsonlId = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
    const config = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    mkdirSync(join(config, '..'), { recursive: true })
    writeFileSync(config, JSON.stringify({
      preferences: {
        epitaxyPrefs: {
          'starred-local-code-sessions': [`local_${starredId}`, `local_${jsonlId}`],
        },
      },
    }))
    const desktopDir = join(
      home,
      'Library', 'Application Support', 'Claude', 'claude-code-sessions',
      'account', 'workspace',
    )
    mkdirSync(desktopDir, { recursive: true })
    const desktop = join(desktopDir, `local_${starredId}.json`)
    writeFileSync(desktop, JSON.stringify({
      sessionId: `local_${starredId}`,
      cwd: '/Users/ukaoma/Documents/GitHub/MU-Chief-Staff',
      title: 'ThriftCart end-of-year campaign design',
    }))
    const stale = new Date('2026-07-09T20:56:00Z')
    touch(desktop, stale)
    const proj = join(home, '.claude', 'projects', 'MU-Chief-Staff')
    mkdirSync(proj, { recursive: true })
    const jsonl = join(proj, `${jsonlId}.jsonl`)
    writeFileSync(jsonl, '{"type":"custom-title","customTitle":"COS-glasses Server work (meetings)"}\n{"type":"user","message":{"role":"user","content":"Meetings work"}}\n')
    touch(jsonl, new Date('2026-05-12T16:43:00Z'))
    const now = new Date('2026-08-13T19:30:00Z')
    const listed = await listClaudeSessions(
      join(home, '.claude', 'projects'),
      now,
      new Set(),
      20,
      await loadClaudeStarredIds(config),
      join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    )
    expect(listed.some(row => row.display_label === 'ThriftCart end-of-year campaign design' && row.pinned)).toBe(true)
    expect(listed.some(row => row.display_label === 'COS-glasses Server work (meetings)' && row.pinned)).toBe(true)
    expect(listed.every(row => row.pinned)).toBe(true)
  })

  it('lists a stale Cursor pin from workspaceStorage pinnedComposers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cos-agent-cursor-pin-'))
    const id = 'a488f8e0-d7e9-40e5-a1d5-61f0938fa790'
    const realDir = join(home, '.cursor', 'projects', 'Users-ukaoma-Documents-GitHub-MU-Chief-Staff', 'agent-transcripts', id)
    writeJsonl(join(realDir, `${id}.jsonl`), [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Briefly inform the user about the task result and perform any follow-up actions</user_query>"}]}}',
    ])
    touch(join(realDir, `${id}.jsonl`), new Date('2026-06-01T12:00:00Z'))
    const dbDir = join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')
    mkdirSync(dbDir, { recursive: true })
    const db = join(dbDir, 'state.vscdb')
    execFileSync('/usr/bin/sqlite3', [db, `
      CREATE TABLE composerHeaders (composerId TEXT, value TEXT);
      INSERT INTO composerHeaders VALUES ('${id}', '${JSON.stringify({ name: 'V2 verification and performance' })}');
    `])
    const wsDbDir = join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage', 'empty-window')
    mkdirSync(wsDbDir, { recursive: true })
    const wsDb = join(wsDbDir, 'state.vscdb')
    execFileSync('/usr/bin/sqlite3', [wsDb, `
      CREATE TABLE ItemTable (key TEXT, value BLOB);
      INSERT INTO ItemTable VALUES ('cursor/pinnedComposers', '${JSON.stringify([id])}');
    `])
    const now = new Date('2026-08-13T19:30:00Z')
    const pinned = await loadCursorPinnedIds(join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'))
    expect(pinned.has(id)).toBe(true)
    const unnamed = await listCursorSessions(join(home, '.cursor', 'projects'), now)
    expect(unnamed).toHaveLength(0)
    const listed = await listCursorSessions(
      join(home, '.cursor', 'projects'),
      now,
      20,
      db,
      pinned,
    )
    expect(listed).toHaveLength(1)
    expect(listed[0].display_label).toBe('V2 verification and performance')
    expect(listed[0].pinned).toBe(true)
    expect(listed[0].project).toBe('MU-Chief-Staff')
  })
})

describe('keep-warm Claude sessions stay out of the list', () => {
  it('skips ready and provider-proof titles so real chats fill the cap', async () => {
    expect(isKeepWarmSessionTitle('ready')).toBe(true)
    expect(isKeepWarmSessionTitle('This is an automated local readiness check. Do not use tools. Reply with exactly')).toBe(true)
    expect(isKeepWarmSessionTitle('Fireflies meeting sync')).toBe(false)

    const home = mkdtempSync(join(tmpdir(), 'cos-agent-warm-'))
    const proj = join(home, '.claude', 'projects', 'MU-Chief-Staff')
    mkdirSync(proj, { recursive: true })
    const now = new Date('2026-08-13T19:20:00Z')
    const ready = join(proj, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl')
    const proof = join(proj, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl')
    const real = join(proj, 'cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl')
    writeFileSync(ready, '{"type":"user","message":{"role":"user","content":"ready"}}\n')
    writeFileSync(proof, '{"type":"user","message":{"role":"user","content":"This is an automated local readiness check. Do not use tools. Reply with exactly COS_CONTROL_OK and nothing else."}}\n')
    writeFileSync(real, '{"type":"custom-title","customTitle":"Fireflies meeting sync"}\n{"type":"user","message":{"role":"user","content":"Sync Fireflies"}}\n')
    touch(ready, now)
    touch(proof, now)
    touch(real, new Date('2026-08-13T19:10:00Z'))

    const listed = await listClaudeSessions(join(home, '.claude', 'projects'), now, new Set())
    expect(listed.map(row => row.display_label)).toEqual(['Fireflies meeting sync'])
  })
})

describe('discussion gist', () => {
  it('joins first user turn and latest assistant without repeating the sidebar title', () => {
    expect(composeDiscussionSummary({
      title: 'POS complexity and competitive challenges',
      firstPrompt: 'Are there any calls and attention around this?',
      latestAssistant: 'We can do this or that depending on EWIC month-out.',
    })).toBe('Are there any calls and attention around this? · We can do this or that depending on EWIC month-out.')
    expect(composeDiscussionSummary({
      title: 'POS complexity and competitive challenges',
      firstPrompt: 'POS complexity and competitive challenges',
      latestAssistant: 'We can do this or that.',
    })).toBe('We can do this or that.')
  })

  it('reads the last assistant prose from a Claude window', () => {
    const window = [
      '{"type":"user","message":{"role":"user","content":"Are there any calls and attention around this?"}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"We can do this or that?"}]}}',
    ].join('\n')
    expect(latestAssistantFromWindow(window)).toBe('We can do this or that?')
  })

  it('lists a discussion gist next to the sidebar title', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cos-agent-gist-'))
    const proj = join(home, '.claude', 'projects', 'MU-Chief-Staff')
    mkdirSync(proj, { recursive: true })
    const now = new Date('2026-08-13T19:20:00Z')
    const file = join(proj, 'dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl')
    writeFileSync(file, [
      '{"type":"custom-title","customTitle":"POS complexity and competitive challenges"}',
      '{"type":"user","message":{"role":"user","content":"Are there any calls and attention around this?"}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"We can do this or that depending on EWIC."}]}}',
    ].join('\n') + '\n')
    touch(file, now)
    const listed = await listClaudeSessions(join(home, '.claude', 'projects'), now, new Set())
    expect(listed).toHaveLength(1)
    expect(listed[0].display_label).toBe('POS complexity and competitive challenges')
    expect(listed[0].first_prompt).toBe('Are there any calls and attention around this?')
    expect(listed[0].discussion_summary).toContain('Are there any calls and attention around this?')
    expect(listed[0].discussion_summary).toContain('We can do this or that depending on EWIC.')
  })
})
