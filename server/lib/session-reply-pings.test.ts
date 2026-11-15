import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createSessionReplyPings, REPLY_SETTLE_MS } from './session-reply-pings.js'
import { SessionSignalStore } from './session-signal-store.js'
import { parseHookEnvelope, projectHookPayload, type HookEnvelope, type HookEventName, type HookProvider } from './session-hook-events.js'
import { DropStore, InboxFeedStore } from './drop-store.js'
import { PingStateStore, type PingBanner } from './ping-engine.js'
import { createDropP2Runtime } from './drop-p2-runtime.js'
import { normalizeP2Settings } from './drop-p2-settings.js'
import { WRAP_UP_TOOL } from './turn-end-ask.js'

const ID='00000000-0000-0000-0000-000000000001'
const roots:string[]=[]; const closers:Array<()=>void>=[]
afterEach(()=>{for(const close of closers.splice(0))close();vi.useRealTimers();for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true})})
function rig(options:{at?:string;cap?:number;phoneThrows?:boolean;category?:boolean}={}){
 vi.useFakeTimers();vi.setSystemTime(new Date(options.at??'2026-11-16T16:00:00Z'))
 const root=mkdtempSync(join(tmpdir(),'cos-reply-ping-'));roots.push(root)
 const scripts=join(root,'scripts');mkdirSync(scripts)
 const drops=new DropStore(join(root,'drops')),feed=new InboxFeedStore(join(root,'feed')),state=new PingStateStore(join(root,'pings'))
 const phones:PingBanner[]=[];const signals=new SessionSignalStore({isCosSpawnedPid:()=>false})
 const settings=normalizeP2Settings({pings:{dailyCap:options.cap??20,perSource:10,gapMinutes:0},banners:{agent:options.category??true}})
 const runtime=createDropP2Runtime({drops,feed,pingState:state,now:Date.now,timezone:()=> 'America/Chicago',scriptsDir:scripts,
  nextEvent:async()=>null,intakeOpen:()=>[],board:async()=>[],journal:()=>[],settings:()=>settings,
  phoneBanner:b=>{expect(state.read().ledger.length).toBeGreaterThan(0);phones.push(b);if(options.phoneThrows)throw Error('fixture phone unavailable')},bootId:'fixture'})
 let bridge=createSessionReplyPings({initial:signals.snapshot(),signal:id=>signals.get(id),deliver:r=>runtime.pushAgent(r)})
 const off=signals.subscribe((s,e,c)=>bridge.observe(s,e,c)),offObs=signals.subscribeObservations((s,e,c)=>bridge.observe(s,e,c))
 const close=()=>{bridge.stop();off();offObs();runtime.stop();drops.close();feed.close();state.close()};closers.push(close)
 const event=(event:HookEventName,payload:Record<string,unknown>={},provider:HookProvider='claude',child=false,ts=Date.now())=>{
  const env:HookEnvelope={event,sessionId:ID,ts,ppid:null,provider,payload:{session_id:ID,...payload}};signals.apply(env,child);return env
 }
 const prompt=(provider:HookProvider='claude')=>event('UserPromptSubmit',{},provider)
 const settle=()=>vi.advanceTimersByTimeAsync(REPLY_SETTLE_MS+1)
 const restart=()=>{bridge.stop();bridge=createSessionReplyPings({initial:signals.snapshot(),signal:id=>signals.get(id),deliver:r=>runtime.pushAgent(r)})}
 return{root,feed,state,phones,signals,event,prompt,settle,restart,settings}
}

it.each(['claude','codex'] as const)('%s actual parsed Stop -> reducer -> runtime -> durable phone destination once per turn, including duplicate/restart',async provider=>{
 const r=rig();r.prompt(provider);vi.advanceTimersByTime(1)
 const stop={ts:Date.now(),ppid:null,event:'Stop',provider,payload:{session_id:ID,last_assistant_message:'PRIVATE answer'}}
 const parsed=parseHookEnvelope(JSON.stringify(stop));expect(parsed.ok).toBe(true);if(!parsed.ok)throw Error(parsed.reason)
 r.signals.apply(parsed.envelope);vi.advanceTimersByTime(1);r.event('Stop',{},provider)
 await r.settle();expect(r.phones).toHaveLength(1);expect(r.feed.list().filter(x=>x.kind==='ping')).toHaveLength(1)
 expect(r.feed.list().find(x=>x.kind==='ping')?.links[0].label).toBe('Session')
 expect(r.phones[0].title).toBe('Reply ready');expect(r.phones[0].line).toBe(`${provider==='claude'?'Claude':'Codex'} has a reply ready.`)
 expect(JSON.stringify(r.phones)).not.toContain('PRIVATE')
 r.restart();r.event('Stop',{},provider);await r.settle();expect(r.phones).toHaveLength(1)
 r.prompt(provider);vi.advanceTimersByTime(1);r.event('Stop',{},provider);await r.settle();expect(r.phones).toHaveLength(2)
})

