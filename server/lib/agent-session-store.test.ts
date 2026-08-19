import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  agentSessionRoots,
  composeDiscussionDigest,
  isWrapperPrompt,
  composeDiscussionSummary,
  DISCUSSION_DIGEST_MAX,
  isKeepWarmSessionTitle,
  isScratchCursorProject,
  lastRecordStart,
  latestAssistantFromWindow,
  latestAssistantReply,
  LATEST_REPLY_MAX,
  proseSnippet,
  tailWindowStart,
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

  it('spends the whole budget on RECENCY, not on the opening ask', () => {
    // REVERSED ON PURPOSE. This previously asserted the opposite -- that the opening
    // ask is reserved because it "frames everything after it" -- and Miles overruled it
    // from hardware, 2026-08-17, looking at a digest led by a question from the
    // previous day: "The discussion should show the questions that we're asking and a
    // summary of those most recent things, not something that's the 'first' message."
    //
    // The opening is not lost, it moved: `first_prompt` still carries it in full, which
    // is asserted in the head+tail tests below.
    //
    // Realistic turn length (~150 chars), not the toy 30-char kind: at 2000 chars a
    // toy fixture holds 50+ turns and nothing gets dropped, so the test would prove
    // nothing about elision. Real prompts are paragraphs.
    const real = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `Turn ${i + 1}: ${'detail '.repeat(20)}marker${i + 1}`)
    const body = composeDiscussionDigest({ userTurns: real(60), latestAssistant: 'Done.' })
    expect(body).not.toContain('marker1 ')
    expect(body).not.toContain('Turn 1:')
    // The newest turns are what a follow-up continues from, so they are what survives.
    expect(body).toContain('marker60')
    expect(body).toContain('marker59')
    // The turns it could not fit are still declared rather than silently dropped.
    expect(body).toMatch(/… \d+ earlier turns …/)
    expect(body.length).toBeLessThanOrEqual(DISCUSSION_DIGEST_MAX)
  })

  it('orders the surviving turns oldest to newest, so it reads forwards', () => {
    const real = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `Turn ${i + 1}: ${'detail '.repeat(20)}marker${i + 1}`)
    const body = composeDiscussionDigest({ userTurns: real(60), latestAssistant: 'Done.' })
    expect(body.indexOf('marker59')).toBeLessThan(body.indexOf('marker60'))
    // And the elision sits above them, because what it elides is older still.
    expect(body.indexOf('earlier turns')).toBeLessThan(body.indexOf('marker60'))
  })

  it('drops the compaction preamble instead of listing it as something Miles asked', () => {
    // From the 2026-08-17 screenshot. It is written as a USER turn by the harness and
    // it is RECENT -- compaction happens mid-session -- so recency ordering alone does
    // not remove it. Measured: 29 occurrences across the 25 most recent transcripts on
    // this machine, exactly one distinct opening.
    const preamble = 'This session is being continued from a previous conversation that ran out '
      + 'of context. The summary below covers the earlier portion of the conversation.'
    expect(isWrapperPrompt(preamble)).toBe(true)
    // A human sentence that merely mentions continuing is NOT the preamble.
    expect(isWrapperPrompt('Can we continue from a previous conversation about pricing?')).toBe(false)
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
    // Both ends are present — that is the whole point of head+tail. The HEAD proof
    // moved to `first_prompt` when the digest became recency-only: the digest no longer
    // reserves the opening, but the opening is still parsed and still published, which
    // is what this test actually needs to establish.
    expect(parsed.first_prompt).toContain('marker-head')
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

/**
 * Realistic assistant prose of an EXACT length, ending in a findable marker.
 *
 * A short string cannot reproduce a truncation bug, and `'x'.repeat(n)` cannot show
 * WHERE a cut landed — every prefix looks like every other. Real sentences plus a
 * terminal marker let a test prove the LAST words crossed the wire, which is the
 * whole complaint: Miles's reply arrived cut off mid-sentence.
 *
 * Deliberately free of double spaces, leading/trailing whitespace, fences and angle
 * brackets, so prose cleaning is a no-op and the length assertions measure the CAP
 * rather than the cleaner.
 */
function replyOfLength(total: number, marker = 'FINAL-WORDS-MARKER'): string {
  const unit = 'The three caps sit in series so raising one alone only moves the ceiling. '
  let body = ''
  while (body.length < total) body += unit
  body = body.slice(0, total - marker.length).replace(/\s+$/, '')
  return body.padEnd(total - marker.length, 'z') + marker
}

const rec = (role: string, text: string): string =>
  JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }] } })

