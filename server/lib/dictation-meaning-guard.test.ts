import { describe, expect, it } from 'vitest'
import { looksEnglish, meaningGuardCounts, meaningGuardEnabled, meaningGuardProblem } from './dictation-meaning-guard.js'

// 6.91.0 meaning guard (plan r2, canary C1b). Synthetic, fictional text only.
const kind = (input: string, output: string, known: string[] = []) => meaningGuardProblem(input, output, known)?.kind ?? null

describe('6.91.0 meaning guard: planted drops are caught', () => {
  it.each([
    ['negation: "never merge" becomes "merge"', 'never merge to main before the review', 'Merge to main before the review.', 'negation'],
    ['negation: a dropped n\'t', "we don't ship on Fridays", 'We ship on Fridays.', 'negation'],
    ['negation: a dropped not', 'the build is not ready for Lena', 'The build is ready for Lena.', 'negation'],
    ['negation: without, unless, except', 'ship it unless the tests fail', 'Ship it if the tests fail.', 'negation'],
    ['negation: no as a determiner', 'there are no meetings this week', 'There are meetings this week.', 'negation'],
    ['number: digits', 'order 12 cases of the red', 'Order cases of the red.', 'number'],
    ['number: a spoken number changed', 'order five cases of the red', 'Order four cases of the red.', 'number'],
    ['number: an amount', 'the quote was $450 for the stand', 'The quote was for the stand.', 'number'],
    ['number: a percent', 'conversion rose 15% last week', 'Conversion rose last week.', 'number'],
    ['number: a clock time', 'the call is at 10:30 with Marco', 'The call is at 10 with Marco.', 'number'],
    ['number: am and pm', 'meet at three pm in the lobby', 'Meet at three in the lobby.', 'number'],
    ['number: an ordinal', 'take the second exit after the bridge', 'Take the exit after the bridge.', 'number'],
    ['number: thousands', 'the budget is fifty thousand for Q4', 'The budget is for Q4.', 'number'],
    ['date: a weekday', 'send it to Lena on Thursday', 'Send it to Lena.', 'date'],
    ['date: a month', 'the trial ends in October for the store', 'The trial ends for the store.', 'date'],
    ['name: a mid-sentence capital', 'send the deck to Priya before lunch', 'Send the deck before lunch.', 'name'],
    ['name: a different name', 'loop in Marco on the thread', 'Loop in Lena on the thread.', 'name'],
    ['name: a dictionary term in lowercase', 'pull the tableau numbers', 'Pull the numbers.', 'name'],
    ['a dictionary term with digits (the digits count first)', 'pull the jewel360 numbers', 'Pull the numbers.', 'number'],
    ['name: an acronym', 'the API returns an error for Lena', 'The endpoint returns an error for Lena.', 'name'],
    ['number: a digit inside a word changed', 'the Q4 plan is ready', 'The Q3 plan is ready.', 'number'],
    // A dropped name is not "re-spelled" into a near name the speaker also said.
    ['name: dropped beside a similar name', 'send it to Dan and Dana', 'Send it to Dana.', 'name'],
  ])('%s', (_label, input, output, expected) => {
    expect(kind(input, output, ['Jewel360', 'Tableau'])).toBe(expected)
  })

  it('symmetric: a negation or number the speaker never said trips it too', () => {
    expect(kind('merge it to main today', 'Do not merge it to main today.')).toBe('negation')
    expect(kind('order cases of the red', 'Order 6 cases of the red.')).toBe('number')
    expect(meaningGuardProblem('order cases', 'Order 6 cases.')!.added.number).toBe(1)
  })

  it('counts only, never a word', () => {
    const problem = meaningGuardProblem('never send it to Priya on Friday', 'Send it.')!
    const line = meaningGuardCounts(problem)
    expect(line).toBe('negation=1/0 number=0/0 date=1/0 name=1/0')
    expect(line).not.toMatch(/priya|friday|never/i)
  })
})

