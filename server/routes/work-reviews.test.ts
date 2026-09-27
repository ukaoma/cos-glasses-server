import express from 'express'
import { afterEach, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createWorkReviewsRouter } from './work-reviews.js'
import type { WorkReviewRuntime } from '../lib/work-review-runtime.js'
const servers: Server[]=[]
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(()=>r()))))})
async function start(runtime:WorkReviewRuntime|null){
 const app=express();app.use(express.json());app.use('/api',(req,res,next)=>{if(req.header('X-COS-Token')!=='disposable-token')return res.sendStatus(401);next()});app.use('/api',createWorkReviewsRouter(runtime));app.get('/api/base-health',(_req,res)=>res.json({ok:true}))
 const server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});servers.push(server)
 return `http://127.0.0.1:${(server.address() as {port:number}).port}/api/work-reviews`
}
it('auth boundary rejects anonymous reads/writes and disabled service never claims readiness',async()=>{
 const base=await start(null);expect((await fetch(base)).status).toBe(401)
 expect((await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401)
 const response=await fetch(base,{headers:{'X-COS-Token':'disposable-token'}})
 expect(response.status).toBe(404);expect((await response.json()).error.code).toBe('work_reviews_disabled')
 expect((await fetch(base.replace('/work-reviews','/base-health'),{headers:{'X-COS-Token':'disposable-token'}})).status).toBe(200)
})
it('projects manual-only capabilities and distinguishes created from repeated review',async()=>{
 let calls=0
 const runtime={capabilities:async()=>({manualReview:true,automaticAfterSync:false,reviewModels:[]}),list:async()=>[],request:async()=>({review:{id:'wr_test'},replayed:calls++>0}),get:async()=>({id:'wr_test'})} as unknown as WorkReviewRuntime
 const base=await start(runtime);const headers={'X-COS-Token':'disposable-token','content-type':'application/json'}
 const snapshot=await(await fetch(base,{headers})).json();expect(snapshot.capabilities.automaticAfterSync).toBe(false)
 expect((await fetch(base,{method:'POST',headers,body:'{}'})).status).toBe(202)
 expect((await fetch(base,{method:'POST',headers,body:'{}'})).status).toBe(200)
 expect((await(await fetch(base+'/wr_test',{headers})).json()).review.id).toBe('wr_test')
})
