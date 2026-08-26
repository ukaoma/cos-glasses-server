import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.COS_DATA_DIR = `/tmp/cos-openai-compat-model-test-${process.pid}-${Date.now()}`
})
import {
  resolveModel,
  selectOpenAICompatibleModel,
} from './openai-compat.js'

describe('OpenAI-compatible Cursor model selection', () => {
  it('lets an Add Agent URL force Composer over a generic body model', () => {
    const requested = selectOpenAICompatibleModel('gpt-4o-mini', 'cursor-composer')
    expect(requested).toBe('cursor-composer')
    expect(resolveModel(requested)).toBe('cursor-composer')
  })

  it('accepts the concrete Composer CLI model id', () => {
    expect(resolveModel('composer-2.5-fast')).toBe('cursor-composer')
  })

  it("accepts Grok's stable slot and concrete CLI model id", () => {
    expect(resolveModel('cursor-grok')).toBe('cursor-grok')
    expect(resolveModel('cursor-grok-4.5-high-fast')).toBe('cursor-grok')
    expect(resolveModel('cursor-grok-4.6-high-fast')).toBe('cursor-grok')
  })

  it('resolves the Ollama slot without stealing GPT Frontier', () => {
    expect(resolveModel('ollama')).toBe('ollama')
    expect(resolveModel('cos-ollama')).toBe('ollama')
    expect(resolveModel('codex-frontier')).toBe('codex-frontier')
  })

  it('retains the public server default when no Cursor override is present', () => {
    expect(selectOpenAICompatibleModel('cos-sonnet', undefined)).toBe('cos-sonnet')
    expect(resolveModel('cos-sonnet')).toBe('sonnet')
  })
})
