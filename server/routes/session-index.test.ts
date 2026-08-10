import express from 'express'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A getter, not a value. The route reads COS_SCRIPTS_DIR as a live ESM binding, so
// this lets each case decide whether the pipeline is configured — which is the whole
// point of the 503 test, and impossible with a plain literal in a hoisted factory.
let scriptsDir: string | null = null
let bridgeState: 'ready' | 'pipeline_missing' | 'bridge_missing' = 'ready'
vi.mock('../lib/python-bridge.js', () => ({
  get COS_SCRIPTS_DIR() { return scriptsDir },
  pythonBridgeState: () => bridgeState,
}))

import { __resetSessionIndexCache, sessionIndexRouter } from './session-index.js'

const closers: Array<() => Promise<void>> = []

async function startTestServer(): Promise<string> {
  const app = express()
  app.use('/api', sessionIndexRouter)
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve_ => {
    const listener = app.listen(0, '127.0.0.1', () => resolve_(listener))
  })
  closers.push(() => new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res())))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

// The fixture directory CONTAINS a dot component. A bare mktemp -d lands under
// /var/folders and structurally cannot, so it could never reproduce a
// dot-directory bug against the real data home (~/.cos-glasses).
let dir: string
beforeEach(() => {
  const parent = mkdtempSync(join(tmpdir(), 'cos-session-index-'))
  dir = resolve(parent, '.cos-fixture', 'scripts')
  mkdirSync(dir, { recursive: true })
  scriptsDir = dir
  bridgeState = 'ready'
  __resetSessionIndexCache()
})

const entry = (over: Record<string, unknown> = {}) => ({
  session_id: 'sess_a',
  glasses_session_id: 'dea05c6e-00f0-4a1b-9c2d-000000000001',
  slug: 'a-slug',
  created: '2026-08-01T10:00:00Z',
  modified: '2026-08-01T11:00:00Z',
  duration_minutes: 12,
  message_count: 8,
  user_message_count: 4,
  assistant_message_count: 4,
  first_prompt: 'How are we starting August?',
  tools_used: { Bash: 3 },
  files_touched: ['a.ts'],
  domain: 'personal',
  git_branch: 'main',
  has_subagents: false,
  total_input_tokens: 100,
  total_output_tokens: 50,
  file_size_bytes: 2048,
  device_id: 'Ukaoma-Mac-Studio',
  ...over,
})

function writeCache(name: string, entries: Record<string, unknown>[]): void {
  const sessions: Record<string, unknown> = {}
  for (const e of entries) sessions[String(e.session_id)] = e
  writeFileSync(join(dir, name), JSON.stringify({ sessions }))
}

describe('an unconfigured pipeline says so instead of showing an empty list', () => {
  it('answers 503 with a reason, never 200 with zero sessions', async () => {
    // THE DEFECT THIS REPLACES. The original returned [] when COS_SCRIPTS_DIR was
    // unset, which is every standalone npm install, so the tab rendered "no
    // sessions" for a user whose pipeline simply was not wired.
    scriptsDir = null
    bridgeState = 'pipeline_missing'
    const base = await startTestServer()
    const res = await fetch(`${base}/api/session-index`)
    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body).toMatchObject({ available: false, reason: 'pipeline_missing', sessions: [], total: 0 })
  })

  it('answers 503 on the detail route too', async () => {
    scriptsDir = null
    bridgeState = 'bridge_missing'
    const base = await startTestServer()
    const res = await fetch(`${base}/api/session-index/sess_a`)
    expect(res.status).toBe(503)
    expect((await res.json() as any).reason).toBe('bridge_missing')
  })
})

describe('reading the caches', () => {
  it('serves entries and collects the device list', async () => {
    writeCache('.session_index_cache_Studio.json', [entry()])
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/session-index`)).json() as any
    expect(body.total).toBe(1)
    expect(body.devices).toEqual(['Ukaoma-Mac-Studio'])
    expect(body.sessions[0]).toMatchObject({
      session_id: 'sess_a', domain: 'personal', message_count: 8,
      first_prompt: 'How are we starting August?',
    })
  })

  it('ignores files that are not session caches', async () => {
    writeCache('.session_index_cache_Studio.json', [entry()])
    writeFileSync(join(dir, 'notes.json'), JSON.stringify({ sessions: { x: entry({ session_id: 'nope' }) } }))
    writeFileSync(join(dir, '.session_index_cache_Studio.json.lock'), 'locked')
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/session-index`)).json() as any
    expect(body.sessions.map((s: any) => s.session_id)).toEqual(['sess_a'])
  })

  it('survives one unreadable file rather than emptying the whole list', async () => {
    writeCache('.session_index_cache_Good.json', [entry()])
    writeFileSync(join(dir, '.session_index_cache_Torn.json'), '{"sessions": {"a": ')
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/session-index`)).json() as any
    expect(body.total).toBe(1)
  })

  it('skips entries missing session_id or slug', async () => {
    writeCache('.session_index_cache_Studio.json', [
      entry(),
      entry({ session_id: 'no_slug', slug: '' }),
      entry({ session_id: '', slug: 'orphan' }),
    ])
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/session-index`)).json() as any
    expect(body.sessions.map((s: any) => s.session_id)).toEqual(['sess_a'])
  })
})

