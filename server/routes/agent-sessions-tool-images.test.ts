import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'
import { requireApiToken } from '../lib/api-auth.js'
const toolImageContent = vi.hoisted(() => vi.fn())
const enabled = vi.hoisted(() => ({ value: true }))
vi.mock('../lib/agent-session-output-images.js', () => ({ agentSessionOutputImages: { toolImageContent, content: vi.fn(), context: vi.fn() }, sharedFileHeaders: vi.fn() }))
vi.mock('../lib/session-files-setting.js', () => ({
  sessionFilesSetting: { read: () => ({ enabled: enabled.value, source: 'settings', saved: enabled.value }), set: vi.fn() },
  withoutPreviews: (t: unknown) => t,
}))
import { agentSessionsRouter, logPreviewOutcome, resetPreviewLogThrottle } from './agent-sessions.js'
let server: Server, base: string, tmp: string, root: string
const ID = 'ti_' + 'a'.repeat(64)
const path = '/api/agent-sessions/claude/session/tool-images/' + ID + '/content'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png')])
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cos-tool-image-route-'))
  root = join(tmp, '.cos-glasses', 'data'); mkdirSync(root, { recursive: true })
  const app = express(); app.use('/api', requireApiToken('test-tool-image-token')); app.use('/api', agentSessionsRouter)
  server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const address = server.address(); base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); rmSync(tmp, { recursive: true, force: true }) })
beforeEach(() => { toolImageContent.mockReset(); enabled.value = true })
const request = (p = path, token = true) => fetch(base + p, { headers: token ? { 'X-COS-Token': 'test-tool-image-token' } : {} })

describe('authenticated session tool-image route', () => {
  it('requires auth before anything is resolved', async () => {
    expect((await request(path, false)).status).toBe(401); expect(toolImageContent).not.toHaveBeenCalled()
  })
  it('previews off answers 403 previews_off before any transcript is read', async () => {
    enabled.value = false
    const res = await request()
    expect(res.status).toBe(403); expect(await res.json()).toEqual({ error: 'previews_off' })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(toolImageContent).not.toHaveBeenCalled()
  })
  it('embedded bytes: the sniffed image type, inline, nosniff, no-store, sandbox CSP, same-origin only', async () => {
    toolImageContent.mockResolvedValue({ status: 'ok', bytes: PNG, type: 'image/png' })
    const res = await request()
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(toolImageContent).toHaveBeenCalledWith('claude', 'session', ID)
  })
  it('a path-only Read comes back as the normalized JPEG, through the dot-directory media root', async () => {
    const file = join(root, 'normalized.jpg'); writeFileSync(file, 'JPEG fixture')
    toolImageContent.mockResolvedValue({ status: 'ok', path: file, mime: 'image/jpeg', bytes: 12 })
    const res = await request()
    expect(res.status).toBe(200); expect(await res.text()).toBe('JPEG fixture')
    expect(res.headers.get('content-type')).toContain('image/jpeg')
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
  })
  it('not found 404, too large 413, anything else 503, and an unknown provider never resolves; no path in any answer', async () => {
    toolImageContent.mockResolvedValueOnce({ status: 'not_found' })
    const a = await request(); expect(a.status).toBe(404); expect(await a.json()).toEqual({ error: 'image_not_found' })
    toolImageContent.mockResolvedValueOnce({ status: 'too_large' })
    const b = await request(); expect(b.status).toBe(413); expect(await b.json()).toEqual({ error: 'image_too_large' })
    toolImageContent.mockResolvedValueOnce({ status: 'unavailable' })
    const c = await request(); expect(c.status).toBe(503); expect(await c.json()).toEqual({ error: 'image_unavailable' })
    toolImageContent.mockRejectedValueOnce(new Error('/Users/someone/secret.png exploded'))
    const d = await request(); expect(d.status).toBe(503); expect(await d.text()).not.toContain('/Users/')
    const e = await request(path.replace('/claude/', '/nobody/')); expect(e.status).toBe(404)
    expect(toolImageContent).toHaveBeenCalledTimes(4)
  })
  it('7.0.4 QA: a full reader answers 503 previews_busy with Retry-After, and every refusal is logged by reason, never by path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetPreviewLogThrottle()
    try {
      toolImageContent.mockResolvedValueOnce({ status: 'busy' })
      const a = await request(); expect(a.status).toBe(503); expect(await a.json()).toEqual({ error: 'previews_busy' }); expect(a.headers.get('retry-after')).toBe('2')
      toolImageContent.mockResolvedValueOnce({ status: 'secret' })
      const b = await request(); expect(b.status).toBe(403); expect(await b.json()).toEqual({ error: 'secret_file_denied' })
      toolImageContent.mockResolvedValueOnce({ status: 'too_large' })
      expect((await request()).status).toBe(413)
      toolImageContent.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file or directory, open '/Users/someone/secret.png'"), { code: 'ENOENT' }))
      expect((await request()).status).toBe(503)
      const lines = warn.mock.calls.map(c => c.join(' '))
      for (const reason of ['reason=busy', 'reason=secret_file_denied', 'reason=too_large', 'reason=error_ENOENT']) expect(lines.some(l => l.includes('preview tool_image') && l.includes(reason)), reason).toBe(true)
      expect(lines.join('\n')).not.toContain('/Users/')
    } finally { warn.mockRestore() }
  })
  it('a burst of one reason logs once per 10 seconds, with the count it held back', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetPreviewLogThrottle()
    try {
      for (let i = 0; i < 5; i++) logPreviewOutcome('tool_image', 'busy', 1_000 + i)
      logPreviewOutcome('tool_image', 'busy', 12_000)
      expect(warn.mock.calls.map(c => c.join(' '))).toEqual(['[agent-sessions] preview tool_image refused reason=busy', '[agent-sessions] preview tool_image refused reason=busy (+4 like it)'])
    } finally { warn.mockRestore() }
  })
})
