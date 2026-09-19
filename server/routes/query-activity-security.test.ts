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

  // 6.52.0. The execution proof is query-job-runtime-trail.test.ts (the real runner, with
  // emitDisplay captured, never carries a trail string); these pin the routes that must not
  // even be handed one.
  it('keeps the Messages trail off the global display bus and off the legacy and compat routes', () => {
    const displayBus = readFileSync(new URL('../lib/display-bus.ts', import.meta.url), 'utf8')
    expect(displayBus).not.toMatch(/['"]trail['"]/)

    const runtime = readFileSync(new URL('../lib/query-job-runtime.ts', import.meta.url), 'utf8')
    const start = runtime.indexOf('onTrail:')
    const end = runtime.indexOf('onAnswerReady:', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(runtime.slice(start, end)).not.toContain('emitDisplay')

    for (const route of ['./query.ts', './openai-compat.ts']) {
      const source = readFileSync(new URL(route, import.meta.url), 'utf8')
      expect(source).toContain('callModelStreaming(')
      expect(source).not.toContain('onTrail')
    }
  })
})
