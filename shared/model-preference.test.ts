import { describe, expect, it } from 'vitest'
import {
  CLAUDE_CLI_MODEL_ID,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  formatResolvedModelDisplay,
  isClaudeModel,
  isCodexModel,
  isCursorModel,
  isOllamaModel,
  modelLabel,
  normalizeEffortPreference,
  normalizeModelPreference,
  resolveClaudeCliModelId,
  resolveCliEffortFlag,
  resolveConfiguredCodexReasoningEffort,
  resolveCodexReasoningEffort,
  visibleModelOptions,
} from './model-preference.js'

describe('model preferences', () => {
  it('keeps the public default while exposing Fable, GPT, and Cursor slots', () => {
    expect(DEFAULT_MODEL).toBe('sonnet')
    expect(MODEL_OPTIONS).toEqual([
      'opus', 'fable', 'sonnet', 'codex-frontier', 'codex-balanced',
      'cursor-grok', 'cursor-composer', 'ollama',
    ])
    expect(isClaudeModel('fable')).toBe(true)
    expect(isCodexModel('codex-frontier')).toBe(true)
    expect(isCodexModel('codex-balanced')).toBe(true)
    expect(isCursorModel('cursor-grok')).toBe(true)
    expect(isCursorModel('cursor-composer')).toBe(true)
    expect(isOllamaModel('ollama')).toBe(true)
    expect(modelLabel('cursor-grok')).toBe('Grok Fast')
    expect(modelLabel('cursor-composer')).toBe('Composer 2.5 Fast')
    expect(modelLabel('ollama')).toBe('Ollama')
    expect(visibleModelOptions(false, false)).toEqual([
      'opus', 'fable', 'sonnet', 'codex-frontier', 'codex-balanced',
    ])
    expect(visibleModelOptions(true, true)).toContain('ollama')
    expect(visibleModelOptions(true, true)).toContain('cursor-grok')
  })

  it('migrates legacy codex-high state to the frontier slot', () => {
    expect(normalizeModelPreference('codex-high')).toBe('codex-frontier')
    expect(normalizeModelPreference('unknown')).toBeUndefined()
  })

  it('uses versionless Claude tier aliases that auto-track releases', () => {
    expect(resolveClaudeCliModelId('opus')).toBe('opus[1m]')
    expect(resolveClaudeCliModelId('fable')).toBe('fable[1m]')
    expect(resolveClaudeCliModelId('sonnet')).toBe('sonnet[1m]')
    expect(resolveClaudeCliModelId('haiku')).toBe('haiku')
    for (const id of Object.values(CLAUDE_CLI_MODEL_ID)) expect(id).not.toMatch(/^claude-/)
  })

  it('formats concrete resolved Claude ids for diagnostics', () => {
    expect(formatResolvedModelDisplay('claude-sonnet-5[1m]')).toBe('Sonnet 5 (1M)')
    expect(formatResolvedModelDisplay('claude-fable-5-1')).toBe('Fable 5.1')
    expect(formatResolvedModelDisplay(undefined)).toBe('')
  })
})

describe('effort preferences', () => {
  it('accepts only the four client effort values', () => {
    expect(EFFORT_OPTIONS).toEqual(['high', 'xhigh', 'max', 'ultracode'])
    for (const effort of EFFORT_OPTIONS) expect(normalizeEffortPreference(effort)).toBe(effort)
    expect(normalizeEffortPreference('low')).toBeUndefined()
  })

  it('maps Claude and Codex effort vocabularies correctly', () => {
    expect(resolveCliEffortFlag('ultracode')).toBe('xhigh')
    expect(resolveCliEffortFlag('max')).toBe('max')
    expect(resolveCodexReasoningEffort('ultracode')).toBe('ultra')
    expect(resolveCodexReasoningEffort('max')).toBe('max')
    expect(resolveCodexReasoningEffort(undefined)).toBe('high')
  })

  it('accepts the documented legacy Codex effort override and fails safe', () => {
    process.env.COS_CODEX_REASONING_EFFORT = 'medium'
    expect(resolveConfiguredCodexReasoningEffort()).toBe('medium')
    process.env.COS_CODEX_REASONING_EFFORT = 'not-valid'
    expect(resolveConfiguredCodexReasoningEffort()).toBe('high')
    delete process.env.COS_CODEX_REASONING_EFFORT
  })
})
