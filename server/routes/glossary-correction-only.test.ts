// 6.83.1, end to end on the real modules: a correction whose written form is a path is
// learned through the real route, applied by the real correction pass, and never reaches the
// real decoder prompt builder (vocabulary prompt, rolling context, cloud prompt). Synthetic
// text only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmpDir = ''
let server: Server | null = null
let baseUrl = ''
let whisper: typeof import('../lib/whisper-local.js')
let filter: typeof import('../lib/hallucination-filter.js')
let profile: typeof import('../lib/profile.js')

function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((resolveRequest, reject) => {
    const req = request(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(Buffer.from(c)))
      res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || 'null') }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const PREV = { profile: process.env.COS_PROFILE_PATH, data: process.env.COS_DATA_DIR }

describe('correction-only learn, end to end', () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cos-correction-only-'))
    const profilePath = join(tmpDir, '.cos-profile.json')
    writeFileSync(profilePath, JSON.stringify({
      owner_name: 'Sam Example',
      vocabulary: ['Quilt', 'Bottle POS'],
      whisper_corrections: JSON.stringify({ Myles: 'Miles', 'Miles Ukoma': 'Miles Ukaoma' }),
    }))
    process.env.COS_PROFILE_PATH = profilePath
    process.env.COS_DATA_DIR = join(tmpDir, 'data')
    vi.resetModules()
    profile = await import('../lib/profile.js')
    whisper = await import('../lib/whisper-local.js')
    filter = await import('../lib/hallucination-filter.js')
    profile.clearProfileCache()
    whisper.resetDecoderCaches()
    filter.resetVocabEchoCache()
    const { glossaryRouter } = await import('./glossary.js')
    const app = express()
    app.use(express.json())
    app.use('/api', glossaryRouter)
    await new Promise<void>(res => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address()
        if (!addr || typeof addr === 'string') throw new Error('no addr')
        baseUrl = `http://127.0.0.1:${addr.port}`
        res()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>(res => server ? server.close(() => res()) : res())
    server = null
    if (PREV.profile === undefined) delete process.env.COS_PROFILE_PATH; else process.env.COS_PROFILE_PATH = PREV.profile
    if (PREV.data === undefined) delete process.env.COS_DATA_DIR; else process.env.COS_DATA_DIR = PREV.data
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('learns "/pricing" and "/build-and-price" as corrections only, says so, and undo works', async () => {
    const a = await post('/api/transcription-glossary/correction', { heard: 'forward slash pricing', written: '/pricing', source: 'dictation' })
    expect(a.status).toBe(200)
    expect(a.json).toMatchObject({ unchanged: false, correctionOnly: true, entry: { written: '/pricing', addedVocabulary: false } })
    expect(a.json.note).toContain('Saved as a correction')
    expect(a.json.glossary.vocabulary).toEqual(['Quilt', 'Bottle POS'])
    expect(a.json.glossary.corrections['forward slash pricing']).toBe('/pricing')
    const b = await post('/api/transcription-glossary/correction', { heard: 'forward slash build and price', written: '/build-and-price', source: 'dictation' })
    expect(b.json.glossary.vocabulary).toEqual(['Quilt', 'Bottle POS'])
    // A plain word still joins the vocabulary and carries no correction-only flag.
    const c = await post('/api/transcription-glossary/correction', { heard: 'Whisper', written: 'Wispr', source: 'dictation' })
    expect(c.json).not.toHaveProperty('correctionOnly')
    expect(c.json.glossary.vocabulary).toEqual(['Quilt', 'Bottle POS', 'Wispr'])

    const undone = await post('/api/transcription-glossary/correction/undo', { id: b.json.entry.id })
    expect(undone.status).toBe(200)
    expect(undone.json.glossary.corrections).not.toHaveProperty('forward slash build and price')
    expect(undone.json.glossary.vocabulary).toEqual(['Quilt', 'Bottle POS', 'Wispr'])
  })

  it('the decoder prompt never holds the path: not from the vocabulary, not from the rolling context', async () => {
    await post('/api/transcription-glossary/correction', { heard: 'forward slash pricing', written: '/pricing', source: 'dictation' })
    await post('/api/transcription-glossary/correction', { heard: 'forward slash build and price', written: '/build-and-price', source: 'dictation' })
    await post('/api/transcription-glossary/correction', { heard: 'sam at example dot com', written: 'sam@example.com', source: 'dictation' })
    const bare = whisper.buildPrompt()
    expect(bare).toContain('Quilt')
    // The context the live path primes with is CORRECTED text, so it holds the forms.
    const context = whisper.applyCorrections('We track demo, forward slash pricing, forward slash build and price, and mail sam at example dot com.')
    expect(context).toBe('We track demo, /pricing, /build-and-price, and mail sam@example.com.')
    const primed = whisper.buildPrompt(context)
    for (const prompt of [bare, primed]) {
      expect(prompt).not.toContain('/pricing')
      expect(prompt).not.toContain('/build-and-price')
      expect(prompt).not.toContain('@')
      expect(prompt).not.toMatch(/(?<![\p{L}\p{N}])\/[\p{L}]/u)
    }
    expect(primed).toContain('forward slash pricing, forward slash build and price')
    expect(primed).toContain('sam at example dot com')
    expect(whisper.buildPrompt(context, true)).toBe('')
  })

  it('applies a multi-word key across case, punctuation, hyphens and doubled spaces', async () => {
    await post('/api/transcription-glossary/correction', { heard: 'forward slash pricing', written: '/pricing', source: 'dictation' })
    await post('/api/transcription-glossary/correction', { heard: 'forward slash build', written: '/build', source: 'manual' })
    await post('/api/transcription-glossary/correction', { heard: 'forward slash build and price', written: '/build-and-price', source: 'dictation' })
    await post('/api/transcription-glossary/correction', { heard: 'price tag', written: '$&price', source: 'manual' })
    expect(whisper.applyCorrections('demo, Forward slash pricing, forward-slash build and price, all of which'))
      .toBe('demo, /pricing, /build-and-price, all of which')
    expect(whisper.applyCorrections('FORWARD SLASH PRICING.')).toBe('/pricing.')
    expect(whisper.applyCorrections('see forward  slash\tpricing; then')).toBe('see /pricing; then')
    expect(whisper.applyCorrections('"forward slash pricing"')).toBe('"/pricing"')
    // The shorter key added FIRST still loses to the longer phrase that contains it.
    expect(whisper.applyCorrections('go to forward slash build and price now')).toBe('go to /build-and-price now')
    expect(whisper.applyCorrections('go to forward slash build now')).toBe('go to /build now')
    // A key inside a longer word is not a match.
    expect(whisper.applyCorrections('forward slash pricingly')).toBe('forward slash pricingly')
    // A written form is literal: "$&" is not a replacement pattern.
    expect(whisper.applyCorrections('the price tag')).toBe('the $&price')
    // A chain the profile relies on keeps its order ("Myles" first, then "Miles Ukoma").
    expect(whisper.applyCorrections('Myles Ukoma said hi')).toBe('Miles Ukaoma said hi')
  })

  it('a chunk of just the spoken path is speech, not a prompt echo', async () => {
    await post('/api/transcription-glossary/correction', { heard: 'forward slash pricing', written: '/pricing', source: 'dictation' })
    filter.resetVocabEchoCache()
    expect(filter.isVocabEchoOnly('Forward slash pricing.')).toBe(false)
    expect(filter.isVocabEchoOnly('/pricing')).toBe(false)
    // A real vocabulary echo is still caught.
    expect(filter.isVocabEchoOnly('Bottle POS.')).toBe(true)
  })
})

describe('correctionOrder', () => {
  it('keeps profile order except that a containing key goes first', async () => {
    const { correctionOrder } = await import('../lib/whisper-local.js')
    expect(correctionOrder({ a: '1', 'forward slash build': '/build', 'x y': '2', 'forward slash build and price': '/b' }).map(([k]) => k))
      .toEqual(['a', 'forward slash build and price', 'forward slash build', 'x y'])
    expect(correctionOrder({ Myles: 'Miles', 'Miles Ukoma': 'Miles Ukaoma' }).map(([k]) => k)).toEqual(['Myles', 'Miles Ukoma'])
    // Word-bounded: "build" is not inside "rebuild".
    expect(correctionOrder({ build: 'B', rebuild: 'R' }).map(([k]) => k)).toEqual(['build', 'rebuild'])
  })
})
