// Display-only evidence. Never decides whether a thread can be written or dequeued.
import type { HookEnvelope } from './session-hook-events.js'
import type { SubagentActivity } from './codex-subagent-activity.js'
export interface WorkObservation {
  agents: Array<{id:string;at:number;state:'active'|'completed'}>
  partial: boolean
  compactingAt: number | null
  phaseAt?: number
}
export function observeWork(previous: WorkObservation | undefined, env: HookEnvelope): WorkObservation {
  const prev=previous ?? {agents:[],partial:false,compactingAt:null}
  if (!Number.isFinite(env.ts) || env.ts <= 0 || env.ts > Date.now()+5000) return prev
  const p=env.payload, id=typeof p.agent_id==='string' && /^[a-zA-Z0-9_-]{1,160}$/.test(p.agent_id) ? p.agent_id : null
  if(env.event==='SubagentStart'||env.event==='SubagentStop') {
    if(!id)return {...prev,partial:true}
    const existing=prev.agents.find(a=>a.id===id)
    if(existing && (existing.at>env.ts || (existing.at===env.ts && (existing.state==='completed' || env.event==='SubagentStart'))))return prev
    if(!existing && prev.agents.length>=512)return {...prev,partial:true}
    const row={id,at:env.ts,state:env.event==='SubagentStart'?'active' as const:'completed' as const}
    return {...prev,agents:[...prev.agents.filter(a=>a.id!==id),row]}
  }
  if(id && ['PreToolUse','PostToolUse','PostToolUseFailure'].includes(env.event)) {
    const existing=prev.agents.find(a=>a.id===id)
    // Tool output may arrive after Stop; it must never reopen a completed child.
    if(existing?.state==='active' && env.ts>existing.at)return {...prev,agents:prev.agents.map(a=>a.id===id?{...a,at:env.ts}:a)}
    return prev
  }
  if(id)return prev // Child compaction must not label the parent as compacting.
  if(env.ts<(prev.phaseAt??0))return prev
  if(env.event==='PreCompact')return {...prev,compactingAt:env.ts,phaseAt:env.ts}
  const resumes=['PostCompact','UserPromptSubmit','Stop','StopFailure','SessionEnd','PostToolUse','PostToolUseFailure'].includes(env.event)
    || (env.event==='SessionStart' && p.source==='compact')
  if(resumes)return {...prev,compactingAt:null,phaseAt:env.ts}
  return prev
}
export function workObservationFields(observation: WorkObservation | undefined, now=Date.now()): {subagent_activity?:SubagentActivity;compaction?:{state:'compacting'|'unknown';started_at:number;checked_at:number}} {
  if(!observation)return {}
  const fields:ReturnType<typeof workObservationFields>={}
  if(observation.agents.length||observation.partial){
    const summary:SubagentActivity={active:0,completed:0,unknown:0,total:observation.agents.length,checked_at:now,partial:observation.partial}
    for(const a of observation.agents)summary[a.state==='completed'?'completed':now-a.at<=300_000&&a.at<=now+5000?'active':'unknown']++
    fields.subagent_activity=summary
  }
  if(observation.compactingAt!==null)fields.compaction={state:now-observation.compactingAt<=600_000?'compacting':'unknown',started_at:observation.compactingAt,checked_at:now}
  return fields
}
