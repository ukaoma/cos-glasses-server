import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { createWorkBoardRouter } from './work-board.js'
import { TaskBridgeError, rejectReservedWorkText } from '../lib/task-store.js'
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))) })
async function setup(writable = true) {
  const deps = { list: vi.fn(async () => [{ id:'a'.repeat(12), workStage:'built', workIdentity:'stable', workRevision:'b'.repeat(64), meetingRefs:[] }] as any),
    capabilities: vi.fn(async () => ({version:writable ? 1 : 0,writable})), stage:vi.fn(async()=>{}), link:vi.fn(async()=>{}),
    resolveMeeting: vi.fn(async()=>({recordId:'meeting:one',title:'Canonical title'}) as any) }
  const app=express();app.use(express.json({limit:'16kb'}));app.use('/api',(req,res,next)=>req.header('X-COS-Token')==='fixture-token'?next():res.sendStatus(401));app.use('/api',createWorkBoardRouter(deps))
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
