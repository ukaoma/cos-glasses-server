import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The engine holds module-level session state, so every case builds a fresh
// module graph with controllable provider/memory mocks. Gates are the product
// here: each test pins one of the cost-containment answers.

type ComposerReply =
  | { ok: true; text: string; durationMs: number }
  | { ok: false; reason: string; authFailure: boolean; treeClosed: boolean; durationMs: number }

interface EngineHarness {
  engine: typeof import('./live-cues-engine.js')
  composerAsk: ReturnType<typeof vi.fn>
  emitDisplay: ReturnType<typeof vi.fn>
  lightragExploreHop: ReturnType<typeof vi.fn>
  budgetDir: string
}

const PLANNER_OK: ComposerReply = { ok: true, text: '{"query":"q3 budget","entity":null}', durationMs: 1 }
const PLANNER_WITH_ENTITY: ComposerReply = { ok: true, text: '{"query":"q3 budget","entity":"CaratIQ"}', durationMs: 1 }
const INSIGHT_OK: ComposerReply = {
  ok: true,
  text: '{"nudge":"Ask what changed since the March number","type":"open_question","priority":2}',
  durationMs: 1,
}
const FAIL: ComposerReply = { ok: false, reason: 'cursor.timeout', authFailure: false, treeClosed: true, durationMs: 1 }

const WORDS_40 = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ') + ' can you send me the budget numbers?'

let activeBudgetDir: string | null = null

async function buildHarness(): Promise<EngineHarness> {
  vi.resetModules()
  const budgetDir = mkdtempSync(join(tmpdir(), 'live-cues-engine-'))
  activeBudgetDir = budgetDir
  const composerAsk = vi.fn()
  const emitDisplay = vi.fn()
  const lightragExploreHop = vi.fn(async () => ({ ok: true, text: 'graph context', treeClosed: true }))

  vi.doMock('./live-cues-capability.js', () => ({
    liveCuesEnabled: () => process.env.COS_LIVE_CUES === '1',
    liveCuesModelSupported: () => true,
    liveCuesGraphEnabled: () => process.env.COS_LIVE_CUES_GRAPH !== '0',
    liveCuesCapability: () => ({ available: true }),
    registerLiveCuesBudgetProbe: () => {},
  }))
  vi.doMock('./cursor-model-catalog.js', () => ({
    getCursorModelCatalog: async () => ({}),
    resolveCursorModelOption: () => ({ preference: 'cursor-composer', id: 'composer-2.5-fast', displayName: 'Composer' }),
  }))
  vi.doMock('./live-cues-cursor.js', () => ({ composerAsk }))
  vi.doMock('./live-cues-memory.js', () => ({
    semanticSearchHop: async () => ({ ok: true, snippets: ['2026-07-01 Budget Review: Q3 target moved'] }),
    lightragExploreHop,
  }))
  vi.doMock('./display-bus.js', () => ({ emitDisplay }))
  vi.doMock('./data-dir.js', () => ({ dataPath: (...parts: string[]) => join(budgetDir, ...parts) }))

  const engine = await import('./live-cues-engine.js')
  return { engine, composerAsk, emitDisplay, lightragExploreHop, budgetDir }
}

