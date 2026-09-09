import express from 'express'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../lib/python-bridge.js', () => ({ callPython: vi.fn(), contextSourceAvailable: () => null, pythonBridgeState: () => 'not_configured' }))
vi.mock('../lib/whisper-local.js', () => ({ resetDecoderCaches: vi.fn() }))
vi.mock('../lib/hallucination-filter.js', () => ({ resetVocabEchoCache: vi.fn() }))
import { memoryRouter } from './memory.js'
import { requireApiToken } from '../lib/api-auth.js'
import { clearProfileCache } from '../lib/profile.js'
import { callPython } from '../lib/python-bridge.js'
let root: string, base: string, listener: ReturnType<ReturnType<typeof express>['listen']>
beforeEach(async () => {
 root=mkdtempSync(join(tmpdir(),'owner-route-'));vi.stubEnv('COS_PROFILE_PATH',join(root,'profile.json'));clearProfileCache()
 const app=express();app.use('/api',requireApiToken('synthetic-owner-test'));app.use(express.json());app.use('/api',memoryRouter)
 listener=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server))})
 base=`http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/context`
})
afterEach(async()=>{await new Promise<void>(resolve=>listener.close(()=>resolve()));rmSync(root,{recursive:true,force:true});vi.unstubAllEnvs();clearProfileCache();vi.mocked(callPython).mockReset()})
const headers={'X-Cos-Token':'synthetic-owner-test','Content-Type':'application/json'}
const save=(body: unknown)=>fetch(`${base}/profile/owner`,{method:'POST',headers,body:JSON.stringify(body)})
it('requires pairing for both reads and writes',async()=>{
 expect((await fetch(`${base}/profile/owner`)).status).toBe(401)
 expect((await fetch(`${base}/profile/owner`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"owner_name":"Synthetic","expected_owner":null}'})).status).toBe(401)
})
it('supports first setup without a bridge and refuses stale edits',async()=>{
 expect(await (await fetch(`${base}/profile/owner`,{headers})).json()).toEqual({owner_name:null})
 expect((await save({owner_name:'Synthetic Owner',expected_owner:null})).status).toBe(200)
 expect((await save({owner_name:'Stale Edit',expected_owner:null})).status).toBe(409)
 expect(JSON.parse(readFileSync(join(root,'profile.json'),'utf8')).owner_name).toBe('Synthetic Owner')
 expect((await save({owner_name:'Other Owner',expected_owner:'Synthetic Owner',authority_host:'other'})).status).toBe(400)
})
it('handles malformed profiles without destroying them or exposing file paths',async()=>{
 for(const content of ['null','[]','broken']){
  writeFileSync(join(root,'profile.json'),content);clearProfileCache()
  expect((await fetch(`${base}/profile/owner`,{headers})).status).toBe(200)
  const result=await save({owner_name:'Synthetic Owner',expected_owner:null});expect(result.status).toBe(503)
  expect(await result.json()).toEqual({error:'profile_unreadable'});expect(readFileSync(join(root,'profile.json'),'utf8')).toBe(content)
 }
})
it('admits bounded graph overview through the real authenticated workspace route',async()=>{
 vi.mocked(callPython).mockResolvedValue({protocol:1,nodes:[{id:'Synthetic'}],links:[]})
 const response=await fetch(`${base}/memory/workspace`,{method:'POST',headers,body:JSON.stringify({action:'graph_overview'})})
 expect(response.status).toBe(200);expect((await response.json()).nodes).toEqual([{id:'Synthetic'}])
 expect(vi.mocked(callPython).mock.calls[0][0]).toEqual(['memory-workspace'])
})
