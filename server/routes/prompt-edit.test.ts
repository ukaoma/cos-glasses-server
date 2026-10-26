import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { request } from 'node:http'
import type { Server } from 'node:http'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { dataPath } from '../lib/data-dir.js'

// 6.92.0: the prompt-edit counter lives in the data dir; a private one keeps another worker's file out.
const SHARED_DATA_DIR = vi.hoisted(() => {
  const shared = { dataDir: process.env.COS_DATA_DIR, profile: process.env.COS_PROFILE_PATH }
  process.env.COS_DATA_DIR = `${shared.dataDir ?? '/tmp'}/private-edit-${process.pid}-${Math.random().toString(36).slice(2)}`
  // 6.92.0: the profile (vocabulary, corrections) too. Other files write the shared one (a
  // vocabulary term there reached this file's prompts as a known spelling in a 4-worker run).
  process.env.COS_PROFILE_PATH = `${process.env.COS_DATA_DIR}/.cos-profile.json`
  return shared
})
afterAll(() => {
  for (const [key, value] of [['COS_DATA_DIR', SHARED_DATA_DIR.dataDir], ['COS_PROFILE_PATH', SHARED_DATA_DIR.profile]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})

let server: Server | null = null
let baseUrl = ''
const applyPromptEdit = vi.fn()
// 6.92.0: the route writes an audit row; it is captured here, never written to a real audit file.
const logTokenAudit = vi.fn()

vi.mock('../lib/prompt-edit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/prompt-edit.js')>()
  return {
    ...actual,
    applyPromptEdit,
  }
})
vi.mock('../lib/token-audit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/token-audit.js')>()),
  logTokenAudit,
}))

async function startTestServer(): Promise<void> {
  vi.resetModules()
  applyPromptEdit.mockReset()
  logTokenAudit.mockReset()
  const { promptEditRouter } = await import('./prompt-edit.js')
  const app = express()
  app.use(express.json())
  app.use('/api', (req, res, next) => {
    if (req.headers['x-cos-token'] !== 'test-token') return res.status(401).json({ error: 'unauthorized' })
    next()
  })
  app.use('/api', promptEditRouter)
  await new Promise<void>((resolveStart) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (!address || typeof address === 'string') throw new Error('server address unavailable')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolveStart()
    })
  })
}

