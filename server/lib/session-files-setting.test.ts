/**
 * The opt-out for images and files sessions make (6.99.35). Miles asked where a person opts in to session files and
 * images showing on the web; until now 6.99.28 images and SendUserFile previews were simply on. The setting is stored
 * like the Today summary switch (a small JSON file in the data folder), default ON; COS_WEB_SESSION_FILES=0 forces it
 * off. Off: both content routes answer 403 previews_off and the reader gets no names, only "previews are off".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { createSessionFilesSetting, sessionFilesSetting, SESSION_FILES_SETTINGS_FILE, withoutPreviews } from './session-files-setting.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks() })
function setting(env: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cos-sf-')); dirs.push(dir)
  const file = join(dir, 'data', SESSION_FILES_SETTINGS_FILE)
  return { file, s: createSessionFilesSetting({ file: () => file, env: () => env }) }
}

describe('the setting', () => {
  it('is on by default, with nothing saved', () => {
    expect(setting().s.read()).toEqual({ enabled: true, source: 'default', saved: null })
  })
  it('the Settings toggle saves it, privately, and it is read back', () => {
    const { s, file } = setting()
    expect(s.set(false)).toEqual({ enabled: false, source: 'settings', saved: false })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: 1, enabled: false })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(s.read()).toEqual({ enabled: false, source: 'settings', saved: false })
    expect(s.set(true).enabled).toBe(true)
  })
  it('COS_WEB_SESSION_FILES=0 (or false, off) forces it off over a saved on; other values change nothing', () => {
    for (const v of ['0', 'false', ' OFF ']) {
      const { s } = setting({ COS_WEB_SESSION_FILES: v }); s.set(true)
      expect(s.read(), v).toEqual({ enabled: false, source: 'env', saved: true })
    }
    for (const v of ['1', 'on', 'yes', '']) {
      const { s } = setting({ COS_WEB_SESSION_FILES: v }); s.set(false)
      expect(s.read(), v).toEqual({ enabled: false, source: 'settings', saved: false })
    }
  })
  // QA 7.0.0 (Codex root-completionist): a saved OFF whose file was damaged read as nothing saved, so previews came back
  // on. Only a file that is not there is first use; a damaged, foreign or unreadable one fails closed.
  it('a damaged or foreign saved file fails closed: off, source damaged, whatever it once said', () => {
    for (const body of ['{not json', '', JSON.stringify({ schema: 2, enabled: false }), JSON.stringify({ schema: 1, enabled: 'no' }), 'null', '[]']) {
      const { s, file } = setting(); s.set(false); writeFileSync(file, body)
      expect(s.read(), JSON.stringify(body)).toEqual({ enabled: false, source: 'damaged', saved: null })
    }
  })
  it('an unreadable saved file (not ENOENT) fails closed too; only a missing file is first use and on', () => {
    const { s, file } = setting(); s.set(false)
    rmSync(file); mkdirSync(file)   // EISDIR: it exists and cannot be read as the setting
    expect(s.read()).toEqual({ enabled: false, source: 'damaged', saved: null })
    rmSync(file, { recursive: true })
    expect(s.read(), 'gone again: first use').toEqual({ enabled: true, source: 'default', saved: null })
  })
  it('damaged, then the Settings toggle saves a good file again and it is read back', () => {
    const { s, file } = setting(); s.set(true); writeFileSync(file, '{oops')
    expect(s.read().source).toBe('damaged')
    expect(s.set(true)).toEqual({ enabled: true, source: 'settings', saved: true })
  })
  it('COS_WEB_SESSION_FILES=0 still says env over a damaged file', () => {
    const { s, file } = setting({ COS_WEB_SESSION_FILES: '0' }); s.set(true); writeFileSync(file, '{oops')
    expect(s.read()).toEqual({ enabled: false, source: 'env', saved: null })
  })
  it('the shared instance stores under the data folder, never in the repo', () => {
    expect(SESSION_FILES_SETTINGS_FILE).toBe('web-session-files-settings.json')
    expect(typeof sessionFilesSetting.read).toBe('function')
  })
})

describe('off: the reader gets one line per message and no names', () => {
  it('drops every image and file descriptor, marks the message, and keeps the words', () => {
    const turns = [
      { role: 'user' as const, text: 'Send it' },
      { role: 'assistant' as const, text: 'Here.', at: 'x', outputImages: [{ id: 'ai_' + 'a'.repeat(64), label: 'secret_plan.png', state: 'available' as const }],
        outputFiles: [{ id: 'af_' + 'b'.repeat(64), name: 'salaries.pdf', kind: 'pdf' as const, type: 'PDF', size: 9, state: 'available' as const }] },
      { role: 'assistant' as const, text: '', outputFiles: [{ id: 'af_' + 'c'.repeat(64), name: 'x.md', kind: 'text' as const, type: 'Markdown', state: 'available' as const }] },
      { role: 'assistant' as const, text: 'Plain.' },
    ]
    const out = withoutPreviews(turns)
    expect(out).toEqual([
      { role: 'user', text: 'Send it' },
      { role: 'assistant', text: 'Here.', at: 'x', previewsOff: true },
      { role: 'assistant', text: '', previewsOff: true },
      { role: 'assistant', text: 'Plain.' },
    ])
    expect(JSON.stringify(out)).not.toMatch(/secret_plan|salaries|x\.md|ai_|af_/)
  })
})

describe('routes', () => {
  async function serve() {
    const { agentSessionsRouter } = await import('../routes/agent-sessions.js')
    const app = express(); app.use(express.json()); app.use('/api', agentSessionsRouter)
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
    return { base, close: () => server.close() }
  }
  it('off: both content routes answer 403 previews_off before reading anything', async () => {
    vi.spyOn(sessionFilesSetting, 'read').mockReturnValue({ enabled: false, source: 'settings', saved: false })
    const mod = await import('./agent-session-output-images.js')
    const img = vi.spyOn(mod.agentSessionOutputImages, 'content'), file = vi.spyOn(mod.agentSessionOutputImages, 'fileContent')
    const s = await serve()
    try {
      for (const p of ['/agent-sessions/claude/s/output-images/ai_' + 'a'.repeat(64) + '/content', '/agent-sessions/claude/s/output-files/af_' + 'a'.repeat(64) + '/content']) {
        const res = await fetch(s.base + p)
        expect(res.status, p).toBe(403)
        expect(await res.json()).toEqual({ error: 'previews_off' })
      }
      expect(img).not.toHaveBeenCalled(); expect(file).not.toHaveBeenCalled()
    } finally { s.close() }
  })
  it('on: the content routes go on to the resolver', async () => {
    vi.spyOn(sessionFilesSetting, 'read').mockReturnValue({ enabled: true, source: 'default', saved: null })
    const mod = await import('./agent-session-output-images.js')
    const file = vi.spyOn(mod.agentSessionOutputImages, 'fileContent').mockResolvedValue({ status: 'not_found' })
    const s = await serve()
    try {
      expect((await fetch(s.base + '/agent-sessions/claude/s/output-files/af_' + 'a'.repeat(64) + '/content')).status).toBe(404)
      expect(file).toHaveBeenCalledTimes(1)
    } finally { s.close() }
  })
  it('GET and POST /api/session-files/settings: read, save, and refuse anything but { enabled: boolean }', async () => {
    const read = vi.spyOn(sessionFilesSetting, 'read').mockReturnValue({ enabled: true, source: 'default', saved: null })
    const set = vi.spyOn(sessionFilesSetting, 'set').mockImplementation(enabled => ({ enabled, source: 'settings', saved: enabled }))
    const s = await serve()
    try {
      expect(await (await fetch(s.base + '/session-files/settings')).json()).toEqual({ enabled: true, source: 'default', saved: null })
      const post = (body: unknown) => fetch(s.base + '/session-files/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const ok = await post({ enabled: false })
      expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ enabled: false, source: 'settings', saved: false })
      expect(set).toHaveBeenCalledWith(false)
      for (const bad of [{}, { enabled: 'no' }, { enabled: true, extra: 1 }, [true]]) expect((await post(bad)).status, JSON.stringify(bad)).toBe(400)
      expect(set).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenCalled()
    } finally { s.close() }
  })
  it('the session detail strips previews when off (the route runs withoutPreviews on the turns it read)', () => {
    const src = readFileSync(new URL('../routes/agent-sessions.ts', import.meta.url), 'utf8')
    expect(src).toContain('if (recentTurns && !sessionFilesSetting.read().enabled) recentTurns = { ...recentTurns, turns: withoutPreviews(recentTurns.turns) }')
  })
})

describe('the switch is documented where the Mac reads switches', () => {
  it('managed-runtime contract and .env.example name COS_WEB_SESSION_FILES', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    expect(contract.optionalEnvironment).toContain('COS_WEB_SESSION_FILES')
    const example = new URL('../../.env.example', import.meta.url)
    expect(existsSync(example)).toBe(true)
    expect(readFileSync(example, 'utf8')).toMatch(/^# COS_WEB_SESSION_FILES=0/m)
  })
})
