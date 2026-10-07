import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { createWorkBoardRouter } from './work-board.js'
import { requireApiToken } from '../lib/api-auth.js'
import { TaskBridgeError, rejectReservedWorkText } from '../lib/task-store.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listCosOperationsMeetings } from '../lib/cos-operations-meetings.js'
import { resolveSavedMeetingDetail } from './meetings.js'
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))) })
async function setup(writable = true, overrides: Record<string, unknown> = {}) {
  const deps = { journal: vi.fn((): any => ({available:true,receipts:[],drafts:[]})), list: vi.fn(async () => [{ id:'a'.repeat(12), workStage:'built', workIdentity:'stable', workRevision:'b'.repeat(64), meetingRefs:[] }] as any),
    capabilities: vi.fn(async () => ({version:writable ? 1 : 0,writable})), stage:vi.fn(async()=>{}), link:vi.fn(async()=>{}),
    resolveMeeting: vi.fn(async()=>({recordId:'meeting:one',title:'Canonical title'}) as any) }
  const app=express();app.use(express.json({limit:'16kb'}));app.use('/api',requireApiToken('fixture-token'));Object.assign(deps,overrides);app.use('/api',createWorkBoardRouter(deps))
  const server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});servers.push(server)
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/work-board`
  const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'X-COS-Token':'fixture-token','Content-Type':'application/json'},body:JSON.stringify(body)})
  return {deps,base,post}
}
const target={domain:'personal',id:'a'.repeat(12),expectedText:'Exact task',expectedRevision:'b'.repeat(64)}
const meeting={recordId:'meeting:one',domain:'personal',month:'2026-09',filename:'meeting.md',title:'Untrusted submitted title'}
it('requires auth and retains additive fields and explicit capability',async()=>{
  const s=await setup();expect((await fetch(s.base)).status).toBe(401)
  const body=await(await fetch(s.base,{headers:{'X-COS-Token':'fixture-token'}})).json()
  expect(body.capabilities).toEqual({version:1,writable:true});expect(body.tasks[0]).toMatchObject({workStage:'built',workIdentity:'stable',workRevision:target.expectedRevision})
})
it('6.65.0: serves the dated rows (createdOn, createdFrom, lineChangedAt) with an unchanged task revision',async()=>{
  const row={ id:'a'.repeat(12), domain:'personal', text:'Exact task', checked:false, workStage:'built', workIdentity:'stable', meetingRefs:[] }
  const dated={...row,createdOn:'2026-03-01',createdFrom:'git',lineChangedAt:'2026-04-15T12:00:00.000Z'}
  const plain=await setup(true,{list:vi.fn(async()=>[row])})
  const before=(await(await fetch(plain.base,{headers:{'X-COS-Token':'fixture-token'}})).json()).tasks[0]
  const s=await setup(true,{listDated:vi.fn(async()=>[dated])})
  const after=(await(await fetch(s.base,{headers:{'X-COS-Token':'fixture-token'}})).json()).tasks[0]
  expect(after).toMatchObject({createdOn:'2026-03-01',createdFrom:'git',lineChangedAt:'2026-04-15T12:00:00.000Z'})
  expect(after.taskRevision).toBe(before.taskRevision)  // what a handoff request names does not move
  expect(s.deps.list).not.toHaveBeenCalled()
})
it('passes one atomic stage operation including completion and exact CAS snapshot',async()=>{
  const s=await setup();expect((await s.post('/stage',{...target,workStage:'complete'})).status).toBe(200)
  expect(s.deps.stage).toHaveBeenCalledExactlyOnceWith(target.domain,target.id,'complete',target.expectedText,target.expectedRevision)
  expect(s.deps.link).not.toHaveBeenCalled()
})
it('old bridge permits reading but refuses both mutations',async()=>{
  const s=await setup(false)
  expect((await s.post('/stage',{...target,workStage:'qa'})).status).toBe(409)
  expect((await s.post('/meeting',{...target,meeting})).status).toBe(409)
  expect(s.deps.stage).not.toHaveBeenCalled();expect(s.deps.link).not.toHaveBeenCalled();expect(s.deps.resolveMeeting).not.toHaveBeenCalled()
})
it('refuses ordinal IDs, missing revisions, unknown phases, and extra authority fields',async()=>{
  const s=await setup()
  for(const patch of [{id:'personal-1'},{expectedRevision:''},{workStage:'published'},{checked:true}]) {
    expect((await s.post('/stage',{...target,workStage:'qa',...patch})).status).toBeGreaterThanOrEqual(400)
  }
  expect(s.deps.stage).not.toHaveBeenCalled()
})
it('resolves canonical meeting and ignores submitted title; mismatch never writes',async()=>{
  const s=await setup();expect((await s.post('/meeting',{...target,meeting})).status).toBe(200)
  expect(s.deps.link).toHaveBeenCalledExactlyOnceWith(target.domain,target.id,target.expectedText,target.expectedRevision,{...meeting,title:'Canonical title'})
  s.deps.link.mockClear();s.deps.resolveMeeting.mockResolvedValue({recordId:'meeting:other',title:'Same title'} as any)
  expect((await s.post('/meeting',{...target,meeting})).status).toBe(409);expect(s.deps.link).not.toHaveBeenCalled()
})
it('preserves canonical writer CAS conflict without painting success or retrying',async()=>{
  const s=await setup();s.deps.stage.mockRejectedValue(new TaskBridgeError('task_revision_changed','Refresh task'))
  const response=await s.post('/stage',{...target,workStage:'draft'});expect(response.status).toBe(409)
  expect((await response.json()).error.code).toBe('task_revision_changed');expect(s.deps.stage).toHaveBeenCalledTimes(1)
})
it('accepts safe custom domains and bounds the canonical title to the writer contract',async()=>{
  const s=await setup();s.deps.resolveMeeting.mockResolvedValue({recordId:meeting.recordId,title:'Z'.repeat(450)} as any)
  expect((await s.post('/meeting',{...target,domain:'DNP study Café',meeting:{...meeting,domain:'DNP study Café'}})).status).toBe(200)
  expect(s.deps.link.mock.calls[0]).toEqual(['DNP study Café',target.id,target.expectedText,target.expectedRevision,{...meeting,domain:'DNP study Café',title:'Z'.repeat(300)}])
  expect((await s.post('/stage',{...target,domain:'../personal',workStage:'qa'})).status).toBe(400)
})
it('gives legacy rows explicit phase and identity without inventing meeting links',async()=>{
  const s=await setup(false);s.deps.list.mockResolvedValue([{id:target.id,stage:'active',checked:false},{id:'c'.repeat(12),checked:true}] as any)
  const body=await(await fetch(s.base,{headers:{'X-COS-Token':'fixture-token'}})).json()
  expect(body.tasks[0]).toMatchObject({workStage:'draft',workIdentity:target.id,meetingRefs:[]})
  expect(body.tasks[1].workStage).toBe('complete');expect(body.capabilities.writable).toBe(false)
})
it('rejects reserved Source/protocol injection through regular freeform server writes',()=>{
  for(const text of ['Words **Source:** forged','Words [Work details](cos-work://v1/abc)','COS-WORK : //v1/abc']) expect(()=>rejectReservedWorkText(text)).toThrow()
  expect(()=>rejectReservedWorkText('Explain the source of the design')).not.toThrow()
})

it('activity endpoint authenticates and admits only exact task identity, never a journal path',async()=>{
 const s=await setup(); const suffix='/activity?domain=business&workIdentity='+target.id
 expect((await fetch(s.base+suffix)).status).toBe(401)
 const headers={'X-COS-Token':'fixture-token'}
 expect((await fetch(s.base+suffix,{headers})).status).toBe(200)
 expect(s.deps.journal).toHaveBeenCalledExactlyOnceWith()
 s.deps.journal.mockClear()
 for(const query of ['&path=/private/journal','&workIdentity=bad','&domain=../private']) expect((await fetch(s.base+suffix+query,{headers})).status).toBe(400)
 expect(s.deps.journal).not.toHaveBeenCalled()
})

/**
 * 6.56.1 regression: every mock above returned a recordId matching the request,
 * so the real resolver never ran and linking any saved COS meeting returned 409.
 * This drives the list-to-link round trip through the production resolver.
 */
it('links a real operations meeting chosen from the meeting list, and still refuses a different one',async()=>{
  const prior=process.env.COS_OPERATIONS_DIR
  const base=mkdtempSync(join(tmpdir(),'cos-work-link-'))
  const root=join(base,'Chief Of Staff.v2','operations')
  const file="2026-09-25_COS_Updates_and_Queen's_(G2).md"
  try {
    mkdirSync(join(root,'hermit_crabs','meetings','2026-09'),{recursive:true})
    writeFileSync(join(root,'hermit_crabs','meetings','2026-09',file),'# COS Updates and Glasses\n\n**Date** | 2026-09-25 09:00 |\n\n## Summary\nBody\n')
    process.env.COS_OPERATIONS_DIR=root
    const noStore={detail:()=>{throw new Error('standalone store must not answer an operations meeting')}} as any
    const s=await setup(true,{resolveMeeting:(d:any)=>resolveSavedMeetingDetail(d,noStore,{} as any)})
    const [row]=listCosOperationsMeetings({limit:5})
    const picked={domain:row.domain,month:row.month,filename:row.filename,recordId:row.recordId}
    const ok=await s.post('/meeting',{...target,meeting:picked})
    expect(ok.status).toBe(200)
    expect(s.deps.link).toHaveBeenCalledExactlyOnceWith(target.domain,target.id,target.expectedText,target.expectedRevision,
      {...picked,recordId:`ops:hermit_crabs:2026-09:${file}`,title:'COS Updates and Glasses'})
    const other=await s.post('/meeting',{...target,meeting:{...picked,recordId:'ops:hermit_crabs:2026-09:another.md'}})
    expect(other.status).toBe(409)
    expect((await other.json()).error.code).toBe('meeting_identity_changed')
    expect(s.deps.link).toHaveBeenCalledTimes(1)
  } finally {
    if(prior==null) delete process.env.COS_OPERATIONS_DIR; else process.env.COS_OPERATIONS_DIR=prior
    rmSync(base,{recursive:true,force:true})
  }
})

// ---- 6.59.0: S1 capabilities, task revision and saved destination, S2 open list over HTTP ----
import { realpathSync } from 'node:fs'
import { readWorkJournal, controlSnapshotRevision, WORK_ACTIVITY_STAGES } from '../lib/work-activity.js'
import { createWorkBoardReader } from '../lib/work-board-reader.js'
import { WORK_STAGES } from '../lib/task-store.js'
const identity = 'a'.repeat(12), X1 = 'codex:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', C1 = 'claude:11111111-2222-4333-8444-555555555555'
const secretWords = ['SECRET detail','SECRET prompt','SECRET result','Private task','SECRET event','SECRET draft prompt']
const tmpRoots: string[] = []
afterEach(() => { vi.restoreAllMocks(); tmpRoots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const receiptFor = (patch: Record<string, unknown> = {}) => ({ id:'one', workID:`task:business:${identity}`, workTitle:'Private task', sourceRevision:'r', mode:'continueSession', provider:'codex',
  modelID:'codex-frontier', sessionID:X1, sessionTitle:'Recorded target', status:'running', detail:'SECRET detail', prompt:'SECRET prompt', result:'SECRET result',
  createdAt:Math.floor(Date.now()/1000) - 60, progress:{ tag:identity, events:[{id:'e',at:Math.floor(Date.now()/1000) - 30,kind:'received',text:'SECRET event'}],
  reported:'needsInput', reportedBy:'session', evidence:'Which footer?', receivedAt:Math.floor(Date.now()/1000) - 30, seenReplies:[], notified:[] }, ...patch })
const boardRow = { id:identity, domain:'business', title:'Board title', text:'Board text', workIdentity:identity, workRevision:'b'.repeat(64), meetingRefs:[], checked:false }
function journalFile(receipts: unknown[], drafts: unknown[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'work-board-journal-'))); tmpRoots.push(root)
  const journalPath = join(root, 'handoffs.json'); writeFileSync(journalPath, JSON.stringify({ version:2, receipts, sessions:[], drafts }), { mode:0o600 })
  return () => readWorkJournal({ journalPath })
}
const headers = { 'X-COS-Token':'fixture-token' }
const noSecrets = (text: string) => { for (const word of secretWords) expect(text).not.toContain(word) }
const off = { requests:0, requestsInbox:0, requestsConsumerSeenAt:null }
const activityUrl = (base: string) => base + '/activity?domain=business&workIdentity=' + identity

it('stage names in the activity projection are the board\'s Work stages', () => {
  expect([...WORK_ACTIVITY_STAGES]).toEqual([...WORK_STAGES])
})
it('S1 through the production path: v1 and v2 journals, exact identity, capabilities, no private field', async () => {
  for (const version of [1, 2]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'work-board-journal-'))); tmpRoots.push(root)
    const journalPath = join(root, 'handoffs.json')
    writeFileSync(journalPath, JSON.stringify({ version, sessions:[], drafts:[], receipts:[receiptFor({ progress:undefined }), receiptFor({ id:'other', workID:`task:personal:${identity}` }),
      receiptFor({ id:'title', workID:'task:business:'+'b'.repeat(12), workTitle:'Same title' })] }), { mode:0o600 })
    const s = await setup(true, { journal: () => readWorkJournal({ journalPath }) }); s.deps.list.mockResolvedValue([boardRow])
    const text = await (await fetch(activityUrl(s.base), { headers })).text(), body = JSON.parse(text)
    expect(body).toMatchObject({ version:1, available:true, capabilities:{ progress:1, ...off }, taskRevision:controlSnapshotRevision(boardRow) })
    expect(body.activities.map((a: { id: string }) => a.id)).toEqual(['one'])
    noSecrets(text)
  }
})
it('S1 answers capabilities as the inbox says, and an unavailable journal still says so, with the task revision', async () => {
  const seen = { requests:1 as const, requestsInbox:1 as const, requestsConsumerSeenAt:'2026-09-30T15:00:00.000Z' }
  const s = await setup(true, { journal: () => ({ available:false, reason:'No native Work history is available on this host.' }), requests: () => seen })
  s.deps.list.mockResolvedValue([boardRow])
  expect(await (await fetch(activityUrl(s.base), { headers })).json())
    .toEqual({ version:1, available:false, reason:'No native Work history is available on this host.', capabilities:{ progress:1, ...seen }, activities:[], taskRevision:controlSnapshotRevision(boardRow) })
  const plain = await setup(true, { journal: journalFile([receiptFor()]) }); plain.deps.list.mockResolvedValue([boardRow])
  const body = await (await fetch(activityUrl(plain.base), { headers })).json()
  expect(body.capabilities).toEqual({ progress:1, ...off })
  expect(body.activities[0]).toMatchObject({ status:'running', progress:{ reported:'needsInput', evidence:'Which footer?' } })
})
it('S1 carries the saved destination and task revision at the top level, and answers without them past 3 s or on a board failure', async () => {
  const draft = { sourceID:`task:business:${identity}`, sourceRevision:controlSnapshotRevision(boardRow), mode:'fork', sessionID:C1, provider:'', modelID:'', prompt:'SECRET draft prompt', editVersion:2 }
  const s = await setup(true, { journal: journalFile([receiptFor()], [draft]) }); s.deps.list.mockResolvedValue([boardRow])
  const text = await (await fetch(activityUrl(s.base), { headers })).text(), body = JSON.parse(text)
  expect(body.savedDestination).toEqual({ mode:'fork', provider:'claude', sessionId:C1 }); expect(body.taskRevision).toBe(controlSnapshotRevision(boardRow)); noSecrets(text)
  expect(body.activities[0]).not.toHaveProperty('savedDestination')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const down = await setup(true, { journal: journalFile([receiptFor()], [draft]) }); down.deps.list.mockRejectedValue(new TaskBridgeError('invalid_task_inventory', 'x'))
  const failed = await (await fetch(activityUrl(down.base), { headers })).json()
  expect(failed.available).toBe(true); expect(failed.activities).toHaveLength(1); expect(failed).not.toHaveProperty('savedDestination'); expect(failed).not.toHaveProperty('taskRevision')
  expect(warn.mock.calls.map(call => String(call[0]))).toContain('[work-board] activity: answered without the board (invalid_task_inventory)')
  // A board that takes longer than 3 s: the activity answers at 3 s, without the board.
  let release!: () => void
  const slow = await setup(true, { journal: journalFile([receiptFor()], [draft]) })
  slow.deps.list.mockImplementation(() => new Promise(r => { release = () => r([boardRow] as any) }))
  const started = Date.now(), late = await (await fetch(activityUrl(slow.base), { headers })).json(), waited = Date.now() - started
  expect(waited).toBeGreaterThanOrEqual(2_900); expect(waited).toBeLessThan(4_500)
  expect(late.available).toBe(true); expect(late).not.toHaveProperty('savedDestination')
  expect(warn.mock.calls.map(call => String(call[0]))).toContain('[work-board] activity: answered without the board (work_board_timeout)')
  release()
}, 10_000)
it('GET /work-board carries each task\'s own revision and primes the glances\' board read', async () => {
  const s = await setup(true, { journal: journalFile([receiptFor()]) }); s.deps.list.mockResolvedValue([boardRow])
  const board = await (await fetch(s.base, { headers })).json()
  expect(board.tasks[0].taskRevision).toBe(controlSnapshotRevision(boardRow))
  await fetch(activityUrl(s.base), { headers })
  expect(s.deps.list).toHaveBeenCalledTimes(1)
})
it('S2 lists open work with board titles, total and truncated, takes no parameters, and says when the journal or board is unavailable', async () => {
  const s = await setup(true, { journal: journalFile([receiptFor()]), requests: () => ({ requests:1, requestsInbox:1, requestsConsumerSeenAt:null }) }); s.deps.list.mockResolvedValue([boardRow])
  expect((await fetch(s.base + '/activity/open')).status).toBe(401)
  const response = await fetch(s.base + '/activity/open', { headers }), text = await response.text(), body = JSON.parse(text)
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(body).toMatchObject({ version:1, available:true, capabilities:{ progress:1, requests:1 }, total:1, truncated:false })
  expect(body.items).toEqual([expect.objectContaining({ id:'one', workIdentity:identity, domain:'business', title:'Board title', group:'needsInput',
    taskRevision:controlSnapshotRevision(boardRow), progress:expect.objectContaining({ reported:'needsInput' }) })])
  noSecrets(text)
  for (const query of ['?domain=business', '?limit=100']) expect((await fetch(s.base + '/activity/open' + query, { headers })).status).toBe(400)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const down = await setup(true, { journal: journalFile([receiptFor()]) }); down.deps.list.mockRejectedValue(new Error('bridge down'))
  expect(await (await fetch(down.base + '/activity/open', { headers })).json()).toMatchObject({ available:false, items:[], total:0, truncated:false })
  expect(warn.mock.calls.map(call => String(call[0]))).toContain('[work-board] open work: answered without the board (work_board_unavailable)')
  const offJournal = await setup(true, { journal: () => ({ available:false, reason:'Native Work history is not safely readable.' }) })
  expect(await (await fetch(offJournal.base + '/activity/open', { headers })).json())
    .toEqual({ version:1, available:false, reason:'Native Work history is not safely readable.', capabilities:{ progress:1, ...off }, items:[], total:0, truncated:false })
  expect(offJournal.deps.list).not.toHaveBeenCalled()
})
it('S1 takes the revision from the task in the asked domain, never a same-identity task in another', async () => {
  const twin = { ...boardRow, domain:'personal', text:'Another domain\'s task with the same identity' }
  const s = await setup(true, { journal: journalFile([receiptFor()]) }); s.deps.list.mockResolvedValue([twin, boardRow])
  const body = await (await fetch(activityUrl(s.base), { headers })).json()
  expect(body.taskRevision).toBe(controlSnapshotRevision(boardRow)); expect(body.taskRevision).not.toBe(controlSnapshotRevision(twin))
})
it('the glances reuse one board read for 10 s, and a Work stage or meeting write drops it at once', async () => {
  let clock = 1_000_000
  const list = vi.fn(async () => [boardRow] as any)
  const readBoard = createWorkBoardReader<any>(() => list(), { now: () => clock })
  const s = await setup(true, { journal: journalFile([receiptFor()]), list, readBoard })
  const glance = async () => { await fetch(activityUrl(s.base), { headers }); await fetch(s.base + '/activity/open', { headers }) }
  await glance(); expect(list).toHaveBeenCalledTimes(1)
  clock += 10_000; await glance(); expect(list).toHaveBeenCalledTimes(1)
  clock += 1; await glance(); expect(list).toHaveBeenCalledTimes(2)
  // A stage move changes the board: the next glance reads it again, however fresh the cache was.
  expect((await s.post('/stage', { ...target, workStage:'qa' })).status).toBe(200)
  await glance(); expect(list).toHaveBeenCalledTimes(3)
  expect((await s.post('/meeting', { ...target, meeting })).status).toBe(200)
  await glance(); expect(list).toHaveBeenCalledTimes(4)
  // A write the task bridge refused may still have raced another writer: the cache goes all the same.
  s.deps.stage.mockRejectedValueOnce(new TaskBridgeError('task_revision_changed', 'Refresh task'))
  expect((await s.post('/stage', { ...target, workStage:'draft' })).status).toBe(409)
  await glance(); expect(list).toHaveBeenCalledTimes(5)
})
it('the shared board reader joins one read, and gives up at its bound while the read finishes for the next caller', async () => {
  let clock = 0, calls = 0, release!: (rows: number[]) => void
  const reader = createWorkBoardReader(() => { calls++; return new Promise<number[]>(r => { release = r }) }, { timeoutMs: 50, now: () => clock })
  const a = reader.read(10_000), b = reader.read(10_000)
  await new Promise(r => setTimeout(r, 0)); expect(calls).toBe(1)
  await expect(a).rejects.toThrow('work_board_timeout'); await expect(b).rejects.toThrow('work_board_timeout')
  clock = 20_000; release([1, 2])   // the read ends 20 s after it began
  await new Promise(r => setTimeout(r, 0))
  clock = 30_000; expect(await reader.read(10_000)).toEqual([1, 2]); expect(calls).toBe(1)   // age counts from its END: 10 s
  clock = 30_001
  const fresh = reader.read(10_000); await new Promise(r => setTimeout(r, 0)); expect(calls).toBe(2); release([3]); expect(await fresh).toEqual([3])
})
it('the reader serves a slow read after it ends (a running clock), keeps the newer of two reads, and forgets everything on invalidate', async () => {
  // A real clock: the read takes 300 ms, and is served for 200 ms after it ENDS although it began more than 200 ms ago.
  let calls = 0
  const slow = createWorkBoardReader(() => { calls++; return new Promise<number[]>(r => setTimeout(() => r([calls]), 300)) }, { timeoutMs: 2_000 })
  expect(await slow.read(200)).toEqual([1]); expect(await slow.read(200)).toEqual([1]); expect(calls).toBe(1)
  await new Promise(r => setTimeout(r, 260)); expect(await slow.read(200)).toEqual([2])

  // Newer wins: a read that began earlier and ends later never replaces what a later read cached.
  let clock = 0, release!: (rows: string[]) => void
  const reader = createWorkBoardReader(() => new Promise<string[]>(r => { release = r }), { timeoutMs: 1_000, now: () => clock })
  const early = reader.begin()                     // GET /api/work-board starts reading at 0
  clock = 5; const later = reader.read(0); await new Promise(r => setTimeout(r, 0)); clock = 6; release(['newer']); expect(await later).toEqual(['newer'])
  clock = 8; reader.prime(['older'], early)        // the early read ends last
  expect(await reader.read(10)).toEqual(['newer'])
  clock = 9; reader.prime(['newest'], reader.begin()); expect(await reader.read(10)).toEqual(['newest'])

  // Invalidate: the cache goes, and a read that began before the write is neither joined nor kept.
  clock = 100; const before = reader.read(0); await new Promise(r => setTimeout(r, 0)); const releaseBefore = release
  const token = reader.begin()
  reader.invalidate()
  const after = reader.read(1_000); await new Promise(r => setTimeout(r, 0)); const releaseAfter = release
  expect(releaseAfter).not.toBe(releaseBefore)     // a second read started: the first was not joined
  releaseAfter(['after the write']); expect(await after).toEqual(['after the write'])
  releaseBefore(['before the write']); expect(await before).toEqual(['before the write'])
  reader.prime(['also before the write'], token)
  expect(await reader.read(1_000)).toEqual(['after the write'])
})


it('task edit requires advertised capability, accepts one exact guarded payload, and returns the saved identity',async()=>{
  const saved={ok:true,id:target.id,workIdentity:target.id,workRevision:'c'.repeat(64),text:'Renamed task',doneWhen:'Reviewed'}
  const edit=vi.fn(async()=>saved)
  const legacy=await setup(true,{edit}); expect((await legacy.post('/edit',{...target,text:'Renamed task',doneWhen:'Reviewed'})).status).toBe(409)
  expect(edit).not.toHaveBeenCalled()
  const s=await setup(true,{edit,capabilities:async()=>({version:1,writable:true,editTasks:1})})
  const response=await s.post('/edit',{...target,text:'Renamed task',doneWhen:'Reviewed'})
  expect(response.status).toBe(200);expect(await response.json()).toEqual(saved)
  expect(edit).toHaveBeenCalledExactlyOnceWith(target.domain,target.id,'Renamed task','Reviewed',target.expectedText,target.expectedRevision)
  for(const extra of [{checked:true},{doneWhen:4},{text:4},{expectedRevision:''},{id:'ambiguous'}]) {
    expect((await s.post('/edit',{...target,text:'Renamed task',doneWhen:'Reviewed',...extra})).status).toBe(400)
  }
  expect(edit).toHaveBeenCalledTimes(1)
})
