import { afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeetingAskRuntime, phoneMediaFile, PHONE_FILE_TEXT_BYTES, MEETING_ASK_CAPABILITIES } from './meeting-ask-runtime.js'
import { MeetingAskStore } from './meeting-ask-store.js'
import { MediaStore, MediaStoreError } from './media-store.js'
// 6.71.1: a file the phone uploads through /api/media joins a meeting's Ask file list.
const SESSION = 'meeting_phone_files'
const dirs: string[] = []
const temp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
function runtime(media: () => any, extra: Record<string, unknown> = {}) {
  const store = new MeetingAskStore(temp('ask-phone-'))
  const rt = new MeetingAskRuntime({ store, identity: () => 'server-one', admissions: () => true, lease: () => ({ release() {} } as any), catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'haiku', models: ['haiku'] }] as any, run: vi.fn(async () => ({ text: JSON.stringify({ sections: [{ label: 'So what', text: 'Uses the file [F1].' }] }), model: 'haiku' })), search: async () => ({ sources: [], notices: [] }), media, ...extra })
  return { rt, store, run: (rt as any).deps.run as ReturnType<typeof vi.fn> }
}
const ref = (id: string, category: 'image' | 'document' | 'video', label?: string) => ({ id, kind: category === 'image' ? 'user_photo' : category === 'video' ? 'user_video' : 'user_document', category, mime: 'text/plain', width: 0, height: 0, createdAt: '2026-10-11T00:00:00Z', ...(label ? { label } : {}) })
const fake = (records: Record<string, { category: 'image' | 'document' | 'video'; text?: string; label?: string; truncated?: boolean } | string>): (() => any) => () => ({
  resolveUsable: (id: string) => { const r = records[id]; if (!r) throw new MediaStoreError('media_not_found', id); if (typeof r === 'string') throw new MediaStoreError(r as any, id); return { record: { ref: { ...ref(id, r.category, r.label), ...(r.truncated ? { truncated: true } : {}) }, sha256: 'abc123def456abc123', createdAtMs: 1 }, path: '/x' } },
  resolveModelDerivatives: (id: string) => { const r = records[id] as any; return { record: { ref: ref(id, r.category, r.label), sha256: 'abc123def456abc123', createdAtMs: 1 }, originalPath: '/x', ...(r.text !== undefined ? { text: r.text } : {}), imagePaths: [] } },
})
const M = (n: number) => `m_${String(n).padStart(24, '0')}`

