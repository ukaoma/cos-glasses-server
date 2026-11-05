/**
 * Canary 12 (6.99.12, Even app parity on COS Control Web), the canary 11 shape with attachments and Reply. With a message
 * era ACTIVE, through the REAL media store and routes (POST /api/media and POST /api/media/file behind their own body
 * parsers, as index.ts mounts them), the REAL attachment resolution, job runtime, coordinator, store, conversation cache,
 * Messages routes and message counter. Only the model router and the display bus are faked, so nothing reaches a
 * provider (the fake records what the model was handed).
 *
 * The requests are the web's own, read out of panes/cos-chat.js: the photo upload body, the file upload headers and the
 * Ask body. A web Ask with a photo and a PDF is admitted, its answer turn carries both attachment refs, the message
 * number moves by exactly one, and a Reply (the turn's sessionId) continues the same conversation.
 */
import express from 'express'
import type { Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ callModelStreaming: vi.fn(), emitDisplay: vi.fn(), seen: [] as Array<{ query: string; sessionId: string; images: unknown }> }))
vi.mock('./model-router.js', () => ({
  callModelStreaming: mocks.callModelStreaming,
  acquireModelSessionRunLock: vi.fn(async () => () => {}),
}))
vi.mock('./display-bus.js', () => ({ emitDisplay: mocks.emitDisplay, getDisplayBusStats: () => ({}) }))

const ANSWER = 'The photo shows the endcap; the PDF says it ships Friday.'
async function scriptedRun(query: string, sessionId: string, callbacks: Record<string, (...args: any[]) => any>, ...rest: any[]): Promise<string> {
  // callModelStreaming(query, sessionId, callbacks, model, imageInputs, ...): what the runtime resolved from attachmentIds.
  mocks.seen.push({ query, sessionId, images: rest[1] })
  await callbacks.onStart?.('opus', sessionId, undefined, { claudeRunId: 'run-' + mocks.seen.length })
  callbacks.onChunk?.(ANSWER)
  await callbacks.onAnswerReady?.(ANSWER)
  await callbacks.onDone?.(ANSWER, 'opus', 'cli-1', { claudeRunId: 'run-' + mocks.seen.length })
  return sessionId
}

/** A small, valid one-page PDF with a line of text (xref offsets computed, so pdftotext reads it cleanly). */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

let root = ''
const cleanup: Array<() => void | Promise<void>> = []
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.seen.length = 0
  root = await mkdtemp(join(tmpdir(), 'cos-canary12-'))
  process.env.COS_DATA_DIR = root
  process.env.COS_DURABLE_QUERY_JOBS = '1'
  process.env.COS_QUERY_JOB_DIR = root
  mocks.callModelStreaming.mockImplementation(scriptedRun)
})
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  delete process.env.COS_DURABLE_QUERY_JOBS
  delete process.env.COS_QUERY_JOB_DIR
  delete process.env.COS_DATA_DIR
  await rm(root, { recursive: true, force: true })
  vi.resetModules()
})