it('actual installed Cursor observer spool -> parser -> display-only callback -> runtime; no lifecycle/authority listener',async()=>{
 const r=rig();const spool=join(r.root,'spool');let ordinary=0;r.signals.subscribe(()=>ordinary++)
 const before=r.signals.get(ID)
 const output=execFileSync(process.execPath,[resolve('bin/hooks/cos-cursor-observer.cjs'),'stop',spool],{input:JSON.stringify({conversation_id:ID,status:'completed',generation_id:'generation-1',text:'PRIVATE'})}).toString()
 expect(output.trim()).toBe('{}')
 const row=JSON.parse(readFileSync(join(spool,readdirSync(spool)[0]),'utf8'));row.ts=Date.now()
 const parsed=parseHookEnvelope(JSON.stringify(row));expect(parsed.ok).toBe(true);if(!parsed.ok)throw Error(parsed.reason)
 expect(parsed.envelope.payload.notification_completion).toEqual({status:'completed',generationId:'generation-1'})
 expect(projectHookPayload(parsed.envelope.event,parsed.envelope.payload).notification_completion).toBeUndefined()
 r.signals.apply(parsed.envelope);await r.settle();expect(ordinary).toBe(0);expect(r.signals.get(ID)?.turnOpen).toBe(before?.turnOpen??false)
 expect(r.phones).toHaveLength(1);expect(r.phones[0].line).toBe('Cursor has a reply ready.')
 r.signals.apply({...parsed.envelope,ts:Date.now()});await r.settle();expect(r.phones).toHaveLength(1)
})

it.each(['StopFailure','Interrupt'] as const)('%s cancels a pending reply; stale startup/children/errors and old turns do not notify',async terminal=>{
 const r=rig();r.event('Stop',{turn_id:'old'},'claude',false,Date.now()-1)
 r.prompt();r.event('Stop',{agent_id:'native-child'});r.event('Stop',{},'claude',true);r.event('Stop',{is_error:true});await r.settle();expect(r.phones).toHaveLength(0)
 r.event('Stop');r.event(terminal);await r.settle();expect(r.phones).toHaveLength(0)
 r.prompt();r.event('Stop');r.prompt();await r.settle();expect(r.phones).toHaveLength(0)
})

it('known unanswered permission survives Stop and unrelated late tool, but matching resolution before Stop permits reply',async()=>{
 const r=rig();r.prompt();r.event('PermissionRequest',{tool_name:'Bash',tool_input:{command:'one'}});r.event('Stop')
 r.event('PostToolUse',{tool_name:'Read',tool_input:{file_path:'other'}});r.event('Stop');await r.settle();expect(r.phones).toHaveLength(0)
 r.prompt();r.event('PermissionRequest',{tool_name:'Bash',tool_input:{command:'two'}})
 r.event('PostToolUse',{tool_name:'Bash',tool_input:{command:'two'}});r.event('Stop');await r.settle();expect(r.phones).toHaveLength(1)
})

it('known and late async wrap-up asks cancel pending replies, stay blocked through unrelated tools, reset only on a new prompt',async()=>{
 const r=rig();r.prompt();r.event('Stop');r.event('PostToolUse',{tool_name:WRAP_UP_TOOL,tool_input:{ask:'Private question',actions:[{label:'Yes'}]}})
 r.event('PostToolUse',{tool_name:'Read'});r.event('Stop');await r.settle();expect(r.phones).toHaveLength(0)
 r.prompt();r.event('Stop');await r.settle();expect(r.phones).toHaveLength(1)
})

it.each(['error','aborted'] as const)('Cursor explicit %s cancels completed generation, and never upgrades display-only phase',async status=>{
 const r=rig();const obs=(status:string,generationId='gen1')=>r.event('PostCompact',{display_only:true,notification_completion:{status,generationId}},'cursor')
 obs('completed');obs(status);obs('completed');await r.settle();expect(r.phones).toHaveLength(0)
 obs('completed','gen2');await r.settle();expect(r.phones).toHaveLength(1);expect(r.signals.get(ID)?.turnOpen).toBe(false)
})