describe('6.91.0 meaning guard: normalization classes do not trip', () => {
  it.each([
    ['number words and digits', 'we need twenty five chairs and three tables', 'We need 25 chairs and 3 tables.'],
    ['digits and number words', 'we need 25 chairs', 'We need twenty-five chairs.'],
    ['a year spoken in pairs', 'the plan for twenty twenty six is ready', 'The plan for 2026 is ready.'],
    ['a time with o\'clock', 'call me at three o\'clock', 'Call me at 3:00.'],
    ['a spoken time', 'the call is at ten thirty Central', 'The call is at 10:30 Central.'],
    ['a.m. and AM', 'the train is at 7 a.m.', 'The train is at 7 AM.'],
    ['an amount in words and symbols', 'it cost two hundred dollars', 'It cost $200.'],
    ['thousands separators', 'we sold 1,000 units', 'We sold 1000 units.'],
    ['k for thousand', 'the budget is 50k', 'The budget is fifty thousand.'],
    ['percent sign and word', 'it rose 15 percent', 'It rose 15%.'],
    ['contractions in', 'I do not think we will make it', "I don't think we'll make it."],
    ['contractions out', "I don't think it's ready", 'I do not think it is ready.'],
    ['cannot and can\'t', 'we cannot ship it', "We can't ship it."],
    ['possessives fold', "send it to Dana's team", 'Send it to the team of Dana.'],
    ['plurals fold', 'the OKRs are due for Lena', 'The OKR list is due for Lena.'],
    ['sentence-initial capitals are not names', 'So the plan is ready. Basically we ship it.', 'The plan is ready. We ship it.'],
    ['"I" is not a name', 'I think I can do it', 'I can do it.'],
    ['"I" mid-sentence is not a name either', 'the plan I think works', 'The plan works.'],
    ['"I\'m" and "I\'ll" are not names', "so I'm thinking we ship it and I'll tell Lena", 'We ship it and tell Lena.'],
    ['a slug keeps its words', 'move it to /build-and-price for Marco', 'Move it to /build-and-price for Marco.'],
    ['an email keeps its parts', 'mail sam@example.com about Lena', 'Mail sam@example.com about Lena.'],
    ['a name joined into one word', 'update the Hub Spot form', 'Update the HubSpot form.'],
    ['a dictionary phrase joined into a domain', 'the site is bottle pos dot com slash pricing', 'The site is bottlepos.com/pricing'],
    ['spoken digits joined into a product name', 'pull the tablo numbers for jewel three sixty', 'Pull the Tableau numbers for Jewel360.'],
    ['digits inside a word on both sides', 'the Q4 plan for iTerm2', 'The Q4 plan for iTerm2.'],
    ['a name re-spelled to the dictionary', 'ask Preeya about the form', 'Ask Priya about the form.'],
    ['a near re-spelling of a mis-heard name', 'ask Silus about the plan', 'Ask Silas about the plan.'],
    ['a false start without guarded words', 'we should, the plan is to ship it', 'The plan is to ship it.'],
    ['fillers and stutters', 'um the the pricing page is is broken', 'The pricing page is broken.'],
    ['"may" the verb is not a date', 'we may ship it', 'We might ship it.'],
  ])('%s', (_label, input, output) => {
    expect(meaningGuardProblem(input, output, ['Priya', 'HubSpot', 'Tableau', 'Jewel360', 'Bottle POS'])).toBeNull()
  })
})

