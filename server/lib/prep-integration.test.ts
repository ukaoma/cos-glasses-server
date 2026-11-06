// 6.99.19 Prep, the whole chain on real stores: the real PrepRuntime with a real PrepStore, a real MeetingAskStore and
// a real MediaStore, each in a temp dir. Only the query-job coordinator is faked (no provider, no mic).
//
// The meeting is made known exactly the way the unknown_session check reads it in production (prep-runtime.ts
// knownCapture, through meeting-ask-transcript-sources.ts): an active-session file at
// dataPath('active-sessions')/<sessionId>.json, which transcriptSources.activeFile reads. dataPath is the per-run temp
// data dir vitest.config.ts sets (COS_DATA_DIR), never ~/.cos-glasses. knownSession is NOT injected here.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrepRuntime } from './prep-runtime.js'
import { PrepStore } from './prep-store.js'
import { MeetingAskStore } from './meeting-ask-store.js'
import { MediaStore } from './media-store.js'
import { dataPath } from './data-dir.js'
import { prepAdoptedFileId, prepSteerFileId } from '../../shared/prep.js'
import type { QueryJobSnapshot } from './query-job-types.js'

/** A one-page PDF whose text layer says `text` (the same builder drop-attachments.test.ts uses). */
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

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const SESSION = `meeting_prep_integration_${Date.now()}`
let root = ''
const activeFile = () => join(dataPath('active-sessions'), `${SESSION}.json`)

beforeAll(() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }) } catch {
    // Without the real decoder the document half proves nothing, so fail rather than pass.
    throw new Error('prep-integration needs pdftotext on PATH')
  }
  root = mkdtempSync(join(tmpdir(), 'prep-integration-'))
  mkdirSync(dataPath('active-sessions'), { recursive: true })
  writeFileSync(activeFile(), JSON.stringify({ sessionId: SESSION, startTime: Date.now(), chunks: [] }))
})
afterAll(() => {
  rmSync(activeFile(), { force: true })
  rmSync(root, { recursive: true, force: true })
})

