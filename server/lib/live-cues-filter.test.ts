import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { CUE_FILTER_STOPWORDS, CUE_TEMPLATE_RE, cueOverlap, cueTokens, isTemplateCue, repeatOf, wouldWithhold } from './live-cues-filter.js'

// Vectors in the reference's format (cue_verdicts_mvp/v4_replay/filter_test_vectors.json). The committed set is synthetic,
// with every expectation produced by the Python reference (filter_cues.py), because the real receipts hold meeting text and
// this repository is public. Point COS_LIVE_CUES_FILTER_VECTORS at the real file to run it byte for byte as well.
interface Vector {
  earlier: string | null
  cue: string
  expect: {
    tokens_cue: string[]; template_cue: boolean; tokens_earlier?: string[]; template_earlier?: boolean; overlap?: number
    'decision_topic_0.25_repeat_0.5'?: string | null; 'decision_meeting_repeat_0.5'?: string | null
  }
}
const synthetic = JSON.parse(readFileSync(new URL('./__fixtures__/live-cues-filter-vectors.synthetic.json', import.meta.url), 'utf8')) as Vector[]
const realPath = process.env.COS_LIVE_CUES_FILTER_VECTORS

/** The server's decision for [earlier, cue] in the reference's order: repeat at 0.5 first, then the template rule. */
function decide(earlier: string, cue: string, mode: 'topic' | 'meeting'): string | null {
  const shown = [{ cueId: 'earlier', detail: earlier }]
  if (repeatOf(cue, shown, 0.5)) return 'repeat'
  const w = wouldWithhold(cue, shown)
  return (mode === 'topic' ? w.perTopic : w.perMeeting) ? 'template' : null
}
const sorted = (s: Set<string>) => [...s].sort()

function check(vectors: Vector[]) {
  vectors.forEach((v, i) => {
    const e = v.expect
    expect(sorted(cueTokens(v.cue)), `tokens_cue ${i}`).toEqual(e.tokens_cue)
    expect(isTemplateCue(v.cue), `template_cue ${i}`).toBe(e.template_cue)
    if (!v.earlier) return
    expect(sorted(cueTokens(v.earlier)), `tokens_earlier ${i}`).toEqual(e.tokens_earlier)
    if (e.template_earlier !== undefined) expect(isTemplateCue(v.earlier), `template_earlier ${i}`).toBe(e.template_earlier)
    expect(Math.round(cueOverlap(cueTokens(v.cue), cueTokens(v.earlier)) * 1e4) / 1e4, `overlap ${i}`).toBe(e.overlap)
    expect(decide(v.earlier, v.cue, 'topic'), `topic decision ${i}`).toBe(e['decision_topic_0.25_repeat_0.5'])
    if ('decision_meeting_repeat_0.5' in e) expect(decide(v.earlier, v.cue, 'meeting'), `meeting decision ${i}`).toBe(e['decision_meeting_repeat_0.5'])
  })
}

