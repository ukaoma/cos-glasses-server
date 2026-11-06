import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrepRuntime, buildPrepPrompt, capAnswers, prepClientJobId, type PrepJobs } from './prep-runtime.js'
import { PrepStore, PrepError, DRAFT_LOAD_BYTES, DRAFT_WRITE_BYTES } from './prep-store.js'
import { MeetingAskStore } from './meeting-ask-store.js'
import { MediaStoreError } from './media-store.js'
import { PREP_LIMITS, PREP_UUID_V4, prepAdoptedFileId, prepSteerFileId, type PrepDraft } from '../../shared/prep.js'
import type { QueryJobSnapshot } from './query-job-types.js'

const SESSION = 'meeting_prep_test_1'
const SERVER = 'srv-1'
const uuid = () => globalThis.crypto.randomUUID()

interface FakeMedia { mime: string; kind: string; category?: string; label?: string; bytes: Buffer; text?: string; storedSha?: string }

function fixture(opts: { media?: Record<string, FakeMedia>; ocr?: (path: string) => Promise<{ text: string; lowConfidence: boolean }> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prep-rt-'))
  const media = opts.media ?? {}
  const state = { open: true, now: Date.parse('2026-11-06T15:00:00Z'), leases: 0, released: 0, sessions: 0, unknown: new Set<string>() }
  const jobs = new Map<string, QueryJobSnapshot>()
  const submitted: Array<Record<string, unknown>> = []
  const fakeJobs: PrepJobs = {
    prepare: vi.fn(async (raw: unknown) => {
      const r = raw as Record<string, unknown>
      return { ...r, sessionId: typeof r.sessionId === 'string' ? r.sessionId : `conv-${++state.sessions}` }
    }),
    submit: vi.fn(async (raw: unknown) => {
      const r = raw as Record<string, unknown>
      submitted.push(r)
      const existing = jobs.get(r.clientJobId as string)
      if (existing) return { created: false, job: existing }
      const job = { jobId: `job-${jobs.size + 1}`, clientJobId: r.clientJobId, generation: 1, sessionId: r.sessionId, status: 'accepted' } as unknown as QueryJobSnapshot
      jobs.set(r.clientJobId as string, job)
      return { created: true, job }
    }),
    byClient: vi.fn(async (id: string) => jobs.get(id)),
  }
  const store = new PrepStore(join(dir, 'prep'))
  const meetingFiles = new MeetingAskStore(join(dir, 'meeting-ask'))
  const readImage = vi.fn(opts.ocr ?? (async () => ({ text: 'Revenue 42', lowConfidence: false })))
  const deps = {
    store, meetingFiles, jobs: fakeJobs, readImage,
    identity: () => SERVER,
    knownSession: (id: string) => !state.unknown.has(id),
    admissions: () => state.open,
    lease: () => { state.leases++; return { id: 'l', setPhase() {}, release() { state.released++ } } },
    now: () => state.now,
    readFile: (path: string) => { const m = Object.values(media).find((_, i) => `/media/${Object.keys(media)[i]}` === path); if (!m) throw new Error('no file'); return m.bytes },
    media: () => ({
      resolveUsable: (id: string) => {
        const m = media[id]
        if (!m) throw new MediaStoreError('media_not_found', 'gone')
        return { record: { ref: { id, kind: m.kind, mime: m.mime, width: 0, height: 0, createdAt: '', ...(m.category ? { category: m.category } : {}), ...(m.label ? { label: m.label } : {}) }, bytes: m.bytes.length, sha256: m.storedSha ?? createHash('sha256').update(m.bytes).digest('hex'), createdAtMs: 1 } as any, path: `/media/${id}` }
      },
      resolveModelDerivatives: (id: string) => ({ record: {} as any, originalPath: '', imagePaths: [], ...(media[id]?.text !== undefined ? { text: media[id].text } : {}) }),
    }),
  }
  const runtime = new TestRuntime(deps as any, media)
  return { dir, runtime, store, meetingFiles, jobs: fakeJobs, submitted, state, readImage, deps, close: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Fills each media entry's sha256 from the fake upload unless the test sets one (the client sends the hash it uploaded). */
class TestRuntime extends PrepRuntime {
  constructor(deps: any, private media: Record<string, FakeMedia> = {}) { super(deps) }
  override addFiles(id: string, raw: any) {
    const media = Array.isArray(raw?.media) ? raw.media.map((m: any) => m && m.sha256 === undefined && this.media[m.id] ? { ...m, sha256: createHash('sha256').update(this.media[m.id].bytes).digest('hex') } : m) : raw?.media
    return super.addFiles(id, { ...raw, media })
  }
}

const M = (n: number) => 'm_' + n.toString(16).padStart(24, '0')
const doc = (text: string, label = 'Brief.pdf'): FakeMedia => ({ mime: 'application/pdf', kind: 'user_document', category: 'document', label, bytes: Buffer.from('%PDF-1.4 bytes'), text })
const txt = (text: string, label = 'notes.md'): FakeMedia => ({ mime: 'text/markdown', kind: 'user_document', category: 'document', label, bytes: Buffer.from(text) })
const img = (label = 'slide.png'): FakeMedia => ({ mime: 'image/png', kind: 'user_photo', label, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
const vid = (): FakeMedia => ({ mime: 'video/mp4', kind: 'user_video', category: 'video', label: 'clip.mp4', bytes: Buffer.from('mp4') })

async function caught(p: Promise<unknown> | (() => unknown)): Promise<PrepError> {
  try { await (typeof p === 'function' ? p() : p) } catch (e) { return e as PrepError }
  throw new Error('expected a PrepError')
}

let open: Array<() => void> = []
afterEach(() => { for (const c of open) c(); open = [] })
function make(opts?: Parameters<typeof fixture>[0]) { const f = fixture(opts); open.push(f.close); return f }
/** A bind of the draft's current revision, as a client that just read it would send. */
function bindNow(f: ReturnType<typeof make>, draftId: string, sessionId: string, surface: string, serverInstanceId: string = SERVER) {
  return f.runtime.bind(draftId, { revision: f.store.get(draftId)?.revision, sessionId, serverInstanceId, surface })
}

describe('Prep drafts', () => {
  it('creates once per clientDraftId: a repeat returns the same draft, created false', async () => {
    const f = make()
    const cid = uuid()
    const a = await f.runtime.create({ clientDraftId: cid, title: 'Pete 1:1', startsAt: '2026-11-06T16:00:00-06:00' })
    const b = await f.runtime.create({ clientDraftId: cid, title: 'something else' })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.draft.id).toBe(a.draft.id)
    expect(a.draft.id).toMatch(/^prep_[a-z2-7]{26}$/)
    expect(a.draft).toMatchObject({ revision: 1, title: 'Pete 1:1', startsAt: '2026-11-06T22:00:00.000Z', identity: 'none', occurrence: null, state: 'active', conversation: { sessionId: null } })
    expect((await caught(f.runtime.create({ clientDraftId: 'not-a-uuid' }))).code).toBe('invalid_client_draft_id')
  })

  it('never derives identity from title or time; occurrence needs provider, calendarId, an event id and startsAt', async () => {
    const f = make()
    const plain = (await f.runtime.create({ clientDraftId: uuid(), title: 'Pete 1:1', startsAt: '2026-11-06T22:00:00Z' })).draft
    const twin = (await f.runtime.create({ clientDraftId: uuid(), title: 'Pete 1:1', startsAt: '2026-11-06T22:00:00Z' })).draft
    expect(plain.occurrence).toBeNull()
    expect(plain.identity).toBe('none')
    expect(twin.id).not.toBe(plain.id)
    // Incomplete provider identity is no identity, never a guess.
    const partial = (await f.runtime.create({ clientDraftId: uuid(), occurrence: { provider: 'm365', calendarId: 'cal', startsAt: '2026-11-06T22:00:00Z' } })).draft
    expect(partial.occurrence).toBeNull()
    expect(partial.identity).toBe('none')
    const full = (await f.runtime.create({ clientDraftId: uuid(), title: 'Pete 1:1', occurrence: { provider: 'm365', calendarId: 'cal-1', eventId: 'evt-9', startsAt: '2026-11-06T16:00:30-06:00', key: 'occ:v2:forged' } })).draft
    const expected = 'occ:v2:' + createHash('sha256').update('occ:v2:m365||cal-1|evt-9||2026-11-06T22:00:30.000Z').digest('hex')
    expect(full.occurrence?.key).toBe(expected)
    expect(full.identity).toBe('provider')
    // The key finds only the draft that carries it, not the drafts with the same title and time.
    expect(f.runtime.list({ occurrence: expected }).map(d => d.id)).toEqual([full.id])
    expect((await caught(f.runtime.create({ clientDraftId: uuid(), occurrence: 'm365' }))).code).toBe('invalid_occurrence')
  })

  it('PATCH is compare-and-swap: a stale revision is 409 revision_conflict carrying the current draft', async () => {
    const f = make()
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const next = await f.runtime.patch(d.id, { revision: 1, steer: 'Ask about Q4 pipeline' })
    expect(next.revision).toBe(2)
    const err = await caught(f.runtime.patch(d.id, { revision: 1, steer: 'stale' }))
    expect(err.code).toBe('revision_conflict')
    expect(err.status).toBe(409)
    expect(err.draft?.revision).toBe(2)
    expect(err.draft?.steer).toBe('Ask about Q4 pipeline')
    expect(f.store.get(d.id)!.steer).toBe('Ask about Q4 pipeline')
  })

  it('two concurrent writes with the same revision serialize: one wins, the other is 409', async () => {
    const f = make()
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const results = await Promise.allSettled([f.runtime.patch(d.id, { revision: 1, steer: 'A' }), f.runtime.patch(d.id, { revision: 1, steer: 'B' })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    expect(rejected).toHaveLength(1)
    expect((rejected[0].reason as PrepError).code).toBe('revision_conflict')
    expect(f.store.get(d.id)!.revision).toBe(2)
  })

  it('caps steer at 4,000 characters (413) and 300 active drafts and the 1 GB store (507)', async () => {
    const f = make()
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    expect((await caught(f.runtime.patch(d.id, { revision: 1, steer: 'x'.repeat(4001) }))).code).toBe('prep_steer_limit')
    expect((await f.runtime.patch(d.id, { revision: 1, steer: 'x'.repeat(4000) })).steer).toHaveLength(4000)
    const usage = vi.spyOn(f.store, 'usageBytes').mockReturnValue(PREP_LIMITS.storeBytes)
    expect((await caught(f.runtime.create({ clientDraftId: uuid() }))).status).toBe(507)
    usage.mockRestore()
    const b32 = (n: number) => Array.from({ length: 26 }, (_, k) => 'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(n / 32 ** Math.min(k, 3)) % 32]).join('')
    for (let i = 0; i < PREP_LIMITS.activeDrafts - 1; i++) f.store.write({ ...d, id: 'prep_' + b32(i + 1), clientDraftId: uuid() })
    expect(f.store.list().filter(x => x.state === 'active')).toHaveLength(PREP_LIMITS.activeDrafts)
    const full = await caught(f.runtime.create({ clientDraftId: uuid() }))
    expect([full.code, full.status]).toEqual(['prep_draft_limit', 507])
  }, 60_000) // 300 fsynced drafts: seconds alone, longer beside a parallel suite

  it('a fresh store and runtime on the same directory read every draft back (restart safety)', async () => {
    const f = make({ media: { [M(1)]: txt('Agenda: renewals') } })
    const d = (await f.runtime.create({ clientDraftId: uuid(), title: 'QBR' })).draft
    const withFile = await f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(1) }] })
    const again = new PrepRuntime({ ...f.deps, store: new PrepStore(f.store.root) } as any)
    expect(await again.get(d.id)).toEqual(withFile)
    expect(again.readText(d.id, withFile.files[0].id)).toBe('Agenda: renewals')
    expect(again.readOriginal(d.id, withFile.files[0].id).bytes.toString()).toBe('Agenda: renewals')
  })

  it('refuses writes with 503 maintenance while admissions are closed, and holds a lease per write', async () => {
    const f = make()
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    expect(f.state.leases).toBe(1)
    expect(f.state.released).toBe(1)
    f.state.open = false
    const err = await caught(f.runtime.patch(d.id, { revision: 1, steer: 'x' }))
    expect([err.code, err.status]).toEqual(['maintenance', 503])
    f.state.open = true
    const drain = new PrepRuntime({ ...f.deps, lease: () => { throw new Error('maintenance_drain_active') } } as any)
    expect((await caught(drain.patch(d.id, { revision: 1, steer: 'x' }))).code).toBe('maintenance')
    expect(f.store.get(d.id)!.revision).toBe(1)
  })
})

describe('Prep files', () => {
  it('copies bytes and extracts text by kind: document, text, image OCR, image with a key, video', async () => {
    const f = make({
      media: { [M(1)]: doc('Pipeline is 3.2M'), [M(2)]: txt('# Agenda\nRenewals'), [M(3)]: img(), [M(4)]: img('keys.png'), [M(5)]: vid() },
      ocr: async path => ({ text: path.endsWith(M(4)) ? 'api_key = sk-ant-abcdefghijklmnopqrstuvwxyz0123456789' : 'Revenue 42', lowConfidence: false }),
    })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const next = await f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(1) }, { id: M(2), name: 'Agenda.md', sourceRef: 'ctl-7' }, { id: M(3) }, { id: M(4) }, { id: M(5) }] })
    expect(next.revision).toBe(2)
    const [a, b, c, k, v] = next.files
    expect(a).toMatchObject({ kind: 'document', status: 'ready', mime: 'application/pdf', name: 'Brief.pdf', source: 'upload', textChars: 16 })
    expect(b).toMatchObject({ kind: 'text', status: 'ready', name: 'Agenda.md', source: 'control-local', sourceRef: 'ctl-7' })
    expect(c).toMatchObject({ kind: 'image', status: 'ready' })
    expect(k).toMatchObject({ kind: 'image', status: 'secret-held' })
    expect(v).toMatchObject({ kind: 'other', status: 'unsupported' })
    expect(a.id).toMatch(/^pf_[0-9a-f]{16}$/)
    expect(a.sha256).toBe(createHash('sha256').update('%PDF-1.4 bytes').digest('hex'))
    expect(f.runtime.readText(d.id, a.id)).toBe('Pipeline is 3.2M')
    expect(f.runtime.readText(d.id, c.id)).toContain('Revenue 42')
    expect(f.runtime.readText(d.id, k.id)).toBe('')
    expect(f.runtime.readOriginal(d.id, v.id)).toEqual({ bytes: Buffer.from('mp4'), mime: 'video/mp4', name: 'clip.mp4' })
  })

  it('takes 1 to 10 media per call and 10 per draft (413 prep_file_limit), and caps text at 100 KB', async () => {
    const media: Record<string, FakeMedia> = {}
    for (let i = 1; i <= 12; i++) media[M(i)] = txt(i === 1 ? 'é'.repeat(60_000) : `file ${i}`, `f${i}.txt`)
    const f = make({ media })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const eleven = Array.from({ length: 11 }, (_, i) => ({ id: M(i + 1) }))
    const tooMany = await caught(f.runtime.addFiles(d.id, { revision: 1, media: eleven }))
    expect([tooMany.code, tooMany.status]).toEqual(['prep_file_limit', 413])
    expect((await caught(f.runtime.addFiles(d.id, { revision: 1, media: [] }))).code).toBe('invalid_media')
    const eight = await f.runtime.addFiles(d.id, { revision: 1, media: eleven.slice(0, 8) })
    expect(Buffer.byteLength(f.runtime.readText(d.id, eight.files[0].id), 'utf8')).toBeLessThanOrEqual(100_000)
    expect(eight.files[0].notice).toContain('first part')
    const over = await caught(f.runtime.addFiles(d.id, { revision: 2, media: eleven.slice(8, 11) }))
    expect(over.code).toBe('prep_file_limit')
    // A removed file frees its slot.
    const removed = await f.runtime.removeFile(d.id, eight.files[1].id, 2)
    expect((await f.runtime.addFiles(d.id, { revision: removed.revision, media: eleven.slice(8, 10) })).files.filter(x => x.status !== 'removed')).toHaveLength(9)
  })

  it('replays a files call by operationId before CAS, refuses a reused operationId, and never adds one media twice', async () => {
    const f = make({ media: { [M(1)]: doc('a'), [M(2)]: doc('b', 'Two.pdf') } })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const op = uuid()
    const first = await f.runtime.addFiles(d.id, { operationId: op, revision: 1, media: [{ id: M(1) }] })
    // Lost response: the same call with its now-stale revision returns the original result, no 409, no second file.
    const replay = await f.runtime.addFiles(d.id, { operationId: op, revision: 1, media: [{ id: M(1) }] })
    expect(replay).toEqual(first)
    const reused = await caught(f.runtime.addFiles(d.id, { operationId: op, revision: 1, media: [{ id: M(2) }] }))
    expect([reused.code, reused.status]).toEqual(['request_reused', 409])
    // A new operation naming media already in the draft returns the existing file.
    const same = await f.runtime.addFiles(d.id, { operationId: uuid(), revision: first.revision, media: [{ id: M(1) }] })
    expect(same.files).toHaveLength(1)
    expect(same.revision).toBe(first.revision)
    expect(first.fileOperations).toEqual([expect.objectContaining({ operationId: op, fileIds: [first.files[0].id] })])
  })

  it('refuses a copy whose sha256 differs from the client upload (409 media_hash_mismatch) and writes nothing', async () => {
    const f = make({ media: { [M(1)]: doc('a') } })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const usage = f.store.usageBytes()
    const err = await caught(f.runtime.addFiles(d.id, { operationId: uuid(), revision: 1, media: [{ id: M(1), sha256: 'f'.repeat(64) }] }))
    expect([err.code, err.status]).toEqual(['media_hash_mismatch', 409])
    expect(f.store.get(d.id)).toEqual(d)
    expect(f.store.usageBytes()).toBe(usage)
    expect((await caught(f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(1), sha256: 'nothex' }] }))).code).toBe('invalid_media')
  })

  it('images are re-encoded by /api/media: the copy is checked against the store hash and the client hash is kept', async () => {
    const f = make({ media: { [M(1)]: img(), [M(2)]: { ...img('torn.png'), storedSha: 'e'.repeat(64) } } })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const upload = 'c'.repeat(64) // the hash of the JPEG the browser sent, which /api/media no longer has
    const ok = await f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(1), sha256: upload }] })
    expect(ok.files[0]).toMatchObject({ uploadSha256: upload, sha256: createHash('sha256').update(img().bytes).digest('hex') })
    const torn = await caught(f.runtime.addFiles(d.id, { revision: ok.revision, media: [{ id: M(2), sha256: upload }] }))
    expect([torn.code, torn.status]).toEqual(['media_hash_mismatch', 409])
    expect(f.store.get(d.id)!.files).toHaveLength(1)
  })

  it('cuts a long file name by code point: an emoji at the limit is never halved', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const name = 'a'.repeat(239) + '\u{1F600}b'   // the emoji is code point 240
    const added = await f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(1), name: name.slice(0, 240) }] })
    expect(added.files[0].name).toBe('a'.repeat(239))   // the input itself ended in half an emoji: dropped
    const whole = await f.runtime.patch(d.id, { revision: added.revision, title: 'b'.repeat(299) + '\u{1F600}c' })
    expect(whole.title).toBe('b'.repeat(299) + '\u{1F600}')
    expect(() => encodeURIComponent(whole.title)).not.toThrow()
  })

  it('maps a missing upload to its media error and writes nothing', async () => {
    const f = make()
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const err = await caught(f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(9), sha256: 'a'.repeat(64) }] }))
    expect([err.code, err.status]).toEqual(['media_not_found', 404])
    expect(f.store.get(d.id)!.revision).toBe(1)
  })
})

