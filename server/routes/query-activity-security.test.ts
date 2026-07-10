import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('query activity transport security', () => {
  it('keeps activity_line on the authenticated query SSE and off the global display bus', () => {
    const source = readFileSync(new URL('./query.ts', import.meta.url), 'utf8')
    const start = source.indexOf('onActivityLine:')
    const end = source.indexOf('onDone:', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const activityHandler = source.slice(start, end)
    expect(activityHandler).toContain('event: activity_line')
    expect(activityHandler).not.toContain('emitDisplay')

    const displayBus = readFileSync(new URL('../lib/display-bus.ts', import.meta.url), 'utf8')
    expect(displayBus).not.toContain("'activity_line'")
  })
})
