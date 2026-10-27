import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyFuzzyCorrections } from '../lib/fuzzy-correct.js'

const here = dirname(fileURLToPath(import.meta.url))
// 6.91.0: the outbound pipeline moved out of the route into lib/dictation-polish-pipeline.ts.
const routeSrc = () => readFileSync(resolve(here, '../lib/dictation-polish-pipeline.ts'), 'utf8')

// Miles's 344 report: phone Moonshine dictation renders Ilona and Ukamya wrong. The exact
// correction map only fixes hand-authored misspellings, so a novel miss sails through.
// applyFuzzyCorrections is the pass that should catch those, and it had exactly ONE call
// site (transcribe-audio.ts:252) — the server-transcription route. Phone dictation arrives
// at /dictation/finalize as TEXT and never reached it.

describe('fuzzy corrections reach the dictation finalize path (6.27.4)', () => {
  it('is wired into cleanOutboundDictation, not just the transcribe route', () => {
    const src = routeSrc()
    expect(src).toMatch(/import \{ applyFuzzyCorrections \} from '\.\/fuzzy-correct\.js'/)
    // Inside cleanOutboundDictation, and BEFORE the autoclean LLM call, so the model sees
    // corrected proper nouns instead of being asked to guess at them.
    // 6.79.2: the body moved to polishOutboundDictation (cleanOutboundDictation wraps it to settle a prewarm).
    // 6.91.0: the deterministic passes are prepareOutboundDictation, which polishOutboundDictation runs first.
    expect(src).toMatch(/export function prepareOutboundDictation[\s\S]{0,1400}applyFuzzyCorrections\(cleaned, fuzzyTargets\)/)
    expect(src).toMatch(/async function polishOutboundDictation\([\s\S]{0,200}const cleaned = prepareOutboundDictation\(text, opts\.bucket\)[\s\S]{0,3200}autoCleanDictation\(/)
  })

  it('uses the same target construction as the proven call site', () => {
    expect(routeSrc()).toMatch(/\[\.\.\.getAllSpeakerNames\(\), \.\.\.getVocabulary\(\)\]/)
  })

  it('cannot cost the user their transcript when it throws', () => {
    // Non-fatal by construction, matching transcribe-audio.ts. A correction pass is
    // quality enhancement, never a durability dependency.
    expect(routeSrc()).toMatch(/applyFuzzyCorrections[\s\S]{0,400}catch \(fuzzyErr/)
  })
})

// The measured behaviour, so nobody assumes a reach this pass does not have. Thresholds
// are edit-distance by word length: 5-8 chars gets 1, 9-11 gets 2, 12+ gets 3.
describe('what the fuzzy pass actually catches (measured, not assumed)', () => {
  const targets = ['Ilona', 'Ukamya', 'Austin', 'Miles', 'Faith', 'Talia', 'Felix']
  const run = (s: string) => applyFuzzyCorrections(s, targets)

  it('catches single-edit misses', () => {
    expect(run('Meet in Austen').text).toContain('Austin')
    expect(run('Talk to Ilena').text).toContain('Ilona')
  })

  it('DOES NOT catch multi-edit misses — the distance budget is 1 at these lengths', () => {
    // Yilena->Ilona is 2 edits and Yukmya->Ukamya is 3, both over budget for their length.
    // Recorded rather than wished away: these two specific words still need explicit
    // entries in whisper_corrections, so wiring the fuzzy pass does NOT make that
    // backfill redundant.
    expect(run('Call Yilena today').replacements).toBe(0)
    expect(run('Miles Yukmya spoke').replacements).toBe(0)
  })
})