it('Cursor observer only admits explicit root stop outcomes; response/session end/missing success/subagent/background never manufacture completion',()=>{
 const r=rig(),spool=join(r.root,'spool');let count=0
 for(const [event,extra] of [['afterAgentResponse',{status:'completed'}],['sessionEnd',{status:'completed'}],['stop',{}],['stop',{status:'completed',subagent_id:'child'}],['stop',{status:'completed',is_background_agent:true}],['stop',{status:'completed',parent_conversation_id:ID}]] as const){
  execFileSync(process.execPath,[resolve('bin/hooks/cos-cursor-observer.cjs'),event,spool],{input:JSON.stringify({conversation_id:ID,generation_id:'gen',...extra})});count++
 }
 const rows=readdirSync(spool).map(n=>JSON.parse(readFileSync(join(spool,n),'utf8')));expect(rows).toHaveLength(count)
 expect(rows.every(r=>r.payload.notification_completion===undefined)).toBe(true)
})

it('quiet/weekend hold, category and daily cap still govern the actual bridge; phone failure is isolated with no retry',async()=>{
 const r=rig({cap:1,phoneThrows:true});r.prompt();r.event('Stop');await r.settle();expect(r.phones).toHaveLength(1)
 r.prompt();r.event('Stop');await r.settle();expect(r.phones).toHaveLength(1);expect(r.feed.list().filter(x=>x.kind==='ping')).toHaveLength(2)
 r.settings.banners.agent=false;r.prompt();r.event('Stop');await r.settle();expect(r.phones).toHaveLength(1)
})
it.each(['2026-11-17T00:00:00Z','2026-11-15T16:00:00Z'])('quiet period %s holds the reply without phone delivery',async at=>{
 const r=rig({at});r.prompt();r.event('Stop');await r.settle();expect(r.phones).toHaveLength(0);expect(r.state.read().held).toHaveLength(1)
})

it('a fresh Stop for a turn open before restart qualifies, while a delayed old Stop after long uptime does not',async()=>{
 const r=rig();r.prompt();vi.advanceTimersByTime(1);r.restart();vi.advanceTimersByTime(121_000)
 r.event('Stop',{turn_id:'delayed'},'claude',false,Date.now()-120_001);await r.settle();expect(r.phones).toHaveLength(0)
 r.event('Stop');await r.settle();expect(r.phones).toHaveLength(1)
})
it('a reported Stop error cancels an earlier successful Stop even at the same timestamp',async()=>{
 const r=rig();r.prompt();r.event('Stop');r.event('Stop',{is_error:true});await r.settle();expect(r.phones).toHaveLength(0)
})

it('a wait replayed before bridge subscription remains blocked after fresh Stop clears reducer waiting',async()=>{
 const r=rig();r.prompt();r.event('PermissionRequest',{tool_name:'Bash',tool_input:{command:'one'}});r.restart()
 r.event('Stop');await r.settle();expect(r.phones).toHaveLength(0)
})

it('machine-only new prompts do not answer a known ask',async()=>{
 const r=rig();r.prompt();r.event('PostToolUse',{tool_name:WRAP_UP_TOOL,tool_input:{ask:'Choose',actions:[{label:'Yes'}]}})
 r.event('UserPromptSubmit',{prompt:'<task-notification>Background update</task-notification>'});r.event('Stop');await r.settle();expect(r.phones).toHaveLength(0)
})
it('category and master/source preferences independently suppress phone output without changing the saved preferences',async()=>{
 const r=rig({category:false});r.prompt();r.event('Stop');await r.settle();expect(r.phones).toHaveLength(0);expect(r.feed.list().filter(x=>x.kind==='ping')).toHaveLength(1)
 r.settings.pings.on=false;r.prompt();r.event('Stop');await r.settle();expect(r.feed.list().filter(x=>x.kind==='ping')).toHaveLength(1)
 r.settings.pings.on=true;r.settings.pings.sources.agent=false;r.prompt();r.event('Stop');await r.settle();expect(r.phones).toHaveLength(0);expect(r.feed.list().filter(x=>x.kind==='ping')).toHaveLength(1)
 expect(r.settings.banners.agent).toBe(false)
})
it('automated keep-warm turns stay silent',async()=>{
 const r=rig();r.event('UserPromptSubmit',{prompt:'This is an automated local readiness check for COS'});r.event('Stop');await r.settle();expect(r.phones).toHaveLength(0)
})

it('duplicate Stop payloads with optional IDs omitted or added retain the known turn identity',async()=>{
 const r=rig();r.prompt();r.event('Stop',{turn_id:'optional-id'});await r.settle();expect(r.phones).toHaveLength(1)
 r.event('Stop');await r.settle();expect(r.phones).toHaveLength(1)
 r.event('Stop',{prompt_id:'another-optional-id'});await r.settle();expect(r.phones).toHaveLength(1)
})
