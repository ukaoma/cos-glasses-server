import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SAFE_MODE_ENV,
  CLAUDE_PROOF_MODEL,
  CLAUDE_PROOF_TIMEOUT_MS,
  claudeProofArgs,
  claudeProofText,
  codexProofText,
  runBounded,
} from './provider-proof.js'

describe('transactional provider proof parsing', () => {
  it('accepts only Claude result text', () => {
    expect(claudeProofText(JSON.stringify({ result: 'COS_CONTROL_OK' }))).toBe('COS_CONTROL_OK')
    expect(claudeProofText(JSON.stringify({ prompt: 'COS_CONTROL_OK' }))).toBe('')
  })

  it('accepts Codex assistant output but not echoed input', () => {
    const jsonl = [
      JSON.stringify({ type: 'user_message', text: 'COS_CONTROL_OK' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'COS_CONTROL_OK' } }),
    ].join('\n')
    expect(codexProofText(jsonl)).toBe('COS_CONTROL_OK')
    expect(codexProofText(JSON.stringify({ type: 'user_message', text: 'COS_CONTROL_OK' }))).toBe('')
  })

  it('uses a bounded lightweight Claude model for readiness', () => {
    expect(CLAUDE_PROOF_MODEL).toBe('haiku')
    expect(CLAUDE_PROOF_TIMEOUT_MS).toBe(45_000)
    expect(claudeProofArgs()).toContain('--model')
    expect(claudeProofArgs()[claudeProofArgs().indexOf('--model') + 1]).toBe('haiku')
    // 6.43.2 — the proof must not load the user's MCP catalog: with the
    // fleet on Miles's Mac, `--tools ''` alone produced a 244K-token request
    // that Haiku refused before any API call, and every update rolled back.
    const args = claudeProofArgs()
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}')
    expect(args.indexOf('--strict-mcp-config')).toBeLessThan(args.indexOf('--tools'))
  })

  it('isolates readiness from oversized project configuration', async () => {
    const result = await runBounded(
      process.execPath,
      ['-e', `process.stdout.write(process.env.${CLAUDE_SAFE_MODE_ENV} ?? '')`],
      '',
      2_000,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('1')
  })

  it('preserves timeout classification when child close wins termination race', async () => {
    const result = await runBounded(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      '',
      30,
    )
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
  })
})
