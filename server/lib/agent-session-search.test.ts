import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectAgentSessionSearchDocs,
  cosineSimilarity,
  mergeSessionSearchHits,
  searchAgentSessions,
  type AgentSessionSearchHit,
  type EmbedTexts,
} from './agent-session-search.js'
import { isKeepWarmSessionTitle } from './agent-session-store.js'
import { agentSessionRoots, type AgentSessionRoots } from './agent-session-store.js'

const jewelryId = '019dfe42-d4ba-7152-b5ae-60f600a2675a'
const cursorId = 'bbbbbbbb-1111-2222-3333-cccccccccccc'
const claudeId = 'd3786335-cfb4-4556-9a4a-7308ce66eab1'
const listingNow = new Date('2026-08-13T18:00:00Z')

function writeJsonl(path: string, lines: string[]) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`)
}

function touch(path: string, date: Date) {
  utimesSync(path, date, date)
}

function fixtureHome(): { home: string; roots: AgentSessionRoots } {
  const home = mkdtempSync(join(tmpdir(), 'cos-agent-session-search-'))
  const roots = agentSessionRoots(home)
  mkdirSync(roots.claudeProjects, { recursive: true })
  mkdirSync(roots.codexSessions, { recursive: true })
  mkdirSync(roots.cursorProjects, { recursive: true })
  return { home, roots }
}

function hit(partial: Partial<AgentSessionSearchHit> & Pick<AgentSessionSearchHit, 'session_id' | 'provider'>): AgentSessionSearchHit {
  return {
    display_label: 'Untitled',
    project: '',
    modified: listingNow.toISOString(),
    created: listingNow.toISOString(),
    alive: false,
    state: 'recent',
    pinned: false,
    snippet: '',
    keywordScore: 0,
    semanticScore: 0,
    match: 'keyword',
    ...partial,
  }
}

const noEmbed: EmbedTexts = async () => ({ reason: 'no_session_embeddings' })

const jewelEmbed: EmbedTexts = async (texts) => texts.map(text => {
  const lower = text.toLowerCase()
  if (lower.includes('jewel') || lower.includes('gemstone')) return [1, 0]
  if (lower.includes('markt') || lower.includes('grocery')) return [0, 1]
  return [0.2, 0.8]
})

describe('session search helpers', () => {
  it('scores aligned vectors as similar', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('merges keyword and meaning hits for the same session', () => {
    const merged = mergeSessionSearchHits(
      [hit({ session_id: jewelryId, provider: 'codex', keywordScore: 0.8, snippet: 'keyword snippet' })],
      [hit({ session_id: jewelryId, provider: 'codex', semanticScore: 0.6, match: 'semantic', snippet: 'meaning snippet' })],
      10,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].match).toBe('both')
    expect(merged[0].keywordScore).toBe(0.8)
    expect(merged[0].semanticScore).toBe(0.6)
    expect(merged[0].snippet).toBe('keyword snippet')
  })
})

describe('agent session search', () => {
  it('finds a stale Codex thread by first prompt when the sidebar name differs', async () => {
    const { roots } = fixtureHome()
    const file = join(roots.codexSessions, '2026/05/06', `rollout-2026-05-06T12-08-05-${jewelryId}.jsonl`)
    writeJsonl(file, [
      `{"type":"session_meta","payload":{"id":"${jewelryId}","cwd":"/repo","timestamp":"2026-05-06T17:08:05.000Z"}}`,
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Jewelry Edge bridge"}]}}',
    ])
    touch(file, new Date('2026-05-06T17:08:05Z'))
    writeFileSync(join(roots.codexSessions, '..', 'session_index.jsonl'), `{"id":"${jewelryId}","thread_name":"Markt POS 2.0 build"}\n`)

    const byPrompt = await searchAgentSessions({
      query: 'Jewelry Edge',
      roots,
      now: listingNow,
      embedTexts: noEmbed,
    })
    expect(byPrompt.hits.some(row => row.session_id === jewelryId)).toBe(true)
    expect(byPrompt.hits[0]?.match).toBe('keyword')
    expect(byPrompt.semanticAvailable).toBe(false)

    const byTitle = await searchAgentSessions({
      query: 'Markt POS',
      roots,
      now: listingNow,
      embedTexts: noEmbed,
    })
    expect(byTitle.hits.some(row => row.display_label === 'Markt POS 2.0 build')).toBe(true)
  })

  it('finds a Cursor chat by sidebar name and by the buried user_query', async () => {
    const { roots } = fixtureHome()
    const query = '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Take Video 1 MiB chunks on V2</user_query>"}]}}'
    const real = join(roots.cursorProjects, 'Users-ukaoma-Documents-GitHub-MU-Chief-Staff', 'agent-transcripts', cursorId, `${cursorId}.jsonl`)
    writeJsonl(real, [query])
    touch(real, listingNow)
    mkdirSync(dirname(roots.cursorComposerDb), { recursive: true })
    execFileSync('/usr/bin/sqlite3', [
      roots.cursorComposerDb,
      `CREATE TABLE composerHeaders (composerId TEXT, value TEXT);
       INSERT INTO composerHeaders VALUES ('${cursorId}', '{"name":"V2 verification and performance"}');`,
    ])

    const bySidebar = await searchAgentSessions({
      query: 'verification performance',
      roots,
      now: listingNow,
      embedTexts: noEmbed,
    })
    expect(bySidebar.hits[0]?.display_label).toBe('V2 verification and performance')

    const byPrompt = await searchAgentSessions({
      query: 'Take Video',
      roots,
      now: listingNow,
      embedTexts: noEmbed,
    })
    expect(byPrompt.hits.some(row => row.session_id === cursorId)).toBe(true)
  })

  it('finds a Claude /rename title and the first user line', async () => {
    const { roots } = fixtureHome()
    const file = join(roots.claudeProjects, '-Users-ukaoma-Documents-GitHub-MU-Chief-Staff', `${claudeId}.jsonl`)
    writeJsonl(file, [
      '{"type":"custom-title","customTitle":"Fireflies meeting sync"}',
      '{"type":"user","message":{"role":"user","content":"Pull last night\\u2019s Fireflies notes into COS"}}',
    ])
    touch(file, listingNow)

    const byRename = await searchAgentSessions({
      query: 'Fireflies meeting',
      roots,
      now: listingNow,
      embedTexts: noEmbed,
    })
    expect(byRename.hits[0]?.display_label).toBe('Fireflies meeting sync')

    const byBody = await searchAgentSessions({
      query: 'last night notes',
      roots,
      now: listingNow,
      embedTexts: noEmbed,
    })
    expect(byBody.hits.some(row => row.session_id === claudeId)).toBe(true)
  })

  it('adds a meaning hit when embeddings align and keeps keyword when they do not', async () => {
    const { roots } = fixtureHome()
    const file = join(roots.codexSessions, '2026/05/06', `rollout-2026-05-06T12-08-05-${jewelryId}.jsonl`)
    writeJsonl(file, [
      `{"type":"session_meta","payload":{"id":"${jewelryId}","cwd":"/repo","timestamp":"2026-05-06T17:08:05.000Z"}}`,
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Jewelry Edge bridge"}]}}',
    ])
    touch(file, new Date('2026-05-06T17:08:05Z'))
    writeFileSync(join(roots.codexSessions, '..', 'session_index.jsonl'), `{"id":"${jewelryId}","thread_name":"Jewelry 2.0 Build"}\n`)

    const meaning = await searchAgentSessions({
      query: 'gemstone retail checkout',
      roots,
      now: listingNow,
      embedTexts: jewelEmbed,
    })
    const row = meaning.hits.find(item => item.session_id === jewelryId)
    expect(row?.match).toBe('semantic')
    expect(row?.semanticScore).toBeGreaterThan(0.28)
    expect(meaning.semanticAvailable).toBe(true)
  })
})

/**
 * The scan budget, which had ZERO coverage until 2026-08-18.
 *
 * `collectAgentSessionSearchDocs` was never called directly by any test and its `cap`
 * was never exercised, so with a dozen fixture files the 134-per-provider budget was
 * never reached and the branch that spends it was never run. That is precisely where
 * the defect lived: the budget was charged BEFORE the keep-warm filter, so on a real
 * machine (1,296 Claude transcripts, ~89% machine-authored) the allowance was consumed
 * by scaffolding and Miles's actual conversations were never reached.
 */
describe('search scan budget', () => {
  /**
   * Sized against a SMALL cap on purpose. `cap` 30 gives each provider a 10-doc budget
   * and a 50-file examine ceiling, which exercises exactly the branch that matters while
   * writing ~50 files instead of ~1,900. The first draft used the real 134/670 budget,
   * created 1,910 files per run, and went flaky under the full parallel suite while
   * passing 5/5 in isolation -- a test that only fails when the machine is busy is worse
   * than no test.
   *
   * In both fixtures the decoys are the NEWEST files on disk. That is what the real
   * corpus looks like -- machine transcripts are written constantly -- and it is what
   * keeps these honest now that candidates are ranked by mtime before the budget is
   * spent: recency ordering alone cannot rescue a real conversation sitting behind them.
   *
   * Before ranking landed this leaned on traversal order, which was never controllable.
   * `readdir` returned `2026/08/01` ahead of `2026/08/18` regardless of creation order,
   * and a draft with the Codex roles reversed put every real rollout inside the pre-fix
   * allowance and passed against the very bug it was written to catch.
   */
  const CAP = 30

  it('spends the Claude budget on kept docs, not on machine transcripts', async () => {
    const { roots } = fixtureHome()
    const folders = ['-Users-ukaoma-repo-a', '-Users-ukaoma-repo-b', '-Users-ukaoma-repo-c']
    const hex = (n: number) => n.toString(16).padStart(12, '0')
    for (let i = 0; i < 40; i++) {
      const file = join(roots.claudeProjects, folders[i % folders.length], `aaaaaaaa-1111-2222-3333-${hex(i)}.jsonl`)
      writeJsonl(file, ['{"type":"user","message":{"role":"user","content":"You are the COS Slack Bridge proxy serving method conversations.list"}}'])
      // Newest on disk, so recency ordering alone could not rescue these either.
      touch(file, new Date('2026-08-18T20:00:00Z'))
    }
    for (let i = 0; i < 6; i++) {
      const file = join(roots.claudeProjects, folders[i % folders.length], `ffffffff-9999-8888-7777-${hex(i)}.jsonl`)
      writeJsonl(file, [
        `{"type":"custom-title","customTitle":"Jewel360 lead gen review ${i}"}`,
        '{"type":"user","message":{"role":"user","content":"Where did the Jewel360 TOFU pipeline go"}}',
      ])
      touch(file, new Date('2026-08-01T09:00:00Z'))
    }

    const docs = await collectAgentSessionSearchDocs(roots, CAP, listingNow)
    const claude = docs.filter(doc => doc.row.provider === 'claude')

    // Every real conversation is reachable even though 40 machine transcripts sit in
    // front of a 10-doc budget. Before the filter moved ahead of the decrement the
    // allowance was gone long before they were reached.
    expect(claude).toHaveLength(6)
    expect(claude.every(doc => doc.title.startsWith('Jewel360 lead gen review'))).toBe(true)
  })

  it('spends the Codex budget on kept docs, not on subagent rollouts', async () => {
    const { roots } = fixtureHome()
    const hex = (n: number) => n.toString(16).padStart(12, '0')
    for (let i = 0; i < 40; i++) {
      const id = `bbbbbbbb-1111-2222-3333-${hex(i)}`
      const file = join(roots.codexSessions, '2026/08/18', `rollout-2026-08-18T20-00-00-${id}.jsonl`)
      writeJsonl(file, [
        `{"type":"session_meta","payload":{"id":"${id}","cwd":"/repo","timestamp":"2026-08-18T20:00:00.000Z","thread_source":"subagent"}}`,
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"subagent work"}]}}',
      ])
      touch(file, new Date('2026-08-18T20:00:00Z'))
    }
    for (let i = 0; i < 4; i++) {
      const id = `cccccccc-4444-5555-6666-${hex(i)}`
      const file = join(roots.codexSessions, '2026/08/01', `rollout-2026-08-01T09-00-00-${id}.jsonl`)
      // Codex derives its title from `agent_nickname` or the first user message -- there
      // is no `payload.title` -- so the first prompt is what has to be distinctive here.
      writeJsonl(file, [
        `{"type":"session_meta","payload":{"id":"${id}","cwd":"/repo","timestamp":"2026-08-01T09:00:00.000Z"}}`,
        `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Bottle POS parity ${i}"}]}}`,
      ])
      touch(file, new Date('2026-08-01T09:00:00Z'))
    }

    const docs = await collectAgentSessionSearchDocs(roots, CAP, listingNow)
    const codex = docs.filter(doc => doc.row.provider === 'codex')

    expect(codex).toHaveLength(4)
    expect(codex.every(doc => doc.title.startsWith('Bottle POS parity'))).toBe(true)
  })

  /**
   * Ranking, which had no coverage until a mutation removing the sort left every test
   * green. Without it the walk is raw `readdir` order, so the newest transcript on disk
   * is reachable only by filesystem luck -- which is exactly how Miles's running fork
   * came to sit in the session list while being absent from a search for its own title.
   */
  it('reaches the newest conversation even when it is behind a corpus of older ones', async () => {
    const { roots } = fixtureHome()
    const hex = (n: number) => n.toString(16).padStart(12, '0')
    for (let i = 0; i < 250; i++) {
      const file = join(roots.claudeProjects, '-Users-ukaoma-repo-a', `aaaaaaaa-1111-2222-3333-${hex(i)}.jsonl`)
      writeJsonl(file, [
        `{"type":"custom-title","customTitle":"Older session ${i}"}`,
        '{"type":"user","message":{"role":"user","content":"an older conversation"}}',
      ])
      touch(file, new Date('2026-06-01T09:00:00Z'))
    }
    const needle = join(roots.claudeProjects, '-Users-ukaoma-repo-b', 'ffffffff-9999-8888-7777-000000000001.jsonl')
    writeJsonl(needle, [
      '{"type":"custom-title","customTitle":"Luke Henry merge"}',
      '{"type":"user","message":{"role":"user","content":"fold Luke H into Luke Henry"}}',
    ])
    touch(needle, new Date('2026-08-18T20:00:00Z'))

    const docs = await collectAgentSessionSearchDocs(roots, CAP, listingNow)
    expect(docs.some(doc => doc.title === 'Luke Henry merge')).toBe(true)
  })

  it('reaches the newest Codex rollout even when it is behind older ones', async () => {
    const { roots } = fixtureHome()
    const hex = (n: number) => n.toString(16).padStart(12, '0')
    for (let i = 0; i < 250; i++) {
      const id = `aaaaaaaa-1111-2222-3333-${hex(i)}`
      const file = join(roots.codexSessions, '2026/06/01', `rollout-2026-06-01T09-00-00-${id}.jsonl`)
      writeJsonl(file, [
        `{"type":"session_meta","payload":{"id":"${id}","cwd":"/repo","timestamp":"2026-06-01T09:00:00.000Z"}}`,
        `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"an older rollout ${i}"}]}}`,
      ])
      touch(file, new Date('2026-06-01T09:00:00Z'))
    }
    const id = 'ffffffff-9999-8888-7777-000000000001'
    const needle = join(roots.codexSessions, '2026/08/18', `rollout-2026-08-18T20-00-00-${id}.jsonl`)
    writeJsonl(needle, [
      `{"type":"session_meta","payload":{"id":"${id}","cwd":"/repo","timestamp":"2026-08-18T20:00:00.000Z"}}`,
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Luke Henry merge"}]}}',
    ])
    touch(needle, new Date('2026-08-18T20:00:00Z'))

    const docs = await collectAgentSessionSearchDocs(roots, CAP, listingNow)
    expect(docs.some(doc => doc.title === 'Luke Henry merge')).toBe(true)
  })

  /**
   * Named for what it actually asserts. An earlier version of this called itself a test
   * of the examine ceiling, which it was not: with no real transcripts present the doc
   * count is zero on both sides of the fix, and what it really caught was the broadened
   * predicate. The ceiling itself is not observable from the outside -- the examined
   * counter is not returned -- so it is covered by construction, not by assertion.
   */
  it('returns nothing at all from a corpus that is only machine transcripts', async () => {
    const { roots } = fixtureHome()
    const hex = (n: number) => n.toString(16).padStart(12, '0')
    for (let i = 0; i < 100; i++) {
      const file = join(roots.claudeProjects, '-Users-ukaoma-repo-a', `aaaaaaaa-1111-2222-3333-${hex(i)}.jsonl`)
      writeJsonl(file, ['{"type":"user","message":{"role":"user","content":"Reply with the single word READY."}}'])
      touch(file, new Date('2026-08-18T20:00:00Z'))
    }
    const docs = await collectAgentSessionSearchDocs(roots, CAP, listingNow)
    expect(docs.filter(doc => doc.row.provider === 'claude')).toHaveLength(0)
  })
})