function httpRequest(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Buffer; headers: Record<string, string | string[] | undefined> }> {
  const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body))
  return new Promise((resolveRequest, reject) => {
    const req = request(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...opts.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const COUNT_FILE = () => dataPath('.prompt_edit_count.json')
const POLISH_COUNT_FILE = () => dataPath('.dictation_autoclean_count.json')
const EDIT_ENV = ['COS_PROMPT_EDIT', 'COS_PROMPT_EDIT_DAILY_CAP']

describe('prompt edit route', () => {
  beforeEach(async () => {
    rmSync(COUNT_FILE(), { force: true })
    for (const key of EDIT_ENV) delete process.env[key]
    await startTestServer()
    // The breaker is module state the route shares with this import: start each test closed.
    ;(await import('../lib/prompt-edit.js')).promptEditBreaker.recordSuccess()
  })

  afterEach(async () => {
    await new Promise<void>((resolveClose) => {
      if (!server) return resolveClose()
      server.close(() => resolveClose())
    })
    server = null
    baseUrl = ''
  })

  it('requires auth through the API wrapper', async () => {
    const res = await httpRequest('POST', '/api/prompt-edit', {
      body: { draftText: 'Original prompt', editInstruction: 'Make it shorter', visibleChunk: 'Original prompt', chunkIndex: 0, chunkCount: 1 },
    })

    expect(res.status).toBe(401)
    expect(applyPromptEdit).not.toHaveBeenCalled()
  })

  it('rejects empty and oversized inputs before applying edits', async () => {
    const empty = await httpRequest('POST', '/api/prompt-edit', {
      headers: { 'X-COS-Token': 'test-token' },
      body: { draftText: '', editInstruction: 'Make it shorter', visibleChunk: '', chunkIndex: 0, chunkCount: 1 },
    })
    expect(empty.status).toBe(400)

    const tooLong = await httpRequest('POST', '/api/prompt-edit', {
      headers: { 'X-COS-Token': 'test-token' },
      body: { draftText: 'x'.repeat(24_001), editInstruction: 'Make it shorter', visibleChunk: '', chunkIndex: 0, chunkCount: 1 },
    })
    expect(tooLong.status).toBe(400)
    expect(applyPromptEdit).not.toHaveBeenCalled()
  })

  it('returns revised text from the no-history edit helper', async () => {
    applyPromptEdit.mockResolvedValueOnce('Revised prompt.')

    const res = await httpRequest('POST', '/api/prompt-edit', {
      headers: { 'X-COS-Token': 'test-token' },
      body: {
        draftText: 'Original prompt with pricing.',
        editInstruction: 'Remove the pricing part.',
        visibleChunk: 'Original prompt with pricing.',
        chunkIndex: 0,
        chunkCount: 1,
      },
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body.toString())).toEqual({ revisedText: 'Revised prompt.' })
    expect(applyPromptEdit).toHaveBeenCalledWith({
      draftText: 'Original prompt with pricing.',
      editInstruction: 'Remove the pricing part.',
      visibleChunk: 'Original prompt with pricing.',
      chunkIndex: 0,
      chunkCount: 1,
    }, expect.any(AbortSignal))
  })

  it('does not abort the edit signal mid-flight on a normally completed request', async () => {
    // Regression for the req.on('close') bug: express.json() drains the request
    // stream before the handler runs, so a `req` 'close' listener fires on the
    // next tick and aborts the in-flight claude spawn (instant 500). A real edit
    // awaits a multi-second spawn, so we delay here to let any spurious 'close'
    // fire while the signal is observed.
    let signalAbortedMidFlight: boolean | null = null
    applyPromptEdit.mockImplementationOnce(async (_input: unknown, signal?: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 30))
      signalAbortedMidFlight = signal?.aborted ?? null
      return 'Revised prompt.'
    })

    const res = await httpRequest('POST', '/api/prompt-edit', {
      headers: { 'X-COS-Token': 'test-token' },
      body: {
        draftText: 'Original prompt with pricing.',
        editInstruction: 'Remove the pricing part.',
        visibleChunk: 'Original prompt with pricing.',
        chunkIndex: 0,
        chunkCount: 1,
      },
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body.toString())).toEqual({ revisedText: 'Revised prompt.' })
    // The signal must stay live until we actually respond — never aborted by a
    // request-stream close.
    expect(signalAbortedMidFlight).toBe(false)
  })

  const BODY = { draftText: 'Original prompt with pricing.', editInstruction: 'Remove the pricing part.', visibleChunk: 'Original prompt with pricing.', chunkIndex: 0, chunkCount: 1 }
  const edit = (body: unknown = BODY) => httpRequest('POST', '/api/prompt-edit', { headers: { 'X-COS-Token': 'test-token' }, body })
  const text = (res: { body: Buffer }) => res.body.toString()

  it('6.92.0: COS_PROMPT_EDIT=0 answers 503 "Edit is off" as text/plain, and never calls the model', async () => {
    process.env.COS_PROMPT_EDIT = '0'
    const res = await httpRequest('POST', '/api/prompt-edit', { headers: { 'X-COS-Token': 'test-token' }, body: BODY })
    expect(res.status).toBe(503)
    expect(text(res)).toBe('Edit is off')
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(applyPromptEdit).not.toHaveBeenCalled()
    process.env.COS_PROMPT_EDIT = 'banana'
    applyPromptEdit.mockResolvedValueOnce('Revised.')
    expect((await edit()).status).toBe(200)
  })

  it('6.92.0: the daily cap (COS_PROMPT_EDIT_DAILY_CAP, default 200) answers 429 "Edit limit reached" in its own counter', async () => {
    process.env.COS_PROMPT_EDIT_DAILY_CAP = '2'
    applyPromptEdit.mockResolvedValue('Revised.')
    expect((await edit()).status).toBe(200)
    expect((await edit()).status).toBe(200)
    const capped = await edit()
    expect([capped.status, text(capped)]).toEqual([429, 'Edit limit reached'])
    expect(applyPromptEdit).toHaveBeenCalledTimes(2)
    expect(JSON.parse(readFileSync(COUNT_FILE(), 'utf8')).count).toBe(2)
    // Never the dictation polish counter.
    expect(existsSync(POLISH_COUNT_FILE())).toBe(false)
    const { promptEditDailyCap } = await import('../lib/prompt-edit.js')
    expect(promptEditDailyCap({})).toBe(200)
    for (const bad of ['0', '-1', '2.5', 'x']) expect(promptEditDailyCap({ COS_PROMPT_EDIT_DAILY_CAP: bad }), bad).toBe(200)
  })

  it('6.92.0: 3 CLI failures open the breaker: 503 "Edit paused" for 10 minutes; a success closes it', async () => {
    applyPromptEdit.mockRejectedValue(new Error('Prompt edit failed'))
    for (let i = 0; i < 2; i++) expect((await edit()).status).toBe(500)
    applyPromptEdit.mockResolvedValueOnce('Revised.')
    expect((await edit()).status).toBe(200)
    for (let i = 0; i < 3; i++) expect((await edit()).status).toBe(500)
    const paused = await edit()
    expect([paused.status, text(paused)]).toEqual([503, 'Edit paused'])
    expect(applyPromptEdit).toHaveBeenCalledTimes(6)
    const { PROMPT_EDIT_BREAKER_FAILURES, PROMPT_EDIT_BREAKER_MS } = await import('../lib/prompt-edit.js')
    expect([PROMPT_EDIT_BREAKER_FAILURES, PROMPT_EDIT_BREAKER_MS]).toEqual([3, 600_000])
  })

  it('6.92.0: a failure answers 500 "Edit failed", never the CLI\'s stdout or stderr', async () => {
    applyPromptEdit.mockRejectedValueOnce(new Error('Prompt edit failed (1)\nstderr: secret draft words\nstdout: more draft words'))
    const res = await edit()
    expect([res.status, text(res)]).toEqual([500, 'Edit failed'])
    expect(text(res)).not.toMatch(/draft|stderr|stdout/)
  })

  it('6.92.0: a client abort is neutral to the breaker and audited as aborted', async () => {
    let started: () => void = () => {}
    applyPromptEdit.mockImplementation(async (_input: unknown, signal: AbortSignal) => {
      started()
      await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('Prompt edit aborted')), { once: true }))
    })
    for (let i = 0; i < 4; i++) {
      const inFlight = new Promise<void>(resolve => { started = resolve })
      const payload = Buffer.from(JSON.stringify(BODY))
      const req = request(`${baseUrl}/api/prompt-edit`, { method: 'POST', headers: { 'X-COS-Token': 'test-token', 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } })
      req.on('error', () => {})
      req.end(payload)
      await inFlight
      req.destroy()
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    applyPromptEdit.mockResolvedValueOnce('Revised.')
    expect((await edit()).status).toBe(200)
    const outcomes = logTokenAudit.mock.calls.map(([row]) => row.promptEditOutcome)
    expect(outcomes).toEqual(['aborted', 'aborted', 'aborted', 'aborted', 'ok'])
  })

  it('6.92.0: one audit row per call that ran, codes and sizes only', async () => {
    applyPromptEdit.mockResolvedValueOnce('Revised prompt.')
    await edit()
    expect(logTokenAudit).toHaveBeenCalledTimes(1)
    const row = logTokenAudit.mock.calls[0][0]
    expect(row).toMatchObject({ source: 'g2-prompt-edit', caller: 'prompt_edit', model: 'sonnet', outputChars: 15, promptEditOutcome: 'ok' })
    expect(JSON.stringify(row)).not.toContain('pricing')
    // A refusal never ran, so it writes no row.
    process.env.COS_PROMPT_EDIT = 'off'
    await edit()
    expect(logTokenAudit).toHaveBeenCalledTimes(1)
  })

  it('6.92.0: every refusal body is 24 characters or fewer', async () => {
    const { PROMPT_EDIT_REFUSALS } = await import('../lib/prompt-edit.js')
    expect(PROMPT_EDIT_REFUSALS).toEqual({
      cap: { status: 429, body: 'Edit limit reached' }, off: { status: 503, body: 'Edit is off' },
      paused: { status: 503, body: 'Edit paused' }, failed: { status: 500, body: 'Edit failed' },
    })
    for (const { body } of Object.values(PROMPT_EDIT_REFUSALS)) expect(body.length).toBeLessThanOrEqual(24)
  })
})