describe('the newest assistant reply crosses the wire whole', () => {
  it('carries an 1821-char reply intact while the summary and digest keep their caps', async () => {
    // 1821 is the length of the reply that surfaced this: it reached the glasses as
    // 160 characters, cut mid-word, with nothing on screen to say so.
    const reply = replyOfLength(1821)
    expect(reply).toHaveLength(1821)
    const dir = mkdtempSync(join(tmpdir(), 'cos-latest-reply-'))
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-111111111111.jsonl')
    writeFileSync(file, [rec('user', 'Why did my reply get cut off?'), rec('assistant', reply)].join('\n') + '\n')

    const parsed = await parseAgentSession('claude', file)

    // THE FIX: whole, byte for byte, ending included.
    expect(parsed.latest_reply).toBe(reply)
    expect(parsed.latest_reply).toHaveLength(1821)
    expect(parsed.latest_reply.endsWith('FINAL-WORDS-MARKER')).toBe(true)

    // AND the two existing fields are untouched, which is the no-regression half.
    // The digest still carries only the 160-char snippet, so it must NOT contain the
    // ending — if it did, the digest budget had been raised behind our back.
    expect(parsed.discussion_summary.length).toBeLessThanOrEqual(180)
    expect(parsed.discussion_digest.length).toBeLessThanOrEqual(DISCUSSION_DIGEST_MAX)
    expect(parsed.discussion_digest).not.toContain('FINAL-WORDS-MARKER')
    expect(parsed.discussion_digest).toContain('Latest:')
  })

  it('marks a cut with an ellipsis instead of stopping mid-word', () => {
    const long = replyOfLength(LATEST_REPLY_MAX + 500)
    const cut = latestAssistantReply(long)
    expect(cut).toHaveLength(LATEST_REPLY_MAX)
    // Visibly truncated. `proseSnippet` ends in a bare slice, which is exactly how a
    // cut reply reached the lens looking like a complete one.
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).not.toContain('FINAL-WORDS-MARKER')
  })

  it('leaves a reply exactly at the cap alone', () => {
    const exact = replyOfLength(LATEST_REPLY_MAX)
    const kept = latestAssistantReply(exact)
    expect(kept).toBe(exact)
    expect(kept).not.toContain('…')
  })

  it('keeps proseSnippet on its old 160-char hard slice', () => {
    // The shared `proseBody` refactor must not have changed the summary path. 160,
    // no ellipsis, and the cut lands mid-word exactly as before.
    const long = replyOfLength(1821)
    expect(proseSnippet(long)).toHaveLength(160)
    expect(proseSnippet(long)).toBe(long.slice(0, 160))
    expect(proseSnippet(long)).not.toContain('…')
  })

  it('strips fences and wrappers the same way both fields always did', () => {
    expect(latestAssistantReply('before ```code fence dropped``` after')).toBe('before after')
    expect(latestAssistantReply('<user_query>tagged</user_query>')).toBe('tagged')
    expect(latestAssistantReply('SYSTEM INSTRUCTIONS do not surface this')).toBe('')
    expect(latestAssistantReply('')).toBe('')
  })
})

