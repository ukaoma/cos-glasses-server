/**
 * 7.0.18 (Miles 2026-11-10 07:14, "fold this in ... so I can respond from glasses, web app and desktop"; X1 contract v1,
 * Q1 PASS 07:19): a Claude session that ended its turn with a question and reply buttons. These run app.js's own text
 * against fakes: the row reading, the attributed text, Today's row, the reader's card and its send. The Today overlay's
 * part is in today-actions.test.ts ("7.0.18: a turn that ended asking you, in Today's overlay").
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
function block(startMark: string, endMark: string): string {
  const a = APP.indexOf(startMark), b = APP.indexOf(endMark, a)
  expect(a, startMark).toBeGreaterThan(0)
  expect(b, endMark).toBeGreaterThan(a)
  return APP.slice(a, b)
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)
const TE_SRC = block('  // ── A turn that ended asking you (7.0.18', '  function askedTitle(s) {')
const PREFIX = 'Answer sent from COS Control Web through COS, not typed in this session: '
const LINE = 'A choice or a reply here reaches the session as a message from COS, not typed in the session, and the session may ask you to confirm.'
// eslint-disable-next-line no-new-func
const TE = new Function(`${TE_SRC}\nreturn { turnEndOf, turnEndPrompt, turnEndBare, TURN_END_LINE, TURN_END_PREFIX, TURN_END_QUOTE };`)() as {
  TURN_END_QUOTE: Record<string, (...a: never[]) => string>
  turnEndOf: (s: unknown) => { ask: string; choices: string[]; id: string } | null; turnEndPrompt: (t: string) => string; turnEndBare: (t: string) => string; TURN_END_LINE: string; TURN_END_PREFIX: string
}
const SID = 'aaaaaaaa-7018-4018-8018-000000000018'
const ROW = { session_id: SID, provider: 'claude', display_label: 'Mail intel', agent_state: 'waiting', waiting_kind: 'question', waiting_source: 'turn_end',
  waiting_detail: 'Where should the overnight mail intel show up first?', waiting_choices: ['Good Morning + Today', 'COS Control pane'] }

describe('the row: what the server marks, read as the contract says', () => {
  it('a turn-end row gives its ask and at most two choices, each cleaned and at most 40 characters', () => {
    expect(TE.turnEndOf(ROW)).toEqual({ ask: 'Where should the overnight mail intel show up first?', choices: ['Good Morning + Today', 'COS Control pane'], id: '' })
    const odd = TE.turnEndOf({ ...ROW, waiting_detail: 'Pick‮ one\u0007 now', waiting_choices: ['A'.repeat(60), 7, '', 'B​', 'C'] })!
    expect(odd.ask).toBe('Pick one now')
    expect(odd.choices).toEqual(['A'.repeat(40), 'B'])
  })
  it('the words switch off: a question with no words and no choices', () => {
    expect(TE.turnEndOf({ ...ROW, waiting_detail: '', waiting_choices: [] })).toEqual({ ask: '', choices: [], id: '' })
  })
  it('anything else is not a turn-end ask: another source, no source (an older server, or the switch off), not waiting', () => {
    expect(TE.turnEndOf({ ...ROW, waiting_source: 'hook' })).toBeNull()
    const { waiting_source: _s, ...old } = ROW
    expect(TE.turnEndOf(old)).toBeNull()
    expect(TE.turnEndOf({ ...ROW, agent_state: 'idle' })).toBeNull()
    expect(TE.turnEndOf(null)).toBeNull()
  })
  it('the text sent is the contract’s, exactly, and never twice', () => {
    expect(TE.TURN_END_PREFIX).toBe(PREFIX)
    expect(TE.turnEndPrompt('Good Morning + Today')).toBe(PREFIX + 'Good Morning + Today')
    expect(TE.turnEndPrompt(PREFIX + 'my own words')).toBe(PREFIX + 'my own words')
    expect(TE.turnEndBare(PREFIX + 'my own words')).toBe('my own words')
    expect(TE.TURN_END_LINE).toBe(LINE)
  })
  it('7.0.36: the ask carries the server\u2019s id when it has the shape turn_end:<ms>; anything else reads as none', () => {
    expect(TE.turnEndOf({ ...ROW, waiting_ask_id: 'turn_end:1794600000123' })!.id).toBe('turn_end:1794600000123')
    for (const bad of ['turn_end:', 'turn_end:12a', 'hook:1', 7, ' turn_end:1', 'turn_end:12345678901234567']) expect(TE.turnEndOf({ ...ROW, waiting_ask_id: bad })!.id).toBe('')
  })
  it('7.0.36: the approved words (lead 00:03), (2) to (6), exactly', () => {
    const Q = TE.TURN_END_QUOTE as unknown as { button: (l: string) => string; text: (l: string, a: string) => string; moved: (l: string, a: string, n: unknown) => string; answered: (l: string) => string }
    expect(Q.moved('Yes', 'Ship it?', { id: 'turn_end:2', ask: 'Which branch?', choices: [] })).toBe('The session asked something new: \u201cWhich branch?\u201d. Your answer to \u201cShip it?\u201d was not sent.')
    expect(Q.moved('Yes', 'Ship it?', null)).toBe('The session took another turn. Your answer to \u201cShip it?\u201d was not sent.')
    expect(Q.button('Yes')).toBe('Send \u201cYes\u201d anyway')
    expect(Q.text('Yes', 'Ship it?')).toBe(PREFIX + 'Yes. This answers your earlier question \u201cShip it?\u201d. You have taken a turn since asking it.')
    expect(Q.text('Yes', 'Ship it?').indexOf(PREFIX), 'the contract words first and unchanged').toBe(0)
    expect(Q.answered('Yes')).toBe('Already answered on another screen. \u201cYes\u201d was not sent.')
    expect((Q as unknown as { unconfirmed: () => string }).unconfirmed()).toBe('An answer was just sent and COS could not confirm it arrived. Look at the session before answering again.')
    // A question with no words (the switch off): the sentences still read, without empty quotes.
    expect(Q.moved('Yes', '', null)).toBe('The session took another turn. Your answer \u201cYes\u201d was not sent.')
    expect(Q.text('Yes', '')).toBe(PREFIX + 'Yes. This answers your earlier question. You have taken a turn since asking it.')
  })
})

describe('Today’s row: "<title> asked: <ask>", answered by a reply', () => {
  const SRC = block('  function askedTitle(s) {', '  // 6.99.26: where a waiting session')
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', `with (deps) {\n${SRC}\nreturn { askedTitle, askedWhy };\n}`)({ plain: (s: unknown) => String(s ?? ''), sxProvider: (p: string) => p || 'claude', turnEndOf: TE.turnEndOf }) as {
    askedTitle: (s: unknown) => string; askedWhy: (s: unknown) => string }
  it('the title carries the question; the line under it says how to answer', () => {
    expect(fns.askedTitle(ROW)).toBe('Mail intel asked: Where should the overnight mail intel show up first?')
    expect(fns.askedWhy(ROW)).toBe('Tap a choice or reply here')
    expect(fns.askedTitle({ ...ROW, waiting_detail: '', waiting_choices: [] })).toBe('Mail intel asked you something')
    expect(fns.askedWhy({ ...ROW, waiting_choices: [] })).toBe('Reply here')
  })
  it('a question at the Mac’s prompt reads as before', () => {
    const { waiting_source: _s, waiting_choices: _c, ...mac } = ROW
    expect(fns.askedTitle(mac)).toBe('Mail intel asked you a question')
  })
  it('the Needs you row shows the how-to line, not the question twice', () => {
    expect(APP).toContain("esc(r.where === 'turnend' ? r.why : (r.ask || r.why))")
    expect(APP).toContain("where: w.where, ask: w.ask, choices: w.choices || [], askId: w.askId || '' });")
  })
})

describe('whereFor: a turn-end ask is answered here, never "at the Mac"', () => {
  const WHERE = block('  function sessionQs() {', "  // ── At the Mac's prompt, in the session reader (W1 A5)")
  function where(q: Record<string, unknown> | null) {
    const deps = { window: { COSWeb: q ? { sessionQuestions: { itemsFor: () => [], atMacFor: () => [], answeredFor: () => false, wordsOf: () => null, ...q } } : {} },
      sxProvider: (p: string) => p || 'claude', turnEndOf: TE.turnEndOf }
    // eslint-disable-next-line no-new-func
    return new Function('deps', `with (deps) {\n${WHERE}\nreturn whereFor;\n}`)(deps) as (p: string, id: string, row?: unknown) => { where: string; ask: string; choices?: string[]; askId?: string }
  }
  it('turn-end row: where turnend, its ask and choices', () => {
    expect(where({})('claude', SID, ROW)).toEqual({ where: 'turnend', ask: ROW.waiting_detail, choices: ROW.waiting_choices, askId: '' })
    expect(where({})('claude', SID, { ...ROW, waiting_ask_id: 'turn_end:9' }).askId).toBe('turn_end:9')
  })
  it('a question held here still wins; a question at the Mac’s prompt is still at the Mac', () => {
    expect(where({ itemsFor: () => [{ kind: 'question', questions: [{ question: 'Ship?' }] }] })('claude', SID, ROW).where).toBe('here')
    const { waiting_source: _s, ...mac } = ROW
    expect(where({})('claude', SID, mac).where).toBe('mac')
  })
})

describe('the reader’s card and its send', () => {
  const READER = block("  // ── At the Mac's prompt, in the session reader (W1 A5)", "  // ── end at the Mac's prompt")
  function reader(row: Record<string, unknown> | null, send: (text: string, opts: Record<string, unknown>) => Promise<string> = () => Promise.resolve('sent')) {
    const el = { innerHTML: '', hidden: true }
    const input = { attrs: {} as Record<string, string>, setAttribute(n: string, v: string) { this.attrs[n] = v } }
    const status: Array<{ text: string; kind?: string; action?: string }> = []
    const sent: string[] = []
    const optsSent: Array<Record<string, unknown>> = []
    const verdicts: unknown[] = []
    const deps = {
      esc, plain: (s: unknown) => String(s ?? ''), $: (id: string) => (id === 'session-mac-q' ? el : id === 'session-input' ? input : null),
      whereFor: () => ({ where: '', ask: '' }), sessionQs: () => null, askedWhy: () => '',
      state: { sessions: row ? [row] : [], reading: null as unknown }, splitSessionId: (p: string, id: string) => ({ provider: p, id }),
      turnEndOf: TE.turnEndOf, turnEndPrompt: TE.turnEndPrompt, TURN_END_LINE: TE.TURN_END_LINE, TURN_END_QUOTE: TE.TURN_END_QUOTE,
      continueSession: (_r: unknown, text: string, opts: Record<string, unknown>) => { sent.push(text); optsSent.push(opts); return send(text, opts) },
      sessionStatus: (text: string, kind?: string, action?: string) => { status.push(action ? { text, kind, action } : { text, kind }) }, renderVerdict: (r: unknown) => { verdicts.push(r) },
    }
    // eslint-disable-next-line no-new-func
    const fns = new Function('deps', `with (deps) {\n${READER}\nreturn { readerMacPaint, sendTurnEndChoice, sendTurnEndQuoted };\n}`)(deps) as {
      readerMacPaint: (r: unknown, waiting: boolean) => void; sendTurnEndChoice: (r: unknown, i: number) => Promise<unknown> | undefined; sendTurnEndQuoted: (r: unknown) => Promise<unknown> | undefined }
    const r: Record<string, unknown> = { provider: 'claude', id: SID }
    deps.state.reading = r
    return { fns, el, input, status, sent, optsSent, verdicts, r, deps }
  }
  const flush = () => new Promise(res => setTimeout(res, 0))

  it('the card: "<title> asked:", the question, a button per choice, the honest line; the box is the other answer', () => {
    const h = reader(ROW)
    h.fns.readerMacPaint(h.r, false)
    expect(h.el.hidden).toBe(false)
    expect(h.el.innerHTML).toContain('<strong>Mail intel asked:</strong>')
    expect(h.el.innerHTML).toContain('<blockquote class="ta-quote sx-te-ask">Where should the overnight mail intel show up first?</blockquote>')
    expect(h.el.innerHTML).toContain('data-sx="turnend" data-i="0">Good Morning + Today</button>')
    expect(h.el.innerHTML).toContain('data-sx="turnend" data-i="1">COS Control pane</button>')
    expect(h.el.innerHTML).toContain(esc(LINE))
    expect(h.el.innerHTML).not.toMatch(/at the Mac(’|&#39;|')s prompt/)
    expect(h.input.attrs.placeholder).toBe('Or write your own answer')
  })
  it('the feature off, or a question at the Mac’s prompt: the card never shows', () => {
    const { waiting_source: _s, ...mac } = ROW
    const h = reader(mac)
    h.fns.readerMacPaint(h.r, false)
    expect(h.el.innerHTML).toBe('')
    expect(h.input.attrs.placeholder).toBe('Continue this session…')
  })
  it('a tap sends the contract’s exact text through Continue, once, and says it was sent', async () => {
    const h = reader(ROW)
    h.fns.readerMacPaint(h.r, false)
    h.fns.sendTurnEndChoice(h.r, 0); h.fns.sendTurnEndChoice(h.r, 0)
    expect(h.el.innerHTML, 'the buttons are off while it goes').toContain('disabled')
    await flush()
    expect(h.sent).toEqual([PREFIX + 'Good Morning + Today'])
    expect(h.status.at(-1)).toEqual({ text: 'Sent “Good Morning + Today”. It reaches the session as a message from COS; it may ask you to confirm.', kind: undefined })
  })
  it('answered on another screen (the row moved on): nothing is sent, and it says so', () => {
    const h = reader({ ...ROW, waiting_source: undefined, agent_state: 'idle' })
    h.fns.sendTurnEndChoice(h.r, 0)
    expect(h.sent).toEqual([])
    expect(h.status.at(-1)!.text).toBe('Already answered on another screen, or the session moved on. Nothing was sent.')
  })
  it('7.0.36: the tap names its ask when the server gave one, and only then', async () => {
    const h = reader({ ...ROW, waiting_ask_id: 'turn_end:1794600000123' })
    h.fns.sendTurnEndChoice(h.r, 0)
    await flush()
    expect(h.optsSent).toEqual([{ turnEndAskId: 'turn_end:1794600000123' }])
    const old = reader(ROW)
    old.fns.sendTurnEndChoice(old.r, 0)
    await flush()
    expect(old.optsSent, 'an older server: nothing new in the request').toEqual([{}])
  })
  it('7.0.36: moved past it, with a newer ask: says what it asks now, draws it, and offers ONE button; nothing sends by itself', async () => {
    const row: Record<string, unknown> = { ...ROW, waiting_ask_id: 'turn_end:1' }
    // Refused as moved only while the answer names its ask, as the server does; a quoted send would go through.
    const h = reader(row, (_t, o) => o.turnEndAskId ? (Object.assign(h.r, { teRefusal: { revision: 'rev9', askNow: { id: 'turn_end:2', ask: 'Which branch?', choices: ['main', 'feature'] } } }), Promise.resolve('moved')) : Promise.resolve('sent'))
    h.fns.sendTurnEndChoice(h.r, 1)
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.status.at(-1)).toEqual({ text: 'The session asked something new: “Which branch?”. Your answer to “Where should the overnight mail intel show up first?” was not sent.', kind: 'error',
      action: ' <button type="button" class="link-btn" data-action="te-quote">Send “COS Control pane” anyway</button>' })
    expect(row.waiting_detail, 'the new ask is drawn at once').toBe('Which branch?')
    expect(row.waiting_choices).toEqual(['main', 'feature'])
    expect(row.waiting_ask_id).toBe('turn_end:2')
    expect(h.el.innerHTML).toContain('data-sx="turnend" data-i="1">feature</button>')
    expect(h.r.teQuote).toEqual({ label: 'COS Control pane', ask: 'Where should the overnight mail intel show up first?', revision: 'rev9' })
  })
  it('7.0.36: the button sends the quoted words with the revision and NO ask id, once per tap', async () => {
    const h = reader({ ...ROW, waiting_ask_id: 'turn_end:1' }, (_t, o) => o.turnEndAskId ? (Object.assign(h.r, { teRefusal: { revision: 'rev9', askNow: null } }), Promise.resolve('moved')) : Promise.resolve('sent'))
    h.fns.sendTurnEndChoice(h.r, 0)
    await flush()
    expect(h.status.at(-1)!.text).toBe('The session took another turn. Your answer to “Where should the overnight mail intel show up first?” was not sent.')
    h.fns.sendTurnEndQuoted(h.r); h.fns.sendTurnEndQuoted(h.r)
    await flush()
    expect(h.sent).toEqual([PREFIX + 'Good Morning + Today', PREFIX + 'Good Morning + Today. This answers your earlier question “Where should the overnight mail intel show up first?”. You have taken a turn since asking it.'])
    expect(h.optsSent[1]).toEqual({ acknowledgedRevision: 'rev9' })
    expect(h.status.at(-1)).toEqual({ text: 'Sent “Good Morning + Today”. It reaches the session as a message from COS; it may ask you to confirm.', kind: undefined })
    h.fns.sendTurnEndQuoted(h.r)
    expect(h.sent, 'the button is spent').toHaveLength(2)
  })
  it('7.0.36 (Q1 00:22): a moved answer never sends by itself: ten minutes of timers later, still one send and the button waiting', async () => {
    vi.useFakeTimers()
    try {
      const h = reader({ ...ROW, waiting_ask_id: 'turn_end:1' }, (_t, o) => o.turnEndAskId ? (Object.assign(h.r, { teRefusal: { revision: 'rev9', askNow: { id: 'turn_end:2', ask: 'Which branch?', choices: ['main'] } } }), Promise.resolve('moved')) : Promise.resolve('sent'))
      h.fns.sendTurnEndChoice(h.r, 0)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(h.sent, 'only his tap sends the quoted answer').toHaveLength(1)
      expect(h.r.teQuote).toEqual({ label: 'Good Morning + Today', ask: 'Where should the overnight mail intel show up first?', revision: 'rev9' })
    } finally { vi.useRealTimers() }
  })
  it('7.0.36 (Q1 00:22): the same for an older server’s refusal', async () => {
    vi.useFakeTimers()
    try {
      const h = reader(ROW, (_t, o) => o.acknowledgedRevision ? Promise.resolve('sent') : ((h.r as Record<string, unknown>).sendAnyway = 'rev2', Promise.resolve('changed')))
      h.fns.sendTurnEndChoice(h.r, 0)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(h.sent).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })
  it('7.0.37 (lead 00:54): an earlier answer whose delivery is unknown: the lead’s words, no button, nothing more sent', async () => {
    const h = reader({ ...ROW, waiting_ask_id: 'turn_end:1' }, () => Promise.resolve('unconfirmed'))
    h.fns.sendTurnEndChoice(h.r, 0)
    await flush()
    expect(h.status.at(-1)).toEqual({ text: 'An answer was just sent and COS could not confirm it arrived. Look at the session before answering again.', kind: 'error' })
    expect(h.r.teQuote ?? null).toBeNull()
    h.fns.sendTurnEndQuoted(h.r)
    expect(h.sent).toHaveLength(1)
  })
  it('7.0.36: answered first on another screen: said, no button, nothing more sent', async () => {
    const h = reader({ ...ROW, waiting_ask_id: 'turn_end:1' }, () => Promise.resolve('answered'))
    h.fns.sendTurnEndChoice(h.r, 0)
    await flush()
    expect(h.status.at(-1)).toEqual({ text: 'Already answered on another screen. “Good Morning + Today” was not sent.', kind: 'error' })
    expect(h.r.teQuote).toBeNull()
    h.fns.sendTurnEndQuoted(h.r)
    expect(h.sent).toHaveLength(1)
  })
  it('an older server (or Codex) refuses on the moved head: the composer’s box is cleared, and the choice keeps its own button with that revision', async () => {
    // Refused as changed only without the acknowledged revision, as the server does.
    const h = reader(ROW, (_t, o) => o.acknowledgedRevision ? Promise.resolve('sent') : ((h.r as Record<string, unknown>).refusal = { changed: true }, (h.r as Record<string, unknown>).sendAnyway = 'rev2', Promise.resolve('changed')))
    h.fns.sendTurnEndChoice(h.r, 1)
    await flush()
    expect(h.r.refusal).toBeNull()
    expect(h.r.sendAnyway).toBeNull()
    expect(h.status.at(-1)).toEqual({ text: 'The session took another turn. Your answer to “Where should the overnight mail intel show up first?” was not sent.', kind: 'error',
      action: ' <button type="button" class="link-btn" data-action="te-quote">Send “COS Control pane” anyway</button>' })
    expect(h.r.teQuote).toEqual({ label: 'COS Control pane', ask: 'Where should the overnight mail intel show up first?', revision: 'rev2' })
  })
  it('refused, or the Mac never answered: said plainly, and a second tap is safe', async () => {
    const h = reader(ROW, () => Promise.resolve('refused'))
    h.fns.sendTurnEndChoice(h.r, 0)
    await flush()
    expect(h.status.at(-1)).toEqual({ text: 'The session did not take “Good Morning + Today”. Try again, or answer it on your Mac.', kind: 'error' })
    const lost = reader(ROW, () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })))
    lost.fns.sendTurnEndChoice(lost.r, 0)
    await flush()
    expect(lost.status.at(-1)!.text).toBe('Not sent: No answer from your Mac yet. It may still land; tapping again is safe, it will not post twice.')
    expect(lost.r.sending).toBe(false)
  })
  it('the reader’s box: his own words go with the same attribution while the card is open, and the box clears after', () => {
    expect(APP).toContain('    var answering = !!(!fork && r.turnEnd && turnEndOf(readerRowOf(r)));\n    if (answering) text = turnEndPrompt(text);')
    const CLEAR = block('  function clearBoxOf(text, r) {', '  // Words go back in the box only if the box is empty')
    const box = { value: 'Use the pane, but only after lunch' }
    // eslint-disable-next-line no-new-func
    const clearBoxOf = new Function('deps', `with (deps) {\n${CLEAR}\nreturn clearBoxOf;\n}`)({ $: () => box, autoGrow: () => {}, state: { reading: null }, turnEndBare: TE.turnEndBare }) as (t: string) => void
    clearBoxOf(PREFIX + 'Use the pane, but only after lunch')
    expect(box.value).toBe('')
  })
  it('the click reaches it: data-sx="turnend" sends the tapped choice', () => {
    expect(APP).toContain("      if (act === 'turnend' && rd) return sendTurnEndChoice(rd, Number(t.getAttribute('data-i')));")
    expect(APP).toContain("    if (action === 'te-quote') return sendTurnEndQuoted(state.reading);")
  })
})

describe('the choice buttons: a thumb-sized target that wraps instead of squeezing (Duo 382 and 951)', () => {
  const CSS = readFileSync(join(HERE, 'app.css'), 'utf8')
  it('both cards share one rule: wrap the row, each button at least 44 px tall, long labels wrap inside the button', () => {
    expect(CSS).toContain('.sx-te-choices, .ta-te-choices { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 6px; }')
    expect(CSS).toContain('.sx-te-choices .cx-btn, .ta-te-choices .cx-btn { flex: 1 1 12rem; min-height: 44px; white-space: normal; text-align: center; line-height: 1.25; }')
  })
})
