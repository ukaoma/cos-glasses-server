import { describe, expect, it } from 'vitest'
import { claudeProofText, codexProofText } from './provider-proof.js'

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
})
