import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetOllamaCatalogCache,
  _setOllamaCatalogFetchForTests,
  getOllamaCatalog,
  isLoopbackHostname,
  isOllamaProviderReady,
  parseOllamaTagNames,
  resolveOllamaOrigin,
  selectOllamaModel,
} from './ollama-catalog.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('ollama catalog', () => {
  afterEach(() => {
    _resetOllamaCatalogCache()
    _setOllamaCatalogFetchForTests(null)
    delete process.env.COS_OLLAMA_HOST
    delete process.env.COS_OLLAMA_MODEL
  })

  it('accepts only loopback hosts', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('::1')).toBe(true)
    expect(resolveOllamaOrigin(undefined).ok).toBe(true)
    expect(resolveOllamaOrigin('http://127.0.0.1:11434')).toEqual({
      ok: true, origin: 'http://127.0.0.1:11434',
    })
    expect(resolveOllamaOrigin('localhost:11434').ok).toBe(true)
    expect(resolveOllamaOrigin('http://192.168.1.10:11434').ok).toBe(false)
    expect(resolveOllamaOrigin('0.0.0.0:11434').ok).toBe(false)
    expect(resolveOllamaOrigin('https://example.com').ok).toBe(false)
  })

  it('selects the pinned model when pulled, else the first tag', () => {
    const names = parseOllamaTagNames({
      models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5-coder:latest' }],
    })
    expect(selectOllamaModel(names)).toBe('llama3.2:latest')
    expect(selectOllamaModel(names, 'qwen2.5-coder:latest')).toBe('qwen2.5-coder:latest')
    expect(selectOllamaModel(names, 'qwen2.5-coder')).toBe('qwen2.5-coder:latest')
    expect(selectOllamaModel(names, 'missing')).toBe('')
  })

  it('is ready when /api/tags returns at least one model', async () => {
    _setOllamaCatalogFetchForTests(async () => jsonResponse({
      models: [{ name: 'qwen2.5-coder:latest' }],
    }))
    const catalog = await getOllamaCatalog(true)
    expect(catalog.ready).toBe(true)
    expect(catalog.model).toBe('qwen2.5-coder:latest')
    expect(isOllamaProviderReady()).toBe(true)
  })

  it('hides when the daemon is down or tags are empty', async () => {
    _setOllamaCatalogFetchForTests(async () => { throw new Error('fetch failed') })
    expect((await getOllamaCatalog(true)).ready).toBe(false)
    expect(isOllamaProviderReady()).toBe(false)

    _resetOllamaCatalogCache()
    _setOllamaCatalogFetchForTests(async () => jsonResponse({ models: [] }))
    expect((await getOllamaCatalog(true)).ready).toBe(false)
    expect(isOllamaProviderReady()).toBe(false)
  })
})
