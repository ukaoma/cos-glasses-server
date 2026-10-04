import { describe,it,expect } from 'vitest'
import { observeWork, workObservationFields } from './session-work-observation.js'
import { applyHookEvent } from './session-signal-store.js'
import { projectHookPayload, type HookEnvelope } from './session-hook-events.js'
const now=Date.now()-10_000
const ev=(event:HookEnvelope['event'],ts=now,id?:string):HookEnvelope=>({event,ts,ppid:null,sessionId:'00000000-0000-0000-0000-000000000001',payload:id?{agent_id:id}:{}})
describe('display-only multi-agent and compaction evidence',()=>{
 it('deduplicates events by identity, handles out of order stops and preserves other agents',()=>{
  let s=observeWork(undefined,ev('SubagentStart',now,'a'))
  s=observeWork(s,ev('SubagentStart',now,'a'));s=observeWork(s,ev('SubagentStart',now+1,'b'))
  s=observeWork(s,ev('SubagentStop',now+4,'a'));s=observeWork(s,ev('SubagentStart',now+2,'a'))
  expect(workObservationFields(s,now+5).subagent_activity).toMatchObject({active:1,completed:1,total:2})
  s=observeWork(s,ev('Stop',now+6))
  expect(workObservationFields(s,now+7).subagent_activity?.active).toBe(1)
  expect(workObservationFields(s,now+400_000).subagent_activity).toMatchObject({active:0,unknown:1})
 })
 it('keeps compaction separate from transport, children and parent write state',()=>{
  let s=observeWork(undefined,ev('PreCompact'))
  s=observeWork(s,ev('SubagentStart',now+1,'a'))
  expect(workObservationFields(s,now+2).compaction?.state).toBe('compacting')
  expect(workObservationFields(s,now+700_000).compaction?.state).toBe('unknown')
  s=observeWork(s,ev('PostCompact',now+3))
  expect(workObservationFields(s,now+4).compaction).toBeUndefined()
 })
 it('native Cursor observer events never turn hooks into permission or occupancy evidence',()=>{
  const e=ev('SubagentStart',now,'worker');e.payload.display_only=true
  const s=applyHookEvent(undefined,e,{isCosSpawnedPid:()=>false})
  expect(s.observationOnly).toBe(true);expect(s.turnOpen).toBe(false);expect(s.waiting).toBeNull()
  expect(workObservationFields(s.workObservation,now+1).subagent_activity?.active).toBe(1)
  expect(projectHookPayload(e.event,e.payload).display_only).toBe(true)
  const ordinary=applyHookEvent(s,ev('UserPromptSubmit',now+2),{isCosSpawnedPid:()=>false})
  expect(ordinary.observationOnly).toBe(false);expect(ordinary.turnOpen).toBe(true)
 })
 it('missing identities and truncated populations produce uncertainty, never exact zero',()=>{
  const s=observeWork(undefined,ev('SubagentStart'))
  expect(workObservationFields(s,now+1).subagent_activity?.partial).toBe(true)
 })
})

it('does not notify action listeners for a native observation',async()=>{
 const {SessionSignalStore}=await import('./session-signal-store.js')
 const store=new SessionSignalStore({isCosSpawnedPid:()=>false});let calls=0
 store.subscribe(()=>{calls++})
 const e=ev('SubagentStart',now,'worker');e.payload.display_only=true
 store.apply(e)
 expect(calls).toBe(0)
 expect(workObservationFields(store.get(e.sessionId)?.workObservation,now+1).subagent_activity?.active).toBe(1)
})

it('does not replay old compaction or child compaction over a resumed parent',()=>{
 let s=observeWork(undefined,ev('PostCompact',now+20))
 s=observeWork(s,ev('PreCompact',now+10))
 expect(workObservationFields(s).compaction).toBeUndefined()
 s=observeWork(s,ev('PreCompact',now+30,'child'))
 expect(workObservationFields(s).compaction).toBeUndefined()
 s=observeWork(s,ev('PreCompact',now+30))
 s=observeWork(s,ev('PostCompact',now+40,'child'))
 expect(workObservationFields(s,now+41).compaction?.state).toBe('compacting')
})
