import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SttCapabilities } from '../lib/stt-settings.js'

let dir = '', base = ''
let server: Server | null = null
let live = false
let caps: SttCapabilities
const install = vi.fn(async () => {})

const allCaps = (over: Partial<SttCapabilities> = {}): SttCapabilities => ({
  turboModel: true, liveLargeV3: true, hqLargeV3: true, parakeetInstalled: true,
  parakeetPreviewWarm: false, parakeetPreviewWarming: false, previewDisabledByEnv: false, ...over,
})

async function call(method: string, path = '/api/stt-settings', body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

describe('STT settings route (6.72.0)', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cos-stt-settings-'))
    process.env.COS_DATA_DIR = dir
    process.env.COS_PROFILE_PATH = join(dir, 'profile.json')
    live = false
    caps = allCaps()
    install.mockClear()
    vi.resetModules()
    const { createSttSettingsRouter } = await import('./stt-settings.js')
    const app = express()
    app.use(express.json())
    app.use('/api', createSttSettingsRouter({ recordingLive: () => live, capabilities: () => caps, install }))
    await new Promise<void>(res => { server = app.listen(0, '127.0.0.1', () => { const a = server!.address(); if (!a || typeof a === 'string') throw new Error('no addr'); base = `http://127.0.0.1:${a.port}`; res() }) })
  })
  afterEach(async () => {
    await new Promise<void>(res => server ? server.close(() => res()) : res())
    server = null
    delete process.env.COS_DATA_DIR
    delete process.env.COS_PROFILE_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('GET returns the contract shape with the 6.72.0 defaults', async () => {
    const { status, json } = await call('GET')
    expect(status).toBe(200)
    expect(json.preview.selected).toBe('turbo')
    expect(json.hq.selected).toBe('large-v3')
    const { DEFAULT_STT_SETTINGS } = await import('../lib/stt-settings.js')
    expect(json.secondOpinion.selected).toBe(DEFAULT_STT_SETTINGS.secondOpinion)
    expect(json.resolver).toMatchObject({ enabled: true, effective: true, reason: null })
    expect(json.frontEnd.selected).toBe('highpass')
    expect(json.quietGate.selected).toBe('silero')
    expect(json.appliesTo).toEqual({ preview: 'next live chunk', hq: 'next saved meeting' })
    expect(json.preview.options.map((o: any) => o.id)).toEqual(['turbo', 'large-v3', 'parakeet', 'nemotron-560'])
    expect(json.hq.options.map((o: any) => o.id)).toEqual(['large-v3', 'large-v3-legacy', 'parakeet-ultra'])
    const { SECOND_OPINION_IDS } = await import('../lib/stt-settings.js')
    expect(json.secondOpinion.options.map((o: any) => o.id)).toEqual([...SECOND_OPINION_IDS])
    expect(json.preview).toMatchObject({ models: ['large-v3-turbo', 'parakeet-ultra'], clientParam: 'previewModels', requiresApp: '6.10.639', reason: null, reasonCode: null })
    expect(json.preview.options.find((o: any) => o.id === 'large-v3')).toMatchObject({ available: false, note: expect.stringMatching(/live Large-v3 worker/) })
    expect(json.preview.options.find((o: any) => o.id === 'parakeet')).toMatchObject({ label: 'Parakeet Ultra' })
    expect(json.lastJob).toBeNull()
    for (const o of [...json.preview.options, ...json.hq.options, ...json.secondOpinion.options, ...json.frontEnd.options, ...json.quietGate.options]) {
      expect(o).toEqual({ id: expect.any(String), label: expect.any(String), available: expect.any(Boolean), experimental: expect.any(Boolean), note: expect.any(String) })
    }
    expect(json.parakeet).toEqual(expect.objectContaining({ installed: expect.any(Boolean), installable: expect.any(Boolean), version: expect.any(String), bytes: expect.any(Number),
      progress: expect.objectContaining({ state: expect.any(String), bytesDone: expect.any(Number), bytesTotal: expect.any(Number) }) }))
  })

  it('never fakes a preview that is not wired: Nemotron is listed unavailable with a note', async () => {
    const nemotron = (await call('GET')).json.preview.options.find((o: any) => o.id === 'nemotron-560')
    expect(nemotron.available).toBe(false)
    expect(nemotron.note).toMatch(/not wired/i)
    const put = await call('PUT', undefined, { preview: 'nemotron-560' })
    expect(put.status).toBe(400)
    expect(put.json.error).toMatch(/not available/)
  })

  it('PUT takes a partial body, persists it atomically and returns the GET shape', async () => {
    const put = await call('PUT', undefined, { hq: 'large-v3-legacy', resolver: false, frontEnd: 'full', quietGate: 'rms', preview: 'parakeet' })
    expect(put.status).toBe(200)
    expect(put.json.hq.selected).toBe('large-v3-legacy')
    expect(put.json.resolver.enabled).toBe(false)
    const saved = JSON.parse(readFileSync(join(dir, 'stt-settings.json'), 'utf8'))
    const { DEFAULT_STT_SETTINGS: D } = await import('../lib/stt-settings.js')
    expect(saved).toEqual({ preview: 'parakeet', hq: 'large-v3-legacy', secondOpinion: D.secondOpinion, resolver: false, frontEnd: 'full', quietGate: 'rms' })
    expect(existsSync(join(dir, 'stt-settings.json.tmp'))).toBe(false)
    expect((await call('GET')).json.frontEnd.selected).toBe('full')
  })

  it('applies without a restart: the next read sees a change made on disk', async () => {
    const { readSttSettings } = await import('../lib/stt-settings.js')
    expect(readSttSettings().frontEnd).toBe('highpass')
    await call('PUT', undefined, { frontEnd: 'full' })
    expect(readSttSettings().frontEnd).toBe('full')
    writeFileSync(join(dir, 'stt-settings.json'), JSON.stringify({ frontEnd: 'highpass', quietGate: 'rms', extra: 1 }) + '\n\n')
    expect(readSttSettings()).toMatchObject({ frontEnd: 'highpass', quietGate: 'rms', hq: 'large-v3' })
  })

  it('400s in plain words for unknown keys, unknown ids, wrong types and unavailable choices', async () => {
    const before = existsSync(join(dir, 'stt-settings.json'))
    for (const [body, pattern] of [
      [{ engine: 'x' }, /Unknown setting: engine/],
      [{ hq: 'whisper-9' }, /HQ model must be one of: large-v3, large-v3-legacy, parakeet-ultra/],
      [{ resolver: 'yes' }, /resolver must be true or false/],
      [{ frontEnd: 3 }, /Front end must be one of/],
      [[1, 2], /Send a JSON object/],
    ] as const) {
      const r = await call('PUT', undefined, body)
      expect(r.status).toBe(400)
      expect(r.json.error).toMatch(pattern)
    }
    caps = allCaps({ parakeetInstalled: false })
    const r = await call('PUT', undefined, { hq: 'parakeet-ultra' })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('Parakeet Ultra is not available: Install Parakeet on this Mac first.')
    expect(existsSync(join(dir, 'stt-settings.json'))).toBe(before)
  })

  it('moving HQ onto the second opinion engine moves the second opinion, unless both are set together', async () => {
    const swapped = await call('PUT', undefined, { hq: 'parakeet-ultra' })
    expect(swapped.status).toBe(200)
    expect(swapped.json.secondOpinion.selected).toBe('large-v3')
    const both = await call('PUT', undefined, { hq: 'parakeet-ultra', secondOpinion: 'large-v3', resolver: true })
    expect(both.status).toBe(200)
    expect(both.json).toMatchObject({ hq: { selected: 'parakeet-ultra', effective: 'parakeet-ultra' }, secondOpinion: { selected: 'large-v3', effective: 'large-v3' }, resolver: { enabled: true, effective: true } })
    const clash = await call('PUT', undefined, { hq: 'large-v3', secondOpinion: 'large-v3' })
    expect(clash.status).toBe(400)
    expect(clash.json.error).toMatch(/different engine/)
  })

  it('a stored choice that is no longer possible falls back and says so in effective', async () => {
    await call('PUT', undefined, { hq: 'parakeet-ultra', preview: 'parakeet' })
    caps = allCaps({ parakeetInstalled: false })
    const g = (await call('GET')).json
    expect(g.hq).toMatchObject({ selected: 'parakeet-ultra', effective: 'large-v3' })
    expect(g.preview).toMatchObject({ selected: 'parakeet', effective: 'turbo' })
    caps = allCaps({ parakeetPreviewWarm: false })
    expect((await call('GET')).json.preview.effective).toBe('turbo')
    caps = allCaps({ parakeetPreviewWarm: true })
    expect((await call('GET')).json.preview.effective).toBe('parakeet')
    caps = allCaps({ parakeetPreviewWarmFailed: true })
    expect((await call('GET')).json.preview).toMatchObject({ effective: 'turbo', reasonCode: 'parakeet_warm_failed', reason: 'Parakeet could not start; using Turbo.' })
    caps = allCaps({ parakeetPreviewWarm: true, parakeetPreviewBreakerOpen: true })
    expect((await call('GET')).json.preview).toMatchObject({ effective: 'turbo', reasonCode: 'parakeet_breaker_open' })
    writeFileSync(join(dir, 'stt-settings.json'), JSON.stringify({ hq: 'large-v3', secondOpinion: 'parakeet-ultra' }))
    caps = allCaps({ parakeetInstalled: false })
    expect((await call('GET')).json.secondOpinion).toMatchObject({ effective: 'off', reasonCode: 'parakeet_not_installed', reason: 'Parakeet is not installed on this Mac.' })
    expect((await call('GET')).json.resolver).toMatchObject({ effective: false, reasonCode: 'no_second_opinion' })
  })

  it('install refuses during a recording and otherwise starts in the background', async () => {
    caps = allCaps({ parakeetInstalled: false })
    live = true
    const refused = await call('POST', '/api/stt-settings/parakeet/install', {})
    expect(refused.status).toBe(409)
    expect(refused.json.error).toBe('A recording is live. Install Parakeet after it is saved.')
    expect(install).not.toHaveBeenCalled()
    live = false
    const bad = await call('POST', '/api/stt-settings/parakeet/install', { localSource: 'relative/dir' })
    expect(bad.status).toBe(400)
    const ok = await call('POST', '/api/stt-settings/parakeet/install', { localSource: '/tmp/somewhere' })
    expect(ok.status).toBe(202)
    expect(ok.json.started).toBe(true)
    expect(install).toHaveBeenCalledWith({ localSources: ['/tmp/somewhere'], requireLocal: true })
    install.mockClear()
    await call('POST', '/api/stt-settings/parakeet/install', { localSource: '/tmp/somewhere', allowDownload: true })
    expect(install).toHaveBeenCalledWith({ localSources: ['/tmp/somewhere'], requireLocal: false })
    install.mockClear()
    await call('POST', '/api/stt-settings/parakeet/install', {})
    expect(install).toHaveBeenCalledWith({})
    expect((await call('POST', '/api/stt-settings/parakeet/install', { allowDownload: 'yes' })).status).toBe(400)
    const del = await call('DELETE', '/api/stt-settings/parakeet/install')
    expect(del.status).toBe(200)
    expect(del.json.cancelled).toBe(false)
  })

  it('a corrupt settings file runs the defaults and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { readSttSettings, DEFAULT_STT_SETTINGS } = await import('../lib/stt-settings.js')
      writeFileSync(join(dir, 'stt-settings.json'), '{not json')
      expect(readSttSettings()).toEqual(DEFAULT_STT_SETTINGS)
      writeFileSync(join(dir, 'stt-settings.json'), '{still not json')
      expect(readSttSettings()).toEqual(DEFAULT_STT_SETTINGS)
      expect(warn.mock.calls.filter(c => String(c[0]).includes('stt-settings.json is unreadable'))).toHaveLength(1)
    } finally { warn.mockRestore() }
  })

  it('GET shows the last HQ job outcome', async () => {
    const { recordLastSttJob } = await import('../lib/stt-settings.js')
    recordLastSttJob({ at: '2026-10-13T00:00:00.000Z', meeting: 'm1', outcome: 'batch', summary: { windows: 3, secondOpinionFailures: 1 } })
    expect((await call('GET')).json.lastJob).toEqual({ at: '2026-10-13T00:00:00.000Z', meeting: 'm1', outcome: 'batch', summary: { windows: 3, secondOpinionFailures: 1 } })
  })
})

