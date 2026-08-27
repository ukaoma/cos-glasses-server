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
  ollamaModelSupportsTools,
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

describe('ollamaModelSupportsTools', () => {
  afterEach(() => {
    _resetOllamaCatalogCache()
    _setOllamaCatalogFetchForTests(null)
  })

  it('is true only when capabilities contains tools', async () => {
    _setOllamaCatalogFetchForTests((async (input: any) => {
      if (String(input).endsWith('/api/show')) {
        return new Response(JSON.stringify({ capabilities: ['completion', 'tools'] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as any)
    await expect(ollamaModelSupportsTools('qwen3.8:27b')).resolves.toBe(true)
  })

  it('is false when the tag advertises no tools', async () => {
    _setOllamaCatalogFetchForTests((async (input: any) => {
      if (String(input).endsWith('/api/show')) {
        return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as any)
    await expect(ollamaModelSupportsTools('llama3.2:latest')).resolves.toBe(false)
  })

  it('is false when show throws, and does NOT cache that as tools-off', async () => {
    let calls = 0
    _setOllamaCatalogFetchForTests((async (input: any) => {
      if (String(input).endsWith('/api/show')) {
        calls += 1
        if (calls === 1) throw new Error('ECONNRESET')
        return new Response(JSON.stringify({ capabilities: ['tools'] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as any)
    // A failed probe must not pin the tag as toolless for the whole TTL:
    // that is inferring absence from a timeout.
    await expect(ollamaModelSupportsTools('qwen3.8:27b')).resolves.toBe(false)
    await expect(ollamaModelSupportsTools('qwen3.8:27b')).resolves.toBe(true)
  })

  it('an empty model name is false without probing', async () => {
    _setOllamaCatalogFetchForTests((async () => {
      throw new Error('should not be called')
    }) as any)
    await expect(ollamaModelSupportsTools('')).resolves.toBe(false)
  })
})
