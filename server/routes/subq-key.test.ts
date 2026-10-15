import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'
import { requireApiToken } from '../lib/api-auth.js'
import { resolveSubqKey, saveSubqKey, subqKeyStatus, validateSubqKey } from '../lib/subq-key.js'
import { createSubqKeyRouter } from './subq-key.js'
const dirs:string[]=[],servers:Server[]=[]
afterEach(async()=>{dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(()=>r()))))})
const KEY='synthetic_subq_'+ 'k'.repeat(32)
async function setup(check:{ok:true}|{ok:false;status:number;reason:string}={ok:true}) {
  const status=vi.fn(()=>({configured:true,source:'config'})),save=vi.fn(),validate=vi.fn(async()=>check),remove=vi.fn(),reset=vi.fn()
  const app=express();app.use('/api',requireApiToken('test-token'));app.use(express.json());app.use('/api',createSubqKeyRouter({status,save,validate,remove,reset}))
  const server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});servers.push(server)
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`
  const call=(method:string,path:string,body?:unknown)=>fetch(base+path,{method,headers:{'X-COS-Token':'test-token','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
  return {base,call,save,validate,remove,reset}
}
it('requires API auth, validates before private save and never echoes the key',async()=>{
  const s=await setup();expect((await fetch(s.base+'/subq-key/status')).status).toBe(401)
  const response=await s.call('POST','/subq-key/set',{key:` ${KEY} `});expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(await response.text()).not.toContain(KEY)
  expect(s.validate).toHaveBeenCalledWith(KEY);expect(s.save).toHaveBeenCalledWith(KEY);expect(s.reset).toHaveBeenCalledOnce()
  expect((await s.call('DELETE','/subq-key')).status).toBe(200);expect(s.remove).toHaveBeenCalledOnce();expect(s.reset).toHaveBeenCalledTimes(2)
})
it('rejects malformed key bodies and does not save a refused key',async()=>{
  const s=await setup({ok:false,status:401,reason:'SubQ did not accept this key.'})
  for(const body of [{},{key:'short'},{key:KEY,extra:1},{key:KEY+' x'}])expect((await s.call('POST','/subq-key/set',body)).status).toBe(400)
  const rejected=await s.call('POST','/subq-key/set',{key:KEY});expect(rejected.status).toBe(400);expect(await rejected.json()).toMatchObject({error:{code:'subq_key_not_accepted',upstreamStatus:401}});expect(s.save).not.toHaveBeenCalled();expect(s.reset).not.toHaveBeenCalled()
})
it('uses the official free models endpoint with no redirect and requires Snap access',async()=>{
  const f=vi.fn(async()=>Response.json({data:[{id:'subq-snap-preview'}]}))
  expect(await validateSubqKey(KEY,f)).toEqual({ok:true});const [url,init]=f.mock.calls[0] as unknown as [string,RequestInit]
  expect(url).toBe('https://api.subq.ai/v1/models');expect(init.redirect).toBe('error');expect(init.headers).toEqual({Authorization:`Bearer ${KEY}`})
  expect(await validateSubqKey(KEY,vi.fn(async()=>Response.json({data:[{id:'subq-preview'}]})))).toMatchObject({ok:false,status:200})
  const failed=await validateSubqKey(KEY,vi.fn(async()=>{throw new Error(KEY)}));expect(JSON.stringify(failed)).not.toContain(KEY);expect(failed).toMatchObject({ok:false,status:0})
})
it('stores credentials at 0600, saved key wins, and a corrupt saved key never silently changes account',()=>{
  const dir=mkdtempSync(join(tmpdir(),'subq-key-test-'));dirs.push(dir);const file=join(dir,'key.json')
  expect(resolveSubqKey(file,{SUBQ_API_KEY:'environment-key'})).toEqual({key:'environment-key',source:'env'})
  saveSubqKey(KEY,file,new Date('2026-10-14T00:00:00Z'));expect(statSync(file).mode&0o777).toBe(0o600);expect(resolveSubqKey(file,{SUBQ_API_KEY:'environment-key'})).toMatchObject({key:KEY,source:'config'})
  expect(JSON.stringify(subqKeyStatus(resolveSubqKey(file,{})))).not.toContain(KEY)
  writeFileSync(file,'broken');expect(resolveSubqKey(file,{SUBQ_API_KEY:'environment-key'})).toBeNull()
  const target=join(dir,'target');writeFileSync(target,'keep');const link=join(dir,'link');symlinkSync(target,link)
  expect(()=>saveSubqKey(KEY,link)).toThrow();expect(resolveSubqKey(link,{SUBQ_API_KEY:'environment-key'})).toBeNull();expect(readFileSync(target,'utf8')).toBe('keep')
  const broken=join(dir,'dangling');symlinkSync(join(dir,'absent'),broken);expect(resolveSubqKey(broken,{SUBQ_API_KEY:'environment-key'})).toBeNull()
})
