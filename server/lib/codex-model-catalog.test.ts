import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelLabel } from '../../shared/model-preference.js'
import {
  buildCodexModelCatalog,
  getCodexModelCatalog,
  refreshCodexModelCatalog,
  resolveCodexEffortForModel,
  resolveCodexModelOption,
  selectTopCodexModels,
  startCodexModelCatalogRefresh,
  stopCodexModelCatalogRefresh,
  type CodexCatalogModel,
} from './codex-model-catalog.js'

function model(
  id: string,
  description: string,
  efforts = ['low', 'medium', 'high', 'xhigh'],
): CodexCatalogModel {
  return {
    id,
    displayName: id.toUpperCase(),
    description,
    hidden: false,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: 'medium',
    serviceTiers: ['priority'],
    isDefault: false,
  }
}

afterEach(() => {
  stopCodexModelCatalogRefresh()
  vi.useRealTimers()
  delete process.env.COS_CODEX_MODEL
  delete process.env.COS_CODEX_REASONING_EFFORT
})

describe('Codex live model catalog', () => {
  it('keeps frontier Astra in Max and newer workhorse Sol in Balanced, regardless of catalog order', async () => {
    const models = [
      { ...model('gpt-6.1-sol', 'Latest workhorse model for coding and everyday work.'), displayName: 'GPT-6.1-Sol' },
      { ...model('gpt-6-astra', 'Frontier intelligence for the most demanding work.'), displayName: 'GPT-6-Astra' },
      model('gpt-6-sol', 'Previous generation workhorse model.'),
      model('gpt-6-luna', 'Fast and affordable model for easier tasks.'),
      model('gpt-5.6-sol', 'Older generation workhorse model.'),
    ]
    for (const ordered of [models, [...models].reverse()]) {
      const catalog = await refreshCodexModelCatalog(async () => ordered)
      expect(catalog.options.map(({ preference, id }) => ({ preference, id }))).toEqual([
        { preference: 'codex-frontier', id: 'gpt-6-astra' },
        { preference: 'codex-balanced', id: 'gpt-6.1-sol' },
      ])
      // Selection drives execution as well as the catalog's visible labels.
      expect(resolveCodexModelOption('codex-frontier').id).toBe('gpt-6-astra')
      expect(resolveCodexModelOption('codex-balanced').id).toBe('gpt-6.1-sol')
      expect(modelLabel('codex-frontier')).toBe('GPT-6-Astra')
      expect(modelLabel('codex-balanced')).toBe('GPT-6.1 Sol')
    }
  })

  it('updates each tier independently and excludes hidden or small candidates', () => {
    expect(selectTopCodexModels([
      model('gpt-6-astra', 'Frontier intelligence.'),
      model('gpt-7-astra', 'Latest frontier intelligence.'),
      { ...model('gpt-8-astra', 'Frontier intelligence.'), hidden: true },
      model('gpt-8-mini', 'Small, fast workhorse model.'),
      model('gpt-7.1-sol', 'Latest workhorse model.'),
      model('gpt-6.1-sol', 'Previous workhorse model.'),
    ]).map(item => item.id)).toEqual(['gpt-7-astra', 'gpt-7.1-sol'])
  })

  it('selects two full-size models from the newest generation', () => {
    const models = [
      model('gpt-5.6-sol', 'Latest frontier agentic coding model.', ['high', 'xhigh', 'max', 'ultra']),
      model('gpt-5.5', 'Previous frontier model.'),
      model('gpt-5.6-terra', 'Balanced agentic coding model.', ['high', 'xhigh', 'max', 'ultra']),
      model('gpt-5.6-mini', 'Fast and affordable agentic coding model.'),
    ]
    expect(selectTopCodexModels(models).map(item => item.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ])
  })

  it('fills a missing second slot from the next-newest capable generation', () => {
    expect(selectTopCodexModels([
      model('gpt-5.7-sol', 'Latest frontier model.'),
      model('gpt-5.7-spark', 'Ultra-fast model.'),
      model('gpt-5.6-sol', 'Previous frontier model.'),
    ]).map(item => item.id)).toEqual(['gpt-5.7-sol', 'gpt-5.6-sol'])
  })

  it('maps concrete ids into stable slots and clamps effort safely', () => {
    const catalog = buildCodexModelCatalog([
      { ...model('gpt-5.6-sol', 'Frontier'), displayName: 'GPT-5.6-Sol' },
      { ...model('gpt-5.6-terra', 'Balanced'), displayName: 'GPT-5.6-Terra' },
    ], 'app-server', '2026-07-09T00:00:00.000Z')
    expect(catalog.options.map(({ preference, id, displayName }) => ({ preference, id, displayName }))).toEqual([
      { preference: 'codex-frontier', id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
      { preference: 'codex-balanced', id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
    ])
    expect(resolveCodexEffortForModel(catalog.options[0], 'ultracode')).toBe('xhigh')
  })

  it('retains the last-known-good catalog after a refresh failure', async () => {
    const successful = await refreshCodexModelCatalog(async () => [
      model('gpt-5.8-frontier', 'Frontier'),
      model('gpt-5.8-balanced', 'Balanced'),
    ])
    expect(successful.source).toBe('app-server')

    const failed = await refreshCodexModelCatalog(async () => {
      throw new Error('temporary outage with secret=do-not-expose')
    })
    expect(failed.source).toBe('app-server')
    expect(failed.options.map(option => option.id)).toEqual(['gpt-5.8-frontier', 'gpt-5.8-balanced'])
    expect(failed.refreshError).toContain('last-known-good')
    expect(failed.refreshError).not.toContain('do-not-expose')
  })

  it('coalesces concurrent forced refreshes into one discovery call', async () => {
    let resolveFetch!: (models: CodexCatalogModel[]) => void
    const fetcher = vi.fn(() => new Promise<CodexCatalogModel[]>(resolve => { resolveFetch = resolve }))
    const first = getCodexModelCatalog(true, fetcher)
    const second = getCodexModelCatalog(true, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)

    resolveFetch([
      model('gpt-5.9-frontier', 'Frontier'),
      model('gpt-5.9-balanced', 'Balanced'),
    ])
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(a.options.map(option => option.id)).toEqual(['gpt-5.9-frontier', 'gpt-5.9-balanced'])
  })

  it('refreshes immediately and periodically without keeping Node alive', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => undefined)
    const stop = startCodexModelCatalogRefresh({ intervalMs: 60_000, refresh })
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(refresh).toHaveBeenCalledTimes(3)
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('preserves legacy explicit overrides on Frontier without pinning Balanced', () => {
    process.env.COS_CODEX_MODEL = 'gpt-explicit-legacy'
    process.env.COS_CODEX_REASONING_EFFORT = 'medium'
    const frontier = resolveCodexModelOption('codex-frontier')
    const balanced = resolveCodexModelOption('codex-balanced')
    expect(frontier.id).toBe('gpt-explicit-legacy')
    expect(frontier.serviceTiers).toEqual([])
    expect(balanced.id).not.toBe('gpt-explicit-legacy')
    expect(resolveCodexEffortForModel(frontier, undefined)).toBe('medium')
    expect(resolveCodexEffortForModel(frontier, 'high')).toBe('high')
    expect(resolveCodexEffortForModel(balanced, undefined)).not.toBe('medium')
  })
})