describe('Prep end to end on real stores', () => {
  it('draft, notes, two uploaded files, bind into a known meeting, frozen snapshot, original bytes, one run', async () => {
    const media = new MediaStore(join(root, 'media'))
    const prepStore = new PrepStore(join(root, 'prep'))
    const meeting = new MeetingAskStore(join(root, 'meeting-ask'))
    const jobs = new Map<string, QueryJobSnapshot>()
    const prepare = vi.fn(async (raw: unknown) => ({ ...(raw as object), sessionId: 'conv-int' }))
    const submit = vi.fn(async (raw: unknown) => {
      const r = raw as { clientJobId: string; sessionId: string }
      const job = { jobId: 'job-int', clientJobId: r.clientJobId, generation: 1, sessionId: r.sessionId, status: 'accepted' } as unknown as QueryJobSnapshot
      jobs.set(r.clientJobId, job)
      return { created: true, job }
    })
    const runtime = new PrepRuntime({
      store: prepStore, meetingFiles: meeting, media: () => media, identity: () => 'srv-int',
      jobs: { prepare, submit, byClient: async id => jobs.get(id) },
    })

    // A file Control dropped on the meeting earlier must survive the bind.
    meeting.putFiles(SESSION, [{ id: 'control_agenda_1', revision: 'r1', name: 'Agenda.txt', status: 'ready', text: 'Item one: renewals' }])

    // 1. Draft and notes.
    const { draft } = await runtime.create({ clientDraftId: globalThis.crypto.randomUUID(), title: 'Pete 1:1', startsAt: '2026-11-06T22:00:00Z' })
    const noted = await runtime.patch(draft.id, { revision: draft.revision, steer: 'Ask about Liquor demos' })

    // 2. Two uploads through the real media store, added with the sha256 of the uploaded bytes.
    const pdfBytes = tinyPdf('Demo count fell twelve percent')
    const txtBytes = Buffer.from('Pricing: Starter is 59 a month.\n')
    const pdf = await media.ingestRichMedia({ bytes: pdfBytes, label: 'Pipeline.pdf', declaredMime: 'application/pdf' })
    const txt = await media.ingestRichMedia({ bytes: txtBytes, label: 'pricing.txt', declaredMime: 'text/plain' })
    const added = await runtime.addFiles(draft.id, { operationId: globalThis.crypto.randomUUID(), revision: noted.revision, media: [{ id: pdf.id, sha256: sha(pdfBytes) }, { id: txt.id, sha256: sha(txtBytes) }] })
    expect(added.files.map(f => [f.name, f.kind, f.status])).toEqual([['Pipeline.pdf', 'document', 'ready'], ['pricing.txt', 'text', 'ready']])
    const [pf, tf] = added.files

    // 3. The meeting is known through the real lookup (the active-session file); an unknown one is refused.
    expect((await runtime.bind(draft.id, { revision: added.revision, sessionId: `${SESSION}_nobody`, surface: 'web' }).catch(e => e)).code).toBe('unknown_session')
    const bound = await runtime.bind(draft.id, { revision: added.revision, sessionId: SESSION, surface: 'web' })

    // 4. The meeting's Meeting Ask files: Prep notes and both files' text with origin prep, the earlier file kept.
    const files = meeting.files(SESSION)
    expect(files.find(f => f.id === 'control_agenda_1')).toMatchObject({ status: 'ready', text: 'Item one: renewals' })
    expect(files.find(f => f.id === prepSteerFileId(draft.id))).toMatchObject({ name: 'Prep notes', status: 'ready', text: 'Ask about Liquor demos', origin: 'prep' })
    const pdfCopy = files.find(f => f.id === prepAdoptedFileId(draft.id, pf.id))!
    expect(pdfCopy).toMatchObject({ name: 'Pipeline.pdf', status: 'ready', origin: 'prep' })
    expect(pdfCopy.text).toContain('Demo count fell twelve percent')
    expect(files.find(f => f.id === prepAdoptedFileId(draft.id, tf.id))).toMatchObject({ name: 'pricing.txt', status: 'ready', text: 'Pricing: Starter is 59 a month.\n', origin: 'prep' })
    expect(files).toHaveLength(4)
    expect(bound.files).toEqual(files)

    // 5. by-session returns the frozen snapshot, unchanged by a later edit.
    const snap = runtime.bySession(SESSION)
    expect(snap).toEqual([expect.objectContaining({ draftId: draft.id, state: 'applied', current: true, draftRevision: added.revision, steer: 'Ask about Liquor demos', files: [
      { id: pf.id, name: 'Pipeline.pdf', revision: pdfCopy.revision, sha256: pf.sha256 },
      { id: tf.id, name: 'pricing.txt', revision: expect.any(String), sha256: tf.sha256 },
    ] })])
    await runtime.patch(draft.id, { revision: prepStore.get(draft.id)!.revision, steer: 'Changed afterwards' })
    expect(runtime.bySession(SESSION)).toEqual(snap)

    // 6. Original bytes come back byte-identical, with the stored sha256 (documents are kept verbatim by /api/media).
    for (const [file, bytes] of [[pf, pdfBytes], [tf, txtBytes]] as const) {
      const original = runtime.readOriginal(draft.id, file.id)
      expect(original.bytes.equals(bytes)).toBe(true)
      expect(sha(original.bytes)).toBe(file.sha256)
      expect(file.sha256).toBe(file.uploadSha256)
    }

    // 7. One run: one job, with the notes and both files' text in its prompt.
    const ran = await runtime.run(draft.id, { clientRequestId: globalThis.crypto.randomUUID(), revision: prepStore.get(draft.id)!.revision })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(ran.run).toMatchObject({ state: 'accepted', jobId: 'job-int', sessionId: 'conv-int' })
    const prompt = String((prepare.mock.calls[0][0] as { query: string }).query)
    expect(prompt).toContain('Changed afterwards')
    expect(prompt).toContain('Demo count fell twelve percent')
    expect(prompt).toContain('Pricing: Starter is 59 a month.')
    expect(prompt.startsWith('Prep: Pete 1:1')).toBe(true)
    media.stopGC()   // never started here; a no-op kept so the store holds no timer
  }, 60_000)
})