describe('Prep run', () => {
  async function ready(f: ReturnType<typeof make>) {
    const d = (await f.runtime.create({ clientDraftId: uuid(), title: 'Pete 1:1', startsAt: '2026-11-06T22:00:00Z' })).draft
    const p = await f.runtime.patch(d.id, { revision: 1, steer: 'Focus on Liquor demos' })
    return f.runtime.addFiles(d.id, { revision: p.revision, media: [{ id: M(1) }] })
  }

  it('submits one web-admitted durable job with title, time, steer and file text, and records the conversation', async () => {
    const f = make({ media: { [M(1)]: doc('Demo count fell 12 percent') } })
    const d = await ready(f)
    const rid = uuid()
    const out = await f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision, model: 'sonnet' })
    expect(f.submitted).toHaveLength(1)
    const sent = f.submitted[0]
    expect(sent.source).toBe('web')
    expect(sent.generation).toBe(1)
    expect(sent.model).toBe('sonnet')
    expect(sent.clientJobId).toBe(await prepClientJobId(d.id, rid))
    expect(PREP_UUID_V4.test(sent.clientJobId as string)).toBe(true)
    expect(sent.query).toContain('Meeting: Pete 1:1')
    expect(sent.query).toContain('2026-11-06T22:00:00.000Z')
    expect(sent.query).toContain('Focus on Liquor demos')
    expect(sent.query).toContain('Demo count fell 12 percent')
    expect((f.jobs.prepare as any).mock.calls[0][0].sessionId).toBeUndefined() // the web admission makes the conversation
    expect(out.run).toMatchObject({ clientRequestId: rid, jobId: 'job-1', sessionId: 'conv-1', draftRevision: d.revision })
    expect(out.draft.conversation.sessionId).toBe('conv-1')
    // One revision for the run (its frozen 'submitting' receipt); recording the admitted job is bookkeeping.
    expect(out.draft.revision).toBe(d.revision + 1)
    expect(out.run).toMatchObject({ state: 'accepted', promptSha256: createHash('sha256').update(sent.query as string).digest('hex') })
  })

  it('is idempotent per clientRequestId: a retry returns the same job and submits nothing, even with a stale revision', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const rid = uuid()
    const first = await f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision })
    const again = await f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision })
    expect(again.job?.jobId).toBe(first.job?.jobId)
    expect(again.run).toEqual(first.run)
    expect(f.jobs.submit).toHaveBeenCalledTimes(1)
    expect(f.store.get(d.id)!.runs).toHaveLength(1)
    // A new request on the old revision is a conflict.
    const stale = await caught(f.runtime.run(d.id, { clientRequestId: uuid(), revision: d.revision }))
    expect([stale.code, stale.status]).toEqual(['revision_conflict', 409])
    expect(f.jobs.submit).toHaveBeenCalledTimes(1)
  })

  it('adopts a job admitted before a lost draft write instead of submitting twice', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const rid = uuid()
    await f.jobs.submit({ clientJobId: await prepClientJobId(d.id, rid), sessionId: 'conv-early' })
    const out = await f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision })
    expect(f.jobs.submit).toHaveBeenCalledTimes(1)
    expect(out.draft.conversation.sessionId).toBe('conv-early')
  })

  it('recovers when the process dies between submit and recording the run: the retry records the admitted job, no second submit', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const rid = uuid()
    // The 'accepted' write (the second write of a run) fails, as a crash right after submit would leave it.
    const real = f.store.write.bind(f.store)
    let writes = 0
    const write = vi.spyOn(f.store, 'write').mockImplementation(draft => { if (++writes === 2) throw new PrepError('prep_write_failed', 507); return real(draft) })
    const failed = await caught(f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision }))
    expect(failed.code).toBe('prep_write_failed')
    expect(f.jobs.submit).toHaveBeenCalledTimes(1)
    expect(f.store.get(d.id)!.runs.map(r => r.state)).toEqual(['submitting'])
    write.mockRestore()
    // A restarted server: a fresh store and runtime on the same directory.
    const restarted = new PrepRuntime({ ...f.deps, store: new PrepStore(f.store.root) } as any)
    // The retry carries the revision it first sent (now stale) and still resolves before CAS.
    const again = await restarted.run(d.id, { clientRequestId: rid, revision: d.revision })
    expect(again.job?.jobId).toBe('job-1')
    expect(again.run).toMatchObject({ state: 'accepted', jobId: 'job-1', sessionId: 'conv-1' })
    expect(f.jobs.submit).toHaveBeenCalledTimes(1)
    expect(again.draft.conversation.sessionId).toBe('conv-1')
  })

  it('one run at a time: a second run while the first is still being admitted is 409 run_in_progress', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const realSubmit = f.jobs.submit
    f.deps.jobs.submit = vi.fn(async (raw: unknown) => { await gate; return realSubmit(raw) })
    const first = uuid()
    const pending = f.runtime.run(d.id, { clientRequestId: first, revision: d.revision })
    while (!(f.deps.jobs.submit as any).mock.calls.length) await new Promise(r => setImmediate(r))
    const second = await caught(f.runtime.run(d.id, { clientRequestId: uuid(), revision: d.revision + 1 }))
    expect([second.code, second.status]).toEqual(['run_in_progress', 409])
    expect((second.extra.run as any).clientRequestId).toBe(first)
    // Editing the draft is not blocked while the job is admitted.
    expect((await f.runtime.patch(d.id, { revision: d.revision + 1, steer: 'typing' })).steer).toBe('typing')
    release()
    expect((await pending).run.state).toBe('accepted')
    const third = await f.runtime.run(d.id, { clientRequestId: uuid(), revision: f.store.get(d.id)!.revision })
    expect(third.run.state).toBe('accepted')
  })

  it('two concurrent identical runs admit once: prepare once, submit once, the same job for both', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const rid = uuid()
    // The first admission is still inside submit when the retry arrives, so the job is not findable yet.
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const realSubmit = f.jobs.submit
    f.deps.jobs.submit = f.jobs.submit = vi.fn(async (raw: unknown) => { await gate; return realSubmit(raw) })
    const first = f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision })
    while (!(f.jobs.submit as any).mock.calls.length) await new Promise(r => setImmediate(r))
    const second = f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision })
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    release()
    const [a, b] = await Promise.all([first, second])
    expect(f.jobs.prepare).toHaveBeenCalledTimes(1)
    expect(f.jobs.submit).toHaveBeenCalledTimes(1)
    expect([a.job?.jobId, b.job?.jobId]).toEqual(['job-1', 'job-1'])
    expect(f.store.get(d.id)!.runs).toHaveLength(1)
  })

  it('GET run: 202 while the admission is in flight, 503 run_status_unknown when the lookup fails, never a 404 guess', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const realSubmit = f.jobs.submit
    f.deps.jobs.submit = vi.fn(async (raw: unknown) => { await gate; return realSubmit(raw) })
    const rid = uuid()
    const pending = f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision })
    while (!(f.deps.jobs.submit as any).mock.calls.length) await new Promise(r => setImmediate(r))
    const during = await f.runtime.getRun(d.id, rid)
    expect([during.status, during.run.state, during.job]).toEqual([202, 'submitting', null])
    release()
    await pending
    const realByClient = f.deps.jobs.byClient
    f.deps.jobs.byClient = vi.fn(async () => { throw new Error('store busy') })
    const unknown = await caught(f.runtime.getRun(d.id, rid))
    expect([unknown.code, unknown.status]).toEqual(['run_status_unknown', 503])
    f.deps.jobs.byClient = realByClient
    expect((await f.runtime.getRun(d.id, rid)).status).toBe(200)
  })

  it('a stranded receipt with no job (restart before submit) is 404 with the receipt, and its retry submits it', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const rid = uuid()
    f.deps.jobs.prepare = vi.fn(async () => { await new Promise(() => {}) }) as any   // the process "dies" inside admission
    void f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision })
    while (!(f.deps.jobs.prepare as any).mock.calls.length) await new Promise(r => setImmediate(r))
    const restarted = new PrepRuntime({ ...f.deps, store: new PrepStore(f.store.root), jobs: { ...f.jobs, prepare: async (raw: unknown) => ({ ...(raw as object), sessionId: 'conv-r' }) } } as any)
    const stranded = await caught(restarted.getRun(d.id, rid))
    expect([stranded.code, stranded.status, (stranded.extra.run as any).state]).toEqual(['run_not_accepted', 404, 'submitting'])
    const retried = await restarted.run(d.id, { clientRequestId: rid, revision: d.revision })
    expect(retried.run).toMatchObject({ state: 'accepted', sessionId: 'conv-r' })
    expect(f.jobs.submit).toHaveBeenCalledTimes(1)
  })

  it('run_in_progress also covers an accepted job that is not terminal and has no session yet', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    f.deps.jobs.prepare = vi.fn(async (raw: unknown) => ({ ...(raw as object), sessionId: '' })) as any
    const first = await f.runtime.run(d.id, { clientRequestId: uuid(), revision: d.revision })
    expect(first.run).toMatchObject({ state: 'accepted', sessionId: null })
    const busy = await caught(f.runtime.run(d.id, { clientRequestId: uuid(), revision: first.draft.revision }))
    expect([busy.code, (busy.extra.run as any).clientRequestId]).toEqual(['run_in_progress', first.run.clientRequestId])
    Object.assign((await f.jobs.byClient(first.run.clientJobId, 1)) as any, { status: 'completed' })
    expect((await f.runtime.run(d.id, { clientRequestId: uuid(), revision: f.store.get(d.id)!.revision })).run.state).toBe('accepted')
  })

  it('a reused clientRequestId with a different body is 409 request_reused', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const rid = uuid()
    await f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision, model: 'sonnet' })
    const reused = await caught(f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision, model: 'opus' }))
    expect([reused.code, reused.status]).toEqual(['request_reused', 409])
    expect(f.jobs.submit).toHaveBeenCalledTimes(1)
  })

  it('a refused admission marks the run failed, so it does not block the next run', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    f.deps.jobs.prepare = vi.fn(async () => { throw Object.assign(new Error('era'), { status: 409, code: 'message_era_mismatch' }) })
    const rid = uuid()
    const err = await caught(f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision }))
    expect([err.code, err.status]).toEqual(['message_era_mismatch', 409])
    expect(f.store.get(d.id)!.runs[0]).toMatchObject({ state: 'failed', error: 'message_era_mismatch' })
    expect((await caught(f.runtime.getRun(d.id, rid))).code).toBe('run_not_accepted')
    // Replaying a failed run says so (409 run_failed with the run), never a fresh 202.
    const replay = await caught(f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision }))
    expect([replay.code, replay.status, (replay.extra.run as any).state]).toEqual(['run_failed', 409, 'failed'])
  })

  it('a stuck submitting receipt (lookup failed): a new id gets 409 with no side effect; the old id re-drives it once; then a new id runs', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const realByClient = f.deps.jobs.byClient
    let fail = 1
    f.deps.jobs.byClient = vi.fn(async (id: string, g: number) => { if (fail-- > 0) throw new Error('store busy'); return realByClient(id, g) })
    const stuck = uuid()
    const err = await caught(f.runtime.run(d.id, { clientRequestId: stuck, revision: d.revision }))
    expect([err.code, err.status]).toEqual(['run_status_unknown', 503])
    expect(f.store.get(d.id)!.runs.map(r => r.state)).toEqual(['submitting'])
    const stuckJob = f.store.get(d.id)!.runs[0].clientJobId
    // A new id: 409 with the stuck run, and nothing else happens (no prepare, no submit, nothing recorded).
    const before = JSON.stringify(f.store.get(d.id))
    for (let i = 0; i < 3; i++) {
      const busy = await caught(f.runtime.run(d.id, { clientRequestId: uuid(), revision: f.store.get(d.id)!.revision }))
      expect([busy.code, busy.status, (busy.extra.run as any).clientRequestId, (busy.extra.run as any).state]).toEqual(['run_in_progress', 409, stuck, 'submitting'])
    }
    expect(f.jobs.prepare).not.toHaveBeenCalled()
    expect(f.jobs.submit).not.toHaveBeenCalled()
    expect(JSON.stringify(f.store.get(d.id))).toBe(before)
    // The client resends the OLD id: it re-drives the stuck run with its frozen prompt, exactly one submit.
    const redriven = await f.runtime.run(d.id, { clientRequestId: stuck, revision: d.revision })
    expect(redriven.run).toMatchObject({ clientRequestId: stuck, state: 'accepted' })
    expect((f.jobs.submit as any).mock.calls.filter((c: any[]) => c[0].clientJobId === stuckJob)).toHaveLength(1)
    expect(createHash('sha256').update((f.jobs.prepare as any).mock.calls[0][0].query).digest('hex')).toBe(redriven.run.promptSha256)
    // Then a new id runs on its own.
    const next = await f.runtime.run(d.id, { clientRequestId: uuid(), revision: f.store.get(d.id)!.revision })
    expect(next.run.state).toBe('accepted')
    expect(f.jobs.submit).toHaveBeenCalledTimes(2)
  })

  it('a drain before submit leaves the receipt: a new id is refused with no submit, the old id re-drives it', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const realByClient = f.deps.jobs.byClient
    f.deps.jobs.byClient = vi.fn(async (id: string, g: number) => { f.state.open = false; return realByClient(id, g) })
    const stuck = uuid()
    expect((await caught(f.runtime.run(d.id, { clientRequestId: stuck, revision: d.revision }))).code).toBe('maintenance')
    f.deps.jobs.byClient = realByClient
    f.state.open = true
    const next = await caught(f.runtime.run(d.id, { clientRequestId: uuid(), revision: f.store.get(d.id)!.revision }))
    expect([next.code, (next.extra.run as any).clientRequestId, next.extra.redriven]).toEqual(['run_in_progress', stuck, undefined])
    expect(f.jobs.submit).not.toHaveBeenCalled()
    expect((await f.runtime.run(d.id, { clientRequestId: stuck, revision: d.revision })).run.state).toBe('accepted')
    expect(f.jobs.submit).toHaveBeenCalledTimes(1)
  })

  it('an accepted run whose job is gone (retention) is recorded unavailable: GET says terminal, and a new run is allowed', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    f.deps.jobs.prepare = vi.fn(async (raw: unknown) => ({ ...(raw as object), sessionId: '' })) as any   // no session: it would block
    const first = await f.runtime.run(d.id, { clientRequestId: uuid(), revision: d.revision })
    expect((await caught(f.runtime.run(d.id, { clientRequestId: uuid(), revision: first.draft.revision }))).code).toBe('run_in_progress')
    // A lookup error is not proof: still 503, nothing recorded.
    const realByClient = f.deps.jobs.byClient
    f.deps.jobs.byClient = vi.fn(async () => { throw new Error('store busy') })
    expect((await caught(f.runtime.getRun(d.id, first.run.clientRequestId))).code).toBe('run_status_unknown')
    expect(f.store.get(d.id)!.runs[0].outcome).toBeUndefined()
    // Nor through a draft read (settle): a failing lookup records nothing.
    expect((await f.runtime.get(d.id)).runs[0].outcome).toBeUndefined()
    expect(f.store.get(d.id)!.runs[0].settledAt).toBeUndefined()
    // The job is evicted: the lookup now authoritatively finds nothing.
    f.deps.jobs.byClient = vi.fn(async () => undefined)
    const got = await f.runtime.getRun(d.id, first.run.clientRequestId)
    expect(got.status).toBe(200)
    expect(got.job).toBeNull()
    expect(got.run).toMatchObject({ state: 'accepted', outcome: 'unavailable', answer: null, settledAt: expect.any(String) })
    expect(f.store.get(d.id)!.runs[0].outcome).toBe('unavailable')   // durable
    f.deps.jobs.byClient = realByClient
    expect((await f.runtime.run(d.id, { clientRequestId: uuid(), revision: f.store.get(d.id)!.revision })).run.state).toBe('accepted')
  })

  it('runInProgress itself records an evicted job unavailable, so the new run goes ahead', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    f.deps.jobs.prepare = vi.fn(async (raw: unknown) => ({ ...(raw as object), sessionId: '' })) as any
    const first = await f.runtime.run(d.id, { clientRequestId: uuid(), revision: d.revision })
    const realByClient = f.deps.jobs.byClient
    f.deps.jobs.byClient = vi.fn(async (id: string, g: number) => id === first.run.clientJobId ? undefined : realByClient(id, g))
    const next = await f.runtime.run(d.id, { clientRequestId: uuid(), revision: first.draft.revision })
    expect(next.run.state).toBe('accepted')
    expect(f.store.get(d.id)!.runs[0]).toMatchObject({ outcome: 'unavailable', answer: null })
  })

  it('an answer copied before eviction is kept: the run stays completed with its answer', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const out = await f.runtime.run(d.id, { clientRequestId: uuid(), revision: d.revision })
    Object.assign((await f.jobs.byClient(out.run.clientJobId, 1)) as any, { status: 'completed', response: 'Lead with demos.' })
    await f.runtime.run(d.id, { clientRequestId: out.run.clientRequestId, revision: d.revision })   // a replay is a read too
    expect(f.store.get(d.id)!.runs[0]).toMatchObject({ status: 'completed', answer: 'Lead with demos.' })
    f.deps.jobs.byClient = vi.fn(async () => undefined)
    const got = await f.runtime.getRun(d.id, out.run.clientRequestId)
    expect(got.run).toMatchObject({ status: 'completed', answer: 'Lead with demos.' })
    expect(got.run.outcome).toBeUndefined()
  })

  it('reading a finished run copies its answer (20 KB at most) without moving the revision or updatedAt', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const out = await f.runtime.run(d.id, { clientRequestId: uuid(), revision: d.revision })
    Object.assign((await f.jobs.byClient(out.run.clientJobId, 1)) as any, { status: 'completed', response: 'é'.repeat(15_000) })
    const before = f.store.get(d.id)!
    f.state.now += 60_000
    const read = await f.runtime.get(d.id)
    expect([read.revision, read.updatedAt]).toEqual([before.revision, before.updatedAt])
    expect(f.store.get(d.id)!.revision).toBe(before.revision)
    expect(Buffer.byteLength(read.runs[0].answer!, 'utf8')).toBeLessThanOrEqual(20_000)
    expect(read.runs[0]).toMatchObject({ status: 'completed', answerTruncated: true })
    // A client holding the revision it read can still write.
    expect((await f.runtime.patch(d.id, { revision: before.revision, steer: 'after the answer' })).steer).toBe('after the answer')
  })

  it('GET run returns {run, job}, copies a finished answer onto the run, and 404s a request with no job', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const rid = uuid()
    const out = await f.runtime.run(d.id, { clientRequestId: rid, revision: d.revision })
    const got = await f.runtime.getRun(d.id, rid)
    expect(got.job?.jobId).toBe('job-1')
    expect(got.run.answer).toBeUndefined()
    Object.assign((await f.jobs.byClient(out.run.clientJobId, 1)) as any, { status: 'completed', response: 'Lead with the demo drop.', trail: [{ x: 1 }] })
    const settled = await f.runtime.getRun(d.id, rid)
    expect(settled.run).toMatchObject({ status: 'completed', answer: 'Lead with the demo drop.', settledAt: expect.any(String) })
    expect('trail' in (settled.job as any)).toBe(false)
    expect((await f.runtime.get(d.id)).runs[0].answer).toBe('Lead with the demo drop.')
    expect((await caught(f.runtime.getRun(d.id, uuid()))).code).toBe('run_not_accepted')
  })

  it('leaves held text out of the text route, the prompt and a bind', async () => {
    const key = 'sk-ant-api03-' + 'A'.repeat(60)
    const f = make({ media: { [M(1)]: txt(`token: ${key}`, 'keys.txt'), [M(2)]: doc('Plain agenda') } })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const added = await f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(1) }, { id: M(2) }] })
    const held = added.files[0]
    expect(held.status).toBe('secret-held')
    expect(f.runtime.readText(d.id, held.id)).toBe('')
    expect(f.runtime.readOriginal(d.id, held.id).bytes.toString()).toContain(key) // the owner may still download it
    await f.runtime.run(d.id, { clientRequestId: uuid(), revision: added.revision })
    expect(String((f.jobs.prepare as any).mock.calls[0][0].query)).not.toContain(key)
    await bindNow(f, d.id, SESSION, 'web')
    expect(JSON.stringify(f.meetingFiles.files(SESSION))).not.toContain(key)
    expect(f.meetingFiles.files(SESSION).map(x => x.id)).toEqual([prepAdoptedFileId(d.id, added.files[1].id)])
  })

  it('continue:true reuses the recorded conversation; without it a new conversation starts', async () => {
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = await ready(f)
    const one = await f.runtime.run(d.id, { clientRequestId: uuid(), revision: d.revision })
    const two = await f.runtime.run(d.id, { clientRequestId: uuid(), revision: one.draft.revision, continue: true })
    expect((f.jobs.prepare as any).mock.calls[1][0].sessionId).toBe('conv-1')
    expect(two.draft.conversation.sessionId).toBe('conv-1')
    const three = await f.runtime.run(d.id, { clientRequestId: uuid(), revision: two.draft.revision })
    expect((f.jobs.prepare as any).mock.calls[2][0].sessionId).toBeUndefined()
    expect(three.draft.conversation.sessionId).toBe('conv-2')
  })

  it('bounds the prompt to 48,000 characters, trimming files in proportion with a note', () => {
    const big = buildPrepPrompt({ title: 'T', startsAt: null, steer: 's'.repeat(4000), files: [{ name: 'a', text: 'a'.repeat(90_000) }, { name: 'b', text: 'b'.repeat(30_000) }] })
    expect(big.trimmed).toBe(true)
    expect(big.prompt.length).toBeLessThanOrEqual(48_000)
    expect(big.prompt).toContain('shortened to fit')
    const a = (big.prompt.match(/a+/g) ?? []).reduce((n, s) => Math.max(n, s.length), 0)
    const b = (big.prompt.match(/b+/g) ?? []).reduce((n, s) => Math.max(n, s.length), 0)
    expect(Math.round(a / b)).toBe(3)
    const small = buildPrepPrompt({ title: '', startsAt: null, steer: '', files: [{ name: 'a', text: 'hello' }] })
    expect(small.trimmed).toBe(false)
    expect(small.prompt).not.toContain('shortened')
    expect(small.prompt).toContain('Untitled meeting')
  })
})

