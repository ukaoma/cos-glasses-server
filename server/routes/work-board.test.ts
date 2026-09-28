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
  const deps = { activity: vi.fn(() => ({version:1 as const,available:true,activities:[]})), list: vi.fn(async () => [{ id:'a'.repeat(12), workStage:'built', workIdentity:'stable', workRevision:'b'.repeat(64), meetingRefs:[] }] as any),
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
 expect(s.deps.activity).toHaveBeenCalledExactlyOnceWith('business',target.id)
 s.deps.activity.mockClear()
 for(const query of ['&path=/private/journal','&workIdentity=bad','&domain=../private']) expect((await fetch(s.base+suffix+query,{headers})).status).toBe(400)
 expect(s.deps.activity).not.toHaveBeenCalled()
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
