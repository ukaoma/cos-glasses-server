import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyFuzzyCorrections } from '../lib/fuzzy-correct.js'

const here = dirname(fileURLToPath(import.meta.url))
const routeSrc = () => readFileSync(resolve(here, 'prompt-drafts.ts'), 'utf8')

// Miles's 344 report: phone Moonshine dictation renders Niala and Ukaoma wrong. The exact
// correction map only fixes hand-authored misspellings, so a novel miss sails through.
// applyFuzzyCorrections is the pass that should catch those, and it had exactly ONE call
// site (transcribe-audio.ts:252) — the server-transcription route. Phone dictation arrives
// at /dictation/finalize as TEXT and never reached it.

describe('fuzzy corrections reach the dictation finalize path (6.27.4)', () => {
  it('is wired into cleanOutboundDictation, not just the transcribe route', () => {
    const src = routeSrc()
    expect(src).toMatch(/import \{ applyFuzzyCorrections \} from '\.\.\/lib\/fuzzy-correct\.js'/)
    // Inside cleanOutboundDictation, and BEFORE the autoclean LLM call, so the model sees
    // corrected proper nouns instead of being asked to guess at them.
    expect(src).toMatch(/async function cleanOutboundDictation[\s\S]{0,1400}applyFuzzyCorrections\(cleaned, fuzzyTargets\)/)
    expect(src).toMatch(/applyFuzzyCorrections\(cleaned, fuzzyTargets\)[\s\S]{0,900}autoCleanDictation\(/)
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
  const targets = ['Niala', 'Ukaoma', 'Austin', 'Miles', 'Queen', 'Amira', 'Isaiah']
  const run = (s: string) => applyFuzzyCorrections(s, targets)

  it('catches single-edit misses', () => {
    expect(run('Meet in Austen').text).toContain('Austin')
    expect(run('Talk to Nyala').text).toContain('Niala')
  })

  it('DOES NOT catch multi-edit misses — the distance budget is 1 at these lengths', () => {
    // Miyala->Niala is 2 edits and Yukoma->Ukaoma is 3, both over budget for their length.
    // Recorded rather than wished away: these two specific words still need explicit
    // entries in whisper_corrections, so wiring the fuzzy pass does NOT make that
    // backfill redundant.
    expect(run('Call Miyala today').replacements).toBe(0)
    expect(run('Miles Yukoma spoke').replacements).toBe(0)
  })
})