describe('the digest lists what is happening NOW, not the session opening', () => {
  // Every rule here was found by parsing Miles's own 94 MiB session, not by reading the
  // code. His screenshot led with a question from the previous day and a compaction
  // preamble, both presented as things he had asked.
  const rec = (role: string, text: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: role, ...extra, message: { role, content: [{ type: 'text', text }] } })

  it('drops rows the harness injected, using the flags rather than a guess', async () => {
    // MEASURED on the real transcript: a slash-command body carries `isMeta: true` and
    // a compaction preamble carries `isCompactSummary: true`. Both are written as USER
    // rows. Structural flags, so no markdown heuristic can misfire on a real paste.
    const dir = mkdtempSync(join(tmpdir(), 'cos-injected-'))
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-333333333333.jsonl')
    writeFileSync(file, [
      rec('user', '# COS Glasses Server Management\n\nStart and verify the stack.', { isMeta: true }),
      rec('user', 'This session is being continued from a previous conversation. Summary: things.',
        { isCompactSummary: true }),
      rec('user', 'REAL-ASK build the discussion recency fix now'),
      rec('assistant', 'On it.'),
    ].join('\n') + '\n')

    const parsed = await parseAgentSession('claude', file)
    expect(parsed.discussion_digest).toContain('REAL-ASK')
    expect(parsed.discussion_digest).not.toContain('COS Glasses Server Management')
    expect(parsed.discussion_digest).not.toContain('being continued from a previous')
  })

  it('trusts the isCompactSummary FLAG even when the wording is not the one we know', async () => {
    // The flag and the text pattern are belt-and-braces, and a mutation proved the
    // earlier test could not tell them apart: deleting the flag check still passed,
    // because the preamble REGEX caught the same row. The regex is a fallback for
    // providers that emit no flag; the flag has to stand on its own, or a compaction
    // whose wording changes by one word walks straight back into the digest.
    const dir = mkdtempSync(join(tmpdir(), 'cos-compactflag-'))
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-666666666666.jsonl')
    writeFileSync(file, [
      rec('user', 'Recap of the earlier discussion follows, with the key decisions.',
        { isCompactSummary: true }),
      rec('user', 'REAL-ASK ship it'),
      rec('assistant', 'Shipped.'),
    ].join('\n') + '\n')

    const parsed = await parseAgentSession('claude', file)
    expect(parsed.discussion_digest).toContain('REAL-ASK')
    expect(parsed.discussion_digest).not.toContain('Recap of the earlier discussion')
  })

  it('keeps the HEAD window out of the recency list on a truncated read', async () => {
    // The head window IS the session opening. On a large session the 60-turn window
    // never fills, so those turns survive to the top of the digest forever -- which is
    // exactly what Miles was looking at. The opening is still published as
    // `first_prompt`; it just stops occupying a list about what is happening now.
    const dir = mkdtempSync(join(tmpdir(), 'cos-headwin-'))
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-444444444444.jsonl')
    const lines = [rec('user', 'OPENING-ASK are we on the latest server?')]
    for (let i = 0; i < 4000; i++) lines.push(rec('assistant', `filler ${i} ${'x'.repeat(200)}`))
    lines.push(rec('user', 'RECENT-ASK build the recency fix'))
    lines.push(rec('assistant', 'Done.'))
    writeFileSync(file, lines.join('\n') + '\n')

    const parsed = await parseAgentSession('claude', file, {
      maxBytes: 64 * 1024, headBytes: 16 * 1024, tailBytes: 16 * 1024,
    })
    expect(parsed.truncated).toBe(true)
    expect(parsed.discussion_digest).toContain('RECENT-ASK')
    expect(parsed.discussion_digest).not.toContain('OPENING-ASK')
    // Still parsed, still published — moved, not lost.
    expect(parsed.first_prompt).toContain('OPENING-ASK')
  })

  it('does NOT thin a normal whole-file session, which is the common case', async () => {
    // A whole-file read yields tail:true for every line, so the head-window rule must
    // not touch it. Without this, narrowing the partial read could silently gut every
    // ordinary session — the digest would keep only whatever the last window held.
    const dir = mkdtempSync(join(tmpdir(), 'cos-wholefile-'))
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-555555555555.jsonl')
    writeFileSync(file, [
      rec('user', 'FIRST-ASK how does the parser work'),
      rec('assistant', 'Like so.'),
      rec('user', 'SECOND-ASK and the digest'),
      rec('assistant', 'Like this.'),
    ].join('\n') + '\n')

    const parsed = await parseAgentSession('claude', file)
    expect(parsed.truncated).toBe(false)
    expect(parsed.discussion_digest).toContain('FIRST-ASK')
    expect(parsed.discussion_digest).toContain('SECOND-ASK')
    // And in reading order.
    expect(parsed.discussion_digest.indexOf('FIRST-ASK'))
      .toBeLessThan(parsed.discussion_digest.indexOf('SECOND-ASK'))
  })
})

