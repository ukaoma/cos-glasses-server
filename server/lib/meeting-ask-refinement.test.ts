import { afterEach, describe, expect, it, vi } from 'vitest'
const data = vi.hoisted(() => ({ root: '/private/canary', entries: [] as any[], results: [] as any[], throws: false }))
vi.mock('../routes/transcribe-stream.js', () => ({
  getSessionAudioDirectory: () => data.root,
  getSessionChunkEntries: () => data.entries,
  getSessionAsrCompletedIndices: () => [0, 1, 2],
}))
vi.mock('./meeting-batch-transcribe.js', () => ({
  readProgressiveAskRefinements: vi.fn(() => { if (data.throws) throw Error('bad cache'); return data.results }),
}))
import { refineActiveMeetingAsk } from './meeting-ask-refinement.js'
import { readProgressiveAskRefinements } from './meeting-batch-transcribe.js'
import type { AskInput } from './live-cos-ask.js'
const priorFlag = process.env.COS_MEETING_ASK_HQ_EVIDENCE
afterEach(() => {
  if (priorFlag === undefined) delete process.env.COS_MEETING_ASK_HQ_EVIDENCE
  else process.env.COS_MEETING_ASK_HQ_EVIDENCE = priorFlag
  data.throws = false; vi.clearAllMocks()
})
function fixture() {
  process.env.COS_MEETING_ASK_HQ_EVIDENCE = '1'
  data.entries = [0, 1, 2].map(chunkIndex => ({ chunkIndex, chunk: { elapsed: chunkIndex * 6000, text: `live ${chunkIndex}`, speaker: 'You', similarity: 0 } }))
  data.results = [{ segment: { startChunkIdx: 0, endChunkIdx: 1, startElapsed: 0, endElapsed: 12000 }, text: 'Earlier corrected facts', words: [] }]
  const input: AskInput = { sessionId: 'meeting_canary', action: 'ask', question: 'What changed?', elapsedMs: 18000,
    turns: data.entries.map(e => ({ id: e.chunkIndex, elapsedMs: e.chunk.elapsed, speaker: e.chunk.speaker, text: e.chunk.text })), history: [] }
  return input
}
describe('direct Meeting Ask evidence admission', () => {
  it('uses completed refinements and retains the client latest tail without decoding', () => {
    const input = fixture(), before = JSON.stringify(input)
    const result = refineActiveMeetingAsk(input)
    expect(result.input.turns.map(t => t.text)).toEqual(['Earlier corrected facts', 'live 2'])
    expect(result.input.turns.map(t => t.id)).toEqual([0, 2])
    expect(result.notices).not.toEqual([])
    expect(JSON.stringify(input)).toBe(before)
  })
  it('never admits a passage or canonical chunk after the question cutoff', () => {
    const input = fixture(); input.elapsedMs = 6000; input.turns = input.turns.slice(0, 2)
    expect(refineActiveMeetingAsk(input).input.turns).toEqual(input.turns)
    expect(vi.mocked(readProgressiveAskRefinements).mock.calls[0][2].map(e => e.chunkIndex)).toEqual([0, 1])
  })
  it('does not replace client partial ranges or reuse a cache when disabled', () => {
    const input = fixture(); input.turns = input.turns.slice(1)
    expect(refineActiveMeetingAsk(input).input.turns).toEqual(input.turns)
    process.env.COS_MEETING_ASK_HQ_EVIDENCE = '0'; vi.clearAllMocks()
    expect(refineActiveMeetingAsk(input)).toEqual({ input, notices: [] })
    expect(readProgressiveAskRefinements).not.toHaveBeenCalled()
  })
  it('falls back to the entire submitted transcript on cache failure', () => {
    const input = fixture(); data.throws = true
    const result = refineActiveMeetingAsk(input)
    expect(result.input).toBe(input)
    expect(result.notices.join(' ')).toContain('uses the live transcript')
  })
})
