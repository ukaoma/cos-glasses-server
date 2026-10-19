// Key lanes K1 P5 (plan v4 10.4, D10): the public OpenRouter catalog, 24 h cache, curated list
// and downselect. Never the network: every fetch goes to a loopback mock server, and a guard
// fails the test if anything here tries a non-loopback host.
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  CHEAPER_KEY_MODEL,
  DEFAULT_KEY_MODEL,
  KEY_CATALOG_CURATED,
  KEY_CATALOG_MAX_ROWS,
  KEY_CATALOG_ROW_CHARS,
  KEY_CATALOG_TTL_MS,
  KEY_CATALOG_URL,
  KeyCatalog,
  catalogLanesFor,
  curatedKeyModels,
  downselectKeyCatalog,
  keyModelPrice,
  keyModelSupportsTools,
  parseKeyCatalog,
} from './key-catalog.js'
import { CURATED_KEY_MODELS } from '../routes/key-lanes.js'

const row = (id: string, prompt: string, completion: string, extra: Record<string, unknown> = {}) => ({
  id, name: extra.name ?? id, pricing: { prompt, completion }, context_length: 200000,
  architecture: { output_modalities: ['text'] }, supported_parameters: ['tools', 'max_tokens'], ...extra,
})

const CATALOG = {
  data: [
    row('anthropic/claude-sonnet-5.5', '0.0000025', '0.0000125', { name: 'Anthropic: Claude Sonnet 5.5' }),
    row('anthropic/claude-haiku-5.5', '0.0000001', '0.0000005'),
    row('openai/gpt-6', '0.000003', '0.000012'),
    row('meta-llama/llama-5-70b', '0.0000004', '0.0000004', { supported_parameters: ['max_tokens'] }),
    row('black-forest/flux-image', '0.00001', '0.00001', { architecture: { output_modalities: ['image'] } }),
    { id: 'broken/no-price', name: 'x' },
    ...Array.from({ length: 40 }, (_, i) => row(`vendor/model-${i}-with-a-really-long-name-that-goes-on`, '0.000001', '0.000002', { name: `Vendor ✓ Model ${i} — extended edition with an absurdly long marketing name` })),
  ],
}

