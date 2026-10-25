import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Server } from 'node:http'
import { dictationPolishSettingsRouter, INSTRUCTIONS_PLACEHOLDER, LEARNED_STYLE_PLACEHOLDER, learnedStyleCapability, polishOptionsCapability } from './dictation-polish-settings.js'
import {
  buildDictationPolishPrompt, dictationPolishRules, DICTATION_POLISH_SYSTEM_PROMPTS, LEARNED_STYLE_INTRO, LEARNED_STYLE_LIMITS, learnedStyleBlock,
  LITERAL_REGISTER_RULES, USER_PREFERENCES_INTRO, USER_PREFERENCES_PRECEDENCE, V4_CLOSING_RULE, V4_LITERAL_CLOSING_RULE,
} from '../lib/dictation-clean.js'
import { __resetLearnedStyleCacheForTests, LEARNED_STYLE_ALLOWLIST, LEARNED_STYLE_FILE } from '../lib/dictation-learned-style.js'
import { __resetPolishOptionsCacheForTests, POLISH_OPTIONS_FILE } from '../lib/dictation-polish-options.js'
import { requireApiToken } from '../lib/api-auth.js'
import { __resetCustomInstructionsCacheForTests, CUSTOM_INSTRUCTIONS_FILE, customInstructionsHash, readCustomInstructions } from '../lib/dictation-polish-instructions.js'
import { dataPath } from '../lib/data-dir.js'
// 6.91.0: this file writes the learned-style, instructions and options stores. A private data dir
// (under the run's isolated one) keeps a file running in another worker from reading them.
const SHARED_DATA_DIR = vi.hoisted(() => {
  const shared = process.env.COS_DATA_DIR
  process.env.COS_DATA_DIR = `${shared ?? '/tmp'}/private-${process.pid}-${Math.random().toString(36).slice(2)}`
  return shared
})
afterAll(() => { if (SHARED_DATA_DIR === undefined) delete process.env.COS_DATA_DIR; else process.env.COS_DATA_DIR = SHARED_DATA_DIR })

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
afterEach(() => {
  rmSync(file(), { force: true }); rmSync(dataPath(LEARNED_STYLE_FILE), { force: true }); rmSync(dataPath(POLISH_OPTIONS_FILE), { force: true })
  __resetCustomInstructionsCacheForTests(); __resetLearnedStyleCacheForTests(); __resetPolishOptionsCacheForTests()
  vi.unstubAllEnvs(); vi.restoreAllMocks()
})

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
  it('shows the rules in use (v4 by default), the system prompt, and every block as the model sees it', async () => {
    vi.stubEnv('COS_DICTATION_POLISH_PROMPT', '')
    const { status, json } = await call('GET', '/dictation/polish/rules')
    expect(status).toBe(200)
    expect(json).toEqual({
      version: 'v4', defaultVersion: 'v4', rolledBack: false,
      systemPrompt: DICTATION_POLISH_SYSTEM_PROMPTS.v4,
      rules: dictationPolishRules('v4').join('\n'),
      userBlock: [...USER_PREFERENCES_INTRO, '<user-style-preferences>', INSTRUCTIONS_PLACEHOLDER, '</user-style-preferences>', USER_PREFERENCES_PRECEDENCE].join('\n'),
      maxChars: 1000,
      learnedStyleBlock: '',
      learnedStyleFrame: [LEARNED_STYLE_INTRO, '<learned-style>', LEARNED_STYLE_PLACEHOLDER, '</learned-style>', LEARNED_STYLE_LIMITS].join('\n'),
      // The literal register is opt-in (COS_DICTATION_REGISTERS=1): off, the model sees no register block.
      registerBlocks: {},
      registersEnabled: false,
      closingRules: { default: V4_CLOSING_RULE, literal: V4_LITERAL_CLOSING_RULE },
      // 6.91.0 option C: v4 on Sonnet only, and the style and register where they were canaried.
      promptByModel: { haiku: 'v3', sonnet: 'v4', 'luna-5.6-fast': 'v3' },
      rulesByPrompt: { v3: dictationPolishRules('v3').join('\n'), v4: dictationPolishRules('v4').join('\n') },
      stylePairs: [{ model: 'sonnet', prompt: 'v4' }],
    })
    expect(json.rules).toContain('Never invent a link')
    // One model's view: Haiku gets v3, no learned style and no register.
    const haiku = (await call('GET', '/dictation/polish/rules?model=haiku')).json
    expect(haiku).toMatchObject({ model: 'haiku', version: 'v3', rolledBack: false, rules: dictationPolishRules('v3').join('\n'), registerBlocks: {}, closingRules: {}, learnedStyleBlock: '' })
    expect((await call('GET', '/dictation/polish/rules?model=sonnet')).json).toMatchObject({ model: 'sonnet', version: 'v4', registerBlocks: {}, registersEnabled: false })
    vi.stubEnv('COS_DICTATION_REGISTERS', '1')
    expect((await call('GET', '/dictation/polish/rules?model=sonnet')).json).toMatchObject({ registerBlocks: { literal: LITERAL_REGISTER_RULES.join('\n') }, registersEnabled: true })
    // 6.91.0: the saved rules show exactly as the prompt carries them.
    await call('PUT', '/dictation/learned-style', { rules: [{ id: 'drop-honestly', kind: 'drop_phrase', register: 'all', param: 'honestly', count: 2, lastSeen: null }] })
    const withStyle = (await call('GET', '/dictation/polish/rules')).json
    expect(withStyle.learnedStyleBlock).toBe(learnedStyleBlock('- Drop "honestly" where the speaker used it as filler.').join('\n').trim())
    expect(buildDictationPolishPrompt('x', [], 'v4', '', { learnedStyle: '- Drop "honestly" where the speaker used it as filler.' })).toContain(withStyle.learnedStyleBlock)
  })

  it('says v2 and rolled back under COS_DICTATION_POLISH_PROMPT=v2; v3 keeps the literal block and has no closing line', async () => {
    vi.stubEnv('COS_DICTATION_POLISH_PROMPT', 'v2')
    const { json } = await call('GET', '/dictation/polish/rules')
    expect(json).toMatchObject({ version: 'v2', defaultVersion: 'v4', rolledBack: true, rules: dictationPolishRules('v2').join('\n'), registerBlocks: {}, closingRules: {} })
    expect(json.rules).not.toContain('Never invent a link')
    vi.stubEnv('COS_DICTATION_POLISH_PROMPT', 'v3')
    // v3 on every model: no pair the style and register were canaried on.
    expect((await call('GET', '/dictation/polish/rules')).json).toMatchObject({ version: 'v3', rolledBack: true, registerBlocks: {}, closingRules: {}, stylePairs: [], promptByModel: { haiku: 'v3', sonnet: 'v3', 'luna-5.6-fast': 'v3' } })
    vi.stubEnv('COS_DICTATION_POLISH_PROMPT', '')
    vi.stubEnv('COS_DICTATION_REGISTERS', '1')
    expect((await call('GET', '/dictation/polish/rules')).json.registerBlocks).toEqual({ literal: LITERAL_REGISTER_RULES.join('\n') })
    vi.stubEnv('COS_DICTATION_REGISTERS', '0')
    expect((await call('GET', '/dictation/polish/rules')).json).toMatchObject({ registerBlocks: {}, registersEnabled: false })
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

// ---------------------------------------------------------------------------------------------
// 6.91.0 (plan r2 contract) learned style and polish options. Codes only; synthetic.
const rule = (param: string, id = `drop-${param.replace(/\s+/g, '-')}`) => ({ id, kind: 'drop_phrase', register: 'all', param, count: 2, lastSeen: '2026-10-24T22:00:00.000Z' })
const contractions = { id: 'contractions', kind: 'contractions', register: 'all', param: 'use', count: 2, lastSeen: null }

describe('6.91.0 /api/dictation/learned-style', () => {
  it('GET is empty and on by default, and publishes kinds, the allowlist and the register map', async () => {
    const { status, json } = await call('GET', '/dictation/learned-style')
    expect(status).toBe(200)
    expect(json).toMatchObject({
      enabled: true, rules: [], text: '', hash: '', updatedAt: null, serverEnabled: true,
      kinds: ['drop_phrase', 'contractions'], allowlist: [...LEARNED_STYLE_ALLOWLIST], maxChars: 1500, maxRules: 20,
      registers: { iTerm2: 'literal', Terminal: 'literal', Ghostty: 'literal', Warp: 'literal', WezTerm: 'literal', Alacritty: 'literal', kitty: 'literal' },
      // The map is published either way; the literal register is opt-in.
      registersEnabled: false,
    })
    expect(json.registers).not.toHaveProperty('Claude')
    vi.stubEnv('COS_DICTATION_REGISTERS', '1')
    expect((await call('GET', '/dictation/learned-style')).json).toMatchObject({ registersEnabled: true, registers: { iTerm2: 'literal' } })
  })

  it('PUT saves codes, the server renders text and hash, GET reads it back, DELETE resets', async () => {
    const put = await call('PUT', '/dictation/learned-style', { rules: [rule('honestly'), contractions] })
    expect(put.status).toBe(200)
    expect(put.json.rules.map((r: any) => r.id)).toEqual(['drop-honestly', 'contractions'])
    expect(put.json.text.split('\n')).toEqual(['- Drop "honestly" where the speaker used it as filler.', expect.stringMatching(/^- Use contractions/)])
    expect(put.json.hash).toMatch(/^[0-9a-f]{8}$/)
    expect(put.json.updatedAt).toEqual(expect.any(String))
    expect((await call('GET', '/dictation/learned-style')).json).toEqual(put.json)
    const reset = await call('DELETE', '/dictation/learned-style')
    expect(reset.json).toMatchObject({ enabled: true, rules: [], hash: '' })
    expect(existsSync(dataPath(LEARNED_STYLE_FILE))).toBe(false)
  })

  it('enabled:false keeps the rules; enabled alone toggles without resending them', async () => {
    await call('PUT', '/dictation/learned-style', { rules: [rule('honestly')] })
    const off = await call('PUT', '/dictation/learned-style', { enabled: false })
    expect(off.json).toMatchObject({ enabled: false, rules: [expect.objectContaining({ id: 'drop-honestly' })] })
    expect((await call('PUT', '/dictation/learned-style', { enabled: true })).json.enabled).toBe(true)
  })

  it('server-owned fields are 400; unknown keys are 400; a bad rule is 400 with its index', async () => {
    for (const field of ['text', 'hash', 'updatedAt']) {
      const result = await call('PUT', '/dictation/learned-style', { rules: [], [field]: 'x' })
      expect(result, field).toEqual({ status: 400, json: { error: 'server_owned_field', field } })
    }
    for (const body of [{}, { rules: [], extra: 1 }, ['x'], { enabled: 'yes' }, { rules: [], baseHash: 'XYZ' }]) {
      expect((await call('PUT', '/dictation/learned-style', body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await call('PUT', '/dictation/learned-style', { rules: [rule('honestly'), rule('like')] }))
      .toEqual({ status: 400, json: { error: 'invalid_rule_param', index: 1 } })
    expect(existsSync(dataPath(LEARNED_STYLE_FILE))).toBe(false)
  })

  it('over 20 rules is 413 and saves nothing', async () => {
    const rules = Array.from({ length: 21 }, (_, i) => rule(LEARNED_STYLE_ALLOWLIST[0], `r${i}`))
    expect(await call('PUT', '/dictation/learned-style', { rules })).toEqual({ status: 413, json: { error: 'too_many_rules', max: 20 } })
    expect(existsSync(dataPath(LEARNED_STYLE_FILE))).toBe(false)
  })

  it('baseHash: a match saves, a stale one is 409 with the current hash', async () => {
    const first = await call('PUT', '/dictation/learned-style', { rules: [rule('honestly')], baseHash: '' })
    expect(first.status).toBe(200)
    const stale = await call('PUT', '/dictation/learned-style', { rules: [], baseHash: '00000000' })
    expect(stale).toEqual({ status: 409, json: { error: 'base_hash_mismatch', hash: first.json.hash } })
    expect((await call('PUT', '/dictation/learned-style', { rules: [rule('literally')], baseHash: first.json.hash })).status).toBe(200)
  })

  it('COS_DICTATION_LEARNED_STYLE=0: the routes still answer and say so; the capability says enabled false', async () => {
    vi.stubEnv('COS_DICTATION_LEARNED_STYLE', '0')
    expect((await call('GET', '/dictation/learned-style')).json.serverEnabled).toBe(false)
    expect(learnedStyleCapability()).toEqual({ protocol: 1, maxChars: 1500, maxRules: 20, enabled: false })
    vi.stubEnv('COS_DICTATION_LEARNED_STYLE', '')
    expect(learnedStyleCapability()).toEqual({ protocol: 1, maxChars: 1500, maxRules: 20, enabled: true })
    expect(polishOptionsCapability()).toEqual({ protocol: 1 })
  })
})

describe('6.91.0 /api/dictation/polish/options ("Previous polish")', () => {
  it('default is v4; PUT v3 rolls the prompt back; PUT default restores it and deletes the file', async () => {
    expect((await call('GET', '/dictation/polish/options')).json).toMatchObject({
      promptVersion: 'default', effectiveVersion: 'v4', source: 'default', envOverride: false,
      effectiveByModel: { haiku: 'v3', sonnet: 'v4', 'luna-5.6-fast': 'v3' },
    })
    const v3 = await call('PUT', '/dictation/polish/options', { promptVersion: 'v3' })
    expect(v3.json).toMatchObject({ promptVersion: 'v3', effectiveVersion: 'v3', source: 'option', effectiveByModel: { haiku: 'v3', sonnet: 'v3', 'luna-5.6-fast': 'v3' } })
    expect((await call('GET', '/dictation/polish/rules')).json.version).toBe('v3')
    expect((await call('PUT', '/dictation/polish/options', { promptVersion: 'default' })).json).toMatchObject({ effectiveVersion: 'v4' })
    expect(existsSync(dataPath(POLISH_OPTIONS_FILE))).toBe(false)
  })

  it('the environment wins when it names a version', async () => {
    await call('PUT', '/dictation/polish/options', { promptVersion: 'v3' })
    vi.stubEnv('COS_DICTATION_POLISH_PROMPT', 'v4')
    expect((await call('GET', '/dictation/polish/options')).json).toMatchObject({ promptVersion: 'v3', effectiveVersion: 'v4', source: 'env', envOverride: true })
  })

  it('anything but {promptVersion: "default" | "v3"} is 400', async () => {
    for (const body of [{}, { promptVersion: 'v2' }, { promptVersion: 'v4' }, { promptVersion: 'v3', extra: 1 }]) {
      expect((await call('PUT', '/dictation/polish/options', body)).status, JSON.stringify(body)).toBe(400)
    }
  })
})

describe('6.91.0 C6: every new route needs X-Cos-Token', () => {
  it('401 without the token, 200 with it', async () => {
    const app = express()
    app.use('/api', requireApiToken('fixture-token'))
    app.use(express.json())
    app.use('/api', dictationPolishSettingsRouter)
    const gated: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const port = (gated.address() as any).port
    try {
      for (const [method, path, body] of [
        ['GET', '/dictation/learned-style', undefined], ['PUT', '/dictation/learned-style', { rules: [] }], ['DELETE', '/dictation/learned-style', undefined],
        ['GET', '/dictation/polish/options', undefined], ['PUT', '/dictation/polish/options', { promptVersion: 'default' }],
      ] as const) {
        const init = (token?: string) => ({ method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Cos-Token': token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
        expect((await fetch(`http://127.0.0.1:${port}/api${path}`, init())).status, `${method} ${path} no token`).toBe(401)
        expect((await fetch(`http://127.0.0.1:${port}/api${path}`, init('wrong'))).status, `${method} ${path} wrong token`).toBe(401)
        expect((await fetch(`http://127.0.0.1:${port}/api${path}`, init('fixture-token'))).status, `${method} ${path} token`).toBe(200)
      }
    } finally {
      await new Promise<void>(resolve => gated.close(() => resolve()))
    }
  })
})
