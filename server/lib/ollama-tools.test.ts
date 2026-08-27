import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Scratch data dir BEFORE importing anything that touches the meeting store or
// the profile: those modules read paths at load, and a shared import would
// otherwise point at the live COS tree.
vi.hoisted(() => {
  process.env.COS_DATA_DIR = `/tmp/cos-ollama-tools-test-${process.pid}-${Date.now()}`
  process.env.COS_PROFILE_PATH = `${process.env.COS_DATA_DIR}/profile.json`
})

vi.mock('./meeting-library-search.js', () => ({
  searchMeetingLibrary: vi.fn(),
}))
vi.mock('./context-library-search.js', () => ({
  searchMemories: vi.fn(),
}))
vi.mock('./cos-operations-meetings.js', () => ({
  cosOperationsMeetingsConfigured: vi.fn(() => false),
  getCosOperationsMeetingDetail: vi.fn(() => null),
  getDirectLibraryMeetingDetail: vi.fn(() => null),
}))

import { searchMemories } from './context-library-search.js'
import { getDirectLibraryMeetingDetail } from './cos-operations-meetings.js'
import { searchMeetingLibrary } from './meeting-library-search.js'
import {
  buildOllamaSystemPrompt,
  buildOllamaToolDefs,
  executeOllamaTool,
  ollamaCosPipelineConfigured,
  ollamaToolStatusLabel,
  OLLAMA_COS_TOOL_NAMES,
  parseToolArguments,
} from './ollama-tools.js'

