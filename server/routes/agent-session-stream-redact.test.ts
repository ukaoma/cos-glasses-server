// 7.0.4 final QA: the lens finds the turn on screen by matching the stream's prompt against the user turns of the
// `?turns=` history (cos-glasses-app src/lib/session-conversation.ts findTurnStart: its normalized() and the first
// PROMPT_MATCH_CHARS = 60 characters). 7.0.4 redacts local paths in that history, so the prompt must leave the stream
// redacted the same way, or a prompt with a Mac path never matches and the lens shows the turn twice.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { clientStreamEvent } from './agent-session-stream.js'
import { redactLocalPathsDeep } from '../lib/local-path-redact.js'

// The lens's normalized(), copied from cos-glasses-app (a different repo, so it cannot be imported). If the lens
// changes it, this copy must follow.
const lensNormalized = (text: string): string => text
  .replace(/```[\s\S]*?(```|$)/g, ' ')
  .replace(/<\/?[A-Za-z][\w:-]*(?:\s[^>]*)?\/?>/g, ' ')
  .replace(/…$/, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()
const LENS_MATCH_CHARS = 60
// What the history route sends a phone or the lens for a user turn (routes/agent-sessions.ts: redactLocalPathsDeep).
const historyText = (raw: string): string => redactLocalPathsDeep({ recent_turns: [{ role: 'user', text: raw }] }).recent_turns[0].text
// What the stream builds before the route writes it (lib/session-stream-events.ts: the prompt on one line).
const streamText = (raw: string): string => (clientStreamEvent({ kind: 'prompt', text: raw.replace(/\s+/g, ' ').trim() }) as { text: string }).text

const PROMPTS = [
  'Read /Users/jane/Acme Chief Of Staff/docs/plan.md and fix the summary in ~/Documents/notes.md. COS Work handoff 0123456789ab.',
  'Fix the bug in /Users/jane/repo/server/app.ts:42 and read ~/Documents/plan.md',
  'Look at /private/var/folders/x/T/build/out.log then\nrerun the tests',
  'No path here, just a long enough question about the Tuesday SEO review and what changed since last week',
]

describe('the stream prompt is redacted like the turn history (7.0.4 final QA)', () => {
  it.each(PROMPTS)('the lens match key agrees: %s', (raw) => {
    const stream = streamText(raw)
    expect(stream).not.toMatch(/\/Users\/|\/private\/var\/folders/)
    const history = lensNormalized(historyText(raw))
    expect(history.startsWith(lensNormalized(stream).slice(0, LENS_MATCH_CHARS))).toBe(true)
  })

  it('without the redaction the key would not match (the regression this fixes)', () => {
    const raw = PROMPTS[0]
    const rawKey = lensNormalized(raw.replace(/\s+/g, ' ')).slice(0, LENS_MATCH_CHARS)
    expect(lensNormalized(historyText(raw)).startsWith(rawKey)).toBe(false)
  })

  it('only prompts change: other kinds leave as they are', () => {
    const tool = { kind: 'tool', text: 'Read /Users/jane/repo/a.ts' }
    expect(clientStreamEvent(tool)).toBe(tool)
    const status = { kind: 'status', state: 'working' }
    expect(clientStreamEvent(status)).toBe(status)
  })

  it('the route writes every event through it, once', () => {
    const src = readFileSync(new URL('./agent-session-stream.ts', import.meta.url), 'utf8')
    const write = src.slice(src.indexOf('const write = (event: PublishedSessionEvent): void => {'), src.indexOf('res.write(`${idLine}data:'))
    // A live statement, never a comment: the line starts with the assignment itself.
    expect(write.match(/^[ \t]*out = clientStreamEvent\(out\)[ \t]*$/gm)?.length).toBe(1)
    expect(src.match(/clientStreamEvent\(/g)?.length).toBe(1) // one call; the definition is clientStreamEvent<T>(
  })
})
