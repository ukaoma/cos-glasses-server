// `transcriptTurnEnded` through the real fd tail read (QA W2, 2026-09-15). On the
// release Mac 3 of the 10 newest Desktop transcripts end in a ~76 KB attachment row
// AFTER the terminal record; a 64 KiB tail read only that row and held the queue for
// the 30 s backstop. The fixture reproduces the production shape: a real-sized
// bookkeeping row past a real terminal record.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TURN_END_TAIL_BYTES, transcriptTurnEnded, transcriptTurnVerdict } from './thread-turn-queue-store.js'

const j = (o: unknown) => JSON.stringify(o)
const user = (text: string) => j({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const endTurn = () => j({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } })
const toolUse = () => j({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }] } })
/** A `prompt_snapshot`-style attachment row of `bytes` bytes: what lands after end_turn on this Mac. */
const attachment = (bytes: number) => j({ type: 'attachment', attachment: { type: 'prompt_snapshot', text: 'x'.repeat(bytes) } })

function transcript(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cos-tail-')), 'session.jsonl')
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

describe('transcriptTurnEnded reads past an oversized bookkeeping row', () => {
  it('a 76 KB attachment after the terminal record does not hide it', () => {
    const path = transcript([user('hi'), endTurn(), attachment(76 * 1024)])
    expect(transcriptTurnVerdict('claude', path)).toEqual({ ended: true, reason: 'terminal_stop' })
    expect(transcriptTurnEnded('claude', path)).toBe(true)
  })

  it('the window covers three such rows with room to spare, and is derived from its own inputs', () => {
    expect(TURN_END_TAIL_BYTES).toBeGreaterThanOrEqual(4 * 80 * 1024)
    const path = transcript([user('hi'), endTurn(), attachment(76 * 1024), attachment(76 * 1024), attachment(76 * 1024)])
    expect(transcriptTurnEnded('claude', path)).toBe(true)
  })

  it('a pending tool past the same row still holds, and a row past the window is no evidence (holds)', () => {
    expect(transcriptTurnEnded('claude', transcript([user('hi'), toolUse(), attachment(76 * 1024)]))).toBe(false)
    const past = transcript([user('hi'), endTurn(), attachment(TURN_END_TAIL_BYTES + 1024)])
    expect(transcriptTurnVerdict('claude', past)).toEqual({ ended: false, reason: 'no_evidence' })
  })

  it('an unreadable path is a hold', () => {
    expect(transcriptTurnEnded('claude', null)).toBe(false)
    expect(transcriptTurnEnded('claude', '/nonexistent/x.jsonl')).toBe(false)
  })
})