describe('ollama read-only tools', () => {
  const prior = process.env.COS_SCRIPTS_DIR
  const dirs: string[] = []

  const withPipeline = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-ollama-tools-'))
    dirs.push(dir)
    process.env.COS_SCRIPTS_DIR = dir
    return dir
  }

  beforeEach(() => { vi.clearAllMocks() })

  afterEach(() => {
    // The live process really has COS_SCRIPTS_DIR set, so restore rather than
    // delete or the next file in the run inherits a lie.
    if (prior === undefined) delete process.env.COS_SCRIPTS_DIR
    else process.env.COS_SCRIPTS_DIR = prior
    while (dirs.length) {
      const dir = dirs.pop()!
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('advertises nothing when the COS pipeline is absent', () => {
    delete process.env.COS_SCRIPTS_DIR
    expect(ollamaCosPipelineConfigured()).toBe(false)
    expect(buildOllamaToolDefs()).toEqual([])
  })

  it('advertises nothing when COS_SCRIPTS_DIR points at a non-directory', () => {
    // A stale path must not advertise tools whose executors cannot run.
    process.env.COS_SCRIPTS_DIR = join(tmpdir(), `cos-missing-${Date.now()}`)
    expect(ollamaCosPipelineConfigured()).toBe(false)
    expect(buildOllamaToolDefs()).toEqual([])
  })

  it('advertises exactly the three COS tools when the pipeline is present', () => {
    withPipeline()
    const names = buildOllamaToolDefs().map(d => d.function.name)
    expect(names).toEqual([...OLLAMA_COS_TOOL_NAMES])
    expect(names).toHaveLength(3)
  })

  it('never names a tool Read (that label means Analyzing photo)', () => {
    withPipeline()
    for (const name of buildOllamaToolDefs().map(d => d.function.name)) {
      expect(name).not.toBe('Read')
      expect(ollamaToolStatusLabel(name)).not.toBe('Analyzing photo...')
    }
  })

  it('search results always carry counts and a semantic reason, even when empty', async () => {
    withPipeline()
    // The helper omits semanticReason when semantic search worked. The tool
    // string must still carry the field, because a model reading an empty list
    // with no reason concludes the archive itself is empty.
    vi.mocked(searchMeetingLibrary).mockResolvedValue({
      hits: [], keywordCount: 0, semanticCount: 0, semanticAvailable: true,
    } as any)
    const out = JSON.parse(await executeOllamaTool('search_meetings', { query: 'quilt' }))
    expect(out.hits).toEqual([])
    expect(out.keywordCount).toBe(0)
    expect(out.semanticCount).toBe(0)
    expect(out.semanticAvailable).toBe(true)
    expect(out.semanticReason).toBe('none')
  })

  it('passes a real semantic reason through', async () => {
    withPipeline()
    vi.mocked(searchMemories).mockResolvedValue({
      hits: [], keywordCount: 0, semanticCount: 0,
      semanticAvailable: false, semanticReason: 'qdrant_unreachable',
    } as any)
    const out = JSON.parse(await executeOllamaTool('search_memories', { query: 'x' }))
    expect(out.semanticAvailable).toBe(false)
    expect(out.semanticReason).toBe('qdrant_unreachable')
  })

  it('returns a string for an unknown tool instead of throwing', async () => {
    withPipeline()
    await expect(executeOllamaTool('nope', {})).resolves.toContain('unknown tool nope')
  })

  it('returns a string for a missing required argument', async () => {
    withPipeline()
    const out = JSON.parse(await executeOllamaTool('search_meetings', {}))
    expect(out.error).toContain('query is required')
  })

  it('read_meeting serializes sourceContent and never the unbounded transcript', async () => {
    withPipeline()
    vi.mocked(getDirectLibraryMeetingDetail).mockReturnValue({
      title: 'Sync', date: '2026-08-26', sourceContent: 'the body',
      // The ops helpers really do attach this, unbounded. It must not cross
      // into the model's context.
      transcript: 'x'.repeat(200_000),
    } as any)
    const raw = await executeOllamaTool('read_meeting', {
      domain: 'library', month: '2026-08', filename: 'sync.md',
    })
    expect(raw).not.toContain('xxxxxxxxxx')
    const out = JSON.parse(raw)
    expect(out.sourceContent).toBe('the body')
    expect(out).not.toHaveProperty('transcript')
    // domain === 'library' uses the 2-arg direct helper.
    expect(vi.mocked(getDirectLibraryMeetingDetail)).toHaveBeenCalledWith('2026-08', 'sync.md')
  })

  it('a read_meeting miss says not found for this path, not that it does not exist', async () => {
    withPipeline()
    vi.mocked(getDirectLibraryMeetingDetail).mockReturnValue(null)
    const out = JSON.parse(await executeOllamaTool('read_meeting', {
      domain: 'library', month: '2026-08', filename: 'gone.md',
    }))
    expect(out.error).toBe('not found for this path')
  })

  it('caps a large result by dropping hits, leaving valid JSON', async () => {
    withPipeline()
    const fat = Array.from({ length: 400 }, (_, i) => ({ id: `h${i}`, snippet: 'y'.repeat(400) }))
    vi.mocked(searchMeetingLibrary).mockResolvedValue({
      hits: fat, keywordCount: fat.length, semanticCount: 0, semanticAvailable: true,
    } as any)
    const raw = await executeOllamaTool('search_meetings', { query: 'big' })
    expect(raw.length).toBeLessThanOrEqual(24_000)
    // Must still PARSE — a mid-string cut would hand the model broken JSON.
    const out = JSON.parse(raw)
    expect(out.truncated).toBe(true)
    expect(out.hits.length).toBeLessThan(fat.length)
  })

  it('accepts tool arguments as an object or a JSON string', () => {
    expect(parseToolArguments({ query: 'a' })).toEqual({ query: 'a' })
    expect(parseToolArguments('{"query":"b"}')).toEqual({ query: 'b' })
    expect(parseToolArguments('not json')).toEqual({})
    expect(parseToolArguments(null)).toEqual({})
  })

  it('returns aborted when the signal is already aborted', async () => {
    withPipeline()
    const controller = new AbortController()
    controller.abort()
    await expect(executeOllamaTool('search_meetings', { query: 'x' }, controller.signal))
      .resolves.toBe('aborted')
  })

  it('the no-tools prompt keeps the original sentence', () => {
    const prompt = buildOllamaSystemPrompt({
      ownerName: 'Miles', cachedContext: '', historyPrompt: '', toolNames: [],
    })
    expect(prompt).toContain('You have no tools')
    expect(prompt).not.toContain('Available tools:')
  })

  it('the tools prompt forbids inventing outages and names the calendar block correctly', () => {
    const prompt = buildOllamaSystemPrompt({
      ownerName: 'Miles',
      cachedContext: 'Next: standup 9am',
      historyPrompt: '',
      toolNames: [...OLLAMA_COS_TOOL_NAMES],
    })
    expect(prompt).toContain('Available tools: search_meetings, search_memories, read_meeting')
    expect(prompt).toContain("TODAY'S calendar")
    expect(prompt).toContain('not proof that no meetings or memories exist')
    // Must never offer to re-run the failed work on this same local slot.
    expect(prompt).toContain('never this local slot')
    expect(prompt).not.toContain('You have no tools')
  })
})