describe('Meeting Ask phone files: real media store', () => {
  it('a text upload becomes a ready meeting file that the next Ask cites as F1; Control rows stay; re-adding is idempotent', async () => {
    const media = new MediaStore(temp('ask-media-'))
    const doc = await media.ingestRichMedia({ bytes: Buffer.from('Q4 price list: Starter is 59 a month.\n'), label: 'pricing.txt', declaredMime: 'text/plain' })
    const f = runtime(() => media), { rt } = f
    rt.putFiles(SESSION, 'server-one', [{ id: 'file_control1', revision: 'r1', name: 'Agenda', status: 'ready', text: 'Agenda text' }])
    const files = rt.attachMedia(SESSION, 'server-one', [{ id: doc.id, name: 'Q4 pricing.txt' }])
    const row = files.find(f => f.id === `phone_${doc.id}`)!
    expect(row).toMatchObject({ name: 'Q4 pricing.txt', status: 'ready', origin: 'phone', text: 'Q4 price list: Starter is 59 a month.' })
    expect(row.revision).toMatch(/^[A-Za-z0-9_.:-]{1,16}$/)
    expect(files.map(f => f.id)).toEqual(['file_control1', `phone_${doc.id}`])
    expect(rt.attachMedia(SESSION, 'server-one', [{ id: doc.id, name: 'Q4 pricing.txt' }])).toEqual(files)
    expect(rt.history(SESSION, 'server-one').files).toEqual(files)
    await rt.submit({ requestId: 'request_phone001', sessionId: SESSION, serverInstanceId: 'server-one', action: 'ask', question: 'What is the price?', elapsedMs: 1000, turns: [{ id: 0, elapsedMs: 0, speaker: 'A', text: 'Pricing?' }] })
    for (let i = 0; i < 100 && ['pending', 'running'].includes(rt.get('request_phone001').status); i++) await new Promise(r => setTimeout(r, 2))
    const e = rt.get('request_phone001')
    expect(e.status).toBe('completed'); expect(e.files.map(f => f.id)).toContain(`phone_${doc.id}`); expect(f.run.mock.calls[0][1]).toContain('Q4 price list: Starter is 59 a month.')
  })
  it('refined direct submissions retain phone evidence, keyword COS search, preset web guard and retry identity', async () => {
    const media = new MediaStore(temp('ask-media-'))
    const doc = await media.ingestRichMedia({ bytes: Buffer.from('Starter costs 59 a month.'), label: 'pricing.txt', declaredMime: 'text/plain' })
    const refine = vi.fn(input => ({ input: { ...input, turns: [{ ...input.turns[0], text: 'Friday review, not Monday. The price is 59.' }] }, notices: ['Verified earlier passage.'] }))
    const search = vi.fn(async (_q: string, _s: string | undefined, _signal: AbortSignal, _mode: string) => ({ sources: [], notices: ['COS search used keywords only, as set in Meeting assistant settings.'] }))
    const webSearch = vi.fn()
    const run = vi.fn().mockResolvedValueOnce({ text: JSON.stringify({ sections: [], searchQuery: 'earlier pricing', searchScope: 'web' }), model: 'haiku' }).mockResolvedValue({ text: JSON.stringify({ sections: [{ label: 'So what', text: 'Friday review [T1].' }, { label: 'Ask', text: 'Is the price still 59? The file confirms it [F1].' }] }), model: 'haiku' })
    const { rt } = runtime(() => media, { refine, search, webSearch, run, webCapability: () => ({ available: true }) })
    try {
      await rt.setConfig({ cosSearch: 'keyword' })
      rt.attachMedia(SESSION, 'server-one', [{ id: doc.id }])
      const submitted = { requestId: 'request_combined1', sessionId: SESSION, serverInstanceId: 'server-one', action: 'questions', question: '', elapsedMs: 1000, turns: [{ id: 4, elapsedMs: 100, speaker: 'A', text: 'Friday review.' }] }
      await rt.submit(submitted)
      for (let i = 0; i < 200 && ['pending', 'running'].includes(rt.get(submitted.requestId).status); i++) await new Promise(r => setTimeout(r, 2))
      const e = rt.get(submitted.requestId)
      expect(e.status).toBe('completed')
      expect(e.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'T1', text: 'Friday review, not Monday. The price is 59.' }), expect.objectContaining({ id: 'F1', text: 'Starter costs 59 a month.' })]))
      expect(e.notices).toContain('Verified earlier passage.')
      expect(search).toHaveBeenCalledTimes(1); expect(search.mock.calls[0][3]).toBe('keyword')
      expect(webSearch).not.toHaveBeenCalled()
      expect(run).toHaveBeenCalledTimes(2)
      expect(run.mock.calls[0][1]).toContain('Starter costs 59 a month.')
      expect(run.mock.calls[0][1]).toContain('Friday review, not Monday.')
      await rt.submit(submitted)
      expect(refine).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(2)
      await expect(rt.submit({ ...submitted, turns: [{ ...submitted.turns[0], text: 'Changed' }] })).rejects.toMatchObject({ reason: 'request_id_conflict' })
    } finally { await rt.shutdown() }
  })
  it('a secret in the text is held, the same rule as Control', async () => {
    const media = new MediaStore(temp('ask-media-'))
    const doc = await media.ingestRichMedia({ bytes: Buffer.from('api key sk-abcdefghijklmnopqrstuvwx\n'), label: 'keys.txt', declaredMime: 'text/plain' })
    const [row] = runtime(() => media).rt.attachMedia(SESSION, 'server-one', [{ id: doc.id }])
    expect(row).toMatchObject({ status: 'secret-held', text: '', name: 'keys.txt' })
  })
})