describe('Prep bind', () => {
  async function bound(f: ReturnType<typeof make>) {
    const d = (await f.runtime.create({ clientDraftId: uuid(), title: 'QBR' })).draft
    const p = await f.runtime.patch(d.id, { revision: 1, steer: 'Push on renewals' })
    const withFiles = await f.runtime.addFiles(d.id, { revision: p.revision, media: [{ id: M(1) }, { id: M(2) }] })
    const out = await bindNow(f, d.id, SESSION, 'web', SERVER)
    return { d: withFiles, out }
  }

  it('adopts the steer as "Prep notes" and each ready file, origin prep; video and failed rows stay out', async () => {
    const f = make({ media: { [M(1)]: doc('Renewal list'), [M(2)]: vid() } })
    const { d, out } = await bound(f)
    const steerId = prepSteerFileId(d.id), fileId = prepAdoptedFileId(d.id, d.files[0].id)
    expect(steerId).toBe(`prep_${d.id}_steer`)
    const files = f.meetingFiles.files(SESSION)
    expect(files.map(x => x.id).sort()).toEqual([fileId, steerId].sort())
    expect(files.find(x => x.id === steerId)).toMatchObject({ name: 'Prep notes', status: 'ready', text: 'Push on renewals', origin: 'prep' })
    expect(files.find(x => x.id === fileId)).toMatchObject({ name: 'Brief.pdf', status: 'ready', text: 'Renewal list', origin: 'prep' })
    expect(out.files).toEqual(files)
    expect(out.draft.bindings).toEqual([expect.objectContaining({ sessionId: SESSION, serverInstanceId: SERVER, surface: 'web', fileIds: [steerId, fileId] })])
  })

  it('replays an exact bind (same meeting and revision) before CAS, and a bind after an edit updates the copy', async () => {
    const f = make({ media: { [M(1)]: doc('Renewal list'), [M(2)]: vid() } })
    const { d, out } = await bound(f)
    const boundAt = d.revision
    const before = f.meetingFiles.files(SESSION)
    const afterBind = f.store.get(d.id)!.revision
    expect(out.draft.bindings[0]).toMatchObject({ revision: boundAt, state: 'applied' })
    const put = vi.spyOn(f.meetingFiles, 'putFiles')
    // The response was lost; the client retries the same bind with the revision it sent (now stale).
    const again = await f.runtime.bind(d.id, { revision: boundAt, sessionId: SESSION, serverInstanceId: SERVER, surface: 'web' })
    expect(again.files).toEqual(before)
    expect(again.draft.revision).toBe(afterBind)
    expect(put).not.toHaveBeenCalled()
    put.mockRestore()
    // The same old revision for a different meeting is not a replay: 409.
    const other = await caught(f.runtime.bind(d.id, { revision: boundAt, sessionId: 'meeting_other_1', serverInstanceId: SERVER, surface: 'web' }))
    expect([other.code, other.status]).toEqual(['revision_conflict', 409])
    await f.runtime.patch(d.id, { revision: afterBind, steer: 'Push on renewals and pricing' })
    await bindNow(f, d.id, SESSION, 'control')
    const steer = f.meetingFiles.files(SESSION).find(x => x.id === prepSteerFileId(d.id))!
    expect(steer.text).toBe('Push on renewals and pricing')
    expect(steer.revision).not.toBe(before.find(x => x.id === prepSteerFileId(d.id))!.revision)
  })

  it('refuses a meeting this server does not know (404 unknown_session)', async () => {
    const f = make({ media: { [M(1)]: doc('x'), [M(2)]: vid() } })
    const { d } = await bound(f)
    f.state.unknown.add('meeting_nowhere_1')
    const err = await caught(bindNow(f, d.id, 'meeting_nowhere_1', 'web'))
    expect([err.code, err.status]).toEqual(['unknown_session', 404])
  })

  it('checks the meeting limits first: over 500 KB or 100 files is 413 with needBytes and haveBytes, and nothing is written', async () => {
    const f = make({ media: { [M(1)]: doc('r'.repeat(90_000)), [M(2)]: vid() } })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const withFile = await f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(1) }] })
    const theirs = Array.from({ length: 5 }, (_, i) => ({ id: `ctl_file_${i}`, revision: 'r1', name: `n${i}`, status: 'ready' as const, text: 'z'.repeat(90_000) }))
    f.meetingFiles.putFiles(SESSION, theirs)
    const before = f.meetingFiles.files(SESSION)
    const err = await caught(bindNow(f, d.id, SESSION, 'web'))
    expect([err.code, err.status]).toEqual(['file_context_limit', 413])
    expect(err.extra).toMatchObject({ needBytes: 90_000, haveBytes: 50_000 })
    expect(f.meetingFiles.files(SESSION)).toEqual(before)
    expect(f.store.get(d.id)).toEqual(withFile)
    expect(f.store.readBindPayload(d.id, SESSION, withFile.revision)).toBeNull()
    // The file count too.
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `ctl_small_${i}`, revision: 'r1', name: `s${i}`, status: 'ready' as const, text: 'a' }))
    f.meetingFiles.putFiles('meeting_full_1', many)
    expect((await caught(bindNow(f, d.id, 'meeting_full_1', 'web'))).extra).toMatchObject({ needFiles: 101, haveFiles: 100 })
  })

  it('writes the intent first: a failed putFiles leaves the binding applying, and the exact retry applies it', async () => {
    const f = make({ media: { [M(1)]: doc('Renewal list'), [M(2)]: vid() } })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const ready = await f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(1) }] })
    const put = vi.spyOn(f.meetingFiles, 'putFiles').mockImplementationOnce(() => { throw new Error('disk') })
    await caught(bindNow(f, d.id, SESSION, 'web'))
    expect(f.store.get(d.id)!.bindings[0]).toMatchObject({ state: 'applying', revision: ready.revision })
    expect(f.meetingFiles.files(SESSION)).toEqual([])
    put.mockRestore()
    // An edit meanwhile must not leak into the retried bind: it re-applies the frozen rows.
    await f.runtime.patch(d.id, { revision: f.store.get(d.id)!.revision, steer: 'added later' })
    const retry = await f.runtime.bind(d.id, { revision: ready.revision, sessionId: SESSION, serverInstanceId: SERVER, surface: 'web' })
    expect(retry.draft.bindings[0].state).toBe('applied')
    expect(f.meetingFiles.files(SESSION).map(x => x.id)).toEqual([prepAdoptedFileId(d.id, ready.files[0].id)])
  })

  it('a replayed bind never brings back a file deleted since it was frozen', async () => {
    const f = make({ media: { [M(1)]: doc('Renewal list'), [M(2)]: doc('Pricing', 'Pricing.pdf') } })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const ready = await f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(1) }, { id: M(2) }] })
    const put = vi.spyOn(f.meetingFiles, 'putFiles').mockImplementationOnce(() => { throw new Error('disk') })
    await caught(bindNow(f, d.id, SESSION, 'web'))
    put.mockRestore()
    await f.runtime.removeFile(d.id, ready.files[1].id, f.store.get(d.id)!.revision)
    await f.runtime.bind(d.id, { revision: ready.revision, sessionId: SESSION, serverInstanceId: SERVER, surface: 'web' })
    const files = f.meetingFiles.files(SESSION)
    expect(files.find(x => x.id === prepAdoptedFileId(d.id, ready.files[1].id))).toMatchObject({ status: 'removed', text: '' })
    expect(files.find(x => x.id === prepAdoptedFileId(d.id, ready.files[0].id))!.status).toBe('ready')
  })

  it('history keeps each snapshot\'s own state: an interrupted apply then a rebind gives [applied (current), applying]', async () => {
    const f = make({ media: { [M(1)]: doc('Renewal list') } })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    await f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(1) }] })
    const put = vi.spyOn(f.meetingFiles, 'putFiles').mockImplementationOnce(() => { throw new Error('disk') })
    await caught(bindNow(f, d.id, SESSION, 'web'))
    put.mockRestore()
    await f.runtime.patch(d.id, { revision: f.store.get(d.id)!.revision, steer: 'Second try' })
    await bindNow(f, d.id, SESSION, 'control')
    expect(f.runtime.bySession(SESSION).map(r => [r.state, r.current, r.steer])).toEqual([['applied', true, 'Second try'], ['applying', false, '']])
    await f.runtime.unbind(d.id, SESSION)
    expect(f.runtime.bySession(SESSION).map(r => r.state)).toEqual(['removed', 'applying'])
  })

  it('a rebind adds a snapshot and keeps the earlier one, newest first, the latest marked current', async () => {
    const f = make({ media: { [M(1)]: doc('Renewal list'), [M(2)]: vid() } })
    const { d } = await bound(f)
    await f.runtime.patch(d.id, { revision: f.store.get(d.id)!.revision, steer: 'Second take' })
    await bindNow(f, d.id, SESSION, 'control')
    const rows = f.runtime.bySession(SESSION)
    expect(rows.map(r => [r.steer, r.current, r.surface])).toEqual([['Second take', true, 'control'], ['Push on renewals', false, 'web']])
    expect(rows[0].draftRevision).toBeGreaterThan(rows[1].draftRevision)
  })

  it('held notes are not repeated in the snapshot: steer is empty with held true', async () => {
    const f = make()
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const key = 'sk-ant-api03-' + 'B'.repeat(60)
    await f.runtime.patch(d.id, { revision: 1, steer: `use token ${key}` })
    await bindNow(f, d.id, SESSION, 'web')
    expect(f.meetingFiles.files(SESSION)[0]).toMatchObject({ status: 'secret-held', text: '' })
    const [row] = f.runtime.bySession(SESSION)
    expect([row.steer, row.held]).toEqual(['', true])
    expect(JSON.stringify(f.store.get(d.id)!.bindings)).not.toContain(key)
  })

  it('by-session returns the frozen snapshot: an edit after the bind leaves it unchanged', async () => {
    const f = make({ media: { [M(1)]: doc('Renewal list'), [M(2)]: vid() } })
    const { d } = await bound(f)
    const snap = f.runtime.bySession(SESSION)
    // The binding's own snapshot is exactly {draftRevision, steer, files}; title and start are frozen beside it.
    const binding = f.store.get(d.id)!.bindings[0]
    expect(Object.keys(binding.snapshot).sort()).toEqual(['draftRevision', 'files', 'steer'])
    expect([binding.title, binding.startsAt]).toEqual(['QBR', null])
    expect(snap).toEqual([expect.objectContaining({ draftId: d.id, sessionId: SESSION, state: 'applied', draftRevision: d.revision, title: 'QBR', steer: 'Push on renewals', files: [{ id: d.files[0].id, name: 'Brief.pdf', revision: expect.stringMatching(/^[0-9a-f]{32}$/), sha256: d.files[0].sha256 }] })])
    await f.runtime.patch(d.id, { revision: f.store.get(d.id)!.revision, title: 'Renamed', steer: 'Changed my mind' })
    await f.runtime.removeFile(d.id, d.files[1].id, f.store.get(d.id)!.revision)
    expect(f.runtime.bySession(SESSION)).toEqual(snap)
  })

  it('validates the meeting id and this server instance', async () => {
    const f = make({ media: { [M(1)]: doc('x'), [M(2)]: vid() } })
    const { d } = await bound(f)
    expect((await caught(bindNow(f, d.id, '../etc', 'web', SERVER))).code).toBe('invalid_session_id')
    const other = await caught(bindNow(f, d.id, SESSION, 'web', 'srv-old'))
    expect([other.code, other.status]).toEqual(['server_instance_mismatch', 409])
    expect((await caught(bindNow(f, d.id, SESSION, 'fax', SERVER))).code).toBe('invalid_surface')
  })

  it('deleting a file marks its copy removed in every bound meeting; the other copies stay', async () => {
    const f = make({ media: { [M(1)]: doc('Renewal list'), [M(2)]: vid() } })
    const { d, out } = await bound(f)
    const second = 'mac_12345678-1234-4234-8234-123456789abc'
    const two = await bindNow(f, d.id, second, 'control', SERVER)
    const after = await f.runtime.removeFile(d.id, d.files[0].id, two.draft.revision)
    expect(after.files[0].status).toBe('removed')
    for (const s of [SESSION, second]) {
      const copy = f.meetingFiles.files(s).find(x => x.id === prepAdoptedFileId(d.id, d.files[0].id))!
      expect(copy).toMatchObject({ status: 'removed', text: '', origin: 'prep' })
      expect(copy.revision).toBe(out.files.find(x => x.id === copy.id)!.revision)
      expect(f.meetingFiles.files(s).find(x => x.id === prepSteerFileId(d.id))!.status).toBe('ready')
    }
  })

  it('DELETE bind marks that meeting\'s copies removed and records removedAt', async () => {
    const f = make({ media: { [M(1)]: doc('Renewal list'), [M(2)]: vid() } })
    const { d } = await bound(f)
    const draft = await f.runtime.unbind(d.id, SESSION)
    expect(draft.bindings[0].removedAt).toBe(new Date(f.state.now).toISOString())
    expect(f.meetingFiles.files(SESSION).every(x => x.status === 'removed')).toBe(true)
    expect((await caught(f.runtime.unbind(d.id, 'meeting_never_bound'))).code).toBe('binding_not_found')
    // A meeting's saved review still lists the draft.
    expect(f.runtime.bySession(SESSION).map(x => x.draftId)).toEqual([d.id])
  })
})