describe('"Latest" can never be a line from the session opening', () => {
  /** A transcript whose HEAD holds assistant prose and whose TAIL holds none — the
   *  shape that made a head record get published under the label "Latest:". */
  function headAssistantTailSilent(dir: string): string {
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-222222222222.jsonl')
    const lines = [
      rec('user', 'OPENING ASK marker-head'),
      rec('assistant', 'HEAD-ASSISTANT-FROM-THE-OPENING and then some prose after it.'),
    ]
    // A tail of nothing but tool traffic and user turns. Realistic: a long agentic
    // run ends in giant tool results, and assistant records carrying only tool_use
    // blocks yield no prose at all.
    for (let i = 0; i < 4000; i++) {
      lines.push(rec('user', `filler turn ${i} ${'x'.repeat(200)}`))
      if (i % 50 === 0) {
        lines.push(JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
        }))
      }
    }
    lines.push(rec('user', 'FINAL ASK marker-tail'))
    writeFileSync(file, lines.join('\n') + '\n')
    return file
  }

  it('publishes nothing rather than the wrong turn when the tail has no assistant prose', async () => {
    const file = headAssistantTailSilent(mkdtempSync(join(tmpdir(), 'cos-latest-head-')))
    const parsed = await parseAgentSession('claude', file, {
      maxBytes: 64 * 1024, headBytes: 16 * 1024, tailBytes: 16 * 1024,
    })
    expect(parsed.truncated).toBe(true)
    // Proof the head really was read, so this is a tail rule and not an empty parse.
    // Read from `first_prompt` rather than the digest, which is recency-only as of
    // 6.36.6 — the head is still parsed, it just no longer occupies the digest.
    expect(parsed.first_prompt).toContain('marker-head')
    expect(parsed.discussion_digest).toContain('marker-tail')

    // The opening assistant line must not appear anywhere as current state.
    expect(parsed.latest_reply).toBe('')
    expect(parsed.discussion_digest).not.toContain('HEAD-ASSISTANT-FROM-THE-OPENING')
    expect(parsed.discussion_summary).not.toContain('HEAD-ASSISTANT-FROM-THE-OPENING')
    expect(parsed.discussion_digest).not.toContain('Latest:')
  })

  it('still takes the latest from the tail when the tail does have prose', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-latest-tail-'))
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-333333333333.jsonl')
    const lines = [
      rec('user', 'OPENING ASK marker-head'),
      rec('assistant', 'HEAD-ASSISTANT-FROM-THE-OPENING and then some prose after it.'),
    ]
    for (let i = 0; i < 4000; i++) lines.push(rec('user', `filler turn ${i} ${'x'.repeat(200)}`))
    lines.push(rec('assistant', `TAIL-ASSISTANT-THE-REAL-LATEST ${replyOfLength(900)}`))
    writeFileSync(file, lines.join('\n') + '\n')

    const parsed = await parseAgentSession('claude', file, {
      maxBytes: 64 * 1024, headBytes: 16 * 1024, tailBytes: 16 * 1024,
    })
    expect(parsed.truncated).toBe(true)
    expect(parsed.latest_reply.startsWith('TAIL-ASSISTANT-THE-REAL-LATEST')).toBe(true)
    expect(parsed.latest_reply).toContain('FINAL-WORDS-MARKER')
    expect(parsed.latest_reply).not.toContain('HEAD-ASSISTANT-FROM-THE-OPENING')
  })

  it('reads a whole file as last-write-wins, unchanged', async () => {
    // A non-truncated read is ALL tail by definition, so the new rule must not have
    // quietly turned every small session's latest reply into nothing.
    const dir = mkdtempSync(join(tmpdir(), 'cos-latest-whole-'))
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-444444444444.jsonl')
    writeFileSync(file, [
      rec('user', 'first'),
      rec('assistant', 'EARLIER-REPLY'),
      rec('user', 'second'),
      rec('assistant', 'NEWEST-REPLY wins'),
    ].join('\n') + '\n')
    const parsed = await parseAgentSession('claude', file)
    expect(parsed.truncated).toBe(false)
    expect(parsed.latest_reply).toBe('NEWEST-REPLY wins')
  })
})

