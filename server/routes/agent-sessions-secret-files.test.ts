/**
 * 7.0.4 S2: every local-file route answers 403 `secret_file_denied` for a file whose name says it may hold secrets.
 * The token gate and the previews switch still answer first, before anything is resolved.
 */
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { requireApiToken } from '../lib/api-auth.js'
const content = vi.hoisted(() => vi.fn())
const fileContent = vi.hoisted(() => vi.fn())
const toolImageContent = vi.hoisted(() => vi.fn())
const enabled = vi.hoisted(() => ({ value: true }))
vi.mock('../lib/agent-session-output-images.js', () => ({ agentSessionOutputImages: { content, fileContent, toolImageContent, context: vi.fn() }, sharedFileHeaders: vi.fn(() => ({})) }))
vi.mock('../lib/session-files-setting.js', () => ({
  sessionFilesSetting: { read: () => ({ enabled: enabled.value, source: 'settings', saved: enabled.value }), set: vi.fn() },
  withoutPreviews: (t: unknown) => t,
}))
import { agentSessionsRouter, SECRET_FILE_DENIED } from './agent-sessions.js'

let server: Server, base: string
const ROUTES: Array<[string, string, ReturnType<typeof vi.fn>]> = [
  ['sent and Markdown output images', '/api/agent-sessions/claude/session/output-images/ai_' + 'a'.repeat(64) + '/content', content],
  ['sent output files', '/api/agent-sessions/claude/session/output-files/af_' + 'a'.repeat(64) + '/content', fileContent],
  ['path-backed tool images', '/api/agent-sessions/claude/session/tool-images/ti_' + 'a'.repeat(64) + '/content', toolImageContent],
]
beforeAll(async () => {
  const app = express(); app.use('/api', requireApiToken('test-secret-token')); app.use('/api', agentSessionsRouter)
  server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const address = server.address(); base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})
afterAll(async () => { await new Promise<void>(r => server.close(() => r())) })
beforeEach(() => { for (const [, , fn] of ROUTES) fn.mockReset(); enabled.value = true })
const request = (path: string, token = true) => fetch(base + path, { headers: token ? { 'X-COS-Token': 'test-secret-token' } : {} })

describe('the secret_file_denied answer', () => {
  it('is the fixed code', () => { expect(SECRET_FILE_DENIED).toBe('secret_file_denied') })
  for (const [label, path, fn] of ROUTES) {
    it(`${label}: a secret answers 403 secret_file_denied, no-store, nosniff, no bytes and no path`, async () => {
      fn.mockResolvedValue({ status: 'secret' })
      const res = await request(path)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'secret_file_denied' })
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(fn).toHaveBeenCalledTimes(1)
    })
    it(`${label}: the token gate answers 401 before anything is resolved`, async () => {
      fn.mockResolvedValue({ status: 'secret' })
      expect((await request(path, false)).status).toBe(401)
      expect(fn).not.toHaveBeenCalled()
    })
    it(`${label}: previews off answers 403 previews_off before anything is resolved`, async () => {
      enabled.value = false; fn.mockResolvedValue({ status: 'secret' })
      const res = await request(path)
      expect(res.status).toBe(403); expect(await res.json()).toEqual({ error: 'previews_off' })
      expect(fn).not.toHaveBeenCalled()
    })
    it(`${label}: not found is still 404, not a secret`, async () => {
      fn.mockResolvedValue({ status: 'not_found' })
      expect((await request(path)).status).toBe(404)
    })
  }
})
