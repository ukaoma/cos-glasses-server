import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  agentSessionRoots,
  composeDiscussionDigest,
  composeDiscussionSummary,
  DISCUSSION_DIGEST_MAX,
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
  parseAgentSession,
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

    const firefliesId = '019f1111-2222-3333-4444-555555555555'
    const firefliesDay = join(home, '.codex', 'sessions', '2026', '08', '13')
    mkdirSync(firefliesDay, { recursive: true })
    const firefliesFile = join(firefliesDay, `rollout-2026-08-13T16-38-12-${firefliesId}.jsonl`)
    writeFileSync(firefliesFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: firefliesId, cwd: '/repo', timestamp: '2026-08-13T16:38:12Z' },
    })}\n${JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Sync Fireflies' }] },
    })}\n`)
    touch(firefliesFile, new Date(listingNow.getTime() + 60_000))
    writeFileSync(
      join(home, '.codex', 'session_index.jsonl'),
      [
        JSON.stringify({ id, thread_name: 'Markt POS 2.0 build' }),
        JSON.stringify({ id: jewelryId, thread_name: 'Jewelry 2.0 Build' }),
        JSON.stringify({ id: firefliesId, thread_name: 'Fireflies meeting sync' }),
      ].join('\n') + '\n',
    )
    const merged = await listAgentSessions(agentSessionRoots(home), listingNow, [], 20, 'updated')
    expect(merged[0].display_label).toBe('Fireflies meeting sync')
    expect(merged[0].pinned).toBe(false)
    expect(merged.findIndex(row => row.display_label === 'Markt POS 2.0 build'))
      .toBeLessThan(merged.findIndex(row => row.display_label === 'Jewelry 2.0 Build'))

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

describe('deep discussion digest (session body, not the row)', () => {
  const turns = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `Turn ${i + 1}: do the thing number ${i + 1}`)

  it('keeps the LIST row at 180 chars while the body goes deep', () => {
    // Miles: "It should be in the body not the title. the row should be no more than
    // the 180 characters." Two fields, two budgets — pinned so a later change that
    // widens the summary cannot quietly wreck the single-line row.
    const row = composeDiscussionSummary({
      title: 'T', firstPrompt: 'x'.repeat(500), latestAssistant: 'y'.repeat(500),
    })
    expect(row.length).toBeLessThanOrEqual(180)

    const body = composeDiscussionDigest({ userTurns: turns(40), latestAssistant: 'Shipped it.' })
    expect(body.length).toBeGreaterThan(180)
    expect(body.length).toBeLessThanOrEqual(DISCUSSION_DIGEST_MAX)
  })

  it('states elision instead of silently dropping turns', () => {
    const body = composeDiscussionDigest({ userTurns: turns(80), latestAssistant: 'Done.' })
    expect(body).toMatch(/… \d+ earlier turns …/)
  })

  it('reports the TRUE dropped count when the caller passes a bounded sample', () => {
    // The store keeps head + a 60-turn window; without totalTurns the elision line
    // would count only what the buffer held and under-report the rest.
    const sample = [...turns(2), ...turns(60)]
    const body = composeDiscussionDigest({
      userTurns: sample, latestAssistant: 'Done.', totalTurns: 900,
    })
    const m = /… (\d+) earlier turns …/.exec(body)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(800)
  })

  it('reserves the opening ask, then weights recency', () => {
    // Realistic turn length (~150 chars), not the toy 30-char kind: at 2000 chars a
    // toy fixture holds 50+ turns and nothing gets dropped, so the test would prove
    // nothing about elision. Real prompts are paragraphs.
    const real = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `Turn ${i + 1}: ${'detail '.repeat(20)}marker${i + 1}`)
    const body = composeDiscussionDigest({ userTurns: real(60), latestAssistant: 'Done.' })
    // The framing survives — this is the regression that shipped first: filling from
    // the end left no budget for the opening ask.
    expect(body).toContain('Turn 1:')
    // The most recent turn survives, because a follow-up continues from there.
    expect(body).toContain('marker60')
    // The middle is dropped, and says so.
    expect(body).not.toContain('marker30')
    expect(body).toMatch(/… \d+ earlier turns …/)
    expect(body.length).toBeLessThanOrEqual(DISCUSSION_DIGEST_MAX)
  })

  it('caps a single enormous paste so one turn cannot eat the budget', () => {
    const body = composeDiscussionDigest({ userTurns: ['z'.repeat(9000)], latestAssistant: '' })
    expect(body.length).toBeLessThanOrEqual(DISCUSSION_DIGEST_MAX)
    expect(body).toContain('…')
  })

  it('returns empty when there is nothing to say', () => {
    expect(composeDiscussionDigest({ userTurns: [], latestAssistant: '' })).toBe('')
  })
})

describe('oversized transcripts are read in part, not refused', () => {
  it('parses a file over the ceiling via head+tail and says it is truncated', async () => {
    // The route used to answer 413 above 32 MiB, so the biggest sessions were
    // unopenable. Build a transcript past a small ceiling and prove both ends survive.
    const dir = mkdtempSync(join(tmpdir(), 'cos-big-session-'))
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl')
    const rec = (role: string, text: string): string =>
      JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }] } })
    const lines = [rec('user', 'OPENING ASK marker-head')]
    // Filler large enough to push past the ceiling used below.
    for (let i = 0; i < 4000; i++) lines.push(rec('user', `filler turn ${i} ${'x'.repeat(200)}`))
    lines.push(rec('user', 'FINAL ASK marker-tail'))
    lines.push(rec('assistant', 'Wrapped it up.'))
    writeFileSync(file, lines.join('\n') + '\n')

    const parsed = await parseAgentSession('claude', file, {
      maxBytes: 64 * 1024, headBytes: 16 * 1024, tailBytes: 16 * 1024,
    })
    expect(parsed.truncated).toBe(true)
    // Both ends are present — that is the whole point of head+tail.
    expect(parsed.discussion_digest).toContain('marker-head')
    expect(parsed.discussion_digest).toContain('marker-tail')
    // And it does NOT print a turn count it cannot know.
    expect(parsed.discussion_digest).toContain('middle of a large session not read')
    expect(parsed.discussion_digest).not.toMatch(/… \d+ earlier turns …/)
    expect(parsed.discussion_digest.length).toBeLessThanOrEqual(DISCUSSION_DIGEST_MAX)
    // PROOF that only two windows were read, not the whole file. Without this the
    // suite passed even with windowing removed entirely — the flag and the markers
    // are both true of a whole-file read, so they discriminate nothing. 4002 user
    // turns were written; a head+tail read must see a small fraction of them.
    expect(parsed.user_message_count).toBeGreaterThan(0)
    expect(parsed.user_message_count).toBeLessThan(1000)
  })

  it('reads a small file whole and reports truncated false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-small-session-'))
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff.jsonl')
    const rec = (role: string, text: string): string =>
      JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }] } })
    writeFileSync(file, [rec('user', 'just one ask'), rec('assistant', 'done')].join('\n') + '\n')
    const parsed = await parseAgentSession('claude', file, { maxBytes: 32 * 1024 * 1024 })
    expect(parsed.truncated).toBe(false)
    expect(parsed.user_message_count).toBe(1)
  })

  it('keeps slash-command scaffolding out of the digest', () => {
    // <command-message> wrappers landed in the two most valuable slots before this.
    const body = composeDiscussionDigest({
      userTurns: ['Are we on the latest server?'],
      latestAssistant: 'Yes.',
    })
    expect(body).toContain('Are we on the latest server?')
    expect(body).not.toContain('<command-message>')
  })
})
