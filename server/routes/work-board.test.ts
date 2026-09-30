import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { createWorkBoardRouter } from './work-board.js'
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
  const app=express();app.use(express.json({limit:'16kb'}));app.use('/api',(req,res,next)=>req.header('X-COS-Token')==='fixture-token'?next():res.sendStatus(401));Object.assign(deps,overrides);app.use('/api',createWorkBoardRouter(deps))
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

// ---- 6.59.0: S1 capabilities and saved destination, S2 open list over HTTP ----
import { realpathSync } from 'node:fs'
import { readWorkJournal, controlSnapshotRevision, WORK_ACTIVITY_STAGES } from '../lib/work-activity.js'
import { WORK_STAGES } from '../lib/task-store.js'
const identity = 'a'.repeat(12)
const secretWords = ['SECRET detail','SECRET prompt','SECRET result','Private task','SECRET event','SECRET draft prompt']
const tmpRoots: string[] = []
afterEach(() => tmpRoots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const receiptFor = (patch: Record<string, unknown> = {}) => ({ id:'one', workID:`task:business:${identity}`, workTitle:'Private task', sourceRevision:'r', mode:'continueSession', provider:'codex',
  modelID:'codex-frontier', sessionID:'codex:owned', sessionTitle:'Recorded target', status:'running', detail:'SECRET detail', prompt:'SECRET prompt', result:'SECRET result',
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

it('stage names in the activity projection are the board\'s Work stages', () => {
  expect([...WORK_ACTIVITY_STAGES]).toEqual([...WORK_STAGES])
})
it('S1 answers capabilities with progress, and requests only when the inbox opened; an unavailable journal still says so', async () => {
  const off = await setup(true, { journal: journalFile([receiptFor()]) })
  const body = await (await fetch(off.base + '/activity?domain=business&workIdentity=' + identity, { headers })).json()
  expect(body.capabilities).toEqual({ progress:1, requests:0 }); expect(body.activities[0]).toMatchObject({ status:'running', progress:{ reported:'needsInput', evidence:'Which footer?' } })
  const on = await setup(true, { journal: () => ({ available:false, reason:'No native Work history is available on this host.' }), requestsAvailable: () => true })
  expect(await (await fetch(on.base + '/activity?domain=business&workIdentity=' + identity, { headers })).json())
    .toEqual({ version:1, available:false, reason:'No native Work history is available on this host.', capabilities:{ progress:1, requests:1 }, activities:[] })
})
it('S1 carries the saved destination at the top level, reads the board only when a draft exists, and survives a board failure', async () => {
  const draft = { sourceID:`task:business:${identity}`, sourceRevision:controlSnapshotRevision(boardRow), mode:'fork', sessionID:'claude:parent-1', provider:'', modelID:'', prompt:'SECRET draft prompt', editVersion:2 }
  const s = await setup(true, { journal: journalFile([receiptFor()], [draft]) }); s.deps.list.mockResolvedValue([boardRow])
  const response = await fetch(s.base + '/activity?domain=business&workIdentity=' + identity, { headers }), text = await response.text()
  expect(JSON.parse(text).savedDestination).toEqual({ mode:'fork', provider:'claude', sessionId:'claude:parent-1' }); noSecrets(text)
  expect(JSON.parse(text).activities[0]).not.toHaveProperty('savedDestination')
  const none = await setup(true, { journal: journalFile([receiptFor()]) })
  await fetch(none.base + '/activity?domain=business&workIdentity=' + identity, { headers }); expect(none.deps.list).not.toHaveBeenCalled()
  const down = await setup(true, { journal: journalFile([receiptFor()], [draft]) }); down.deps.list.mockRejectedValue(new Error('bridge down'))
  const body = await (await fetch(down.base + '/activity?domain=business&workIdentity=' + identity, { headers })).json()
  expect(body.available).toBe(true); expect(body.activities).toHaveLength(1); expect(body).not.toHaveProperty('savedDestination')
})
it('S2 lists open work with board titles, takes no parameters, and says when the journal or board is unavailable', async () => {
  const s = await setup(true, { journal: journalFile([receiptFor()]), requestsAvailable: () => true }); s.deps.list.mockResolvedValue([boardRow])
  expect((await fetch(s.base + '/activity/open')).status).toBe(401)
  const response = await fetch(s.base + '/activity/open', { headers }), text = await response.text(), body = JSON.parse(text)
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(body).toMatchObject({ version:1, available:true, capabilities:{ progress:1, requests:1 } })
  expect(body.items).toEqual([expect.objectContaining({ id:'one', workIdentity:identity, domain:'business', title:'Board title', progress:expect.objectContaining({ reported:'needsInput' }) })])
  noSecrets(text)
  for (const query of ['?domain=business', '?limit=100']) expect((await fetch(s.base + '/activity/open' + query, { headers })).status).toBe(400)
  s.deps.list.mockRejectedValue(new Error('bridge down'))
  expect(await (await fetch(s.base + '/activity/open', { headers })).json()).toMatchObject({ available:false, items:[] })
  const off = await setup(true, { journal: () => ({ available:false, reason:'Native Work history is not safely readable.' }) })
  expect(await (await fetch(off.base + '/activity/open', { headers })).json())
    .toEqual({ version:1, available:false, reason:'Native Work history is not safely readable.', capabilities:{ progress:1, requests:0 }, items:[] })
  expect(off.deps.list).not.toHaveBeenCalled()
})
