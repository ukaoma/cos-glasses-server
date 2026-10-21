import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { request } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmpDir = ''
let profilePath = ''
let server: Server | null = null
let baseUrl = ''

function httpRequest(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolveRequest, reject) => {
    const req = request(`${baseUrl}${path}`, {
      method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        let json: any = null
        try { json = text ? JSON.parse(text) : null } catch { json = text }
        resolveRequest({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

let resetDecoderCachesSpy: ReturnType<typeof vi.fn>

describe('glossary route', () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cos-glossary-'))
    profilePath = join(tmpDir, '.cos-profile.json')
    writeFileSync(profilePath, JSON.stringify({
      owner_name: 'Miles',
      vocabulary: ['Quilt Software'],
      domain_keywords: { work: ['company'] },
      whisper_corrections: '{"Myles": "Miles"}',
    }))
    process.env.COS_PROFILE_PATH = profilePath
    process.env.COS_DATA_DIR = join(tmpDir, 'data')
    vi.resetModules()
    resetDecoderCachesSpy = vi.fn()
    vi.doMock('../lib/whisper-local.js', () => ({ resetDecoderCaches: resetDecoderCachesSpy }))
    const { glossaryRouter } = await import('./glossary.js')
    const app = express()
    app.use(express.json())
    app.use('/api', glossaryRouter)
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address()
        if (!addr || typeof addr === 'string') throw new Error('no addr')
        baseUrl = `http://127.0.0.1:${addr.port}`
        res()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((res) => { server ? server.close(() => res()) : res() })
    server = null
    baseUrl = ''
    vi.doUnmock('../lib/whisper-local.js')
    vi.resetModules()
    delete process.env.COS_PROFILE_PATH
    delete process.env.COS_DATA_DIR
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('GET returns the current glossary with parsed corrections', async () => {
    const res = await httpRequest('GET', '/api/transcription-glossary')
    expect(res.status).toBe(200)
    expect(res.json.vocabulary).toEqual(['Quilt Software'])
    expect(res.json.corrections).toEqual({ Myles: 'Miles' })
    expect(res.json.negative_rules).toEqual([])
  })

  it('PUT updates vocabulary, busts the cache, and preserves untouched keys', async () => {
    const put = await httpRequest('PUT', '/api/transcription-glossary', { vocabulary: ['CaratIQ', 'Jewel360'] })
    expect(put.status).toBe(200)
    expect(put.json.vocabulary).toEqual(['CaratIQ', 'Jewel360']) // response reflects new value → cache busted

    const get = await httpRequest('GET', '/api/transcription-glossary')
    expect(get.json.vocabulary).toEqual(['CaratIQ', 'Jewel360'])

    const onDisk = JSON.parse(readFileSync(profilePath, 'utf-8'))
    expect(onDisk.domain_keywords).toEqual({ work: ['company'] }) // untouched key preserved
    expect(onDisk.owner_name).toBe('Miles')

    // The "busts the cache" half of this test's name, now actually asserted. The mock
    // was created inline as vi.fn(), so the spy was unreachable and deleting
    // resetDecoderCaches() from glossary.ts:137 left this file fully green — a
    // surviving mutation on a hit target. Stale decoder snapshots after a glossary
    // edit is exactly the bug that call prevents.
    expect(resetDecoderCachesSpy, 'a glossary edit must clear the decoder snapshots')
      .toHaveBeenCalled()
  })

  it('stores corrections as a JSON string', async () => {
    await httpRequest('PUT', '/api/transcription-glossary', { corrections: { 'POS Nation': 'POSNation' } })
    const onDisk = JSON.parse(readFileSync(profilePath, 'utf-8'))
    expect(typeof onDisk.whisper_corrections).toBe('string')
    expect(JSON.parse(onDisk.whisper_corrections)).toEqual({ 'POS Nation': 'POSNation' })
  })

  it('rejects URL/email vocabulary (decoder-prompt safety)', async () => {
    const res = await httpRequest('PUT', '/api/transcription-glossary', { vocabulary: ['www.posnation.com'] })
    expect(res.status).toBe(400)
  })

  it('rejects a malformed replace rule', async () => {
    const res = await httpRequest('PUT', '/api/transcription-glossary', { negative_rules: ['replace:missing-arrow'] })
    expect(res.status).toBe(400)
  })

  it('accepts valid negative rules', async () => {
    const res = await httpRequest('PUT', '/api/transcription-glossary', { negative_rules: ['whole:subscribe now', 'replace:POS Nation=>POSNation'] })
    expect(res.status).toBe(200)
    expect(res.json.negative_rules).toEqual(['whole:subscribe now', 'replace:POS Nation=>POSNation'])
  })

  // ── 6.73.11: Fix a word ──────────────────────────────────────────────────────
  it('POST correction learns one word: correction, vocabulary, log, cache bust', async () => {
    const res = await httpRequest('POST', '/api/transcription-glossary/correction', { heard: 'Whisper', written: 'Wispr', source: 'dictation' })
    expect(res.status).toBe(200)
    expect(res.json.unchanged).toBe(false)
    expect(res.json.entry).toMatchObject({ heard: 'Whisper', written: 'Wispr', source: 'dictation', addedVocabulary: true })
    expect(res.json.glossary.corrections).toEqual({ Myles: 'Miles', Whisper: 'Wispr' })
    expect(res.json.glossary.vocabulary).toEqual(['Quilt Software', 'Wispr'])
    const onDisk = JSON.parse(readFileSync(profilePath, 'utf-8'))
    expect(JSON.parse(onDisk.whisper_corrections)).toEqual({ Myles: 'Miles', Whisper: 'Wispr' })
    expect(onDisk.owner_name).toBe('Miles') // untouched key preserved
    expect(resetDecoderCachesSpy, 'a learned word must reach the decoder without a restart').toHaveBeenCalled()
    const logPath = join(tmpDir, 'data', 'transcription-corrections.json')
    expect(statSync(logPath).mode & 0o777, 'the corrections log is private').toBe(0o600)
    const recent = await httpRequest('GET', '/api/transcription-glossary/recent')
    expect(recent.json.entries.map((e: any) => e.id)).toEqual([res.json.entry.id])
  })

  it('GET recent is newest first', async () => {
    const a = await httpRequest('POST', '/api/transcription-glossary/correction', { heard: 'Carrot IQ', written: 'CaratIQ', source: 'meeting' })
    const b = await httpRequest('POST', '/api/transcription-glossary/correction', { heard: 'Santi', written: 'Sante HQ', source: 'g2' })
    const recent = await httpRequest('GET', '/api/transcription-glossary/recent')
    expect(recent.json.entries.map((e: any) => e.id)).toEqual([b.json.entry.id, a.json.entry.id])
  })

  it('concurrent learns all land (writes share the glossary chain)', async () => {
    const results = await Promise.all([
      httpRequest('POST', '/api/transcription-glossary/correction', { heard: 'one', written: 'One', source: 'manual' }),
      httpRequest('POST', '/api/transcription-glossary/correction', { heard: 'two', written: 'Two', source: 'manual' }),
      httpRequest('POST', '/api/transcription-glossary/correction', { heard: 'three', written: 'Three', source: 'manual' }),
    ])
    expect(results.map(r => r.status)).toEqual([200, 200, 200])
    const get = await httpRequest('GET', '/api/transcription-glossary')
    expect(get.json.corrections).toEqual({ Myles: 'Miles', one: 'One', two: 'Two', three: 'Three' })
    const recent = await httpRequest('GET', '/api/transcription-glossary/recent')
    expect(recent.json.entries).toHaveLength(3)
  })

  // 6.83.1: "gotcos.com" is now a correction-only learn (glossary-correction-only.test.ts); a bare "/" is still refused.
  it('POST correction refuses bad input without writing', async () => {
    const before = readFileSync(profilePath, 'utf-8')
    for (const body of [{ heard: 'slash', written: '/', source: 'manual' }, { heard: 'x', written: 'y', source: 'nope' }, { heard: 'x' }]) {
      const res = await httpRequest('POST', '/api/transcription-glossary/correction', body)
      expect(res.status).toBe(400)
    }
    expect(readFileSync(profilePath, 'utf-8')).toBe(before)
    const recent = await httpRequest('GET', '/api/transcription-glossary/recent')
    expect(recent.json.entries).toEqual([])
  })

  it('undo reverts exactly that entry, then refuses a second time', async () => {
    const learned = await httpRequest('POST', '/api/transcription-glossary/correction', { heard: 'Whisper', written: 'Wispr', source: 'dictation' })
    const undo = await httpRequest('POST', '/api/transcription-glossary/correction/undo', { id: learned.json.entry.id })
    expect(undo.status).toBe(200)
    expect(undo.json.glossary.corrections).toEqual({ Myles: 'Miles' })
    expect(undo.json.glossary.vocabulary).toEqual(['Quilt Software'])
    const recent = await httpRequest('GET', '/api/transcription-glossary/recent')
    expect(recent.json.entries).toEqual([])
    const again = await httpRequest('POST', '/api/transcription-glossary/correction/undo', { id: learned.json.entry.id })
    expect(again.status).toBe(404)
  })

  it('undo refuses after a hand edit replaced the word', async () => {
    const learned = await httpRequest('POST', '/api/transcription-glossary/correction', { heard: 'Whisper', written: 'Wispr', source: 'dictation' })
    await httpRequest('PUT', '/api/transcription-glossary', { corrections: { Whisper: 'Whispr' } })
    const undo = await httpRequest('POST', '/api/transcription-glossary/correction/undo', { id: learned.json.entry.id })
    expect(undo.status).toBe(409)
    const get = await httpRequest('GET', '/api/transcription-glossary')
    expect(get.json.corrections).toEqual({ Whisper: 'Whispr' })
  })

  // ── 6.73.12: single-item hand edits ─────────────────────────────────────────
  it('adds and removes one vocabulary word atomically, keeping everything else', async () => {
    await httpRequest('POST', '/api/transcription-glossary/correction', { heard: 'Whisper', written: 'Wispr', source: 'dictation' })
    resetDecoderCachesSpy.mockClear()
    const add = await httpRequest('POST', '/api/transcription-glossary/vocabulary/add', { term: 'Jewel360' })
    expect(add.status).toBe(200)
    expect(add.json.unchanged).toBe(false)
    expect(add.json.glossary.vocabulary).toEqual(['Quilt Software', 'Wispr', 'Jewel360'])
    expect(add.json.glossary.corrections).toEqual({ Myles: 'Miles', Whisper: 'Wispr' })
    expect(resetDecoderCachesSpy, 'a hand edit must reach the decoder without a restart').toHaveBeenCalled()
    const again = await httpRequest('POST', '/api/transcription-glossary/vocabulary/add', { term: 'jewel360' })
    expect(again.json.unchanged).toBe(true)
    const remove = await httpRequest('POST', '/api/transcription-glossary/vocabulary/remove', { term: 'Quilt Software' })
    expect(remove.json.glossary.vocabulary).toEqual(['Wispr', 'Jewel360'])
    const onDisk = JSON.parse(readFileSync(profilePath, 'utf-8'))
    expect(onDisk.owner_name).toBe('Miles')
    expect(onDisk.vocabulary).toEqual(['Wispr', 'Jewel360'])
    // Hand edits are not learned corrections: the undo log only holds the learn.
    const recent = await httpRequest('GET', '/api/transcription-glossary/recent')
    expect(recent.json.entries).toHaveLength(1)
  })

  it('removes one correction and leaves the others', async () => {
    await httpRequest('POST', '/api/transcription-glossary/correction', { heard: 'Carrot IQ', written: 'CaratIQ', source: 'meeting' })
    const res = await httpRequest('POST', '/api/transcription-glossary/correction/remove', { heard: 'Myles' })
    expect(res.status).toBe(200)
    expect(res.json.glossary.corrections).toEqual({ 'Carrot IQ': 'CaratIQ' })
    expect(JSON.parse(JSON.parse(readFileSync(profilePath, 'utf-8')).whisper_corrections)).toEqual({ 'Carrot IQ': 'CaratIQ' })
  })

  it('refuses a bad single edit without writing', async () => {
    const before = readFileSync(profilePath, 'utf-8')
    for (const [path, body] of [
      ['/api/transcription-glossary/vocabulary/add', { term: 'www.posnation.com' }],
      ['/api/transcription-glossary/vocabulary/add', {}],
      ['/api/transcription-glossary/vocabulary/remove', { term: 5 }],
      ['/api/transcription-glossary/correction/remove', { heard: '' }],
    ] as const) {
      const res = await httpRequest('POST', path, body)
      expect(res.status, path).toBe(400)
    }
    expect(readFileSync(profilePath, 'utf-8')).toBe(before)
  })
})