describe('Meeting Ask phone files: statuses and limits', () => {
  it('photos and videos are unsupported with a notice; a document with no words or no extract says so', () => {
    const media = fake({ [M(1)]: { category: 'image', label: 'IMG_1.jpg' }, [M(2)]: { category: 'video' }, [M(3)]: { category: 'document', text: '  \n ' }, [M(4)]: { category: 'document' } })
    const rows = [1, 2, 3, 4].map(n => phoneMediaFile(media, { id: M(n) }))
    expect(rows.map(r => [r.status, r.notice])).toEqual([
      ['unsupported', "Photos can't be read from the phone yet. Add them from COS Control on your Mac."],
      ['unsupported', "Videos can't be read from the phone yet. Add them from COS Control on your Mac."],
      ['unsupported', 'No words were found in it.'],
      ['failed', 'The text of this file is not available.'],
    ])
    expect(rows[0].name).toBe('IMG_1.jpg'); expect(rows[1].name).toBe(M(2))
    expect(rows.map(r => r.id)).toEqual([1, 2, 3, 4].map(n => `phone_${M(n)}`)); expect(rows.every(r => r.text === '' && r.origin === 'phone')).toBe(true)
  })
  it('caps text at 100,000 bytes without splitting a character, with a notice; a truncated upload says so too', () => {
    // One ASCII byte first, so the cap falls inside a two-byte character.
    const long = 'a' + 'é'.repeat(60_000) // 120,001 bytes
    const row = phoneMediaFile(fake({ [M(1)]: { category: 'document', text: long } }), { id: M(1) })
    expect(Buffer.byteLength(row.text, 'utf8')).toBe(PHONE_FILE_TEXT_BYTES - 1); expect(row.text).not.toContain('\uFFFD'); expect(row.text.endsWith('é')).toBe(true)
    expect(row.notice).toBe('Only the first part of this file is used.')
    expect(phoneMediaFile(fake({ [M(2)]: { category: 'document', text: 'short' } }), { id: M(2) }).notice).toBeUndefined()
    expect(phoneMediaFile(fake({ [M(3)]: { category: 'document', text: 'short', truncated: true } }), { id: M(3) }).notice).toBe('Only the first part of this file is used.')
  })
  it('maps media errors to their own codes and statuses', () => {
    const media = fake({ [M(2)]: 'media_expired', [M(3)]: 'media_conflict', [M(4)]: 'media_unavailable' })
    for (const [n, reason, status] of [[1, 'media_not_found', 404], [2, 'media_expired', 410], [3, 'media_conflict', 409], [4, 'media_unavailable', 503]] as const) {
      expect(() => phoneMediaFile(media, { id: M(n) })).toThrow(expect.objectContaining({ reason, status }))
    }
  })
  it('validates the request and writes nothing on a bad one', () => {
    const { rt } = runtime(fake({ [M(1)]: { category: 'document', text: 'x' } }))
    for (const bad of [undefined, [], [{ id: 'nope' }], Array.from({ length: 11 }, (_, i) => ({ id: M(i) })), [{ id: M(1) }, { id: M(1) }], [{ id: M(1), name: 7 }], [{ id: M(1), name: 'n'.repeat(241) }]]) {
      expect(() => rt.attachMedia(SESSION, 'server-one', bad)).toThrow(expect.objectContaining({ reason: 'invalid_media' }))
    }
    // A bad session is refused before any upload is looked up.
    expect(() => rt.attachMedia('bad session', 'server-one', [{ id: M(9) }])).toThrow(expect.objectContaining({ reason: 'invalid_session_id' }))
    expect(() => rt.attachMedia(SESSION, 'other-server', [{ id: M(1) }])).toThrow(expect.objectContaining({ reason: 'server_instance_mismatch' }))
    expect(() => rt.attachMedia(SESSION, 'server-one', [{ id: M(1) }, { id: M(9) }])).toThrow(expect.objectContaining({ reason: 'media_not_found' }))
    expect(rt.history(SESSION, 'server-one').files).toEqual([])
    const closed = runtime(fake({ [M(1)]: { category: 'document', text: 'x' } }), { admissions: () => false }).rt
    expect(() => closed.attachMedia(SESSION, 'server-one', [{ id: M(1) }])).toThrow(expect.objectContaining({ reason: 'maintenance' }))
  })
  it('keeps the meeting file limits: more than 500,000 bytes of text is file_context_limit', () => {
    const records = Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [M(n), { category: 'document' as const, text: 'a'.repeat(99_000) }]))
    const { rt } = runtime(fake(records))
    rt.attachMedia(SESSION, 'server-one', [1, 2, 3, 4, 5].map(n => ({ id: M(n) })))
    expect(() => rt.attachMedia(SESSION, 'server-one', [{ id: M(6) }])).toThrow(expect.objectContaining({ reason: 'file_context_limit', status: 413 }))
  })
  it('advertises phoneFiles in the capabilities', () => {
    expect(MEETING_ASK_CAPABILITIES.phoneFiles).toBe(true)
  })
})

