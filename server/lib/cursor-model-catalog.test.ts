import { describe, expect, it } from 'vitest'
import {
  buildCursorModelCatalog,
  CURSOR_SLOT_MODEL_IDS,
  parseAgentModelsText,
  normalizeCursorDisplayName,
  parseCursorGrokHighFastVersion,
  resolveCursorPreferenceForModelId,
  selectNewestCursorGrokHighFast,
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
    // 6.53.0: the canonical id moved to Grok 4.7's new scheme. The live list is still
    // authoritative, so this Phase 0 list selects its own proven 4.5 below.
    expect(CURSOR_SLOT_MODEL_IDS).toEqual({
      'cursor-grok': 'grok-4.7-high-fast',
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

  it('selects the newest cursor-grok-*-high-fast and ignores xhigh/low/medium', () => {
    const models = parseAgentModelsText(`
cursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast
cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast
cursor-grok-4.6-xhigh-fast - Cursor Grok 4.6 Extra High Fast
cursor-grok-4.6-medium-fast - Cursor Grok 4.6 Medium Fast
cursor-grok-4.6-high - Cursor Grok 4.6
composer-2.5-fast - Composer 2.5 Fast
`)
    expect(parseCursorGrokHighFastVersion('cursor-grok-4.6-xhigh-fast')).toBeNull()
    expect(selectNewestCursorGrokHighFast(models)?.id).toBe('cursor-grok-4.6-high-fast')
    const catalog = buildCursorModelCatalog(models, 'cli')
    expect(catalog.options).toEqual([
      {
        preference: 'cursor-grok',
        id: 'cursor-grok-4.6-high-fast',
        displayName: 'Cursor Grok 4.6 Fast',
      },
      {
        preference: 'cursor-composer',
        id: 'composer-2.5-fast',
        displayName: 'Composer 2.5 Fast',
      },
    ])
  })
})

describe('Grok 4.7 (6.53.0): the new id scheme with no cursor- prefix', () => {
  // `cursor-agent models` on CLI 2026.09.18, as the coordinator captured it: the new ids,
  // the old ones still listed, and display names with a double space and trailing
  // zero-width characters.
  const ZW = '\u200b\u200b'
  const CLI_2026_09_18 = `Available models

auto - Auto (default)
grok-4.7-low - Grok 4.7  Low${ZW}
grok-4.7-low-fast - Grok 4.7  Low Fast${ZW}
grok-4.7-medium - Grok 4.7  Medium${ZW}
grok-4.7-medium-fast - Grok 4.7  Medium Fast${ZW}
grok-4.7-high - Grok 4.7  High${ZW}
grok-4.7-high-fast - Grok 4.7  High Fast${ZW}
grok-4.7-xhigh - Grok 4.7  Extra High${ZW}
grok-4.7-xhigh-fast - Grok 4.7  Extra High Fast${ZW}
cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast
cursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast
composer-2.5-fast - Composer 2.5 Fast
`

  it('picks grok-4.7-high-fast over cursor-grok-4.6-high-fast, with a clean display name', () => {
    const models = parseAgentModelsText(CLI_2026_09_18)
    expect(selectNewestCursorGrokHighFast(models)?.id).toBe('grok-4.7-high-fast')
    const catalog = buildCursorModelCatalog(models, 'cli')
    expect(catalog.options[0]).toEqual({ preference: 'cursor-grok', id: 'grok-4.7-high-fast', displayName: 'Grok 4.7 High Fast' })
    expect(catalog.options[0]!.displayName).not.toMatch(/\p{Cf}|\s\s/u)
  })

  it('ignores low, medium, xhigh and non-fast in the new scheme too', () => {
    for (const id of ['grok-4.7-low-fast', 'grok-4.7-medium-fast', 'grok-4.7-xhigh-fast', 'grok-4.7-high', 'grok-4.7-low', 'xgrok-4.7-high-fast', 'grok-4.7-high-fast-x']) {
      expect(parseCursorGrokHighFastVersion(id)).toBeNull()
    }
    expect(parseCursorGrokHighFastVersion('grok-4.7-high-fast')).toEqual([4, 7])
    expect(parseCursorGrokHighFastVersion('cursor-grok-4.6-high-fast')).toEqual([4, 6])
    const onlyOthers = parseAgentModelsText(`grok-4.8-xhigh-fast - x\ngrok-4.8-medium-fast - m\ngrok-4.8-high - h\ncursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast\n`)
    expect(selectNewestCursorGrokHighFast(onlyOthers)?.id).toBe('cursor-grok-4.6-high-fast')
  })

  it('a list with only the old scheme still picks the newest old id', () => {
    const models = parseAgentModelsText('cursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast\ncursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast\n')
    expect(selectNewestCursorGrokHighFast(models)?.id).toBe('cursor-grok-4.6-high-fast')
  })

  it('compares versions numerically, and prefers the unprefixed id on an exact tie in either order', () => {
    const numeric = parseAgentModelsText('grok-4.10-high-fast - a\ngrok-4.9-high-fast - b\n')
    expect(selectNewestCursorGrokHighFast(numeric)?.id).toBe('grok-4.10-high-fast')
    const prefixedFirst = parseAgentModelsText('cursor-grok-4.7-high-fast - a\ngrok-4.7-high-fast - b\n')
    expect(selectNewestCursorGrokHighFast(prefixedFirst)?.id).toBe('grok-4.7-high-fast')
    const unprefixedFirst = parseAgentModelsText('grok-4.7-high-fast - b\ncursor-grok-4.7-high-fast - a\n')
    expect(selectNewestCursorGrokHighFast(unprefixedFirst)?.id).toBe('grok-4.7-high-fast')
    // A newer prefixed id still beats an older unprefixed one.
    const newerPrefixed = parseAgentModelsText('grok-4.7-high-fast - b\ncursor-grok-4.8-high-fast - a\n')
    expect(selectNewestCursorGrokHighFast(newerPrefixed)?.id).toBe('cursor-grok-4.8-high-fast')
  })

  it('the new ids resolve to the Grok slot', () => {
    expect(resolveCursorPreferenceForModelId('grok-4.7-high-fast')).toBe('cursor-grok')
    expect(resolveCursorPreferenceForModelId('cursor-grok-4.6-high-fast')).toBe('cursor-grok')
  })

  it('normalizes display names: format characters out, one space, trimmed', () => {
    expect(normalizeCursorDisplayName('Grok 4.7  High Fast\u200b\u200b')).toBe('Grok 4.7 High Fast')
    expect(normalizeCursorDisplayName('\ufeff Grok\u200d 4.7\t\tHigh ')).toBe('Grok 4.7 High')
    expect(normalizeCursorDisplayName('Composer 2.5 Fast')).toBe('Composer 2.5 Fast')
  })
})