describe('the iCloud sync-conflict duplicate, measured on the real machine', () => {
  it('serves a session ONCE when two cache files hold it', async () => {
    // Measured 2026-08-10: `.session_index_cache_Ukaoma-Mac-Studio 3.json` shared
    // 543 of its 602 rows with the canonical file. The original filter read both, so
    // the merged list served 543 duplicates.
    writeCache('.session_index_cache_Studio.json', [entry({ modified: '2026-08-01T11:00:00Z' })])
    writeCache('.session_index_cache_Studio 3.json', [entry({ modified: '2026-08-02T09:00:00Z', slug: 'newer' })])
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/session-index`)).json() as any
    expect(body.total).toBe(1)
    // Newest wins, so the duplicate is not merely dropped, it is resolved.
    expect(body.sessions[0].slug).toBe('newer')
  })

  it('still serves rows that exist ONLY in a duplicate-looking file', async () => {
    // The other half of the measurement: ` 2.json` held 245 rows appearing nowhere
    // else. Filtering ' N' filenames out would silently drop real sessions, which is
    // why dedupe is by session_id and every file is still read.
    writeCache('.session_index_cache_Studio.json', [entry()])
    writeCache('.session_index_cache_Studio 2.json', [entry({ session_id: 'only_here', slug: 'unique' })])
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/session-index`)).json() as any
    expect(body.sessions.map((s: any) => s.session_id).sort()).toEqual(['only_here', 'sess_a'])
  })

  it('falls back to _file_mtime when modified is unusable', async () => {
    writeCache('.session_index_cache_A.json', [entry({ modified: '', _file_mtime: 1000 })])
    writeCache('.session_index_cache_B.json', [entry({ modified: '', _file_mtime: 2000, slug: 'newer' })])
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/session-index`)).json() as any
    expect(body.total).toBe(1)
    expect(body.sessions[0].slug).toBe('newer')
  })
})

describe('filters, ordering and bounds', () => {
  beforeEach(() => {
    writeCache('.session_index_cache_Studio.json', [
      entry({ session_id: 'p1', domain: 'personal', modified: '2026-08-03T10:00:00Z' }),
      entry({ session_id: 'q1', domain: 'quilt', modified: '2026-08-05T10:00:00Z', device_id: 'MilesUkaoma-Air' }),
      entry({ session_id: 'i1', domain: 'infrastructure', modified: '2026-08-04T10:00:00Z' }),
    ])
  })

  it('sorts newest modified first', async () => {
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/session-index`)).json() as any
    expect(body.sessions.map((s: any) => s.session_id)).toEqual(['q1', 'i1', 'p1'])
  })

  it('filters by domain and by device', async () => {
    const base = await startTestServer()
    const byDomain = await (await fetch(`${base}/api/session-index?domain=quilt`)).json() as any
    expect(byDomain.sessions.map((s: any) => s.session_id)).toEqual(['q1'])
    const byDevice = await (await fetch(`${base}/api/session-index?device=MilesUkaoma-Air`)).json() as any
    expect(byDevice.sessions.map((s: any) => s.session_id)).toEqual(['q1'])
  })

  it('filters by glasses UUID prefix', async () => {
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/session-index?sid=dea05c6e`)).json() as any
    expect(body.total).toBe(3)
    const none = await (await fetch(`${base}/api/session-index?sid=ffffffff`)).json() as any
    expect(none.total).toBe(0)
  })

  it('clamps limit instead of trusting it', async () => {
    const base = await startTestServer()
    for (const [q, expected] of [['limit=1', 1], ['limit=0', 1], ['limit=9999', 3], ['limit=abc', 3]] as const) {
      const body = await (await fetch(`${base}/api/session-index?${q}`)).json() as any
      expect(body.sessions.length, q).toBe(expected)
      // total always reports the unclamped match count, so the UI can say "3 of 47".
      expect(body.total, q).toBe(3)
    }
  })
})

describe('detail lookup', () => {
  beforeEach(() => writeCache('.session_index_cache_Studio.json', [entry()]))

  it('returns the full field set, including what sessions/recent cannot provide', async () => {
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/session-index/sess_a`)).json() as any
    expect(body).toMatchObject({
      session_id: 'sess_a',
      tools_used: { Bash: 3 },
      files_touched: ['a.ts'],
      git_branch: 'main',
      total_input_tokens: 100,
      total_output_tokens: 50,
      file_size_bytes: 2048,
      user_message_count: 4,
      domain: 'personal',
      device_id: 'Ukaoma-Mac-Studio',
    })
  })

  it('resolves by glasses UUID and by prefix', async () => {
    const base = await startTestServer()
    const full = await fetch(`${base}/api/session-index/dea05c6e-00f0-4a1b-9c2d-000000000001`)
    expect(full.status).toBe(200)
    const prefix = await fetch(`${base}/api/session-index/dea05c6e`)
    expect(prefix.status).toBe(200)
  })

  it('does not prefix-match on a stub too short to be meaningful', async () => {
    const base = await startTestServer()
    expect((await fetch(`${base}/api/session-index/dea`)).status).toBe(404)
  })

  it('404s an unknown id with a reason', async () => {
    const base = await startTestServer()
    const res = await fetch(`${base}/api/session-index/nope`)
    expect(res.status).toBe(404)
    expect((await res.json() as any).reason).toBe('session_not_found')
  })

  it('coerces a malformed stored shape rather than emitting it raw', async () => {
    writeCache('.session_index_cache_Bad.json', [entry({
      session_id: 'weird', tools_used: 'not-an-object', files_touched: 'not-an-array',
      total_input_tokens: 'lots', has_subagents: 'yes',
    })])
    __resetSessionIndexCache()
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/session-index/weird`)).json() as any
    expect(body.tools_used).toEqual({})
    expect(body.files_touched).toEqual([])
    expect(body.total_input_tokens).toBe(0)
    expect(body.has_subagents).toBe(false)
  })
})

describe('it never leaks a filesystem path to the client', () => {
  it('returns a generic reason when the read throws', async () => {
    // The original did res.status(500).json({ error: err.message }), where message is
    // a full path. No other router in this repo does that.
    scriptsDir = resolve(dir, 'does-not-exist-at-all')
    const base = await startTestServer()
    const res = await fetch(`${base}/api/session-index`)
    expect(res.status).toBe(500)
    const body = await res.json() as any
    expect(body).toMatchObject({ reason: 'session_index_read_failed' })
    expect(JSON.stringify(body)).not.toContain('does-not-exist-at-all')
    expect(JSON.stringify(body)).not.toContain(dir)
  })

  it('returns a generic reason when the detail read throws', async () => {
    // Both handlers carry the same 500 responder, so mutating them together looked
    // covered. Mutated ONE AT A TIME, the list site was caught and this one SURVIVED
    // — the detail path had no test, so a path leak there would have shipped.
    scriptsDir = resolve(dir, 'also-missing-entirely')
    const base = await startTestServer()
    const res = await fetch(`${base}/api/session-index/sess_a`)
    expect(res.status).toBe(500)
    const body = await res.json() as any
    expect(body).toMatchObject({ reason: 'session_index_read_failed' })
    expect(JSON.stringify(body)).not.toContain('also-missing-entirely')
    expect(JSON.stringify(body)).not.toContain(dir)
  })
})

describe('the parse cache does not serve staleness', () => {
  it('re-reads after a cache file changes', async () => {
    // 31.7 MB is too much to parse per request, so results are cached against file
    // name, size and mtime. That is only safe if a write invalidates it.
    writeCache('.session_index_cache_Studio.json', [entry({ slug: 'first' })])
    const base = await startTestServer()
    expect((await (await fetch(`${base}/api/session-index`)).json() as any).sessions[0].slug).toBe('first')

    writeCache('.session_index_cache_Studio.json', [entry({ slug: 'second' })])
    const future = new Date(Date.now() + 5_000)
    utimesSync(join(dir, '.session_index_cache_Studio.json'), future, future)

    expect((await (await fetch(`${base}/api/session-index`)).json() as any).sessions[0].slug).toBe('second')
  })

  it('picks up a NEW cache file, not just an edited one', async () => {
    writeCache('.session_index_cache_A.json', [entry()])
    const base = await startTestServer()
    expect((await (await fetch(`${base}/api/session-index`)).json() as any).total).toBe(1)
    writeCache('.session_index_cache_B.json', [entry({ session_id: 'sess_b' })])
    expect((await (await fetch(`${base}/api/session-index`)).json() as any).total).toBe(2)
  })
})

describe('it is actually mounted', () => {
  it('is imported and registered in the real server entrypoint', () => {
    // STRUCTURAL, and stated as such: importing server/index.ts would boot the whole
    // server — listeners on 3141/3143, whisper, boot recovery, timers. The ENTIRE
    // original defect was an unmounted route, and no test asserted mounting, so this
    // closes the exact gap that produced the 404.
    const index = readFileSync(new URL('../index.ts', import.meta.url).pathname, 'utf8')
    expect(index, 'session-index router must be imported')
      .toMatch(/import \{ sessionIndexRouter \} from '\.\/routes\/session-index\.js'/)
    expect(index, 'session-index router must be mounted under /api')
      .toMatch(/app\.use\('\/api', sessionIndexRouter\)/)
  })
})