describe('Prep for a meeting', () => {
  it('suggests at most 5, nearest start first, then drafts with no start, newest first', async () => {
    const f = make()
    const start = Date.parse('2026-11-06T22:00:00Z')
    f.state.now = start
    const mk = async (title: string, offsetMin: number | null) => { await f.runtime.create({ clientDraftId: uuid(), title, ...(offsetMin === null ? {} : { startsAt: new Date(start + offsetMin * 60_000).toISOString() }) }); f.state.now += 1000 }
    await mk('no start old', null); await mk('plus 50', 50); await mk('minus 10', -10); await mk('plus 5', 5); await mk('minus 80', -80); await mk('no start new', null)
    expect(f.runtime.suggest({ startedAt: String(start) }).map(d => d.title)).toEqual(['plus 5', 'minus 10', 'plus 50', 'minus 80', 'no start new'])
  })

  it('DELETE archives: state archived, files and snapshots kept, by-session still lists it', async () => {
    const f = make({ media: { [M(1)]: doc('Renewal list') } })
    const d = (await f.runtime.create({ clientDraftId: uuid(), title: 'QBR' })).draft
    await f.runtime.addFiles(d.id, { revision: 1, media: [{ id: M(1) }] })
    await bindNow(f, d.id, SESSION, 'web')
    const archived = await f.runtime.archive(d.id)
    expect(archived.state).toBe('archived')
    expect(archived.files).toHaveLength(1)
    expect(f.runtime.list({}).map(x => x.id)).toEqual([])
    expect(f.runtime.list({ state: 'archived' }).map(x => x.id)).toEqual([d.id])
    expect(f.runtime.bySession(SESSION).map(r => r.draftId)).toEqual([d.id])
    expect((await f.runtime.archive(d.id)).revision).toBe(archived.revision)   // idempotent
  })

  it('at 300 active drafts, create archives the oldest bound or long-past drafts; with none, 507 prep_draft_limit', async () => {
    const f = make()
    const base = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const b32 = (n: number) => Array.from({ length: 26 }, (_, k) => 'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(n / 32 ** Math.min(k, 3)) % 32]).join('')
    const now = f.state.now
    for (let i = 0; i < PREP_LIMITS.activeDrafts - 1; i++) f.store.write({ ...base, id: 'prep_' + b32(i + 1), clientDraftId: uuid(), updatedAt: new Date(now - (1000 - i) * 1000).toISOString() })
    const ids = f.store.list().map(x => x.id).filter(x => x !== base.id).sort()
    // Two qualify: one bound, one whose start was 8 days ago.
    const bound = f.store.get(ids[10])!, past = f.store.get(ids[20])!
    f.store.write({ ...bound, bindings: [{ sessionId: SESSION } as any] })
    f.store.write({ ...past, startsAt: new Date(now - 8 * 24 * 3600_000).toISOString() })
    const made = await f.runtime.create({ clientDraftId: uuid() })
    expect(made.created).toBe(true)
    expect(f.store.list().filter(x => x.state === 'active')).toHaveLength(PREP_LIMITS.activeDrafts)
    expect([f.store.get(bound.id)!.state, f.store.get(past.id)!.state].sort()).toEqual(['active', 'archived'])
    await f.runtime.create({ clientDraftId: uuid() })
    expect([f.store.get(bound.id)!.state, f.store.get(past.id)!.state]).toEqual(['archived', 'archived'])
    const full = await caught(f.runtime.create({ clientDraftId: uuid() }))
    expect([full.code, full.status]).toEqual(['prep_draft_limit', 507])
  }, 60_000)

  it('keeps a maxed draft loadable: answers capped, the file under the loader limit, read back after a restart', async () => {
    const f = make()
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    const draft = f.store.get(d.id)!
    draft.steer = 'n'.repeat(4000)
    draft.files = Array.from({ length: 10 }, (_, i) => ({ id: `pf_${String(i).padStart(16, '0')}`, mediaId: 'm_' + String(i).padStart(24, '0'), name: 'x'.repeat(240), mime: 'application/pdf', bytes: 1, sha256: 'a'.repeat(64), uploadSha256: 'a'.repeat(64), addedAt: d.createdAt, kind: 'document' as const, status: 'ready' as const, textChars: 1, source: 'upload' as const }))
    draft.runs = Array.from({ length: 50 }, (_, i) => ({ clientRequestId: uuid(), clientJobId: uuid(), jobId: `job-${i}`, sessionId: 'conv', draftRevision: 1, createdAt: d.createdAt, state: 'accepted' as const, fingerprint: 'f'.repeat(64), promptSha256: 'p'.repeat(64), steerSha256: 's'.repeat(64), files: draft.files.map(x => ({ id: x.id, sha256: 'a'.repeat(64) })), answer: '"'.repeat(25_000), settledAt: d.createdAt }))
    draft.snapshots = Array.from({ length: 60 }, (_, i) => ({ sessionId: `meeting_s${i % 3}`, state: 'applied' as const, boundAt: d.createdAt, surface: 'web' as const, title: 't'.repeat(300), startsAt: null, snapshot: { draftRevision: i, steer: 'n'.repeat(4000), files: draft.files.map(x => ({ id: x.id, name: x.name, revision: 'r'.repeat(32), sha256: 'a'.repeat(64) })) } }))
    capAnswers(draft)
    expect(draft.runs.reduce((n, r) => n + Buffer.byteLength(r.answer ?? '', 'utf8'), 0)).toBeLessThanOrEqual(PREP_LIMITS.draftAnswerBytes)
    f.store.write(draft)
    expect(Buffer.byteLength(JSON.stringify(f.store.get(d.id)), 'utf8')).toBeLessThan(DRAFT_LOAD_BYTES)
    expect(new PrepStore(f.store.root).get(d.id)?.runs).toHaveLength(50)
    // A draft the loader would refuse is never written.
    const huge = { ...draft, steer: 'x'.repeat(DRAFT_WRITE_BYTES) }
    expect(() => f.store.write(huge)).toThrow('prep_draft_too_large')
  })

  it('suggests by startsAt window or recent update, never binds, and by-session lists only bound drafts', async () => {
    const f = make()
    const start = Date.parse('2026-11-06T22:00:00Z')
    f.state.now = start - 10 * 60 * 60_000 // created long before the meeting
    const near = (await f.runtime.create({ clientDraftId: uuid(), title: 'near', startsAt: new Date(start + 45 * 60_000).toISOString() })).draft
    const early = (await f.runtime.create({ clientDraftId: uuid(), title: 'early', startsAt: new Date(start - 89 * 60_000).toISOString() })).draft
    await f.runtime.create({ clientDraftId: uuid(), title: 'far', startsAt: new Date(start + 61 * 60_000).toISOString() })
    await f.runtime.create({ clientDraftId: uuid(), title: 'no time' })
    f.state.now = start - 1 * 60 * 60_000
    const fresh = (await f.runtime.create({ clientDraftId: uuid(), title: 'fresh' })).draft
    f.state.now = start
    const got = f.runtime.suggest({ sessionId: SESSION, startedAt: String(start) })
    expect(got.map(d => d.title).sort()).toEqual(['early', 'fresh', 'near'])
    expect(got.every(d => d.bindings.length === 0)).toBe(true)
    expect(f.meetingFiles.files(SESSION)).toEqual([])
    expect(f.runtime.bySession(SESSION)).toEqual([])
    expect(near.id && early.id && fresh.id).toBeTruthy()
    expect((await caught(() => f.runtime.suggest({ startedAt: 'soon' }))).code).toBe('invalid_started_at')
  })
})

describe('the client job id', () => {
  it('is sha256("prep-run:v1:" + draftId:clientRequestId) in UUID v4 shape, deterministic per (draft, request)', async () => {
    const draft = 'prep_' + 'a'.repeat(26), rid = '11111111-1111-4111-8111-111111111111'
    const a = await prepClientJobId(draft, rid)
    const hex = createHash('sha256').update(`prep-run:v1:${draft}:${rid}`).digest('hex').split('')
    hex[12] = '4'; hex[16] = '89ab'[parseInt(hex[16], 16) & 3]
    const h = hex.join('')
    expect(a).toBe(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`)
    expect(PREP_UUID_V4.test(a)).toBe(true)
    expect(await prepClientJobId('prep_' + 'b'.repeat(26), rid)).not.toBe(a)
  })
})

describe('Prep stays out of the COS thread and the ordinary Ask path', () => {
  it('imports no thread, drop or conversation module, and the job it submits carries only Ask job fields', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./prep-runtime.ts', import.meta.url), 'utf8') + readFileSync(new URL('../routes/prep.ts', import.meta.url), 'utf8')
    const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1])
    expect(imports.filter(i => /cos-thread|drop-|conversation|ask-work-plan/.test(i))).toEqual([])
    const f = make({ media: { [M(1)]: doc('x') } })
    const d = (await f.runtime.create({ clientDraftId: uuid() })).draft
    await f.runtime.run(d.id, { clientRequestId: uuid(), revision: 1, continue: true })
    const sent = (f.jobs.prepare as any).mock.calls[0][0]
    expect(Object.keys(sent).sort()).toEqual(['clientJobId', 'generation', 'query', 'sessionName', 'source'])
  })
})

export type { PrepDraft }
