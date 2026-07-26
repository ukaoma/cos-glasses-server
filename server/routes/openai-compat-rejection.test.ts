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

  it('cancels provider work on client disconnect before releasing its lifecycle lease', () => {
    const source = readFileSync(new URL('./openai-compat.ts', import.meta.url), 'utf8')
    const abortRegistration = source.indexOf("res.once('close'")
    const firstProviderStart = source.indexOf('await callModelStreaming', abortRegistration)
    expect(abortRegistration).toBeGreaterThan(0)
    expect(firstProviderStart).toBeGreaterThan(abortRegistration)
    expect(source).toContain("providerAbort.abort(new Error('G2 client disconnected'))")
    expect(source.match(/abortSignal: providerAbort\.signal/g)).toHaveLength(2)
    expect(source).toContain('The lease is released only after the bridge reaches')
  })
})