/**
 * Table-driven, using the REAL strings these callers emit, because the counts that
 * justified each entry span providers -- a Claude-only fixture does not reproduce them.
 */
describe('machine-title predicate', () => {
  const MACHINE: Array<[string, string]> = [
    ['claude', 'You are the COS Slack Bridge proxy serving method conversations.list'],
    ['claude', 'You are a post-processing editor for a meeting transcript.'],
    ['claude', 'Call mcp__claude_ai_Slack__slack_search_users with arguments {"query":"Luke"}'],
    ['codex',  'Reply with the single word READY.'],
    ['claude', 'Reply with the single word READY.'],
    ['claude', 'Reply with exactly OK and nothing else'],
    ['claude', 'say ok'],
    ['claude', 'Say: OK'],
    ['claude', 'reply ok'],
    ['claude', 'ready'],
    ['claude', 'This is an automated local readiness check, reply READY'],
  ]

  const HUMAN: Array<[string, string]> = [
    ['claude', 'You are right that the fence never fires'],
    ['claude', 'You are the only one who can approve the HubDB push'],
    ['claude', 'Reply with the customer quotes from the Bottle POS deck'],
    ['claude', 'say ok to the Quilt MSA and tell me why'],
    ['codex',  'Luke Henry merge'],
    ['claude', 'Jewel360 lead gen review'],
    ['claude', 'ready to ship 6.36.11?'],
  ]

  it.each(MACHINE)('filters the %s machine title: %s', (_provider, title) => {
    expect(isKeepWarmSessionTitle(title)).toBe(true)
  })

  it.each(HUMAN)('keeps the %s human title: %s', (_provider, title) => {
    expect(isKeepWarmSessionTitle(title)).toBe(false)
  })
})