let server: http.Server
let url = ''
const hits: Array<{ path: string; auth?: string }> = []
let status = 200

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push({ path: req.url ?? '', auth: req.headers.authorization })
    // The target serves a real catalog, so FOLLOWING the redirect would succeed (and be seen).
    if (req.url === '/redirect') { res.writeHead(302, { location: url }); res.end(); return }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(status === 200 ? JSON.stringify(CATALOG) : '{"error":"x"}')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/models`
  // Guard: nothing in this file may reach a real host.
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(String(input)).hostname
    if (host !== '127.0.0.1') throw new Error(`network call to ${host} in a test`)
    return realFetch(input, init)
  })
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await new Promise<void>(r => server.close(() => r()))
})
afterEach(() => { hits.length = 0; status = 200 })

describe('key catalog', () => {
  it('defaults to the public OpenRouter models URL and the D10 curated pair', () => {
    expect(KEY_CATALOG_URL).toBe('https://openrouter.ai/api/v1/models')
    expect(DEFAULT_KEY_MODEL).toBe('anthropic/claude-sonnet-5.5')
    expect(KEY_CATALOG_CURATED.map(m => [m.id, m.role])).toEqual([[DEFAULT_KEY_MODEL, 'default'], [CHEAPER_KEY_MODEL, 'cheaper']])
  })

  it('matches the curated list the P1 catalog route serves (ids, names, prices)', () => {
    expect(KEY_CATALOG_CURATED.map(({ id, name, inUsdPerM, outUsdPerM, role }) => ({ id, name, inUsdPerM, outUsdPerM, role })))
      .toEqual(CURATED_KEY_MODELS)
  })

  it('parses prices per million, tool support, and drops non-text and priceless rows', () => {
    const models = parseKeyCatalog(CATALOG)
    const sonnet = models.find(m => m.id === DEFAULT_KEY_MODEL)!
    expect(sonnet).toMatchObject({ inUsdPerM: 2.5, outUsdPerM: 12.5, supportsTools: true, contextLength: 200000 })
    expect(models.find(m => m.id === 'meta-llama/llama-5-70b')!.supportsTools).toBe(false)
    expect(models.some(m => m.id === 'black-forest/flux-image')).toBe(false)
    expect(models.some(m => m.id === 'broken/no-price')).toBe(false)
    expect(parseKeyCatalog({})).toEqual([])
    expect(parseKeyCatalog(null)).toEqual([])
  })

  it('fetches once, with no Authorization header, and serves the cache for 24 hours', async () => {
    let now = 1_000_000
    const catalog = new KeyCatalog({ url, now: () => now })
    expect(catalog.peek()).toBeNull()
    const first = await catalog.get()
    expect(first.from).toBe('openrouter')
    await catalog.get()
    now += KEY_CATALOG_TTL_MS - 1
    await catalog.get()
    expect(hits).toHaveLength(1)
    expect(hits[0]!.auth).toBeUndefined()
    now += 1
    expect(catalog.peek()).toBeNull()
    await catalog.get()
    expect(hits).toHaveLength(2)
  })

  it('a failed first fetch reports built-in; a failed refresh keeps the stale copy', async () => {
    let now = 0
    status = 500
    const catalog = new KeyCatalog({ url, now: () => now })
    expect(await catalog.get()).toEqual({ models: [], from: 'built-in' })
    status = 200
    await catalog.get()
    now += KEY_CATALOG_TTL_MS
    status = 503
    const stale = await catalog.get()
    expect(stale.from).toBe('openrouter')
    expect(stale.models.length).toBeGreaterThan(0)
  })

  it('refuses a redirect rather than follow it off the catalog host', async () => {
    const catalog = new KeyCatalog({ url: url.replace('/api/v1/models', '/redirect') })
    expect((await catalog.get()).from).toBe('built-in')
    expect(hits.map(h => h.path)).toEqual(['/redirect'])
  })

  it('refreshInBackground never fetches while fresh and never throws', async () => {
    const catalog = new KeyCatalog({ url })
    catalog.refreshInBackground()
    await vi.waitFor(() => expect(catalog.peek()).not.toBeNull())
    catalog.refreshInBackground()
    expect(hits).toHaveLength(1)
    status = 500
    const failing = new KeyCatalog({ url })
    expect(() => failing.refreshInBackground()).not.toThrow()
  })

  it('curated rows take live prices when cached and the plan prices when not', () => {
    const models = parseKeyCatalog(CATALOG)
    expect(curatedKeyModels(models)[0]).toMatchObject({ id: DEFAULT_KEY_MODEL, inUsdPerM: 2.5, outUsdPerM: 12.5, role: 'default' })
    expect(curatedKeyModels(null)[0]).toMatchObject({ inUsdPerM: 2, outUsdPerM: 10 })
    expect(keyModelPrice(DEFAULT_KEY_MODEL, null)).toEqual({ inUsdPerM: 2, outUsdPerM: 10, from: 'built-in' })
    expect(keyModelPrice('openai/gpt-6', models)).toEqual({ inUsdPerM: 3, outUsdPerM: 12, from: 'openrouter' })
    expect(keyModelPrice('nobody/knows', models).from).toBe('unknown')
    expect(keyModelSupportsTools('meta-llama/llama-5-70b', models)).toBe(false)
    expect(keyModelSupportsTools(CHEAPER_KEY_MODEL, null)).toBe(true)
    expect(keyModelSupportsTools('nobody/knows', null)).toBeUndefined()
  })

  it('downselects: curated first, at most 20 rows of at most 64 lens-safe characters, lanes per plan 4.4', () => {
    const models = parseKeyCatalog(CATALOG)
    expect(downselectKeyCatalog(models).map(r => r.id)).toEqual([DEFAULT_KEY_MODEL, CHEAPER_KEY_MODEL])
    const rows = downselectKeyCatalog(models, { query: 'model' })
    expect(rows).toHaveLength(KEY_CATALOG_MAX_ROWS)
    expect(rows.slice(0, 2).map(r => r.role)).toEqual(['default', 'cheaper'])
    for (const r of rows) {
      expect([...r.label].length).toBeLessThanOrEqual(KEY_CATALOG_ROW_CHARS)
      expect(r.label).not.toMatch(/[♦✓⚠↻↺⌛⋯░▓⬡—–]/u)
      expect(r.label).toMatch(/\| \$[\d.]+\/\$[\d.]+ per M$/)
    }
    expect(downselectKeyCatalog(models, { query: 'llama' }).map(r => r.lanes)).toEqual([['key', 'direct'], ['key', 'direct'], ['direct']])
    expect(downselectKeyCatalog(models, { query: 'llama', lane: 'key' }).map(r => r.id)).toEqual([DEFAULT_KEY_MODEL, CHEAPER_KEY_MODEL])
    expect(downselectKeyCatalog(models, { query: 'llama', toolsOnly: true }).some(r => r.id.includes('llama'))).toBe(false)
    expect(downselectKeyCatalog(models, { limit: 1 })).toHaveLength(1)
    expect(catalogLanesFor('openai/gpt-6')).toEqual(['key', 'direct'])
    expect(catalogLanesFor('google/gemini-4')).toEqual(['direct'])
  })
})