describe('6.91.0 meaning guard: self-corrections', () => {
  it.each([
    ['"five, actually six" keeps only six', 'order five actually six cases of the red', 'Order six cases of the red.'],
    ['b02 weekday for weekday', 'schedule it for Tuesday no wait Wednesday at ten', 'Schedule it for Wednesday at ten.'],
    ['b03 name for name', 'send the draft to Sam I mean Sara before lunch', 'Send the draft to Sara before lunch.'],
    ['b04 an amount', 'the budget is forty thousand sorry fifty thousand for Q4', 'The budget is fifty thousand for Q4.'],
    ['b05 scratch that', 'tell the team the meeting moved to two scratch that three', 'Tell the team the meeting moved to three.'],
    ['b06 or rather', 'book the room for eight people or rather ten people', 'Book the room for ten people.'],
    ['b07 ", no," is a marker, not a negation', 'use the blue logo, no, the green logo on the banner', 'Use the green logo on the banner.'],
    ['b08 wait no', 'remind me on Monday wait no Friday to follow up', 'Remind me on Friday to follow up.'],
    ['b09 a time', 'the call is at nine thirty I mean ten thirty Central', 'The call is at ten thirty Central.'],
    ['b10 Priya, actually Dana', 'add Priya to the invite actually add Dana instead', 'Add Dana to the invite.'],
    ['never mind is a marker, not a negation', 'set the reminder for nine never mind make it ten', 'Set the reminder for ten.'],
    ['"never mind the cost" kept on both sides', 'never mind the cost we need the faster laptop', 'Never mind the cost, we need the faster laptop.'],
  ])('%s', (_label, input, output) => {
    expect(meaningGuardProblem(input, output, ['Priya', 'Dana'])).toBeNull()
  })

  it('a correction excuses only a same-kind replacement the answer kept', () => {
    // No number after the marker: the dropped number is not excused.
    expect(kind('order five actually make it a big order', 'Make it a big order.')).toBe('number')
    // The replacement itself was dropped too.
    expect(kind('order five actually six cases', 'Order cases.')).toBe('number')
    // A name replaced by a number is not a same-kind replacement.
    expect(kind('ask Marco actually ask 3 people', 'Ask 3 people.')).toBe('name')
  })

  it('a negation is never excused by a correction', () => {
    expect(kind("don't ship it actually ship it", 'Ship it.')).toBe('negation')
    expect(kind('we will not go, sorry, we will go', 'We will go.')).toBe('negation')
    // Even when another negation replaces it: never is not not.
    expect(kind('we will never ship it, actually we will not ship it', 'We will not ship it.')).toBe('negation')
  })

  it('the marker must come after the dropped token, and the replacement must survive', () => {
    // "seven" comes after the marker: it is not the thing corrected, so dropping it trips.
    expect(kind('set it to five actually six or seven', 'Set it to six.')).toBe('number')
    // Marco's replacement (Lena) was itself dropped, so Marco is not excused; Lena is (by Kim).
    expect(kind('ask Marco, actually ask Lena about the new pricing deck, sorry, Kim', 'Ask Kim about the new pricing deck.')).toBe('name')
    expect(meaningGuardProblem('ask Marco, actually ask Lena about the new pricing deck, sorry, Kim', 'Ask Kim about the new pricing deck.')!.dropped.name).toBe(1)
  })

  it('an answer that keeps the replaced value still passes (the backtrack scorer judges that, not the guard)', () => {
    expect(meaningGuardProblem('order five actually six cases', 'Order five, actually six cases.')).toBeNull()
  })
})

describe('6.91.0 meaning guard: language, switch, robustness', () => {
  it('a dictation that is not English skips the name check, never the others', () => {
    expect(looksEnglish('the plan is ready and we ship it on Friday')).toBe(true)
    expect(looksEnglish('der Plan ist fertig und wir liefern ihn am Freitag mit Marco aus')).toBe(false)
    expect(kind('der Plan ist fertig und wir liefern ihn am Freitag mit Marco aus', 'Der Plan ist fertig und wir liefern ihn am Freitag aus.')).toBeNull()
    expect(meaningGuardProblem('der Plan ist fertig und wir liefern 5 Kisten mit Marco heute aus', 'Der Plan ist fertig.')!.namesSkipped).toBe(true)
    expect(kind('der Plan ist fertig und wir liefern 5 Kisten mit Marco heute aus', 'Der Plan ist fertig.')).toBe('number')
  })

  it('COS_DICTATION_MEANING_GUARD: on unless 0, false or off', () => {
    expect(meaningGuardEnabled({})).toBe(true)
    for (const off of ['0', 'false', 'OFF', ' off ']) expect(meaningGuardEnabled({ COS_DICTATION_MEANING_GUARD: off })).toBe(false)
    expect(meaningGuardEnabled({ COS_DICTATION_MEANING_GUARD: '1' })).toBe(true)
  })

  it('never throws on odd input', () => {
    for (const [a, b] of [['', ''], ['$$$ %%%', '%'], ['\u0000\u200B', 'x'], ['a'.repeat(9000), 'b'], ['1,2,3,4', '1234']]) {
      expect(() => meaningGuardProblem(a, b)).not.toThrow()
    }
    expect(meaningGuardProblem(undefined as any, 'x')).toBeNull()
  })
})
