import { describe, expect, it } from 'vitest'
import { fillerPassEnabled, stripDisfluencies } from './dictation-fillers.js'

// Synthetic dictation only.
describe('6.79.1 deterministic filler pass', () => {
  it.each([
    // Mid-sentence, no punctuation.
    ['We need uh the deck by Friday', 'We need the deck by Friday'],
    ['Send the um the update', 'Send the the update'],
    ['ship it er tomorrow', 'ship it tomorrow'],
    ['ship it erm tomorrow', 'ship it tomorrow'],
    ['Book the room uhm at noon', 'Book the room at noon'],
    // Between commas: the pair collapses to one.
    ['So, um, we should ship', 'So, we should ship'],
    ['The plan, uh, is solid', 'The plan, is solid'],
    // Sentence start: capital handed on; lowercase input stays lowercase.
    ['Um, I think we are ready', 'I think we are ready'],
    ['Uh, can you check the build', 'Can you check the build'],
    ['um, so we go', 'so we go'],
    ['Okay. Um, let us start', 'Okay. Let us start'],
    ['Done? Uh, maybe not', 'Done? Maybe not'],
    // Said as its own sentence.
    ['Hmm. Let me think about it.', 'Let me think about it.'],
    ['Okay. Um. Let us go', 'Okay. Let us go'],
    ['Mhm, sure thing', 'Sure thing'],
    // Before closing punctuation, the pause comma goes too.
    ['I think, uh.', 'I think.'],
    ['Is that right, hmm?', 'Is that right?'],
    ['Let us ship it, um', 'Let us ship it'],
    ['Let us ship it um.', 'Let us ship it.'],
    ['Call (uh) Dana', 'Call () Dana'],
    // Ellipses and dashes after a filler.
    ['It was um... great', 'It was great'],
    ['It was um… great', 'It was great'],
    ['well — um — we could', 'well — we could'],
    ['Um... I forgot', 'I forgot'],
    // Runs and elongations.
    ['um um the deck', 'the deck'],
    ['Uh, um, so the plan', 'So the plan'],
    ['Ummm, yes', 'Yes'],
    ['the hmmm thing', 'the thing'],
    ['it is ahh fine', 'it is fine'],
    ['Ahh, I see', 'I see'],
    ['Mm, that works', 'That works'],
    ['that uhh works', 'that works'],
    // Quotes and line breaks.
    ['He said "um, no"', 'He said "no"'],
    ['First line\num, second line', 'First line\nsecond line'],
    ['First line\nUm, second line', 'First line\nSecond line'],
    // A doubled pause mark left at the start goes too.
    ['um,, so we go', 'so we go'],
  ])('%j -> %j', (input, expected) => {
    expect(stripDisfluencies(input)).toBe(expected)
  })

  it.each([
    // Words that contain the letters.
    'Bring an umbrella and keep going ahead',
    'To err is human',
    'The hummingbird hummed',
    'Erma and Ahmed will join',
    'Check the umami and the uhaul',
    // Hyphen and apostrophe forms carry meaning.
    'Uh-oh, the build broke',
    'She said uh-huh and mm-hmm',
    // ALL-CAPS tokens are acronyms.
    'UM beat ER in the final, AH was close',
    'HMM is the model name',
    // A unit after a number.
    'Use a 5 mm bolt and a 10mm spacer',
    // Nothing to do.
    'Plain text with no hesitation.',
    ', and a leading comma stays when nothing was removed',
    '',
  ])('leaves %j unchanged', input => {
    expect(stripDisfluencies(input)).toBe(input)
  })

  it('returns the original when every word was a filler', () => {
    for (const input of ['Um.', 'uh, um', 'Hmm?', ' mm ']) expect(stripDisfluencies(input)).toBe(input)
  })

  it('is idempotent', () => {
    for (const input of ['So, um, we should ship', 'Um, I think, uh.', 'Okay. Um. Let us go']) {
      const once = stripDisfluencies(input)
      expect(stripDisfluencies(once)).toBe(once)
    }
  })

  it('COS_DICTATION_FILLER_PASS: on unless 0, false or off', () => {
    expect(fillerPassEnabled({})).toBe(true)
    expect(fillerPassEnabled({ COS_DICTATION_FILLER_PASS: '1' })).toBe(true)
    expect(fillerPassEnabled({ COS_DICTATION_FILLER_PASS: 'banana' })).toBe(true)
    for (const off of ['0', 'false', 'OFF', ' off ']) expect(fillerPassEnabled({ COS_DICTATION_FILLER_PASS: off }), off).toBe(false)
  })
})