describe('a record bigger than the tail window does not empty the tail', () => {
  it('finds the last record start, ignoring a terminating newline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-record-start-'))
    const withNewline = join(dir, 'a.jsonl')
    writeFileSync(withNewline, 'AA\nBB\nCC\n')
    // 'CC' begins at 6. The trailing newline closes a record, it does not open one.
    expect(await lastRecordStart(withNewline, 9, 1024)).toBe(6)

    const withoutNewline = join(dir, 'b.jsonl')
    writeFileSync(withoutNewline, 'AA\nBB\nCC')
    expect(await lastRecordStart(withoutNewline, 8, 1024)).toBe(6)

    // One record, no boundary anywhere: the file starts it.
    const single = join(dir, 'c.jsonl')
    writeFileSync(single, 'ONLYONE')
    expect(await lastRecordStart(single, 7, 1024)).toBe(0)

    // Out of reach within the budget: say so rather than guessing.
    expect(await lastRecordStart(withNewline, 9, 2)).toBe(-1)
  })

  it('opens the tail at the record boundary when the final record straddles it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-tail-start-'))
    const file = join(dir, 'd.jsonl')
    // 100 bytes of small records, then one 60-byte final record. A 40-byte tail
    // window would open at 120, inside that final record, and see no complete record
    // at all. The boundary at 100 is what must be chosen instead.
    writeFileSync(file, 'x'.repeat(99) + '\n' + 'y'.repeat(59) + '\n')
    const size = 160
    expect(await tailWindowStart(file, size, 10, 40, 1024)).toBe(100)
    // A roomy window already contains complete records; nothing to recover, so the
    // cheaper ordinary start stands.
    expect(await tailWindowStart(file, size, 10, 120, 1024)).toBe(40)
  })

  it('still reads the newest reply when it is larger than the whole tail window', async () => {
    // The measured cliff: 14 records over 768 KiB exist in a 60-transcript sample on
    // this Mac, the largest 1,239,045 bytes — 1.58x the production window. When such
    // a record is the FINAL one, the window opens inside it, the fragment fails to
    // parse, and the tail contributes nothing: no recent turns, no latest reply.
    const dir = mkdtempSync(join(tmpdir(), 'cos-giant-record-'))
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-555555555555.jsonl')
    const lines = [rec('user', 'OPENING ASK marker-head')]
    for (let i = 0; i < 2000; i++) lines.push(rec('user', `filler turn ${i} ${'x'.repeat(200)}`))
    // Final record ~40 KiB against a 16 KiB tail window: 2.5x, the same shape as
    // 1.18 MiB against 768 KiB.
    const giant = `GIANT-FINAL-REPLY ${replyOfLength(40 * 1024)}`
    lines.push(rec('assistant', giant))
    writeFileSync(file, lines.join('\n') + '\n')

    const parsed = await parseAgentSession('claude', file, {
      maxBytes: 64 * 1024, headBytes: 16 * 1024, tailBytes: 16 * 1024,
    })
    expect(parsed.truncated).toBe(true)
    expect(parsed.latest_reply.startsWith('GIANT-FINAL-REPLY')).toBe(true)
    // Capped on the way out, and honestly marked as cut.
    expect(parsed.latest_reply).toHaveLength(LATEST_REPLY_MAX)
    expect(parsed.latest_reply.endsWith('…')).toBe(true)
  })

  it('recovers a final record that begins inside the head window, without double counting', async () => {
    // The awkward shape a mutation exposed: the final record starts BEFORE the head
    // window ends, so the tail has to open behind `headBytes` to reach it.
    //
    // That is safe, and the reason is worth stating because it is not obvious.
    // `lastRecordStart` returns the start of the LAST record, and the last record
    // always runs to EOF — past `maxBytes`, therefore past `headBytes`. So the head
    // pass can only ever see a PREFIX of it, which arrives as a trailing partial line
    // and is dropped by `parseJsonLine`. Every record that the head reads whole ends
    // before the last record begins. Nothing is read twice, and the counts below are
    // what prove it rather than the argument.
    const dir = mkdtempSync(join(tmpdir(), 'cos-head-straddle-'))
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-666666666666.jsonl')
    writeFileSync(file, [
      rec('user', 'OPENING ASK marker-head'),
      rec('assistant', `STRADDLING-FINAL-REPLY ${replyOfLength(80 * 1024)}`),
    ].join('\n') + '\n')

    const parsed = await parseAgentSession('claude', file, {
      maxBytes: 64 * 1024, headBytes: 16 * 1024, tailBytes: 16 * 1024,
    })
    expect(parsed.truncated).toBe(true)
    expect(parsed.latest_reply.startsWith('STRADDLING-FINAL-REPLY')).toBe(true)
    // Exactly one of each, counted once. A tail that reached back over complete
    // records would show two.
    expect(parsed.user_message_count).toBe(1)
    expect(parsed.assistant_message_count).toBe(1)
  })
})

