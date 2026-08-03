import { describe, expect, it } from 'vitest'
import {
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
