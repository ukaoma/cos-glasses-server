/**
 * 6.99.13, Drop it with files. Through the REAL media store (real ffmpeg JPEG, a real one-page PDF), the REAL drop
 * service and the REAL /api/drops router; only the bridge writers and Jev are the usual fakes.
 *
 * A drop with a photo and a PDF keeps both, the receipt lists each with an id the chat opens, the files outlive the
 * upload store's expiry (and a restart), and Undo removes them. Refusals say what to do: an expired or unknown upload,
 * a sixth file, files with no words, a file already sent with an Ask.
 */
import express from 'express'
import type { Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MediaStore, RESERVED_TTL_MS, STAGED_TTL_MS } from './media-store.js'
import { mediaDropAttachments } from './drop-attachments.js'
import { DropRouter } from './drop-router.js'
import { DROP_LIMITS, parseDropRecord } from './drop-store.js'
import { DROP_ATTACHMENTS_MAX, dropItCapability } from './drop-settings.js'
import { MAX_ATTACHMENTS_PER_PROMPT } from '../../shared/media-attachment.js'
import { createDropsRouter, lazyDropService, openDropService } from '../routes/drops.js'
import type { DropService } from './drop-service.js'
import { fakeWriters, scriptedDecisionClient } from './__fixtures__/drop-fixtures.js'

/** A small, valid one-page PDF with a line of text (as canary 12 builds it). */
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

let jpeg: Buffer
beforeAll(() => {
  try {
    jpeg = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=320x240', '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', '-'], { maxBuffer: 8 << 20 })
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' })
  } catch {
    // Without the real decoders these tests prove nothing, so they fail instead of passing.
    throw new Error('drop-attachments tests need ffmpeg and pdftotext on PATH')
  }
})

const servers: Server[] = [], cleanup: Array<() => void> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  cleanup.splice(0).reverse().forEach(fn => fn())
})

