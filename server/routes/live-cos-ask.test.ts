import express from 'express'
import type { Server } from 'node:http'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { requireApiToken } from '../lib/api-auth.js'
const state = vi.hoisted(() => ({ open: true, run: vi.fn() }))
vi.mock('../lib/maintenance-lifecycle.js', () => ({ maintenanceAdmissionsOpen: () => state.open }))
vi.mock('../lib/meeting-ask-runtime.js',()=>({meetingAskRuntime:{legacy:state.run}}))
import { liveCosAskRouter } from './live-cos-ask.js'
let server: Server | undefined
let url = ''
async function start() {
 const app = express(); app.use('/api', requireApiToken('fixture-pairing-token')); app.use(express.json()); app.use('/api', liveCosAskRouter)
 await new Promise<void>(r => { server = app.listen(0,'127.0.0.1',()=> { const a=server!.address() as any; url=`http://127.0.0.1:${a.port}/api/meetings/live-ask`; r() }) })
}
const body = {sessionId:'meeting_test_one',action:'summary',question:'Summary',elapsedMs:1000,turns:[{id:1,speaker:'M',elapsedMs:0,text:'We agreed to review Friday.'}]}
afterEach(async()=>{if(server) await new Promise<void>(r=>server!.close(()=>r())); server=undefined; state.open=true; state.run.mockReset()})
describe('Live Ask HTTP boundary',()=>{
 it('requires existing pairing auth before admitting a call',async()=>{
  await start(); const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  expect(response.status).toBe(401); expect(state.run).not.toHaveBeenCalled()
 })
 it('validates input, respects maintenance and never leaks provider failures',async()=>{
  await start()
  const send=(v:unknown)=>fetch(url,{method:'POST',headers:{'x-cos-token':'fixture-pairing-token','content-type':'application/json'},body:JSON.stringify(v)})
  expect((await send({})).status).toBe(400); expect(state.run).not.toHaveBeenCalled()
  state.open=false; expect((await send(body)).status).toBe(503); expect(state.run).not.toHaveBeenCalled()
  state.open=true; state.run.mockRejectedValue(new Error('SECRET raw transcript or auth detail'))
  const failed=await send(body); expect(await failed.json()).toEqual({error:'haiku_unavailable'})
  state.run.mockResolvedValue({answer:'Review Friday [T1]',sources:[],notices:[],model:'haiku',throughMs:1000})
  const good=await send(body); expect(good.status).toBe(200); expect(good.headers.get('cache-control')).toBe('no-store')
 })
})
