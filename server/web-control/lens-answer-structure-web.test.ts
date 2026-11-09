/**
 * 7.0.5: a COS answer is written for the G2 lens as plain text, so on the phone a numbered list ran together into one
 * paragraph (Miles's iPhone, chat card "Message #455 Answered"). structureLensAnswer (app.js) puts inline lists on their
 * own lines before md() draws the answer, on the web only. It runs from the real app.js in a vm (never re-implemented
 * here), and the two places a COS answer is shown run from the real pane code: the chat card (panes/cos-chat.js
 * askHtml, loaded whole) and the Messages reader (panes/messages.js turnCards, which the recent reader and the archive
 * chat both draw through).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(HERE, p), 'utf8')
const APP = read('app.js')
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1)
  expect(a, from).toBeGreaterThan(-1)
  expect(b, to).toBeGreaterThan(a)
  return src.slice(a, b)
}

function kit() {
  const ctx: any = vm.createContext({})
  vm.runInContext(slice(APP, '  function esc(s)', '  var WORDS = [') + ';this.f = structureLensAnswer; this.md = md; this.esc = esc;', ctx)
  return ctx as { f: (s: unknown) => string; md: (s: string) => string; esc: (s: unknown) => string }
}
const K = kit()
const f = K.f
// Only whitespace may change: the answer's characters, in order, are exactly the original's.
const ink = (s: string) => s.replace(/\s+/g, '')
const words = (s: string) => s.replace(/\s+/g, ' ').trim()

// The #455 answer as Miles's screenshot shows it (the dots are the screenshot's elisions, kept as text).
const T455 = "...What it unlocks for me: 1. Prep before each meeting: past decisions, open items, who's in the room. 2. Catching conflicts early, like ... 3. Checking road closures ... 4. Fitting tasks ... 5. Wrap-ups after each meeting... How your day should change: 1. Block one 90-minute deep-work stretch before 10 AM each day. 2. Settle each overlap the night before: go, delegate or decline. 3. Get a prep card ... 4. Keep the end of the day for wrap-up. I draft the follow-ups and you approve them. Want me to draft which of this week's overlaps to decline or delegate? I'd only draft the list. Nothing changes without your go."
const E455 = "...What it unlocks for me:\n\n" +
  "1. Prep before each meeting: past decisions, open items, who's in the room.\n" +
  '2. Catching conflicts early, like ...\n' +
  '3. Checking road closures ...\n' +
  '4. Fitting tasks ...\n' +
  '5. Wrap-ups after each meeting...\n\n' +
  'How your day should change:\n\n' +
  '1. Block one 90-minute deep-work stretch before 10 AM each day.\n' +
  '2. Settle each overlap the night before: go, delegate or decline.\n' +
  '3. Get a prep card ...\n' +
  "4. Keep the end of the day for wrap-up. I draft the follow-ups and you approve them. Want me to draft which of this week's overlaps to decline or delegate? I'd only draft the list. Nothing changes without your go."

describe('structureLensAnswer: the #455 answer', () => {
  it('two lists, each under its own lead-in line; the closing sentences and question stay with the last item', () => {
    expect(f(T455)).toBe(E455)
  })
  it('a sentence before the first "Label:" gets its own paragraph; the label is the lead-in line', () => {
    expect(f('Short version. Here is the plan: 1. Draft it. 2. Send it.')).toBe('Short version.\n\nHere is the plan:\n\n1. Draft it.\n2. Send it.')
  })
  it('a lead-in that ends with a period still leads the list', () => {
    expect(f('Two things matter. 1. Sleep. 2. Water.')).toBe('Two things matter.\n\n1. Sleep.\n2. Water.')
  })
  it('only whitespace changes, and the visible words are the same', () => {
    expect(ink(f(T455))).toBe(ink(T455))
    expect(words(f(T455))).toBe(words(T455))
  })
  it('md() then draws each item on its own line (the card is white-space: pre-wrap)', () => {
    const html = K.md(f(T455))
    expect(html).toContain('What it unlocks for me:\n\n1. Prep before each meeting')
    expect(html).toContain('\n5. Wrap-ups after each meeting...\n\nHow your day should change:\n\n1. Block one 90-minute')
    expect(html).toContain('who&#39;s in the room.')
  })
})

describe('structureLensAnswer: text it must leave alone', () => {
  it('already-structured Markdown: bullets, numbered lines, headings, paragraphs, fences, quotes, tables', () => {
    const cases = [
      '- one\n- two. 1. a. 2. b.',
      '* one. 1. a. 2. b.',
      'Plan:\n1. Draft it. 2. Send it.',
      '# Plan: 1. Draft it. 2. Send it.',
      'Intro: 1. a. 2. b.\n\nSecond paragraph.',
      '```\nx: 1. a. 2. b.\n```',
      '> quote: 1. a. 2. b.',
      '| a | b |\nPlan: 1. a. 2. b.',
    ]
    for (const c of cases) expect(f(c), c).toBe(c)
  })
  it('numbers inside a sentence never split: "Version 2. Then", "at 8:30. 2 people", "90-minute", "10 AM"', () => {
    for (const c of [
      'Use version 2. Then restart it.',
      'Meet at 8:30. 2 people are coming.',
      'Block one 90-minute stretch before 10 AM. Then rest.',
      'We shipped release 1. 2 bugs came back.',
    ]) expect(f(c), c).toBe(c)
  })
  it('one item is not a list; out of order is not a list', () => {
    expect(f('Next step: 1. only one item. Then we wait.')).toBe('Next step: 1. only one item. Then we wait.')
    expect(f('Order: 1. first. 3. third. 4. fourth.')).toBe('Order: 1. first. 3. third. 4. fourth.')
    expect(f('Order: 2. second. 3. third.')).toBe('Order: 2. second. 3. third.')
  })
  it('a marker needs a sentence end before it: "Steps 1. a 2. b" with no punctuation stays', () => {
    expect(f('Steps 1. a 2. b')).toBe('Steps 1. a 2. b')
  })
  it('a number ending an item does not split it: "Ship version 2. 2. Tell Gina"', () => {
    expect(f('Plan: 1. Ship version 2. 2. Tell Gina at 8:30. 3. Done.')).toBe('Plan:\n\n1. Ship version 2.\n2. Tell Gina at 8:30.\n3. Done.')
  })
  it('after a list, a new 1 without a "Label:" lead-in stays in the last item (no guessing)', () => {
    expect(f('Do: 1. a. 2. b. Also. 1. c. 2. d.')).toBe('Do:\n\n1. a.\n2. b. Also. 1. c. 2. d.')
  })
  it('an item with no sentence end before the next "Label:" keeps its own number (the lead-in scan starts after "2.")', () => {
    expect(f('Do: 1. a. 2. Wrap-ups Next steps: 1. c. 2. d.')).toBe('Do:\n\n1. a.\n2. Wrap-ups Next steps:\n\n1. c.\n2. d.')
  })
  it('a numbered line anywhere means the answer already has structure: the inline list on another line stays', () => {
    const c = 'Steps:\n1. Draft it.\nThen: 1. a. 2. b.'
    expect(f(c)).toBe(c)
  })
  it('a long lead-in sentence is not split from the item before it (the label limit)', () => {
    const long = 'x'.repeat(120)
    expect(f(`Do: 1. a. 2. b. ${long}: 1. c. 2. d.`)).toBe(`Do:\n\n1. a.\n2. b. ${long}:\n\n1. c.\n2. d.`)
  })
  it('never inside a code span', () => {
    expect(f('Run `a. 1. b. 2. c` now.')).toBe('Run `a. 1. b. 2. c` now.')
    expect(f('Steps: 1. Run `x. 2. y` then. 2. Done.')).toBe('Steps:\n\n1. Run `x. 2. y` then.\n2. Done.')
  })
  it('a link stays whole inside its item', () => {
    expect(f('Read: 1. See https://example.com/a.b?x=1. 2. Reply.')).toBe('Read:\n\n1. See https://example.com/a.b?x=1.\n2. Reply.')
  })
  it('empty, null and non-strings come back as strings', () => {
    expect(f('')).toBe('')
    expect(f(null)).toBe('')
    expect(f(undefined)).toBe('')
  })
  it('a lens answer over several lines: only the line with the list changes, and a blank line follows the list', () => {
    expect(f('Morning.\nToday: 1. a. 2. b.\nThat is all.')).toBe('Morning.\nToday:\n\n1. a.\n2. b.\n\nThat is all.')
  })
})

// 7.0.7 (final QA W1): a cut makes a new line start, and md() styles a line by how it starts; it also cannot close
// **bold** across lines. So a cut never enters a code, bold or italic span, never makes a line start with a heading,
// quote, bullet, table row, "[" or "<" or a number marker, and a list whose item starts a block is left whole.
describe('structureLensAnswer: md() draws the same characters (7.0.7, final QA W1)', () => {
  // QA's three probes. Before 7.0.7: "> 5" drew as a quote and lost its ">", "# of" drew as a heading and lost its "#",
  // and the bold was split across lines so both ** showed as stars.
  it('a "Label:" that starts with > or # stays on its line; the list still structures', () => {
    expect(f('Note this. > 5 users said: 1. Fast. 2. Cheap.')).toBe('Note this. > 5 users said:\n\n1. Fast.\n2. Cheap.')
    expect(f('Done. # of open items: 1. Deck. 2. Budget.')).toBe('Done. # of open items:\n\n1. Deck.\n2. Budget.')
    expect(f('Done. - next: 1. a. 2. b.')).toBe('Done. - next:\n\n1. a.\n2. b.')
  })
  it('a "Label:" that starts with * + | [ < or a number marker stays on its line', () => {
    expect(f('Done. * next: 1. a. 2. b.')).toBe('Done. * next:\n\n1. a.\n2. b.')
    expect(f('Done. + next: 1. a. 2. b.')).toBe('Done. + next:\n\n1. a.\n2. b.')
    expect(f('Done. | next: 1. a. 2. b.')).toBe('Done. | next:\n\n1. a.\n2. b.')
    expect(f('Done. [Miles]: 1. a. 2. b.')).toBe('Done. [Miles]:\n\n1. a.\n2. b.')
    expect(f('Done. <details>: 1. a. 2. b.')).toBe('Done. <details>:\n\n1. a.\n2. b.')
    expect(f('Done. 3) next: 1. a. 2. b.')).toBe('Done. 3) next:\n\n1. a.\n2. b.')
    expect(f('Done. 2026 plan: 1. a. 2. b.')).toBe('Done.\n\n2026 plan:\n\n1. a.\n2. b.')
  })
  it('never inside **bold**, __bold__, *italic*, _italic_ or md()\'s code span ("``" is not one); a list item may hold **bold** itself', () => {
    for (const c of [
      '**Steps: 1. Prep the deck. 2. Ship it.**',
      '__Steps: 1. Prep the deck. 2. Ship it.__',
      '*Steps: 1. Prep the deck. 2. Ship it.*',
      '_Steps: 1. Prep the deck. 2. Ship it._',
      'Plan: 1. a**b. 2. c**d.',
      'Plan: 1. a*b. 2. c*d.',
      'Note `` x. Plan: 1. a. 2. b` y.',
      '** Steps: 1. Prep the deck. 2. Ship it. **',
    ]) expect(f(c), c).toBe(c)
    expect(f('Plan: 1. **Prep** the deck. 2. Ship it.')).toBe('Plan:\n\n1. **Prep** the deck.\n2. Ship it.')
    expect(f('Plan: 1. Prep the *deck*. 2. Ship __it__.')).toBe('Plan:\n\n1. Prep the *deck*.\n2. Ship __it__.')
  })
  it('"2 * 3", a lone "*" and a word\'s own underscores are not spans', () => {
    expect(f('2 * 3 is six. Plan: 1. a. 2. b * c.')).toBe('2 * 3 is six.\n\nPlan:\n\n1. a.\n2. b * c.')
    expect(f('Set: 1. max_tokens to 5. 2. top_p to 1.')).toBe('Set:\n\n1. max_tokens to 5.\n2. top_p to 1.')
    expect(f('Set: 1. max_tokens to 5. 2. Use COS_ as the prefix.')).toBe('Set:\n\n1. max_tokens to 5.\n2. Use COS_ as the prefix.')
    expect(f('Plan: 1. a * b. 2. c*.')).toBe('Plan:\n\n1. a * b.\n2. c*.')
  })
  it('an item that starts a heading, a quote or a Mac task box leaves its whole list alone (never half a list)', () => {
    for (const c of [
      'Plan: 1. # one. 2. b.',
      'Plan: 1. a. 2. > b.',
      'Plan: 1. [x] done. 2. [ ] open.',
      'Do: 1. # a. 2. b. Also. 1. c. 2. d.',
    ]) expect(f(c), c).toBe(c)
    expect(f('Do: 1. # a. 2. b. Next: 1. c. 2. d.')).toBe('Do: 1. # a. 2. b.\n\nNext:\n\n1. c.\n2. d.')
    expect(f('Read: 1. [Spec](https://a.co/s). 2. Reply.')).toBe('Read:\n\n1. [Spec](https://a.co/s).\n2. Reply.')
  })
  // Through the real md(): the drawn answer is the original's, line breaks aside (no lost #, > or **).
  const drawn = (s: string) => K.md(s).replace(/\s+/g, '')
  it('the three QA probes through the real md(): same characters, only line breaks differ', () => {
    for (const probe of ['Note this. > 5 users said: 1. Fast. 2. Cheap.', 'Done. # of open items: 1. Deck. 2. Budget.', '**Steps: 1. Prep the deck. 2. Ship it.**']) {
      expect(drawn(f(probe)), probe).toBe(drawn(probe))
    }
    expect(K.md(f('Note this. > 5 users said: 1. Fast. 2. Cheap.'))).toBe('Note this. &gt; 5 users said:\n\n1. Fast.\n2. Cheap.')
    expect(K.md(f('Done. # of open items: 1. Deck. 2. Budget.'))).toBe('Done. # of open items:\n\n1. Deck.\n2. Budget.')
    expect(K.md(f('**Steps: 1. Prep the deck. 2. Ship it.**'))).toBe('<strong>Steps: 1. Prep the deck. 2. Ship it.</strong>')
    expect(K.md(f('Plan: 1. **Prep** the deck. 2. Ship it.'))).toBe('Plan:\n\n1. <strong>Prep</strong> the deck.\n2. Ship it.')
  })
  it('fuzz: 3000 list-shaped answers full of Markdown marks draw the same characters through md()', () => {
    let seed = 11
    const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296 }
    const toks = ['1.', '2.', '3.', 'Plan:', 'go.', 'now?', '**', '**bold', 'it**', '**x**', '*', '*it*', '_', '_it_', '__b__', 'x_y', '#', '>', '-', '+', '|', '[x]', '[Miles]:', '<details>', '3)', '`', '`c`', 'word', 'Done.', 'note:', '\n']
    let structured = 0
    for (let i = 0; i < 3000; i++) {
      let s = 'Intro text. '
      const n = 3 + Math.floor(rnd() * 25)
      for (let k = 0; k < n; k++) {
        if (k % 3 === 0) s += ['go.', 'Plan:', 'now?'][(k / 3) % 3 | 0] + ' ' + (1 + ((k / 3) | 0) % 4) + '. '
        s += toks[Math.floor(rnd() * toks.length)] + (rnd() < 0.85 ? ' ' : '')
      }
      const out = f(s)
      if (out !== s) structured++
      expect(ink(out), s).toBe(ink(s))
      expect(drawn(out), s).toBe(drawn(s))
    }
    expect(structured).toBeGreaterThan(1000)
  })
})

describe('structureLensAnswer: whitespace only, and fast', () => {
  it('fuzz: 2000 random answers keep every character in order', () => {
    let seed = 7
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const toks = ['1.', '2.', '3.', '4.', 'Plan:', 'go.', 'now?', 'yes!', 'at', '8:30.', '`x. 2.`', 'https://a.co/b.', 'word', 'v2.', '\n', '  ', '-', '#']
    for (let i = 0; i < 2000; i++) {
      const n = 3 + Math.floor(rnd() * 30)
      let s = ''
      for (let k = 0; k < n; k++) s += toks[Math.floor(rnd() * toks.length)] + (rnd() < 0.8 ? ' ' : '')
      const out = f(s)
      expect(ink(out), s).toBe(ink(s))
    }
  })
  it('100 KB of answer text in under 50 ms', () => {
    const big = Array(Math.ceil(100000 / T455.length)).fill(T455).join(' ')
    const bigLines = Array(Math.ceil(100000 / T455.length)).fill(T455).join('\n')
    const code = Array(20000).fill('`a. 1.` x. 2. y').join(' ')
    for (const s of [big, bigLines, code]) {
      expect(s.length).toBeGreaterThan(99000)
      f(s)
      const t0 = performance.now()
      const out = f(s)
      const ms = performance.now() - t0
      expect(ms).toBeLessThan(50)
      expect(ink(out)).toBe(ink(s))
    }
    expect(f(bigLines).split('\n1. Prep before each meeting').length - 1).toBe(Math.ceil(100000 / T455.length))
  })
})

// ── the two places a COS answer is drawn ─────────────────
const CHAT = read('panes/cos-chat.js')
function chat() {
  const W: Record<string, unknown> = {
    $: () => null, esc: K.esc, md: K.md, structureLensAnswer: K.f, toast: () => {}, autoGrow: () => {}, skeletonRows: () => '',
    toDate: (s: string) => new Date(s), readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {}, api: () => Promise.resolve({}),
  }
  const media = { matches: false, addEventListener: () => {} }
  const document = {
    addEventListener: () => {}, querySelectorAll: () => [], getElementById: () => null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
  }
  const window = { COSWeb: W, matchMedia: () => media, scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  const ctx = vm.createContext({ window, document, setTimeout, clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(CHAT, ctx)
  return W.cosChat as { _askHtml: (a: Record<string, unknown>, linked: boolean) => string }
}
const answerBody = (html: string) => {
  const m = /<div class="cc-answer md" data-ask-body>([\s\S]*?)<\/div>/.exec(html)
  expect(m, 'the answer body').not.toBeNull()
  return m![1]
}

describe('the COS chat card (panes/cos-chat.js askHtml) structures the finished answer', () => {
  it('Message #455 Answered: each item on its own line under its lead-in', () => {
    const html = chat()._askHtml({ cid: 1, no: 455, status: 'completed', query: 'What does this unlock?', response: T455 }, false)
    expect(html).toContain('Open in Messages')
    expect(answerBody(html)).toBe(K.md(E455))
  })
  it('the streaming partial is left as it streams (never restructured mid-answer)', () => {
    const html = chat()._askHtml({ cid: 2, status: 'running', jobId: 'j', query: 'q', partial: T455 }, false)
    expect(answerBody(html)).toContain('for me: 1. Prep before each meeting')
  })
  it('cos-chat.css: the answer keeps md() newlines (white-space: pre-wrap), as the Messages reader does', () => {
    const css = read('panes/cos-chat.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.cc-answer\.md\s*\{\s*white-space:\s*pre-wrap;\s*\}/)
    expect(read('control.css')).toContain('.cx-card-body.md { white-space: pre-wrap; }')
  })
})

describe('the Messages reader (panes/messages.js turnCards) structures the COS answer', () => {
  const MSG = read('panes/messages.js')
  // eslint-disable-next-line no-new-func
  const turnCards = new Function('W', 'esc', 'atts', 'isUserAtt', 'stripHtml',
    slice(MSG, '  function turnCards(t, msgKey) {', '  function copyTurnText(') + '\nreturn turnCards;')(
    { md: K.md, structureLensAnswer: K.f }, K.esc, () => [], () => true, () => '') as (t: Record<string, unknown>, key: string) => string
  it('the COS card of #455 draws the same structured answer as the chat card', () => {
    const html = turnCards({ query: 'What does this unlock?', text: T455 }, 'm-455')
    const m = /<div class="cx-card-label">COS<\/div><div class="cx-card-body md" data-hl>([\s\S]*?)<\/div>/.exec(html)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(K.md(E455))
  })
  it('Copy turn copies the answer as stored, never the structured text (7.0.7, Mac final QA W1 checked on the web)', () => {
    // eslint-disable-next-line no-new-func
    const copyTurnText = new Function('numOf', slice(MSG, '  function copyTurnText(t) {', '  function renderMessage(') + '\nreturn copyTurnText;')(
      () => 455) as (t: Record<string, unknown>) => string
    expect(copyTurnText({ query: 'What does this unlock?', text: T455 })).toBe('[Msg 455] User: What does this unlock?\n[Msg 455] COS: ' + T455)
    // Both Copy actions (one turn, and the archive chat's turn) go through it, with the turn as loaded.
    expect(MSG).toContain("W.copyText(copyTurnText(turn))")
    expect(MSG).toContain("W.copyText(copyTurnText(ct))")
    expect(MSG.match(/structureLensAnswer/g)?.length).toBe(1)
  })
  it('YOUR words are not restructured (only the answer is)', () => {
    const html = turnCards({ query: 'List: 1. a. 2. b.', text: 'ok' }, 'm-1')
    expect(html).toContain('List: 1. a. 2. b.')
  })
})

describe('the shared kit exports the one function', () => {
  it('window.COSWeb.structureLensAnswer is app.js structureLensAnswer', () => {
    expect(APP).toMatch(/plain: plain, structureLensAnswer: structureLensAnswer,/)
  })
})
