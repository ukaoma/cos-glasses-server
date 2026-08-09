import { describe, expect, it } from 'vitest'
import {
  cleanContextText,
  normalizeMemoryDetail,
  normalizeMemoryList,
  normalizeMemoryOverview,
  normalizeContextBrowserStatus,
  normalizeThreadDetail,
  normalizeThreads,
} from './cos-context-browser.js'

describe('COS memory and thread projections', () => {
  it('keeps stable memory IDs while bounding and redacting client-visible data', () => {
    const rows = normalizeMemoryList([{
      id: 'mem_20260808_120000_123456',
      type: 'decision',
      summary: 'Use /Users/example/private/file.md and sk-supersecretvalue123',
      content: `A${'x'.repeat(2000)}`,
      created_at: '2026-08-08T12:00:00',
      domain: 'personal',
      refs: { people: ['Miles'], files: ['/Users/example/secret.md'] },
      vector: [1, 2, 3],
    }], 20)

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('mem_20260808_120000_123456')
    expect(rows[0].summary).toContain('[local path hidden]')
    expect(rows[0].summary).not.toContain('/Users/example')
    expect(rows[0].summary).toContain('[secret hidden]')
    expect(rows[0].refs.files?.[0]).toContain('[local path hidden]')
    expect(rows[0].refs.files?.[0]).not.toContain('/Users/example')
    expect(rows[0].content.length).toBe(1200)
    expect(rows[0]).not.toHaveProperty('vector')
  })

  it('rejects invalid IDs and applies the larger detail cap', () => {
    expect(normalizeMemoryList([{ id: '../bad', content: 'x' }], 20)).toEqual([])
    const detail = normalizeMemoryDetail({
      id: 'mem_valid_1', type: 'session_summary', content: 'z'.repeat(40_000),
    })
    expect(detail?.content.length).toBe(32_000)
  })

  it('normalizes the full overview without leaking implementation fields', () => {
    expect(normalizeMemoryOverview({
      available: true,
      collection: 'private-name',
      total: 4866,
      by_type: { decision: 1512, session_summary: 2568 },
      qdrant_url: 'http://127.0.0.1:6333',
    })).toEqual({
      available: true,
      collection: 'cos_memory',
      total: 4866,
      by_type: { decision: 1512, session_summary: 2568 },
    })
  })

  it('bounds thread lists and preserves the exact detail identity', () => {
    const raw = {
      active_count: 1,
      stale_count: 2,
      resolved_count: 3,
      threads: [{
        id: '7ce8073d',
        name: 'Pricing workstream',
        domain: 'quilt',
        is_manual: true,
        meeting_count: 3,
        topics: Array.from({ length: 50 }, (_, index) => `topic ${index}`),
        meetings: Array.from({ length: 120 }, (_, index) => ({ name: `Meeting ${index}`, date: '2026-08-08' })),
        manual_updates: [{ content: '/Users/example/private.md', timestamp: 'now', source: 'manual' }],
      }],
    }
    const list = normalizeThreads(raw, 30)
    expect(list.threads[0]).toMatchObject({ id: '7ce8073d', domain: 'quilt', is_manual: true })
    expect(list.threads[0].topics).toHaveLength(12)
    expect(list.threads[0].meetings).toHaveLength(12)

    const detail = normalizeThreadDetail(raw.threads[0])
    expect(detail?.meetings).toHaveLength(50)
    expect(detail?.manual_updates[0].content).toContain('[local path hidden]')
  })

  it('preserves the real manual-thread schema without exposing raw structures', () => {
    const detail = normalizeThreadDetail({
      id: 'mth_20260205_120344', name: 'JCK Next Gen Jeweler 2026', is_manual: true,
      linked_meetings: ['2026-01-05_Jewel360_Commercial_Pitch', '884ca049a19d'],
      meeting_count: 2,
      milestones: [{ event: 'Mitchell confirmed for speaking slot', date: '2026-02-05' }],
      sources: [{ content: 'Customer interview', reference: 'Nick Slack 9:35 AM' }],
    })
    expect(detail?.meetings).toEqual([
      { name: '2026-01-05_Jewel360_Commercial_Pitch', date: '' },
      { name: '884ca049a19d', date: '' },
    ])
    expect(detail?.milestones).toEqual(['Mitchell confirmed for speaking slot (2026-02-05)'])
    expect(detail?.sources).toEqual(['Customer interview (Nick Slack 9:35 AM)'])
  })

  it('rejects incompatible context protocols without leaking bridge internals', () => {
    expect(normalizeContextBrowserStatus({
      available: true, protocol: 999, scripts_dir: '/private/path',
      memory: { available: true, total: 4875, state: 'ready' },
      threads: { available: true, total: 30, active: 20, stale: 4, resolved: 6, state: 'ready' },
    })).toEqual({
      available: false, protocol: 999, state: 'bridge_outdated',
      memory: { available: false, total: 0, state: 'bridge_outdated', reason: 'bridge_outdated' },
      threads: { available: false, total: 0, active: 0, stale: 0, resolved: 0, state: 'bridge_outdated', reason: 'bridge_outdated' },
    })
  })

  it('preserves protocol 1 context readiness without leaking bridge internals', () => {
    expect(normalizeContextBrowserStatus({
      available: true, protocol: 1, scripts_dir: '/private/path',
      memory: { available: true, total: 4875, state: 'ready' },
      threads: { available: true, total: 30, active: 20, stale: 4, resolved: 6, state: 'ready' },
    })).toEqual({
      available: true, protocol: 1,
      memory: { available: true, total: 4875, state: 'ready' },
      threads: { available: true, total: 30, active: 20, stale: 4, resolved: 6, state: 'ready' },
    })
  })

  it('removes control characters', () => {
    expect(cleanContextText('hello\u0000world\u007f', 100)).toBe('helloworld')
  })

  it('bounds sanitizer work for oversized plain text', () => {
    const started = performance.now()
    expect(cleanContextText('z'.repeat(1_000_000), 32_000)).toHaveLength(32_000)
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('replaces arbitrary local absolute paths without corrupting web URLs', () => {
    const cleaned = cleanContextText('See /opt/private/data/file.txt, path:/Users/me/a.md, file:///Users/me/b.md and https://gotcos.com/docs', 240)
    expect(cleaned).toBe('See [local path hidden] path: [local path hidden], [local path hidden] and https://gotcos.com/docs')
  })

  it('redacts common secret families and Windows paths from raw memory text', () => {
    const source = [
      'Bearer abcdefghijklmnopqrstuvwxyz',
      'eyJabcdefghijk.abcdefghijkl.abcdefghijkl',
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
      'DATABASE_URL=postgres://user:pass@host/db',
      'https://user:pass@example.com/path?access_token=abcdef1234567890',
      'C:\\Users\\Queen\\private.txt',
      '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----',
    ].join('\n')
    const cleaned = cleanContextText(source, 4000)
    expect(cleaned).not.toMatch(/abcdefghijklmnopqrstuvwxyz|user:pass|C:\\Users|PRIVATE KEY/)
    expect(cleaned.match(/\[secret hidden\]/g)?.length).toBeGreaterThanOrEqual(5)
    expect(cleaned).toContain('[local path hidden]')
  })

  it('redacts a private key even when bridge truncation removes its END marker', () => {
    const cleaned = cleanContextText('prefix\n-----BEGIN PRIVATE KEY-----\nSUPERSECRETKEYMATERIAL', 500)
    expect(cleaned).toBe('prefix\n[secret hidden]')
    expect(cleaned).not.toContain('SUPERSECRET')
  })
})
