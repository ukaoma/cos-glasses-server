import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SEED_EVENTS } from './agent-session-stream.js'

const SRC = readFileSync(new URL('./agent-session-stream.ts', import.meta.url), 'utf8')

describe('the seed always carries the query', () => {
  it('emits the newest prompt OUTSIDE the step budget', () => {
    // MEASURED DEFECT, not a hypothetical: a live probe against a real session seeded 8
    // events -- 6 tools, 1 prose, 1 status -- and NO prompt, because the query was
    // ~30 steps back and the activity you opened the page to watch had pushed it out.
    //
    // STRUCTURAL rather than behavioural, and stated as such: this route opens a real
    // SSE response against a real transcript, so the assertion pins the ORDER and the
    // INDEPENDENCE of the two seeds. The behaviour is covered where it can be executed
    // (promptDrafts, readTranscriptSeedLines) and end to end on device.
    const promptAt = SRC.indexOf('const lastPrompt')
    const stepsAt = SRC.indexOf("const steps = drafts.filter")
    expect(promptAt).toBeGreaterThan(0)
    expect(stepsAt).toBeGreaterThan(0)
    // The query is written BEFORE the steps, so it cannot be crowded out by them.
    expect(promptAt).toBeLessThan(stepsAt)
  })

  it('does not spend any of the step budget on prompts', () => {
    // If `prompt` were back in this filter, a run with several queries in the window
    // would silently trade steps for duplicate prompts the client only pins one of.
    const filterLine = SRC.slice(SRC.indexOf('const steps = drafts.filter')).split('\n')[0]
    expect(filterLine).toContain("'tool'")
    expect(filterLine).toContain("'prose'")
    expect(filterLine).not.toContain("'prompt'")
  })

  it('seeds exactly the client live window, so it fills the screen once', () => {
    // 7 is SESSION_TRAIL_LIVE_LINES on the client, measured against the 220px body.
    // More would scroll live events out of the view the seed exists to prime.
    expect(SEED_EVENTS).toBe(7)
  })
})