describe('live Claude rows report the transcript mtime, not the registry heartbeat', () => {
  // `liveClaudeRows` (routes/agent-sessions.ts) builds `modified` from the peer
  // registry's `lastActiveAt`. That tracks the REGISTRY record, not the transcript,
  // so a session that is actively writing keeps reporting whenever the registry last
  // moved. Measured on three live sessions 2026-08-18: the wire said 55.3m / 407.7m /
  // 435.0m old while the transcripts had been written 0.1m / 0.2m / 5.1m earlier.
  //
  // Every other test in this file passes `[]` for live rows, so `enrichLiveClaude`
  // had NO execution coverage at all before this block.
  const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

  function fixture(): { home: string; file: string } {
    const home = mkdtempSync(join(tmpdir(), 'live-mtime-'))
    const dir = join(home, '.claude', 'projects', '-repo')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${SID}.jsonl`)
    writeFileSync(file, `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Rank order these activities' },
    })}\n`)
    return { home, file }
  }

  const liveRow = (staleISO: string) => ({
    session_id: SID,
    provider: 'claude' as const,
    display_label: 'COS-glasses Server work (meetings)',
    project: 'repo',
    modified: staleISO,
    created: staleISO,
    alive: true,
    state: 'running' as const,
    pinned: false,
  })

  it('replaces a stale heartbeat with the real transcript mtime', async () => {
    const { home, file } = fixture()
    const now = new Date('2026-08-18T20:00:00Z')
    const realWrite = new Date(now.getTime() - 60_000)          // wrote 1 min ago
    const staleHeartbeat = new Date(now.getTime() - 7 * 3600_000) // registry says 7h
    touch(file, realWrite)

    const rows = await listAgentSessions(
      agentSessionRoots(home), now, [liveRow(staleHeartbeat.toISOString())], 20, 'updated',
    )
    const row = rows.find(r => r.session_id === SID)
    expect(row, 'the live row survives the merge').toBeTruthy()
    // The whole point: a session written a minute ago must not report 7 hours old.
    expect(new Date(row!.modified).getTime()).toBe(realWrite.getTime())
    expect(new Date(row!.modified).getTime())
      .not.toBe(staleHeartbeat.getTime())
  })

  it('keeps the heartbeat when the transcript cannot be found', async () => {
    // Measured: 2 of 6 live rows had no transcript on disk. No file means no better
    // source, so the row must degrade to today's value rather than to nothing.
    //
    // WHAT THIS ACTUALLY COVERS: the `if (!found) return row` guard, which returns
    // BEFORE the stat. A mutation of the `st?.isFile ? ... : row.modified` fallback
    // survives this test, because that fallback only runs when the file was FOUND and
    // the stat then failed — a case this fixture cannot produce without a delete race.
    // Recorded rather than papered over: that branch is defensive and unreached.
    const home = mkdtempSync(join(tmpdir(), 'live-nofile-'))
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    const now = new Date('2026-08-18T20:00:00Z')
    const heartbeat = new Date(now.getTime() - 3600_000).toISOString()

    const rows = await listAgentSessions(
      agentSessionRoots(home), now, [liveRow(heartbeat)], 20, 'updated',
    )
    const row = rows.find(r => r.session_id === SID)
    expect(row).toBeTruthy()
    expect(row!.modified).toBe(heartbeat)
  })
})