const WEB = readFileSync(new URL('../web-control/panes/cos-chat.js', import.meta.url), 'utf8')
/** The photo upload body as startUpload builds it. */
function webPhotoBody(data: string, name: string, at: string): Record<string, unknown> {
  const literal = /var body = JSON\.stringify\((\{ images: [^;]*\})\);/.exec(WEB)?.[1]
  expect(literal, 'startUpload builds the photo body as `var body = JSON.stringify({ images: ... });`').toBeTruthy()
  // eslint-disable-next-line no-new-func
  return new Function('data', 't', 'at', `return ${literal};`)(data, { name }, at)
}
/** The document upload headers as startUpload builds them (X-COS-Web is set by uploadRequest itself). */
function webFileHeaders(name: string, mime: string, at: string): Record<string, string> {
  const literal = /uploadRequest\('\/api\/media\/file', t\.file, (\{[\s\S]*?\}), function/.exec(WEB)?.[1]
  expect(literal, 'startUpload posts the file with a headers literal').toBeTruthy()
  expect(WEB).toContain("xhr.setRequestHeader('X-COS-Web', '1');")
  // eslint-disable-next-line no-new-func
  return { 'X-COS-Web': '1', ...new Function('t', 'at', `return ${literal};`)({ name, mime }, at) }
}
/** The Ask body as submitAsk builds it, with its attachment and session lines. */
function webAskBody(text: string, opts: { attachmentIds?: string[]; sessionId?: string }): Record<string, unknown> {
  const fn = WEB.slice(WEB.indexOf('function submitAsk('), WEB.indexOf('var admit ='))
  const literal = /var body = (\{[^;]*\});/.exec(fn)?.[1]
  expect(literal).toBeTruthy()
  // eslint-disable-next-line no-new-func
  const body = new Function('a', 'text', `return ${literal};`)({ cid: randomUUID() }, text) as Record<string, unknown>
  expect(fn).toContain('if (opts.sessionId) body.sessionId = opts.sessionId;')
  expect(fn).toContain('if (opts.attachmentIds && opts.attachmentIds.length) body.attachmentIds = opts.attachmentIds.slice(0, MAX_ATTS);')
  if (opts.sessionId) body.sessionId = opts.sessionId
  if (opts.attachmentIds?.length) body.attachmentIds = opts.attachmentIds.slice(0, 5)
  return body
}

describe('canary 12: a web Ask with a photo and a PDF, then a Reply, with a message era active', () => {
  it('admits it, the answer turn carries both refs, the number moves by exactly one, and Reply continues the conversation', async () => {
    let jpeg: Buffer
    try {
      jpeg = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=1024x768', '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', '-'], { maxBuffer: 8 << 20 })
      execFileSync('pdftotext', ['-v'], { stdio: 'ignore' })
    } catch {
      // The canary needs the real decoders the Mac has; without them it proves nothing, so it says so instead of passing.
      throw new Error('canary 12 needs ffmpeg and pdftotext on PATH')
    }
    writeFileSync(join(root, 'message-era.json'), JSON.stringify({ v: 1, era: 'era-canary-12', startedAt: Date.now() }))

    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()
    cleanup.push(() => runtime.shutdownQueryJobRuntime('test_shutdown'))
    const { MediaStore, _setMediaStoreForTests } = await import('./media-store.js')
    const prev = _setMediaStoreForTests(new MediaStore(join(root, 'media')))
    cleanup.push(() => { _setMediaStoreForTests(prev) })
    const { mediaRouter, mediaBodyParser, mediaBinaryBodyParser } = await import('../routes/media.js')
    const { createQueryJobsRouter } = await import('../routes/query-jobs.js')
    const { sessionsRouter } = await import('../routes/sessions.js')
    const { messageRefRouter } = await import('../routes/message-ref.js')

    const app = express()
    app.use('/api/media/file', mediaBinaryBodyParser)
    app.use('/api/media', mediaBodyParser)
    app.use(express.json({ limit: '10mb' }))
    app.use('/api', mediaRouter)
    app.use('/api', createQueryJobsRouter(runtime.queryJobCoordinator, { enabled: () => true, prepareAdmission: runtime.preparePublicDurableQueryAdmission }))
    app.use('/api', sessionsRouter); app.use('/api', messageRefRouter)
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    cleanup.push(() => new Promise<void>(r => server.close(() => r())))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
    const getJson = (p: string) => fetch(base + p).then(r => r.json() as Promise<any>)
    const postJson = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json() as any }))
    const counter = async () => (await getJson('/message-counter')).max as number
    const rows = async () => (await getJson('/sessions/today/all-messages')).messages as Array<Record<string, any>>
    const waitDone = async (jobId: string) => {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        const job = (await getJson(`/query-jobs/${jobId}?generation=1`)).job
        if (job.status === 'completed') return job
        if (job.status === 'failed' || job.status === 'interrupted') throw new Error('job ' + job.status + ': ' + JSON.stringify(job.error))
        await new Promise(r => setTimeout(r, 20))
      }
      throw new Error('job did not finish')
    }
    const at = new Date().toISOString()

    // ── The two uploads, as the page sends them. ──
    const photo = await fetch(base + '/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(webPhotoBody(jpeg.toString('base64'), 'endcap.jpg', at)) })
    const photoBody = await photo.json() as any
    expect(photo.status, JSON.stringify(photoBody)).toBe(200)
    const photoRef = photoBody.attachments[0]
    expect(photoRef).toMatchObject({ kind: 'user_photo' })
    const pdf = tinyPdf('Ships Friday')
    const doc = await fetch(base + '/media/file', { method: 'POST', headers: webFileHeaders('Q3 ship plan.pdf', 'application/pdf', at), body: new Uint8Array(pdf) })
    const docBody = await doc.json() as any
    expect(doc.status, JSON.stringify(docBody)).toBe(200)
    const pdfRef = docBody.attachment
    expect(pdfRef).toMatchObject({ mime: 'application/pdf', label: 'Q3 ship plan.pdf' })

    // ── The Ask: admitted under the era, exactly one number. ──
    const before = { max: await counter(), rows: (await rows()).length }
    const ask = webAskBody('What does the photo show, and when does the plan ship?', { attachmentIds: [photoRef.id, pdfRef.id] })
    expect(ask).toMatchObject({ source: 'web', generation: 1, attachmentIds: [photoRef.id, pdfRef.id] })
    expect(ask).not.toHaveProperty('messageEra')
    const admitted = await postJson('/query-jobs', ask)
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(202)
    expect(admitted.body.job.globalMsgNum).toBe(before.max + 1)
    expect(admitted.body.job.messageEra).toBe('era-canary-12')
    const done = await waitDone(admitted.body.job.jobId)
    expect(done.response).toBe(ANSWER)
    expect(await counter()).toBe(before.max + 1)
    // The model was handed the attachments (the photo as an image, the PDF as its text and page stills).
    expect(mocks.seen).toHaveLength(1)
    const inputs = mocks.seen[0]!.images as Array<Record<string, unknown>>
    expect(Array.isArray(inputs), 'the model got image inputs').toBe(true)
    // At least the photo and one page of the PDF; each input names the attachment it came from.
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(inputs)).toContain(photoRef.id)
    expect(JSON.stringify(inputs)).toContain(pdfRef.id)
    const after = await rows()
    expect(after.length).toBe(before.rows + 1)
    const turn = after.find(m => (m.no ?? m.globalMsgNum) === before.max + 1)!
    // The server marks an attached turn's words exactly as it does the glasses': "[2 Attachments] ...".
    expect(turn).toMatchObject({ query: '[2 Attachments] What does the photo show, and when does the plan ship?', text: ANSWER })
    expect((turn.attachments ?? []).map((a: { id: string }) => a.id).sort()).toEqual([photoRef.id, pdfRef.id].sort())

    // ── Reply from the reader: the turn's sessionId, the same conversation, the next number once. ──
    expect(typeof turn.sessionId).toBe('string')
    const reply = await postJson('/query-jobs', webAskBody('And who signs it off?', { sessionId: turn.sessionId }))
    expect(reply.status, JSON.stringify(reply.body)).toBe(202)
    expect(reply.body.job.sessionId).toBe(turn.sessionId)
    expect(reply.body.job.globalMsgNum).toBe(before.max + 2)
    await waitDone(reply.body.job.jobId)
    expect(await counter()).toBe(before.max + 2)
    expect(mocks.seen[1]!.sessionId).toBe(turn.sessionId)
  }, 30_000)
})