describe('live-cues engine gates', () => {
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.COS_LIVE_CUES
    delete process.env.COS_LIVE_CUES_GRAPH
    if (activeBudgetDir) rmSync(activeBudgetDir, { recursive: true, force: true })
    activeBudgetDir = null
    vi.doUnmock('./live-cues-capability.js')
    vi.doUnmock('./cursor-model-catalog.js')
    vi.doUnmock('./live-cues-cursor.js')
    vi.doUnmock('./live-cues-memory.js')
    vi.doUnmock('./display-bus.js')
    vi.doUnmock('./data-dir.js')
  })

  it('refuses to arm when the master switch is off', async () => {
    const { engine } = await buildHarness()
    await expect(engine.armLiveCues('meeting_a')).rejects.toMatchObject({ code: 'disabled', status: 403 })
  })

  it('arm is idempotent — a repeat start returns the existing counter, never a reset', async () => {
    process.env.COS_LIVE_CUES = '1'
    const { engine, composerAsk } = await buildHarness()
    composerAsk.mockResolvedValueOnce(PLANNER_OK).mockResolvedValueOnce(INSIGHT_OK)
    await engine.armLiveCues('meeting_a')
    await engine.feedLiveCueTranscript('meeting_a', WORDS_40)
    const again = await engine.armLiveCues('meeting_a')
    expect(again.pipelinesUsed).toBe(1)
  })

  it('single-flight: a burst of chunks launches exactly one pipeline', async () => {
    process.env.COS_LIVE_CUES = '1'
    const { engine, composerAsk } = await buildHarness()
    let releasePlanner: (value: ComposerReply) => void = () => {}
    composerAsk.mockImplementationOnce(() => new Promise(resolvePlanner => { releasePlanner = resolvePlanner }))
    composerAsk.mockResolvedValue(INSIGHT_OK)
    await engine.armLiveCues('meeting_a')
    const feeds = Array.from({ length: 20 }, () => engine.feedLiveCueTranscript('meeting_a', WORDS_40))
    releasePlanner(PLANNER_OK)
    await Promise.all(feeds)
    // 1 planner + 1 insight — a second pipeline would mean 3+ calls.
    expect(composerAsk.mock.calls.length).toBeLessThanOrEqual(2)
    expect(composerAsk.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('word floor: a thin buffer never fires', async () => {
    process.env.COS_LIVE_CUES = '1'
    const { engine, composerAsk } = await buildHarness()
    await engine.armLiveCues('meeting_a')
    await engine.feedLiveCueTranscript('meeting_a', 'only a few words here')
    expect(composerAsk).not.toHaveBeenCalled()
  })

  it('meeting cap: the 9th pipeline is refused', async () => {
    process.env.COS_LIVE_CUES = '1'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T10:00:00Z'))
    const { engine, composerAsk } = await buildHarness()
    composerAsk.mockImplementation(async (input: { caller: string }) =>
      input.caller === 'live-cues-planner' ? PLANNER_OK : INSIGHT_OK)
    await engine.armLiveCues('meeting_a')
    for (let round = 0; round < 9; round++) {
      vi.setSystemTime(Date.now() + 100_000) // clear the 60s floor and 30s cooldown
      await engine.feedLiveCueTranscript('meeting_a', WORDS_40)
    }
    // 8 pipelines × 2 asks; the 9th is refused at the cap.
    expect(composerAsk.mock.calls.length).toBe(16)
    expect(engine.getLiveCuesStatus()[0]?.pipelinesUsed).toBe(8)
  })

  it('breaker: 3 consecutive failures disable cues for the meeting', async () => {
    process.env.COS_LIVE_CUES = '1'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T10:00:00Z'))
    const { engine, composerAsk } = await buildHarness()
    composerAsk.mockResolvedValue(FAIL)
    await engine.armLiveCues('meeting_a')
    for (let round = 0; round < 5; round++) {
      vi.setSystemTime(Date.now() + 100_000)
      await engine.feedLiveCueTranscript('meeting_a', WORDS_40)
    }
    // Only the 3 breaker-counted failures spawn a planner ask; rounds 4-5 skip.
    expect(composerAsk.mock.calls.length).toBe(3)
    expect(engine.getLiveCuesStatus()[0]?.breakerTripped).toBe(true)
  })

  it('emits coaching_nudge with the client payload shape', async () => {
    process.env.COS_LIVE_CUES = '1'
    const { engine, composerAsk, emitDisplay } = await buildHarness()
    composerAsk.mockResolvedValueOnce(PLANNER_OK).mockResolvedValueOnce(INSIGHT_OK)
    await engine.armLiveCues('meeting_a')
    await engine.feedLiveCueTranscript('meeting_a', WORDS_40)
    expect(emitDisplay).toHaveBeenCalledTimes(1)
    const event = emitDisplay.mock.calls[0][0]
    expect(event.type).toBe('coaching_nudge')
    expect(event.data.nudge).toBe('Ask what changed since the March number')
    expect(event.data.type).toBe('open_question')
    expect(event.data.priority).toBe(2)
    expect(event.data.degraded).toBeUndefined()
  })

  it('marks the cue degraded with a reason when the graph hop fails', async () => {
    process.env.COS_LIVE_CUES = '1'
    const { engine, composerAsk, emitDisplay, lightragExploreHop } = await buildHarness()
    lightragExploreHop.mockResolvedValueOnce({ ok: false, text: null, reason: 'daily_graph_cap', treeClosed: true })
    composerAsk.mockResolvedValueOnce(PLANNER_WITH_ENTITY).mockResolvedValueOnce(INSIGHT_OK)
    await engine.armLiveCues('meeting_a')
    await engine.feedLiveCueTranscript('meeting_a', WORDS_40)
    const event = emitDisplay.mock.calls[0][0]
    expect(event.data.degraded).toBe(true)
    expect(event.data.degradationReason).toBe('daily_graph_cap')
  })

  it('drops a stale cue when the transcript has advanced past the threshold', async () => {
    process.env.COS_LIVE_CUES = '1'
    const { engine, composerAsk, emitDisplay } = await buildHarness()
    let releaseInsight: (value: ComposerReply) => void = () => {}
    composerAsk
      .mockResolvedValueOnce(PLANNER_OK)
      .mockImplementationOnce(() => new Promise(resolveInsight => { releaseInsight = resolveInsight }))
    await engine.armLiveCues('meeting_a')
    const pipeline = engine.feedLiveCueTranscript('meeting_a', WORDS_40)
    // Wait until the pipeline actually reaches the deferred insight ask, then
    // land 130+ words while it is in flight.
    await vi.waitFor(() => expect(composerAsk).toHaveBeenCalledTimes(2))
    await engine.feedLiveCueTranscript('meeting_a', Array.from({ length: 130 }, (_, index) => `later${index}`).join(' '))
    releaseInsight(INSIGHT_OK)
    await pipeline
    expect(emitDisplay).not.toHaveBeenCalled()
  })

  it('stop returns the nudges for SSE-miss backfill', async () => {
    process.env.COS_LIVE_CUES = '1'
    const { engine, composerAsk } = await buildHarness()
    composerAsk.mockResolvedValueOnce(PLANNER_OK).mockResolvedValueOnce(INSIGHT_OK)
    await engine.armLiveCues('meeting_a')
    await engine.feedLiveCueTranscript('meeting_a', WORDS_40)
    const stopped = engine.disarmLiveCues('meeting_a')
    expect(stopped.nudgesGenerated).toBe(1)
    expect(stopped.nudges[0]).toMatchObject({ type: 'open_question', priority: 2 })
  })
})
