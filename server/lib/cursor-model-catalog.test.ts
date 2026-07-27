import { describe, expect, it } from 'vitest'
import {
  buildCursorModelCatalog,
  CURSOR_SLOT_MODEL_IDS,
  parseAgentModelsText,
} from './cursor-model-catalog.js'

const PHASE0_FIXTURE = `Available models

auto - Auto (default)
gpt-5.3-codex-high - Codex 5.3 High
cursor-grok-4.5-high - Cursor Grok 4.5
cursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast
composer-2.5 - Composer 2.5
composer-2.5-fast - Composer 2.5 Fast
claude-opus-5-thinking-high - Opus 5 1M Thinking

Tip: use --model <id> (or /model <id> in interactive mode) to switch.`

describe('parseAgentModelsText', () => {
  it('parses Phase 0 shaped id - Display Name lines', () => {
    const models = parseAgentModelsText(PHASE0_FIXTURE)
    expect(models.find(m => m.id === 'composer-2.5')?.displayName).toBe('Composer 2.5')
    expect(models.find(m => m.id === 'cursor-grok-4.5-high')?.displayName).toBe('Cursor Grok 4.5')
    expect(models.map(m => m.id)).not.toContain('Available models')
  })

})

describe('buildCursorModelCatalog', () => {
  it('maps locked Phase 0 slots to concrete CLI ids', () => {
    const catalog = buildCursorModelCatalog(
      parseAgentModelsText(PHASE0_FIXTURE),
      'cli',
      '2026-07-25T00:00:00.000Z',
    )
    expect(CURSOR_SLOT_MODEL_IDS).toEqual({
      'cursor-grok': 'cursor-grok-4.5-high-fast',
      'cursor-composer': 'composer-2.5-fast',
    })
    expect(catalog.options).toEqual([
      {
        preference: 'cursor-grok',
        id: 'cursor-grok-4.5-high-fast',
        displayName: 'Cursor Grok 4.5 Fast',
      },
      {
        preference: 'cursor-composer',
        id: 'composer-2.5-fast',
        displayName: 'Composer 2.5 Fast',
      },
    ])
  })

  it('leaves slot ids empty when catalog text lacks Phase 0 models', () => {
    const catalog = buildCursorModelCatalog(
      parseAgentModelsText('auto - Auto (default)\n'),
      'cli',
    )
    expect(catalog.options.every(option => option.id === '')).toBe(true)
  })
})