async function setup(options: { attachments?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drop-files-'))
  const media = new MediaStore(join(root, 'media'))
  const writers = fakeWriters()
  let opened: DropService | null = null
  const service = lazyDropService(() => {
    opened = openDropService(part => join(root, part), {
      router: new DropRouter({ client: scriptedDecisionClient(), enabled: () => true }), writers,
      ...(options.attachments === false ? {} : { attachments: mediaDropAttachments(() => media) }),
    })
    return opened
  })
  cleanup.push(() => { (opened as DropService | null)?.close(); rmSync(root, { recursive: true, force: true }) })
  const app = express(); app.use(express.json({ limit: '1mb' }))
  app.use('/api', createDropsRouter({ enabled: () => true, service }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() as any }
  }
  const photo = (name = 'Endcap.jpg') => media.ingestImage({ bytes: jpeg, kind: 'user_photo', label: name })
  const pdf = (name = 'Q3 plan.pdf') => media.ingestRichMedia({ bytes: tinyPdf('Ships Friday'), label: name, declaredMime: 'application/pdf' })
  const text = (name: string) => media.ingestRichMedia({ bytes: Buffer.from('a note ' + name), label: name, declaredMime: 'text/plain' })
  return { root, media, writers, call, photo, pdf, text }
}
const CARD_WORDS = 'Draft the onboarding email sequence for new liquor stores'

describe('a drop with a photo and a PDF', () => {
  it('files both: the drop keeps their refs, every line lists them, and they open from the media store', async () => {
    const h = await setup()
    const p = await h.photo(), d = await h.pdf()
    const dropId = randomUUID()
    const out = await h.call('POST', '/drops', { dropId, text: CARD_WORDS, source: 'web', attachmentIds: [p.id, d.id] })
    expect(out.status).toBe(200)
    expect(out.body.drop).toMatchObject({ state: 'filed', dest: 'new_card', kind: 'task' })
    expect(out.body.drop.attachments).toEqual([
      { id: p.id, name: 'Endcap.jpg', mime: 'image/jpeg', size: expect.any(Number) },
      { id: d.id, name: 'Q3 plan.pdf', mime: 'application/pdf', size: expect.any(Number) },
    ])
    expect(out.body.drop.attachments.every((a: { size: number }) => a.size > 0)).toBe(true)
    // The card takes words only; the files stay with the drop, and the receipt says where and links each one.
    expect(h.writers.cards.size).toBe(1)
    const [line, receipt] = out.body.items
    expect(line.kind).toBe('drop')
    expect(line.links).toEqual([{ kind: 'file', id: p.id, label: 'Endcap.jpg' }, { kind: 'file', id: d.id, label: 'Q3 plan.pdf' }])
    expect(receipt.kind).toBe('receipt')
    expect(receipt.line).toBe('New card in the Inbox. The 2 files stay here in the COS chat with your words.')
    expect(receipt.links.map((l: { kind: string; id: string }) => `${l.kind}:${l.id}`)).toEqual([expect.stringMatching(/^card:/), `file:${p.id}`, `file:${d.id}`])
    // Pinned to this drop in the media store, and readable through the route the chat opens.
    for (const id of [p.id, d.id]) {
      expect(h.media.getRecord(id)).toMatchObject({ lifecycle: 'associated', dropId })
      expect(h.media.getContent(id, 'phone').status).toBe('ok')
    }
    // History finds the drop by a file's name.
    const found = await h.call('GET', '/drops?q=plan.pdf')
    expect(found.body.drops.map((x: { id: string }) => x.id)).toEqual([dropId])
  })

  it('a replay of the same dropId answers the first result and pins nothing twice', async () => {
    const h = await setup()
    const p = await h.photo()
    const dropId = randomUUID()
    const first = await h.call('POST', '/drops', { dropId, text: CARD_WORDS, source: 'web', attachmentIds: [p.id] })
    const again = await h.call('POST', '/drops', { dropId, text: CARD_WORDS, source: 'web', attachmentIds: [p.id] })
    expect(again.status).toBe(200)
    expect(again.body.replayed).toBe(true)
    expect(again.body.drop.attachments).toEqual(first.body.drop.attachments)
    expect(h.writers.cards.size).toBe(1)
  })

  it('a drop read as a question hands its files to the Ask', async () => {
    const h = await setup()
    const p = await h.photo()
    const out = await h.call('POST', '/drops', { dropId: randomUUID(), text: 'what is on this shelf?', source: 'web', attachmentIds: [p.id] })
    expect(out.body.drop.dest).toBe('ask')
    expect(out.body.next).toEqual({ kind: 'ask', prompt: 'what is on this shelf?', attachmentIds: [p.id] })
    expect(out.body.items[1].line).toBe('The answer lands here when it is ready. The files go with the question. The file stays here in the COS chat with your words.')
  })

  it('Move keeps the files: the new receipt lists them again', async () => {
    const h = await setup()
    const p = await h.photo()
    const dropId = randomUUID()
    await h.call('POST', '/drops', { dropId, text: CARD_WORDS, source: 'web', attachmentIds: [p.id] })
    const moved = await h.call('POST', `/drops/${dropId}/move`, { dest: 'note' })
    expect(moved.status).toBe(200)
    const last = moved.body.items[moved.body.items.length - 1]
    expect(last.links).toEqual([{ kind: 'file', id: p.id, label: 'Endcap.jpg' }])
    expect(h.media.getContent(p.id, 'phone').status).toBe('ok')
  })
})

describe('the files outlive the upload store', () => {
  it('a GC past every upload TTL, and a restart, leave a dropped file readable while an unsent upload expires', async () => {
    const h = await setup()
    const kept = await h.pdf(), unsent = await h.text('scratch.txt')
    await h.call('POST', '/drops', { dropId: randomUUID(), text: CARD_WORDS, source: 'web', attachmentIds: [kept.id] })
    const later = Date.now() + STAGED_TTL_MS + RESERVED_TTL_MS + 86_400_000
    const gc = await h.media.runGC(later)
    // The control: the same pass did expire the upload nobody dropped, so it was a pass that could have taken ours.
    expect(gc.expired).toBe(1)
    expect(h.media.getRecord(unsent.id)?.lifecycle).toBe('expired')
    expect(h.media.getRecord(kept.id)?.lifecycle).toBe('associated')
    expect(h.media.getContent(kept.id, 'phone').status).toBe('ok')
    // The pin is in the index on disk: a restarted store still holds it and still keeps it through a GC.
    const reopened = new MediaStore(join(h.root, 'media'))
    expect(reopened.getRecord(kept.id)).toMatchObject({ lifecycle: 'associated', dropId: expect.any(String) })
    await reopened.runGC(later + 86_400_000)
    expect(reopened.getContent(kept.id, 'phone').status).toBe('ok')
  })
})

describe('Undo removes the files with the drop', () => {
  it('the bytes go, the drop forgets them, and no chat line offers them any more', async () => {
    const h = await setup()
    const p = await h.photo(), d = await h.pdf()
    const dropId = randomUUID()
    await h.call('POST', '/drops', { dropId, text: CARD_WORDS, source: 'web', attachmentIds: [p.id, d.id] })
    const undone = await h.call('POST', `/drops/${dropId}/undo`)
    expect(undone.status).toBe(200)
    expect(undone.body.drop.state).toBe('undone')
    expect(undone.body.drop).not.toHaveProperty('attachments')
    for (const id of [p.id, d.id]) {
      expect(h.media.getRecord(id)?.lifecycle).toBe('deleted')
      expect(h.media.getContent(id, 'phone').status).toBe('not_found')
    }
    expect(undone.body.items.flatMap((i: { links: Array<{ kind: string }> }) => i.links).filter((l: { kind: string }) => l.kind === 'file')).toEqual([])
    const last = undone.body.items[undone.body.items.length - 1]
    expect(last).toMatchObject({ title: 'Undone', line: 'The Work card is archived. Your words stay here. The 2 files are removed.' })
    // The card went too (Undo as before).
    expect([...h.writers.cards.values()][0].archived).toBe(true)
  })

  it('a refused Undo (the card was edited) keeps the files', async () => {
    const h = await setup()
    const p = await h.photo()
    const dropId = randomUUID()
    await h.call('POST', '/drops', { dropId, text: CARD_WORDS, source: 'web', attachmentIds: [p.id] })
    for (const c of h.writers.cards.values()) c.touched = true
    const out = await h.call('POST', `/drops/${dropId}/undo`)
    expect(out.status).toBe(409)
    expect(h.media.getContent(p.id, 'phone').status).toBe('ok')
  })

  it('Undo removes only what this drop pinned: a file an Ask since sent with a message stays', async () => {
    const h = await setup()
    const p = await h.photo()
    const dropId = randomUUID()
    await h.call('POST', '/drops', { dropId, text: CARD_WORDS, source: 'web', attachmentIds: [p.id] })
    // Another drop's Undo never takes this drop's file.
    expect(await h.media.unpinDrop([p.id], randomUUID())).toBe(0)
    expect(h.media.getContent(p.id, 'phone').status).toBe('ok')
    // Once an Ask has sent it with a message (globalMsgNum), not even this drop's Undo takes it.
    await h.media.associate([p.id], { sessionId: 's-1', globalMsgNum: 7 })
    expect(await h.media.unpinDrop([p.id], dropId)).toBe(0)
    expect(h.media.getContent(p.id, 'phone').status).toBe('ok')
  })

  it('pinning is idempotent for the same drop and refused for another', async () => {
    const h = await setup()
    const p = await h.photo()
    const dropId = randomUUID()
    const first = await h.media.pinForDrop([p.id], dropId)
    expect(await h.media.pinForDrop([p.id], dropId)).toEqual(first)
    await expect(h.media.pinForDrop([p.id], randomUUID())).rejects.toMatchObject({ code: 'media_conflict' })
    expect(await h.media.unpinDrop([p.id], dropId)).toBe(1)
    expect(await h.media.unpinDrop([p.id], dropId)).toBe(0)
  })
})

describe('refusals say what happened and what to do, and save nothing', () => {
  it('an expired upload is refused with 410, and no drop is saved', async () => {
    const h = await setup()
    const p = await h.photo()
    await h.media.runGC(Date.now() + STAGED_TTL_MS + 60_000)
    const dropId = randomUUID()
    const out = await h.call('POST', '/drops', { dropId, text: CARD_WORDS, source: 'web', attachmentIds: [p.id] })
    expect(out.status).toBe(410)
    expect(out.body.error).toEqual({ code: 'attachment_expired', message: 'A file expired before it was dropped (uploads wait 4 hours). Add it again, then Drop.' })
    expect((await h.call('GET', `/drops/${dropId}`)).status).toBe(404)
    expect(h.writers.cards.size).toBe(0)
  })

  it('an id this Mac never gave out is 404, and one good file with it is not pinned (all or nothing)', async () => {
    const h = await setup()
    const good = await h.photo()
    const out = await h.call('POST', '/drops', { dropId: randomUUID(), text: CARD_WORDS, source: 'web', attachmentIds: [good.id, 'm_' + 'f'.repeat(24)] })
    expect(out.status).toBe(404)
    expect(out.body.error).toEqual({ code: 'attachment_not_found', message: 'A file is no longer on this Mac. Add it again, then Drop.' })
    expect(h.media.getRecord(good.id)?.lifecycle).toBe('staged')
  })

  it('six files are refused before anything is pinned; five are taken', async () => {
    const h = await setup()
    const six = await Promise.all([1, 2, 3, 4, 5, 6].map(n => h.text(`n${n}.txt`)))
    const out = await h.call('POST', '/drops', { dropId: randomUUID(), text: CARD_WORDS, source: 'web', attachmentIds: six.map(r => r.id) })
    expect(out.status).toBe(400)
    expect(out.body.error).toEqual({ code: 'too_many_attachments', message: 'Up to 5 files per drop. Remove one, then Drop.' })
    expect(six.every(r => h.media.getRecord(r.id)?.lifecycle === 'staged')).toBe(true)
    const five = await h.call('POST', '/drops', { dropId: randomUUID(), text: CARD_WORDS, source: 'web', attachmentIds: six.slice(0, 5).map(r => r.id) })
    expect(five.status).toBe(200)
    expect(five.body.drop.attachments).toHaveLength(5)
  })

  it('files with no words are refused: a drop is filed by its words', async () => {
    const h = await setup()
    const p = await h.photo()
    for (const text of ['', '   ', undefined]) {
      const out = await h.call('POST', '/drops', { dropId: randomUUID(), ...(text === undefined ? {} : { text }), source: 'web', attachmentIds: [p.id] })
      expect(out.status).toBe(400)
      expect(out.body.error).toEqual({ code: 'words_needed', message: 'Add a few words with the files so COS knows where they go.' })
    }
    expect(h.media.getRecord(p.id)?.lifecycle).toBe('staged')
  })

  it('a file already queued with an Ask, or held by another drop, is 409', async () => {
    const h = await setup()
    const queued = await h.photo('a.jpg'), held = await h.photo('b.jpg')
    await h.media.reserve([queued.id], { clientQueueItemId: randomUUID() })
    const a = await h.call('POST', '/drops', { dropId: randomUUID(), text: CARD_WORDS, source: 'web', attachmentIds: [queued.id] })
    expect(a.status).toBe(409)
    expect(a.body.error.code).toBe('attachment_in_use')
    await h.call('POST', '/drops', { dropId: randomUUID(), text: CARD_WORDS, source: 'web', attachmentIds: [held.id] })
    const b = await h.call('POST', '/drops', { dropId: randomUUID(), text: 'Book the dentist for the kids', source: 'web', attachmentIds: [held.id] })
    expect(b.status).toBe(409)
    expect(b.body.error).toEqual({ code: 'attachment_in_use', message: 'A file was already sent with something else. Add it again to drop it.' })
  })

  it('a malformed id is 400, and a server without a file store refuses files plainly', async () => {
    const h = await setup()
    const bad = await h.call('POST', '/drops', { dropId: randomUUID(), text: CARD_WORDS, source: 'web', attachmentIds: ['../../etc/passwd'] })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('invalid_attachment')
    const old = await setup({ attachments: false })
    const p = await old.photo()
    const out = await old.call('POST', '/drops', { dropId: randomUUID(), text: CARD_WORDS, source: 'web', attachmentIds: [p.id] })
    expect(out.status).toBe(400)
    expect(out.body.error.code).toBe('attachments_unsupported')
  })
})

describe('the contract', () => {
  it('advertises dropIt.attachments, equal to the Ask\'s own cap and the store\'s limit', async () => {
    expect(dropItCapability({}).attachments).toBe(5)
    expect(DROP_ATTACHMENTS_MAX).toBe(MAX_ATTACHMENTS_PER_PROMPT)
    expect(DROP_LIMITS.attachments).toBe(MAX_ATTACHMENTS_PER_PROMPT)
    const h = await setup()
    expect((await h.call('GET', '/drops/settings')).body.attachments).toBe(5)
  })

  it('a stored drop keeps its file refs, and a bad ref sets the row aside instead of trusting it', () => {
    const base = { id: randomUUID(), text: 'x', source: 'web', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      state: 'filed', dest: 'note', kind: 'note', links: [], route: null, undoUntil: null, timeline: [] }
    const ok = { id: 'm_' + 'a'.repeat(24), name: 'Q3 plan.pdf', mime: 'application/pdf', size: 1234 }
    expect(parseDropRecord({ ...base, attachments: [ok] }).attachments).toEqual([ok])
    for (const bad of [{ ...ok, id: '../x' }, { ...ok, name: 'a\nb' }, { ...ok, mime: 'nope' }, { ...ok, size: -1 }]) {
      expect(() => parseDropRecord({ ...base, attachments: [bad] })).toThrow()
    }
    expect(() => parseDropRecord({ ...base, attachments: Array(6).fill(ok) })).toThrow()
  })
})