describe('Phone image evidence through the HTTP adapter', () => {
  it('reads image text and preserves Control files; the next Ask freezes and cites the image revision', async () => {
    const readImage = vi.fn(async () => ({text:'Rank | Name | Crit Value\n1 | Mavuika | 232.4 cv\n2 | Wanderer | 222.3 cv',lowConfidence:true}));
    const {rt,run}=runtime(fake({[M(1)]:{category:'image',label:'stats.jpg'}}),{readImage});
    const files=await rt.attachMediaReadable(SESSION,'server-one',[{id:M(1)}]);
    expect(files[0]).toMatchObject({status:'ready',origin:'phone'});
    expect(files[0].text).toContain('1 | Mavuika | 232.4');
    expect(files[0].notice).toContain('hard to read');
    expect(files[0].revision).toHaveLength(32);
    await rt.submit({requestId:'request_image001',sessionId:SESSION,serverInstanceId:'server-one',action:'ask',question:'Who is top by crit value?',elapsedMs:1000,turns:[{id:0,elapsedMs:0,speaker:'A',text:'See my character table.'}]});
    for(let i=0;i<100&&['pending','running'].includes(rt.get('request_image001').status);i++)await new Promise(r=>setTimeout(r,2));
    const e=rt.get('request_image001');expect(e.status).toBe('completed');expect(e.sources.some(s=>s.id==='F1'&&s.text.includes('Mavuika'))).toBe(true);
    expect(run.mock.calls[0][1]).toContain('OCR may misread');
    rt.putFiles(SESSION,'server-one',[{...files[0],status:'removed',text:''}]);
    expect(rt.get('request_image001').files[0].status).toBe('ready');
    await rt.shutdown();
  });
  it('holds credentials past the text cap and never sends or stores them',async()=>{
    const readImage=vi.fn(async()=>({text:'a'.repeat(110000)+'\nAPI Key: secret123456',lowConfidence:false}));
    const {rt}=runtime(fake({[M(1)]:{category:'image'}}),{readImage});
    const [f]=await rt.attachMediaReadable(SESSION,'server-one',[{id:M(1)}]);
    expect(f.status).toBe('secret-held');expect(f.text).toBe('');
    expect(JSON.stringify(rt.history(SESSION,'server-one'))).not.toContain('secret123456');
  });
  it('empty, unsupported-platform and timed-out OCR stay honest; a retry can succeed',async()=>{
    const readImage=vi.fn().mockResolvedValueOnce({text:'',lowConfidence:false}).mockRejectedValueOnce(new Error('ocr_failed')).mockResolvedValue({text:'New text',lowConfidence:false});
    const {rt}=runtime(fake({[M(1)]:{category:'image'}}),{readImage});
    expect((await rt.attachMediaReadable(SESSION,'server-one',[{id:M(1)}]))[0].status).toBe('unsupported');
    expect((await rt.attachMediaReadable(SESSION,'server-one',[{id:M(1)}]))[0].status).toBe('failed');
    expect((await rt.attachMediaReadable(SESSION,'server-one',[{id:M(1)}]))[0].status).toBe('ready');
  });
  it('rejects deletion and concurrent removal during OCR without reviving the file',async()=>{
    const records:any={[M(1)]:{category:'image'}};
    let release!:(v:any)=>void;
    const {rt}=runtime(fake(records),{readImage:()=>new Promise(r=>{release=r})});
    const promise=rt.attachMediaReadable(SESSION,'server-one',[{id:M(1)}]);
    delete records[M(1)];release({text:'Picture words',lowConfidence:false});
    await expect(promise).rejects.toMatchObject({reason:'media_not_found'});
    expect(rt.history(SESSION,'server-one').files).toEqual([]);
    records[M(1)]={category:'image'};
    const p2=rt.attachMediaReadable(SESSION,'server-one',[{id:M(1)}]);
    rt.putFiles(SESSION,'server-one',[{id:`phone_${M(1)}`,revision:'r1',name:'Removed',text:'',status:'removed'}]);
    release({text:'Picture words',lowConfidence:false});
    await expect(p2).rejects.toMatchObject({reason:'file_revision_conflict'});
    expect(rt.history(SESSION,'server-one').files[0].status).toBe('removed');
  });
  it('draining or shutdown aborts image admission and releases the maintenance lease',async()=>{
    const release=vi.fn();let admitted=true;
    let finish!:(v:any)=>void;
    const {rt}=runtime(fake({[M(1)]:{category:'image'}}),{admissions:()=>admitted,lease:()=>({release}),readImage:(_path:string,signal:AbortSignal)=>new Promise((r,reject)=>{finish=r;signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})})});
    const p=rt.attachMediaReadable(SESSION,'server-one',[{id:M(1)}]);admitted=false;finish({text:'Read text',lowConfidence:false});
    await expect(p).rejects.toMatchObject({reason:'maintenance'});expect(release).toHaveBeenCalledOnce();
    admitted=true;
    const p2=rt.attachMediaReadable(SESSION,'server-one',[{id:M(1)}]);const rejection=expect(p2).rejects.toMatchObject({reason:'maintenance'});await rt.shutdown();
    await rejection;expect(release).toHaveBeenCalledTimes(2);
  });
});
