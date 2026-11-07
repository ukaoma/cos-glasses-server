import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'
import { requireApiToken } from '../lib/api-auth.js'
const content = vi.hoisted(() => vi.fn())
vi.mock('../lib/agent-session-output-images.js', () => ({ agentSessionOutputImages: { content, context: vi.fn() } }))
import { agentSessionsRouter } from './agent-sessions.js'
let server: Server, base: string, root: string
const path = '/api/agent-sessions/claude/session/output-images/ai_' + 'a'.repeat(64) + '/content'
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cos-preview-route-'))
  const app = express(); app.use('/api', requireApiToken('test-preview-token')); app.use('/api', agentSessionsRouter)
  server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const address = server.address(); base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }) })
beforeEach(() => content.mockReset())
const request = (suffix = '', token = true) => fetch(base + path + suffix, { headers: token ? { 'X-COS-Token': 'test-preview-token' } : {} })
describe('authenticated session output-image route', () => {
  it('requires auth before image resolution', async () => {
    expect((await request('', false)).status).toBe(401); expect(content).not.toHaveBeenCalled()
  })
  it('serves only resolved normalized JPEGs with private caching, through the literal image route', async () => {
    const file = join(root, 'normalized.jpg'); writeFileSync(file, 'JPEG fixture')
    content.mockResolvedValue({ status: 'ok', path: file, mime: 'image/jpeg', bytes: 12 })
    const response = await request('?variant=thumb')
    expect(response.status).toBe(200); expect(await response.text()).toBe('JPEG fixture')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-type')).toContain('image/jpeg')
    expect(content).toHaveBeenCalledWith('claude', 'session', 'ai_' + 'a'.repeat(64), 'thumb')
  })
  it('uses generic unavailable and missing responses and rejects variants', async () => {
    content.mockResolvedValueOnce({ status: 'not_found' })
    const missing = await request(); expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: 'image_not_found' })
    content.mockResolvedValueOnce({ status: 'unavailable' })
    const unavailable = await request(); expect(unavailable.status).toBe(503); expect(await unavailable.json()).toEqual({ error: 'image_unavailable' })
    const invalid = await request('?variant=raw'); expect(invalid.status).toBe(404)
    expect(content).toHaveBeenCalledTimes(2)
  })
})
