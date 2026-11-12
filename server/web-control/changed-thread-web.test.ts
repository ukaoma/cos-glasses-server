/**
 * 7.0.29 ADD 3 (Miles 00:01: "we have to hit continue to steer the session"; 00:03: "Refresh doesn't seem to do
 * anything"; the lead's ruling 00:02 and A1 to A3 00:47): the changed-thread stop in the Sessions reader. The behaviour is
 * checked in WebKit against a scripted server (W1_evidence/two_column/add3_check.cjs: nothing new resends once; a reply he
 * was not shown stops; drawn below the fold is not shown (A1); a new question stops (A2); a second refusal shows the box
 * and Send it anyway carries its revision (A3); a failed read shows the box; Send to a copy forks). These pin what the
 * browser check cannot reach: held and queued messages, turn-end answers, Today's panel, and the box's buttons.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const branch = (() => {
  const a = APP.indexOf("        if (reason === 'native_thread_changed' && b.revision) {")
  expect(a).toBeGreaterThan(-1)
  return APP.slice(a, APP.indexOf("        if (/^(stale_epoch|binding_expired", a))
})()

describe('what never resends by itself', () => {
  it('a held or queued message keeps its own path, before anything else in the branch', () => {
    const held = branch.indexOf("if (opts.held) { settleHeld(r, opts.held, 'refused', 'This session changed on your Mac while your message waited.'); return 'changed'; }")
    expect(held).toBeGreaterThan(-1)
    expect(held).toBeLessThan(branch.indexOf('sxChangedLook('))
  })
  it('a turn-end answer (the ask still open, R6): Send records no "shown" for it (null), so the automatic path never runs; the same test makes the prefix', () => {
    expect(APP).toContain('    var answering = !!(!fork && r.turnEnd && turnEndOf(readerRowOf(r)));\n    if (answering) text = turnEndPrompt(text);')
    expect(APP).toContain('if (!fork && typeof sxPressSeen === \'function\') opts = Object.assign({}, opts || {}, { seen: answering ? null : sxPressSeen(r) });')
    expect(branch).toContain("opts.seen === null ? 'This session changed on your Mac. Your answer is not sent yet.'")
  })
  it('Today’s panel sends no "shown", so it keeps the box it had (the lead: unchanged this pass)', () => {
    expect(branch).toContain("changedBox(opts.seen === undefined ? (b.reasonCopy || 'This session changed on your Mac since you opened it.')")
  })
  it('one automatic resend at most: only a send with no revision may resend, and the resend always carries one', () => {
    expect(branch).toContain('if (opts.seen && !opts.acknowledgedRevision && state.reading === r) {')
    expect(branch).toContain('return continueSession(r, text, Object.assign({}, opts, { acknowledgedRevision: b.revision }));')
  })
})

describe('the box that remains', () => {
  it('Send it anyway carries the revision of the refusal that drew the box (A3)', () => {
    expect(branch).toContain('var changedBox = function (copy) { r.sendAnyway = b.revision;')
  })
  it('two buttons that say what they do; no Refresh (the page has already refreshed)', () => {
    expect(APP).toContain('(f.changed ? \'<button type="button" class="cx-btn quiet" data-action="send-anyway">Send it anyway</button>\' : \'\')')
    expect(APP).toContain('>Send to a copy</button>')
    expect(APP).not.toContain('refresh-turns')
    expect(APP).not.toContain('>Continue anyway<')
  })
  it('the words say what happened and that the message is not sent', () => {
    for (const w of ['A new reply arrived while you were writing. Your message is not sent yet.', 'The session is now waiting on a question. Your message is not sent yet.',
      'This session changed on your Mac, and COS could not load what changed. Your message is not sent yet.', 'This session changed on your Mac again. Your message is not sent yet.']) expect(branch, w).toContain(w)
  })
})
