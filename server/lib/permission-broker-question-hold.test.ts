import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionBroker, type PermissionBrokerDeps } from './permission-broker.js'
import { PermissionBroker as Baseline } from './__fixtures__/permission-broker-6.71.5.js'
import { ASK_INPUT, SESSION, permissionEnvelope, Q1, Q2 } from './__fixtures__/permission-broker.js'
import { type HookEnvelope } from './session-hook-events.js'
const live: PermissionBroker[] = []
afterEach(() => { for(const b of live.splice(0)) b.stop(); vi.useRealTimers() })
function harness(extra: Partial<PermissionBrokerDeps> = {}) {
  const s = {now:1_000_000,idle:0 as number|null,hold:1_000_000 as number|null,legacy:null as number|null,presence:null as number|null,open:true,reads:0}
  let seq=0
  const deps: PermissionBrokerDeps={now:()=>s.now,mode:()=> 'all',admissionsOpen:()=>s.open,lastQuestionsPollAt:()=>s.legacy,lastLegacyPollAt:()=>s.legacy,lastHoldPollAt:()=>s.hold,presenceAgeMs:()=>s.presence,readDeskIdleSeconds:async()=>{s.reads++;return s.idle},deskIdleSeconds:()=>90,timeoutMs:()=>110_000,awayHoldMs:()=>600_000,installedHookTimeoutS:()=>630,pollMs:60_000,newId:()=>`pq_${String(++seq).padStart(24,'0')}`,log:()=>{},...extra}
  const b=new PermissionBroker(deps); live.push(b);return {s,b,deps}
}
const ask=(now=1_000_000,extra={})=>({...permissionEnvelope('AskUserQuestion',ASK_INPUT,{},now),hookWaitS:630,askHold:1,...extra})
const event=(ts:number,payload:Record<string,unknown>={},name:HookEnvelope['event']='PostToolUse'):HookEnvelope=>({ts,ppid:4242,sessionId:SESSION,event:name,payload:{tool_name:'AskUserQuestion',tool_input:ASK_INPUT,...payload}})
function park(h:ReturnType<typeof harness>,r:Awaited<ReturnType<PermissionBroker['admit']>>) {
  if(!r.ok)throw Error(r.reason)
  const sent:Record<string,unknown>[]=[]
  const id=h.b.park(r.request,{writable:()=>true,reply:body=>{sent.push(body);return true}})
  return {id,sent}
}
describe('stamped question hold',()=>{
 it('admits a connected hold client without wearer presence, hides at desk, then latches at 90 seconds',async()=>{
  const h=harness();const r=await h.b.admit(ask());const {id}=park(h,r)
  expect(h.b.pendingCount()).toBe(1);expect(h.b.list()).toEqual([]);expect(h.b.questionsPollIntervalMs()).toBe(3000)
  h.s.now+=89_000;h.s.idle=89;await h.b.tick();expect(h.b.list()).toEqual([])
  h.s.now+=1000;h.s.idle=90;await h.b.tick();expect(h.b.list().map(x=>x.id)).toEqual([id])
  const reads=h.s.reads;h.s.now+=40_000;h.s.idle=null;h.s.hold=null;await h.b.tick();await h.b.tick()
  expect(h.b.list()).toHaveLength(1);expect(h.s.reads).toBe(reads)
  h.s.idle=0;await h.b.tick();expect(h.b.list()).toHaveLength(1)
 })
 it('unreadable desk hides until a good idle read and never hands back a stamped question',async()=>{
  const h=harness();h.s.idle=null;park(h,await h.b.admit(ask()));await h.b.tick();await h.b.tick()
  expect(h.b.pendingCount()).toBe(1);expect(h.b.list()).toEqual([])
  h.s.idle=120;await h.b.tick();expect(h.b.list()).toHaveLength(1)
 })
 it('no connected client or recent presence stays Mac-only, including when away hold is enabled',async()=>{
  const h=harness();h.s.hold=null;expect(await h.b.admit(ask())).toEqual({ok:false,reason:'no_client'})
  h.s.presence=10;expect((await h.b.admit(ask())).ok).toBe(true)
 })
 it('away off and a legacy timeout respect the base deadline rather than extending to the ceiling',async()=>{
  for(const opts of [{awayHoldMs:()=>0},{installedHookTimeoutS:()=>130}]){
   const h=harness(opts);const r=await h.b.admit(ask());expect(r.ok&&r.request.deadlineAt).toBe(h.s.now+110_000)
  }
 })
 it('expires hidden held questions at the real deadline and rejects late answers',async()=>{
  vi.useFakeTimers();const h=harness();const {id,sent}=park(h,await h.b.admit(ask()))
  h.s.now+=600_000;vi.advanceTimersByTime(600_000)
  expect(sent).toEqual([{}]);expect(h.b.pendingCount()).toBe(0)
  expect(h.b.answer(id,{clientAnswerId:'late',answers:[{labels:['Bump']},{labels:['Blue']}]}).body).toEqual({error:'expired'})
 })
 it('desk first, glasses first, and child events preserve one winner',async()=>{
  for(const deskFirst of [true,false]){
   const h=harness();const {id,sent}=park(h,await h.b.admit(ask()))
   h.b.observeHookEvent(event(h.s.now+1),true);expect(h.b.pendingCount()).toBe(1)
   h.b.observeHookEvent(event(h.s.now+1,{agent_id:'child'}),false);expect(h.b.pendingCount()).toBe(1)
   const body={clientAnswerId:'lens',answers:[{labels:['Bump']},{labels:['Blue']}]}
   if(deskFirst){h.b.observeHookEvent(event(h.s.now+2),false);expect(h.b.answer(id,body).status).toBe(409);expect(sent).toEqual([{}])}
   else {expect(h.b.answer(id,body).status).toBe(200);h.b.observeHookEvent(event(h.s.now+2),false);expect(h.b.answer(id,{...body,clientAnswerId:'second'}).status).toBe(409);expect(sent).toHaveLength(1)}
  }
 })
 it('matches one of two parallel questions by tool id, otherwise by fingerprint',async()=>{
  for(const ids of [true,false]){
   const h=harness();const first=park(h,await h.b.admit(ask(h.s.now,ids?{payload:{...ask().payload,tool_use_id:'first'}}:{})))
   const otherInput={questions:[{question:'Another question',options:[{label:'Yes',description:''},{label:'No',description:''}],header:'Other',multiSelect:false}]}
   const second=park(h,await h.b.admit({...ask(),payload:{...ask().payload,tool_input:otherInput,...(ids?{tool_use_id:'second'}:{})}}))
   h.b.observeHookEvent(event(h.s.now+1,ids?{tool_use_id:'first'}:{}),false)
   expect(first.sent).toEqual([{}]);expect(second.sent).toEqual([]);expect(h.b.pendingCount()).toBe(1)
  }
 })
 it('clears pending stamped questions on session-row end, hook close, turn end, hand-back and drain',async()=>{
  for(const action of ['row','close','turn','interrupt','hand','drain']){
   const h=harness();const {id,sent}=park(h,await h.b.admit(ask()))
   if(action==='row') expect(h.b.sessionRowEnded(SESSION)).toBe(1)
   if(action==='close')h.b.hookClosed(id)
   if(action==='turn')h.b.observeHookEvent(event(h.s.now+1,{},'Stop'),false)
   if(action==='interrupt')h.b.observeHookEvent(event(h.s.now+1,{},'Interrupt'),false)
   if(action==='hand')expect(h.b.answer(id,{clientAnswerId:'hand',handBack:true}).status).toBe(200)
   if(action==='drain'){h.s.open=false;await h.b.tick()}
   expect(h.b.pendingCount()).toBe(0);expect(sent).toHaveLength(action==='close'?0:1)
  }
 })
 it('matches a desk completion that includes string or array answers in the input',async()=>{
  for(const answer of ['Blue',['Blue']]){
   const h=harness();const {sent}=park(h,await h.b.admit(ask()));
   h.b.observeHookEvent(event(h.s.now+1,{tool_input:{...ASK_INPUT,answers:{[ASK_INPUT.questions[0].question]:answer}}}),false);
   expect(h.b.pendingCount()).toBe(0);expect(sent).toEqual([{}]);
  }
 })
 it('stamped background/print requests keep the legacy desk gate',async()=>{
  const h=harness({isBackgroundRequest:()=>true});h.s.legacy=h.s.now
  expect(await h.b.admit(ask())).toEqual({ok:false,reason:'desk_active'})
 })
 it('preserves the actual 6.71.5 admission and tick behavior for every unstamped question and approval',async()=>{
  let rows=0
  for(const tool of ['AskUserQuestion','Bash'])for(const stamp of [undefined,1])for(const idle of [0,100,null])for(const client of ['none','legacy','hold','recent'])for(const ceiling of [130,630])for(const away of [0,600_000]){
   if(tool==='AskUserQuestion'&&stamp===1)continue
   const h=harness({installedHookTimeoutS:()=>ceiling,awayHoldMs:()=>away});h.s.idle=idle;h.s.hold=client==='hold'?h.s.now:null;h.s.legacy=client==='legacy'?h.s.now:null;h.s.presence=client==='recent'?100:null
   const old=new Baseline(h.deps)
   const body={...permissionEnvelope(tool,tool==='Bash'?{command:'echo harmless'}:ASK_INPUT,{},h.s.now),hookWaitS:630,...(stamp?{askHold:stamp}:{})}
   const got=await h.b.admit(body),expected=await old.admit(body)
   if(!expected.ok)expect(got,`${tool}/${stamp}/${idle}/${client}/${ceiling}/${away}`).toEqual(expected)
   else {
    expect(got.ok).toBe(true);if(!got.ok)throw Error(got.reason)
    expect(got.request.deadlineAt).toBe(expected.request.deadlineAt);expect(got.request.awayHold).toBe(expected.request.awayHold)
    const id=h.b.park(got.request,{writable:()=>true,reply:()=>true});const oldId=old.park(expected.request,{writable:()=>true,reply:()=>true})
    h.s.idle=0;h.s.now+=40_000;await h.b.tick();await old.tick()
    expect(h.b.settledList().map(x=>x.resolution)).toEqual(old.settledList().map(x=>x.resolution));expect(h.b.pendingCount()).toBe(old.pendingCount());void id;void oldId
   }
   old.stop();h.b.stop();rows++
  }
  expect(rows).toBe(144)
 })
})
