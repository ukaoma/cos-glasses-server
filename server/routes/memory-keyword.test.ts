import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'
const fake=vi.hoisted(()=>({search:vi.fn(async()=>({hits:[],mode:'keyword',reason:'keyword_only'}))}))
vi.mock('../lib/context-library-search.js',()=>({searchMemories:fake.search}))
import { memoryRouter } from './memory.js'
let server:Server|null=null
const prior=process.env.COS_CONTEXT_DIR
let root=''
afterEach(async()=>{if(server)await new Promise<void>(r=>server!.close(()=>r()));server=null;if(root)rmSync(root,{recursive:true,force:true});if(prior===undefined)delete process.env.COS_CONTEXT_DIR;else process.env.COS_CONTEXT_DIR=prior;fake.search.mockClear()})
it('the new route explicitly suppresses semantic lookup; default search retains old behavior',async()=>{root=mkdtempSync(join(tmpdir(),'keyword-route-'));mkdirSync(join(root,'memory'));process.env.COS_CONTEXT_DIR=root;const app=express();app.use('/api',memoryRouter);server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const base=`http://127.0.0.1:${(server.address() as any).port}/api/memory/search`;expect((await fetch(base+'/keyword?q=budget&mode=meaning')).status).toBe(200);expect(fake.search).toHaveBeenLastCalledWith({query:'budget',limit:20,semantic:false});expect((await fetch(base+'?q=budget')).status).toBe(200);expect(fake.search).toHaveBeenLastCalledWith({query:'budget',limit:20});expect((await fetch(base+'/keyword?q=x')).status).toBe(400);expect(fake.search).toHaveBeenCalledTimes(2)})

it('keyword detail reads the same local file tier and refuses another id without invoking search',async()=>{
 root=mkdtempSync(join(tmpdir(),'keyword-detail-'));mkdirSync(join(root,'memory'));process.env.COS_CONTEXT_DIR=root
 const id='mem_20260809_120000_000001';writeFileSync(join(root,'memory','local.md'),'---\nid: '+id+'\n---\n# Local source\nPrivate retained file-tier evidence.')
 const app=express();app.use('/api',memoryRouter);server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const base=`http://127.0.0.1:${(server.address() as any).port}/api/memory/search/keyword`
 const reply=await fetch(base+'/'+id);expect(reply.status).toBe(200);expect(reply.headers.get('cache-control')).toContain('no-store');expect(await reply.json()).toMatchObject({id,content:expect.stringContaining('Private retained file-tier evidence.')})
 expect((await fetch(base+'/mem_20260809_120000_000002')).status).toBe(404);expect(fake.search).not.toHaveBeenCalled()
})
