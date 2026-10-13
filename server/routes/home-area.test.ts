import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmpDir = '', profilePath = '', baseUrl = ''
let server: Server | null = null

async function call(method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/home-area`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

describe('home area route', () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cos-home-area-'))
    profilePath = join(tmpDir, '.cos-profile.json')
    writeFileSync(profilePath, JSON.stringify({ owner_name: 'Miles', vocabulary: ['Quilt Software'] }))
    process.env.COS_PROFILE_PATH = profilePath
    process.env.COS_DATA_DIR = tmpDir
    vi.resetModules()
    const { homeAreaRouter } = await import('./home-area.js')
    const app = express()
    app.use(express.json())
    app.use('/api', homeAreaRouter)
    await new Promise<void>(res => { server = app.listen(0, '127.0.0.1', () => { const a = server!.address(); if (!a || typeof a === 'string') throw new Error('no addr'); baseUrl = `http://127.0.0.1:${a.port}`; res() }) })
  })
  afterEach(async () => {
    await new Promise<void>(res => server ? server.close(() => res()) : res())
    server = null
    delete process.env.COS_PROFILE_PATH
    delete process.env.COS_DATA_DIR
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads empty, sets a city, and keeps every other profile key', async () => {
    expect((await call('GET')).json).toEqual({ homeCity: null, effective: null })
    const put = await call('PUT', { homeCity: '  Denver,   CO ' })
    expect(put.status).toBe(200)
    expect(put.json).toEqual({ homeCity: 'Denver, CO', effective: { text: 'Denver, CO', source: 'profile' } })
    const saved = JSON.parse(readFileSync(profilePath, 'utf8'))
    expect(saved).toEqual({ owner_name: 'Miles', vocabulary: ['Quilt Software'], home_city: 'Denver, CO' })
    expect((await call('GET')).json.homeCity).toBe('Denver, CO')
  })

  it('clearing falls back to the phone area again', async () => {
    writeFileSync(join(tmpDir, 'welcome-weather.json'), JSON.stringify({ city: 'Tulsa', fetchedAt: Date.now() }))
    await call('PUT', { homeCity: 'Denver, CO' })
    for (const clear of ['', null]) {
      const res = await call('PUT', { homeCity: clear })
      expect(res.status).toBe(200)
      expect(res.json).toEqual({ homeCity: null, effective: { text: 'Tulsa', source: 'phone_area' } })
    }
  })

  it('refuses a street address or a non-string, and writes nothing', async () => {
    const before = readFileSync(profilePath, 'utf8')
    for (const bad of ['1200 Main St, Austin TX', 'Austin <script>', 42, ['Austin']]) {
      const res = await call('PUT', { homeCity: bad })
      expect(res.status).toBe(400)
    }
    expect(readFileSync(profilePath, 'utf8')).toBe(before)
  })
})
