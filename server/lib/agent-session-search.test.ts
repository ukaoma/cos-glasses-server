import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cosineSimilarity,
  mergeSessionSearchHits,
  searchAgentSessions,
  type AgentSessionSearchHit,
  type EmbedTexts,
} from './agent-session-search.js'
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
