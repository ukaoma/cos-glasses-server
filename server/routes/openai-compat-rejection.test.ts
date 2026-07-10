import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('OpenAI-compatible non-streaming rejection path', () => {
  it('settles and removes inflight state when model startup rejects', () => {
    const source = readFileSync(new URL('./openai-compat.ts', import.meta.url), 'utf8')
    const start = source.indexOf('// ── Non-streaming response ──')
    const end = source.indexOf('// GET /v1/models', start)
    const branch = source.slice(start, end)
    expect(branch).toContain('let settled = false')
    expect(branch).toContain('inflightQueries.delete(dedupKey)')
    expect(branch).toContain('.catch(fail)')
  })
})
