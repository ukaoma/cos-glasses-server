/**
 * Server 7.0.25 (S1, after Miles's held note of 08:01): a waiting follow-up carries waiting_reason, a short code the
 * drain decided. The queued-note line shows it in plain words. These run app.js's own text.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
function slice(text: string, start: string, end: string): string {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length)
  expect(a, start).toBeGreaterThan(-1)
  expect(b, end).toBeGreaterThan(a)
  return text.slice(a, b)
}
const SRC = slice(APP, '  var SX_HOLD_WORDS = {', '  function loadQueue(provider, id) {')
// eslint-disable-next-line no-new-func
const why = new Function(`${SRC}\nreturn sxQueueWhy;`)() as (t: unknown) => string

describe('the queued-note line says why a note waits', () => {
  it('files: it waits for the turn to end (the case that held his 08:01 note)', () => {
    expect(why({ waiting_reason: 'files_wait_for_turn_end' })).toBe('It has files, so it waits for the current turn to end.')
  })
  it('the other known codes in plain words', () => {
    expect(why({ waiting_reason: 'turn_open' })).toBe('Waiting for the current turn to end.')
    expect(why({ waiting_reason: 'turn_not_ended' })).toBe('Waiting for the current turn to end.')
    expect(why({ waiting_reason: 'live_desktop_process' })).toBe('Waiting while another app has this session open.')
    expect(why({ waiting_reason: 'cancel_hold' })).toBe('Held for 2 minutes after a stop.')
  })
  it('an unknown but well-formed code reads as a plain wait; a malformed value or none shows nothing', () => {
    expect(why({ waiting_reason: 'gate_closed' })).toBe('Waiting for this session to be free.')
    expect(why({ waiting_reason: 'toString' })).toBe('')
    expect(why({ waiting_reason: '<b>x</b>' })).toBe('')
    expect(why({ waiting_reason: 'constructor' })).toBe('Waiting for this session to be free.')
    expect(why({})).toBe('')
    expect(why(null)).toBe('')
  })
  it('the row shows it under the note, escaped, and an older server (no field) shows the row as before', () => {
    const LQ = slice(APP, '  function loadQueue(provider, id) {', '\n  }\n')
    expect(LQ).toContain("var why = sxQueueWhy(t);")
    expect(LQ).toContain("(why ? '<span class=\"sx-queue-reason\">' + esc(why) + '</span>' : '')")
  })
})
