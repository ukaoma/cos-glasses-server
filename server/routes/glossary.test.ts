import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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
    vi.resetModules()
    vi.doMock('../lib/whisper-local.js', () => ({ resetDecoderCaches: vi.fn() }))
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
})
