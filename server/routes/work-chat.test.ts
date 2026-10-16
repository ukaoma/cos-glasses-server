import express from 'express'
import { expect,it,vi } from 'vitest'
import { type Server } from 'node:http'
import { createWorkChatRouter } from './work-chat.js'
import { WORK_CHAT_OUTPUT_TOKENS } from '../lib/work-chat.js'
const budget=(effort:string,thinking:number)=>({effort,maxOutputTokens:WORK_CHAT_OUTPUT_TOKENS,maxThinkingTokens:thinking,deadlineMs:180000})
const input={workID:'task:quilt:aaaaaaaaaaaa',revision:'a'.repeat(64),question:'What needs my review?',context:'Evidence only',sessions:[],history:[],updates:[],mode:'plan'}
async function setup(run:any) {
 const release=vi.fn(),deps={run,admissions:()=>true,lease:()=>({release})}
 const app=express();app.use(express.json({limit:110000}));app.use('/api',(req,res,next)=>req.header('X-Cos-Token')==='t'?next():res.sendStatus(401));app.use('/api',createWorkChatRouter(deps as any))
 const server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))})
 const url=`http://127.0.0.1:${(server.address() as any).port}/api/work/chat`
 const post=(body:any,token='t')=>fetch(url,{method:'POST',headers:{'content-type':'application/json','X-Cos-Token':token},body:JSON.stringify(body)})
 return {server,post,release,url}
}
it('authenticates and uses tools-off Sonnet with a task-chat audit label',async()=>{
 const run=vi.fn(async()=>({text:JSON.stringify({answer:'Review is pending.',assignments:[]}),model:'sonnet'})),s=await setup(run)
 try {
 expect((await s.post(input,'wrong')).status).toBe(401);expect(run).not.toHaveBeenCalled()
 const result=await s.post(input);expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('private, no-store')
 expect(await result.json()).toMatchObject({protocolVersion:1,answer:'Review is pending.',assignments:[]})
 expect((run.mock.calls as any)[0][0]).toEqual({engine:'claude',model:'sonnet'});expect((run.mock.calls as any)[0][5]).toEqual({caller:'work_chat_plan'});expect(s.release).toHaveBeenCalledOnce()
 }finally{s.server.close()}
})
it('malformed input never invokes a provider and failures never imply a send',async()=>{
 const run=vi.fn(async()=>{throw new Error('private credential info')}),s=await setup(run)
 try {expect((await s.post({...input,question:''})).status).toBe(400);expect(run).not.toHaveBeenCalled()
 const response=await s.post(input);expect(response.status).toBe(503);const body=await response.json();expect(body.message).toContain('No assignment was dispatched');expect(JSON.stringify(body)).not.toContain('credential');expect(s.release).toHaveBeenCalledOnce()
 }finally{s.server.close()}
})
it('concurrent admission is capped and capability discovery makes no model call',async()=>{
 let resolve:any; const run=vi.fn(()=>new Promise(r=>{resolve=r})),s=await setup(run)
 try {
 const caps=await fetch(s.url,{headers:{'X-Cos-Token':'t'}});expect(await caps.json()).toMatchObject({protocolVersion:1,maxAssignments:3});expect(run).not.toHaveBeenCalled()
 const first=s.post(input);while(!resolve) await new Promise(r=>setTimeout(r,5))
 expect((await s.post(input)).status).toBe(409);resolve({text:JSON.stringify({answer:'Ready',assignments:[]})});expect((await first).status).toBe(200)
 }finally{s.server.close()}
})
it('runs the planner the client picked, defaults older clients to Sonnet and refuses any other model',async()=>{
 const run=vi.fn(async()=>({text:JSON.stringify({answer:'Planned.',assignments:[]})})),s=await setup(run)
 try {
 expect(await (await fetch(s.url,{headers:{'X-Cos-Token':'t'}})).json()).toMatchObject({planner:'sonnet',planners:['sonnet','opus']})
 const opus=await (await s.post({...input,planner:'opus'})).json()
 expect((run.mock.calls as any)[0][0]).toEqual({engine:'claude',model:'opus'});expect(opus.model).toBe('claude:opus (requested)');expect(JSON.parse((run.mock.calls as any)[0][1])).not.toHaveProperty('planner')
 expect(await (await s.post({...input,planner:'sonnet'})).json()).toMatchObject({model:'claude:sonnet (requested)'});expect((run.mock.calls as any)[1][0]).toEqual({engine:'claude',model:'sonnet'})
 for (const planner of ['haiku','fable','Opus','',null,1]) expect((await s.post({...input,planner})).status).toBe(400)
 expect(run).toHaveBeenCalledTimes(2)
 }finally{s.server.close()}
})
it('6.73.12: plans at high effort by default, runs the effort the client picked, never leaks it, and refuses any other level',async()=>{
 const run=vi.fn(async()=>({text:JSON.stringify({answer:'Planned.',assignments:[]})})),s=await setup(run)
 try {
 expect(await (await fetch(s.url,{headers:{'X-Cos-Token':'t'}})).json()).toMatchObject({effort:'high',efforts:['low','medium','high']})
 const plain=await (await s.post(input)).json()
 expect((run.mock.calls as any)[0][6]).toEqual(budget('high',16000));expect(plain.effort).toBe('high')
 for (const [n,effort] of (['low','medium','high'] as const).entries()) {
  const body=await (await s.post({...input,planner:'opus',effort})).json()
  expect((run.mock.calls as any)[n+1][6]).toEqual(budget(effort,{low:0,medium:6000,high:16000}[effort]));expect(body.effort).toBe(effort)
  expect(JSON.parse((run.mock.calls as any)[n+1][1])).not.toHaveProperty('effort')
 }
 for (const effort of ['xhigh','max','HIGH',' high','',null,1]) expect((await s.post({...input,effort})).status).toBe(400)
 expect(run).toHaveBeenCalledTimes(4)
 }finally{s.server.close()}
})
it('6.73.13: advertises context items and returns each assignment selection',async()=>{
 const id='codex:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
 const run=vi.fn(async()=>({text:JSON.stringify({answer:'Planned.',assignments:[{sessionID:id,prompt:'Check it.',contextItemIDs:['file:aaaaaaaaaaaa']}]})})),s=await setup(run)
 try {
 expect(await (await fetch(s.url,{headers:{'X-Cos-Token':'t'}})).json()).toMatchObject({contextItems:true,maxContextItems:40})
 const items=[{id:'req',kind:'req',label:'Your request',estTokens:9},{id:'task',kind:'task',label:'Task',estTokens:50},{id:'cos',kind:'cos',label:'COS instructions',estTokens:60},
  {id:'file:aaaaaaaaaaaa',kind:'files',label:'Shot.png',estTokens:1600},{id:'file:bbbbbbbbbbbb',kind:'files',label:'Other.png',estTokens:1600}]
 const body=await (await s.post({...input,items,sessions:[{id,title:'Implementation',summary:'',status:'idle',automatic:true}]})).json()
 expect(body.assignments[0].contextItemIDs).toEqual(['req','task','cos','file:aaaaaaaaaaaa'])
 expect(JSON.parse((run.mock.calls as any)[0][1]).items).toEqual(items)
 expect((await s.post({...input,items:[{id:'file:aaaaaaaaaaaa',kind:'files',label:'Shot.png',estTokens:1}]})).status).toBe(400)
 expect(run).toHaveBeenCalledTimes(1)
 }finally{s.server.close()}
})
