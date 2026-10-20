import { describe, expect, it } from 'vitest'
import { MAX_WORDS, polishNeed, skipCleanEnabled } from './dictation-polish-need.js'

// Synthetic dictation only.
describe('6.79.2 skip-when-clean rule', () => {
  it.each([
    // Clean: capitalized, closed, nothing for the model to do.
    ['Can you check the build status?', null],
    ['Send the deck to Dana before lunch.', null],
    ['I think the first option is better.', null],
    ['The API returns a 404 on the v2 endpoint.', null],
    ['"Ship it," she said.', null],
    ['I like the second design better.', 'filler_like'],
    // Backtracks and corrections.
    ['Order five, actually six cases.', 'backtrack'],
    ['Schedule it Tuesday, no wait, Wednesday.', 'backtrack'],
    ['Remind me Monday, wait no, Friday.', 'backtrack'],
    ['Send it to Sam, I mean Sara.', 'backtrack'],
    ['Move it to two, scratch that, three.', 'backtrack'],
    ['Forty thousand, sorry, fifty thousand.', 'backtrack'],
    ['Eight people, or rather ten.', 'backtrack'],
    ['Use the blue logo, no, the green one.', 'backtrack'],
    ['No no, the other file.', 'backtrack'],
    // Repeats, stutters, restarts.
    ['The the pricing page is broken.', 'repeat'],
    ['I, I wanted to ask.', 'repeat'],
    ['We should, we need to finalize it.', 'false_start'],
    ['I think, I know the answer.', 'false_start'],
    // Tics the filler pass leaves to the model.
    ['You know the report is done.', 'filler_like'],
    ['The numbers look kind of off.', 'filler_like'],
    ['Can you sort of summarize it?', 'filler_like'],
    ['It is basically done.', 'filler_like'],
    ['So can you check the build status.', 'filler_like'],
    ['Okay send it to the team.', 'filler_like'],
    ['Well, that went fine.', 'filler_like'],
    // Filler sounds still present (a meeting line, or one the pass kept).
    ['The forecast, um, is ready.', 'filler'],
    ['Hmm, the forecast is ready.', 'filler'],
    // Spoken formatting and punctuation.
    ['Groceries new line milk.', 'formatting'],
    ['Agenda bullet point budget.', 'formatting'],
    ['Numbered list first draft.', 'formatting'],
    ['Hi Dana comma thanks.', 'formatting'],
    ['Can we talk question mark.', 'formatting'],
    ['End it with a period.', 'formatting'],
    // Not finished: the model fixes case and punctuation.
    ['send the deck to Dana', 'unfinished'],
    ['Send the deck to Dana', 'unfinished'],
    ['send the deck to Dana.', 'unfinished'],
    ['', 'unfinished'],
    // Long.
    [`${Array.from({ length: MAX_WORDS + 1 }, (_, i) => `w${i}`).join(' ').replace(/^w/, 'W')}.`, 'long'],
  ] as const)('%j -> %s', (text, need) => {
    expect(polishNeed(text)).toBe(need)
  })

  it('exactly MAX_WORDS words is still clean', () => {
    const text = `${Array.from({ length: MAX_WORDS }, (_, i) => `w${i}`).join(' ').replace(/^w/, 'W')}.`
    expect(polishNeed(text)).toBeNull()
  })

  it('words that merely contain a marker are not markers', () => {
    for (const text of ['The likelihood is high.', 'Factually correct.', 'The thesis is done.', 'Grab the commas file.', 'Then the theme loads.']) {
      expect(polishNeed(text), text).toBeNull()
    }
  })

  it('COS_DICTATION_POLISH_SKIP_CLEAN: off unless 1, true or on', () => {
    expect(skipCleanEnabled({})).toBe(false)
    expect(skipCleanEnabled({ COS_DICTATION_POLISH_SKIP_CLEAN: 'banana' })).toBe(false)
    for (const on of ['1', 'true', ' ON ']) expect(skipCleanEnabled({ COS_DICTATION_POLISH_SKIP_CLEAN: on }), on).toBe(true)
  })
})