describe('live cues filter (port of filter_cues.py)', () => {
  it('agrees with the reference on every synthetic vector (repeat, template by topic and by meeting, tokenizer edges)', () => {
    expect(synthetic.length).toBe(9)
    check(synthetic)
  })

  it.skipIf(!realPath)('agrees with the reference on the real 10/19 receipts (COS_LIVE_CUES_FILTER_VECTORS)', () => {
    const real = JSON.parse(readFileSync(realPath!, 'utf8')) as Vector[]
    expect(real.length).toBe(8)
    check(real)
  })

  it('tokenizer: commas inside numbers drop, decimals stay, single digits and short or stop words go, non-ASCII splits', () => {
    expect(sorted(cueTokens("Revenue hit $3,000 at 1.5x; don't wait 9 days. Café"))).toEqual(['1.5', '3000', 'caf', 'days', 'hit', 'revenue', 'wait'])
    expect(sorted(cueTokens(''))).toEqual([])
    expect(CUE_FILTER_STOPWORDS.has('owner') && CUE_FILTER_STOPWORDS.has('settle') && CUE_FILTER_STOPWORDS.has('okay')).toBe(true)
    // The exact sets and pattern of filter_cues.py: sha256 of its sorted STOPWORDS joined by spaces, and TEMPLATE_RE.pattern.
    expect(CUE_FILTER_STOPWORDS.size).toBe(180)
    expect(createHash('sha256').update([...CUE_FILTER_STOPWORDS].sort().join(' ')).digest('hex')).toBe('76254118faec7ba9c336fb755d82f51870735d957009126b71187463998086cf')
    expect(CUE_TEMPLATE_RE.source).toBe('\\b(owner|owners|owns|ownership|deadline|due date|by when|by what date|a date|no date|set a date|settle a date|who (owns|will|should|builds|takes|drives|runs|tracks|chases|approves|signs off|finalizes|tests|gathers|asks|computes|is computing|does))\\b')
    expect(CUE_TEMPLATE_RE.flags).toBe('i')
  })

  it('overlap is the shared count over the smaller set, and 0 when either is empty', () => {
    expect(cueOverlap(new Set(['a', 'b']), new Set(['b', 'c', 'd']))).toBe(0.5)
    expect(cueOverlap(new Set(), new Set(['a']))).toBe(0)
    expect(cueOverlap(new Set(['a']), new Set())).toBe(0)
  })

  it('repeatOf returns the FIRST earlier cue at or above the threshold, with the overlap to 3 places', () => {
    const shown = [{ cueId: 'c1', detail: 'Gamma onboarding emails convert poorly' }, { cueId: 'c2', detail: 'Gamma onboarding emails convert poorly again' }]
    expect(repeatOf('Gamma onboarding emails convert poorly now', shown, 0.5)).toEqual({ blocker: 'c1', overlap: 1 })
    expect(repeatOf('Gamma launch stalls', shown, 0.5)).toBeNull()
    expect(repeatOf('anything', [], 0.5)).toBeNull()
    // 2/3: the reference rounds to 3 places (filter_meeting gives 0.667 for this pair).
    expect(repeatOf('alpha beta gamma', [{ cueId: 'r', detail: 'alpha beta delta' }], 0.5)).toEqual({ blocker: 'r', overlap: 0.667 })
    expect(repeatOf('Beacon churn alpha beta gamma', [{ cueId: 'x', detail: 'Beacon churn delta omega sigma' }], 0.4)).toEqual({ blocker: 'x', overlap: 0.4 })
  })

  it('wouldWithhold: per meeting on any earlier template cue, per topic only at >= 0.25, blocker is the topic one when it fires', () => {
    const t1 = { cueId: 't1', detail: 'Widget refunds lag; name the owner of the backlog.' }
    const n1 = { cueId: 'n1', detail: 'Kiosk pilot slipped with no owner mentioned.' }
    const t2 = { cueId: 't2', detail: 'Kiosk pilot slipped twice; who drives the vendor review?' }
    expect(wouldWithhold('Kiosk vendor review has no owner yet.', [])).toEqual({ perMeeting: false, perTopic: false })
    expect(wouldWithhold('Kiosk vendor review has no owner yet.', [{ cueId: 'p', detail: 'Kiosk vendor review slipped twice.' }]))
      .toEqual({ perMeeting: false, perTopic: false })                                    // only earlier TEMPLATE cues count
    expect(wouldWithhold('Kiosk pilot vendor review slipped.', [t1, t2])).toEqual({ perMeeting: false, perTopic: false })   // not a template itself
    expect(wouldWithhold('Kiosk vendor review has no owner yet.', [t1])).toEqual({ perMeeting: true, perTopic: false, blockerCueId: 't1' })
    expect(wouldWithhold('Kiosk vendor review has no owner yet.', [t1, t2])).toEqual({ perMeeting: true, perTopic: true, blockerCueId: 't2' })
    // Exactly 0.25 is a topic match (the reference withholds this pair under the topic rule: overlap 0.25, reason template).
    expect(wouldWithhold('Who owns alpha echo foxtrot golf?', [{ cueId: 'q', detail: 'Name the owner for alpha beta gamma delta.' }]))
      .toEqual({ perMeeting: true, perTopic: true, blockerCueId: 'q' })
    expect(isTemplateCue(n1.detail)).toBe(true)
    expect(isTemplateCue('Nothing to ask here.')).toBe(false)
  })
})
