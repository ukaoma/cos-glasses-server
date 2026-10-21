import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Server } from 'node:http'
import { dictationPolishSettingsRouter, INSTRUCTIONS_PLACEHOLDER } from './dictation-polish-settings.js'
import { dictationPolishRules, DICTATION_POLISH_SYSTEM_PROMPTS, USER_PREFERENCES_INTRO, USER_PREFERENCES_PRECEDENCE } from '../lib/dictation-clean.js'
import { __resetCustomInstructionsCacheForTests, CUSTOM_INSTRUCTIONS_FILE, customInstructionsHash, readCustomInstructions } from '../lib/dictation-polish-instructions.js'
import { dataPath } from '../lib/data-dir.js'

// 6.85.0 "Your polish instructions" routes. Synthetic text only.
let server: Server
let base = ''
const file = () => dataPath(CUSTOM_INSTRUCTIONS_FILE)

beforeAll(async () => {
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', dictationPolishSettingsRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  base = `http://127.0.0.1:${address.port}`
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
afterEach(() => { rmSync(file(), { force: true }); __resetCustomInstructionsCacheForTests(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/api${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json() as any }
}
const OFF = { customInstructions: '', enabled: false, updatedAt: null, instructionsHash: '', maxChars: 1000, appliesTo: ['message', 'prompt_draft'] }

describe('6.85.0 /api/dictation/polish/instructions', () => {
  it('GET is off by default; PUT saves the sanitized text; GET reads it back; DELETE clears and removes the file', async () => {
    expect(await call('GET', '/dictation/polish/instructions')).toEqual({ status: 200, json: OFF })
    const put = await call('PUT', '/dictation/polish/instructions', { customInstructions: '  Use Oxford commas.\u0000\r\nWrite product names as Bottle POS and IT Retail.  ' })
    const value = 'Use Oxford commas.\nWrite product names as Bottle POS and IT Retail.'
    expect(put.status).toBe(200)
    expect(put.json).toEqual({ ...OFF, customInstructions: value, enabled: true, updatedAt: expect.any(String), instructionsHash: customInstructionsHash(value) })
    expect(readCustomInstructions().customInstructions).toBe(value)
    expect((await call('GET', '/dictation/polish/instructions')).json).toEqual(put.json)
    expect(await call('DELETE', '/dictation/polish/instructions')).toEqual({ status: 200, json: OFF })
    expect(existsSync(file())).toBe(false)
  })

  it('PUT "" (or only whitespace) is Clear', async () => {
    await call('PUT', '/dictation/polish/instructions', { customInstructions: 'Use Oxford commas.' })
    expect(await call('PUT', '/dictation/polish/instructions', { customInstructions: '  \n ' })).toEqual({ status: 200, json: OFF })
    expect(existsSync(file())).toBe(false)
  })

  it('bounds: 1,000 characters saves, 1,001 is 413 with the cap and length, and nothing changes', async () => {
    expect((await call('PUT', '/dictation/polish/instructions', { customInstructions: 'a'.repeat(1000) })).json.customInstructions).toHaveLength(1000)
    const over = await call('PUT', '/dictation/polish/instructions', { customInstructions: 'b'.repeat(1001) })
    expect(over).toEqual({ status: 413, json: { error: 'instructions_too_long', maxChars: 1000, length: 1001 } })
    expect(readCustomInstructions().customInstructions).toBe('a'.repeat(1000))
  })

  it('a body that is not exactly {customInstructions: string} is 400 and saves nothing', async () => {
    for (const body of [{}, { customInstructions: 42 }, { customInstructions: null }, { customInstructions: 'x', extra: 1 }, ['x']]) {
      const result = await call('PUT', '/dictation/polish/instructions', body)
      expect(result.status, JSON.stringify(body)).toBe(400)
      expect(['invalid_body', 'instructions_not_a_string']).toContain(result.json.error)
    }
    expect(existsSync(file())).toBe(false)
  })

  it('never logs the text', async () => {
    const log = vi.spyOn(console, 'log'); const warn = vi.spyOn(console, 'warn'); const error = vi.spyOn(console, 'error')
    await call('PUT', '/dictation/polish/instructions', { customInstructions: 'PRIVATE-WORDS stay out of logs' })
    await call('GET', '/dictation/polish/instructions')
    await call('PUT', '/dictation/polish/instructions', { customInstructions: `PRIVATE-WORDS ${'c'.repeat(1001)}` })
    expect([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat().join(' ')).not.toContain('PRIVATE-WORDS')
  })
})

describe('6.85.0 GET /api/dictation/polish/rules', () => {
  it('shows the rules in use (v3 by default), the system prompt, and the block with a placeholder', async () => {
    vi.stubEnv('COS_DICTATION_POLISH_PROMPT', '')
    const { status, json } = await call('GET', '/dictation/polish/rules')
    expect(status).toBe(200)
    expect(json).toEqual({
      version: 'v3', defaultVersion: 'v3', rolledBack: false,
      systemPrompt: DICTATION_POLISH_SYSTEM_PROMPTS.v3,
      rules: dictationPolishRules('v3').join('\n'),
      userBlock: [...USER_PREFERENCES_INTRO, '<user-style-preferences>', INSTRUCTIONS_PLACEHOLDER, '</user-style-preferences>', USER_PREFERENCES_PRECEDENCE].join('\n'),
      maxChars: 1000,
    })
    expect(json.rules).toContain('Never invent a link')
  })

  it('says v2 and rolled back under COS_DICTATION_POLISH_PROMPT=v2', async () => {
    vi.stubEnv('COS_DICTATION_POLISH_PROMPT', 'v2')
    const { json } = await call('GET', '/dictation/polish/rules')
    expect(json).toMatchObject({ version: 'v2', defaultVersion: 'v3', rolledBack: true, rules: dictationPolishRules('v2').join('\n') })
    expect(json.rules).not.toContain('Never invent a link')
  })

  it('never includes the saved instructions', async () => {
    await call('PUT', '/dictation/polish/instructions', { customInstructions: 'PRIVATE-WORDS' })
    expect(JSON.stringify((await call('GET', '/dictation/polish/rules')).json)).not.toContain('PRIVATE-WORDS')
  })
})

// A source-shape pin: server/index.ts binds ports at import, so no test executes it, and an
// unmounted router answers 404, which a client reads as "older server".
describe('6.85.0 server/index.ts wiring', () => {
  it('mounts the router under /api, after the token gate and the JSON parser', () => {
    const index = readFileSync(resolve(process.cwd(), 'server/index.ts'), 'utf8')
    expect(index).toContain("import { dictationPolishSettingsRouter } from './routes/dictation-polish-settings.js'")
    const mount = index.indexOf("app.use('/api', dictationPolishSettingsRouter)")
    expect(mount).toBeGreaterThan(index.indexOf("app.use('/api', requireApiToken("))
    expect(mount).toBeGreaterThan(index.indexOf("app.use(express.json({ limit: '10mb' }))"))
    expect(index.indexOf("app.use(express.json({ limit: '10mb' }))")).toBeGreaterThan(0)
  })
})
