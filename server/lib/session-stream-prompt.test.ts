import { describe, it, expect } from 'vitest'
import { draftsFromLine, promptDrafts, PROMPT_MAX_CHARS } from './session-stream-events.js'

const userLine = (content: unknown) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content } })

describe("the user's query reaches the lens", () => {
  it('emits the query a person typed on the Mac', () => {
    // Miles: "we should see the query that the user has versus it just being a blank
    // slate where it says working."
    const drafts = draftsFromLine('claude', userLine([{ type: 'text', text: 'Build 1 through 6 as 374' }]))
    expect(drafts).toEqual([{ kind: 'prompt', text: 'Build 1 through 6 as 374' }])
  })

  it('accepts a plain string content, which is how short prompts are written', () => {
    expect(draftsFromLine('claude', userLine('fix the footer')))
      .toEqual([{ kind: 'prompt', text: 'fix the footer' }])
  })

  it('still says NOTHING for a tool result', () => {
    // The call was announced when it was made. This is the half of the old behaviour
    // that was correct and had to survive the change.
    const drafts = draftsFromLine('claude', userLine([{ type: 'tool_result', content: 'ok' }]))
    expect(drafts).toEqual([])
  })

  it('drops a harness wrapper rather than passing it off as the user speaking', () => {
    // These arrive as user turns and nobody asked them. On the lens they would read as
    // Miles's own words, which is worse than an empty line.
    for (const wrapper of [
      '<system-reminder>do a thing</system-reminder>',
      '<cos-alarms>stale log</cos-alarms>',
      '<relevant-memories>past stuff</relevant-memories>',
      '<local-command-stdout>output</local-command-stdout>',
    ]) {
      expect(draftsFromLine('claude', userLine([{ type: 'text', text: wrapper }])), wrapper).toEqual([])
    }
  })

  it('keeps the real question when a wrapper is attached to it', () => {
    const drafts = draftsFromLine('claude', userLine([
      { type: 'text', text: '<cos-alarms>noise</cos-alarms>Are we ready to test?' },
    ]))
    expect(drafts).toEqual([{ kind: 'prompt', text: 'Are we ready to test?' }])
  })

  it('emits nothing for empty or whitespace-only content', () => {
    expect(promptDrafts({ content: [{ type: 'text', text: '   ' }] })).toEqual([])
    expect(promptDrafts({ content: [] })).toEqual([])
    expect(promptDrafts({})).toEqual([])
  })

  it('caps a long query so one paste cannot own the whole viewport', () => {
    const drafts = promptDrafts({ content: [{ type: 'text', text: 'q'.repeat(400) }] })
    expect(drafts).toHaveLength(1)
    const draft = drafts[0] as { text: string }
    expect(draft.text.length).toBe(PROMPT_MAX_CHARS)
  })

  it('never emits a newline, which would break the trail line count', () => {
    const drafts = promptDrafts({ content: [{ type: 'text', text: 'line one\nline two' }] })
    const draft = drafts[0] as { text: string }
    expect(draft.text).not.toContain('\n')
  })
})
