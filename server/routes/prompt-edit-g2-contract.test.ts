// 6.92.0 (plan r3, A-W0b): G2 6.10.654 shows a prompt-edit refusal as "Edit failed.\n<error>", where
// <error> is its ApiHTTPError message "API <status>: <body>". This test RUNS 654's own code, copied
// verbatim into __fixtures__/g2-6.10.654-prompt-edit.json (ApiHTTPError and applyVoicePromptEdit),
// against the server's real refusals, and checks the footer text and that no undo entry is pushed.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { readFileSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { transformSync } from 'esbuild'
import { dataPath } from '../lib/data-dir.js'

// 6.92.0: the prompt-edit counter lives in the data dir; a private one keeps another worker's file out.
const SHARED_DATA_DIR = vi.hoisted(() => {
  const shared = process.env.COS_DATA_DIR
  process.env.COS_DATA_DIR = `${shared ?? '/tmp'}/private-edit-${process.pid}-${Math.random().toString(36).slice(2)}`
  return shared
})
afterAll(() => { if (SHARED_DATA_DIR === undefined) delete process.env.COS_DATA_DIR; else process.env.COS_DATA_DIR = SHARED_DATA_DIR })

const applyPromptEdit = vi.fn()
vi.mock('../lib/prompt-edit.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/prompt-edit.js')>()), applyPromptEdit }))
vi.mock('../lib/token-audit.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/token-audit.js')>()), logTokenAudit: vi.fn() }))

const FIXTURE = JSON.parse(readFileSync(new URL('../lib/__fixtures__/g2-6.10.654-prompt-edit.json', import.meta.url), 'utf8')) as {
  apiClient: { errorClass: string; bodyRead: string; throw: string }; applyVoicePromptEdit: string
}
const js = (ts: string) => transformSync(ts, { loader: 'ts', format: 'esm' }).code.replace(/^export /gm, '')
const ApiHTTPError = new Function(`${js(FIXTURE.apiClient.errorClass)}; return ApiHTTPError`)() as new (status: number, body: string) => Error

let server: Server | null = null
let baseUrl = ''
const BODY = { draftText: 'Book the room for Dana.', editInstruction: 'Make it Friday.', visibleChunk: 'Book the room for Dana.', chunkIndex: 0, chunkCount: 1 }

/** 654's fetchJSON for this route: a non-OK answer throws ApiHTTPError(status, await res.text()). */
function editVoicePromptDraft(payload: unknown): Promise<{ revisedText: string }> {
  const raw = Buffer.from(JSON.stringify(payload))
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/api/prompt-edit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(raw.length) } }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        if ((res.statusCode ?? 0) >= 400) reject(new ApiHTTPError(res.statusCode ?? 0, body))
        else resolve(JSON.parse(body))
      })
    })
    req.on('error', reject)
    req.end(raw)
  })
}

/** 654's applyVoicePromptEdit, run as written, with its collaborators faked. */
async function runG2Edit(): Promise<{ footer: string | null; undo: string[] }> {
  const state: any = {
    voicePromptSeq: 7, voiceEditBaseText: BODY.draftText, voiceDraftText: BODY.draftText, voiceEditInstructionText: BODY.editInstruction,
    voiceDraftChunks: [BODY.draftText], voiceDraftChunkIndex: 0, voiceEditUndoStack: [] as string[], voicePromptReviewTarget: null,
    activeBridge: null, audioPipeline: null,
  }
  let footer: string | null = null
  const deps = {
    state, editVoicePromptDraft,
    pushVoicePromptEditProcessing: async () => {}, buildVoiceDraftChunks: (t: string) => [t], clearPromptDraftSnapshot: async () => {},
    stopVoicePromptProgress: () => {}, showVoicePromptConfirmation: async () => {}, logEvent: () => {},
    defaultVoicePromptReviewActionIndex: () => 0,
    showVoicePromptReviewActions: async (_bridge: unknown, text: string) => { footer = text },
  }
  const fn = new Function(...Object.keys(deps), `${js(FIXTURE.applyVoicePromptEdit)}; return applyVoicePromptEdit`)(...Object.values(deps))
  await fn(null)
  return { footer, undo: state.voiceEditUndoStack }
}

describe('6.92.0 G2 6.10.654 prompt-edit footer contract', () => {
  beforeEach(async () => {
    vi.resetModules()
    applyPromptEdit.mockReset()
    rmSync(dataPath('.prompt_edit_count.json'), { force: true })
    delete process.env.COS_PROMPT_EDIT
    delete process.env.COS_PROMPT_EDIT_DAILY_CAP
    const { promptEditRouter } = await import('./prompt-edit.js')
    ;(await import('../lib/prompt-edit.js')).promptEditBreaker.recordSuccess()
    const app = express()
    app.use(express.json())
    app.use('/api', promptEditRouter)
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('no address')
        baseUrl = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })
  })
  afterEach(async () => {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
    server = null
  })

  it('the fixture is 654\'s format: "API <status>: <body>" from the response text', () => {
    expect(FIXTURE.apiClient.bodyRead).toBe('const body = await res.text()')
    expect(FIXTURE.apiClient.throw).toBe('throw new ApiHTTPError(res.status, body)')
    expect(new ApiHTTPError(429, 'Edit limit reached').message).toBe('API 429: Edit limit reached')
  })

  it.each([
    ['cap', () => { process.env.COS_PROMPT_EDIT_DAILY_CAP = '1'; applyPromptEdit.mockResolvedValue('Book the room for Dana on Friday.') }, 'Edit failed.\nAPI 429: Edit limit reached', 1],
    ['switch', () => { process.env.COS_PROMPT_EDIT = '0' }, 'Edit failed.\nAPI 503: Edit is off', 0],
    ['failure', () => { applyPromptEdit.mockRejectedValue(new Error('Prompt edit failed\nstderr: draft words')) }, 'Edit failed.\nAPI 500: Edit failed', 0],
  ])('%s: the lens footer is 40 characters or fewer and no undo entry is pushed', async (_name, arrange, footer, warmups) => {
    arrange()
    for (let i = 0; i < (warmups as number); i++) expect((await runG2Edit()).undo).toHaveLength(1)
    const result = await runG2Edit()
    expect(result.footer).toBe(footer)
    expect(result.footer!.length).toBeLessThanOrEqual(40)
    expect(result.undo).toEqual([])
  })

  it('breaker open: "Edit failed.\\nAPI 503: Edit paused", and no undo entry', async () => {
    applyPromptEdit.mockRejectedValue(new Error('Prompt edit failed'))
    for (let i = 0; i < 3; i++) await runG2Edit()
    const result = await runG2Edit()
    expect(result.footer).toBe('Edit failed.\nAPI 503: Edit paused')
    expect(result.undo).toEqual([])
    expect(applyPromptEdit).toHaveBeenCalledTimes(3)
  })
})
