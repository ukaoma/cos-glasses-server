import { describe, expect, it, vi } from 'vitest'

// The real provider path, with only the CLI runner replaced: the cleanup must go through the
// shared Claude CLI runner (tools off, no MCP, no hooks, pinned model), never an SDK.
const calls: Array<{ engine: string; model: string; opts: Record<string, unknown> }> = []
vi.mock('./lens-gist-engines.js', async importOriginal => {
  const real = await importOriginal<typeof import('./lens-gist-engines.js')>()
  return {
    ...real,
    runLensGistEngine: vi.fn(async (engine: string, model: string, _prompt: string, opts: Record<string, unknown>) => {
      calls.push({ engine, model, opts })
      return { text: '{"edits":[]}', usage: { inputTokens: 10, outputTokens: 2 }, model }
    }),
  }
})

const { defaultCleanupDeps } = await import('./transcript-cleanup.js')
const { CLEANUP_SYSTEM, MODEL_LIMITS } = await import('./transcript-cleanup-model.js')
const { buildClaudeGistArgs } = await import('./lens-gist-engines.js')

describe('default model call', () => {
  it('uses the Claude CLI runner with the pinned model, its own audit source and bounded output', async () => {
    const run = await defaultCleanupDeps().callModel('claude-haiku-5-5', CLEANUP_SYSTEM, 'SPANS', { timeoutMs: MODEL_LIMITS.timeoutMs, maxOutputTokens: MODEL_LIMITS.maxOutputTokens })
    expect(run).toEqual({ text: '{"edits":[]}', inputTokens: 10, outputTokens: 2, model: 'claude-haiku-5-5' })
    expect(calls).toEqual([{ engine: 'claude', model: 'claude-haiku-5-5', opts: { system: CLEANUP_SYSTEM, timeoutMs: 75_000, source: 'transcript-cleanup', maxOutputTokens: 1_500 } }])
    // That runner's Claude argv: no tools, no MCP servers, no hooks, the model pinned.
    const argv = buildClaudeGistArgs('claude-haiku-5-5', CLEANUP_SYSTEM)
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'claude-haiku-5-5'])
    expect(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2)).toEqual(['--tools', ''])
    expect(argv).toContain('{"mcpServers":{}}')
    expect(argv).toContain('{"disableAllHooks":true}')
  })
})
