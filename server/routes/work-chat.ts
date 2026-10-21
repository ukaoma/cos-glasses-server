import { Router } from 'express'
import { parseWorkChatInput, parseWorkChatAnswer, WORK_CHAT_SYSTEM, WORK_CHAT_ORCHESTRATOR_RULES, WORK_CHAT_PLANNERS, WORK_CHAT_EFFORTS, WORK_CHAT_DEFAULT_EFFORT,
  WORK_CHAT_OUTPUT_TOKENS, WORK_CHAT_ORCHESTRATOR_OUTPUT_TOKENS, WORK_CHAT_THINKING_TOKENS, WORK_CHAT_DEADLINE_MS, WORK_CHAT_MAX_ASSIGNMENTS, WORK_CHAT_MAX_ITEMS, WORK_CHAT_MAX_REFERENCES,
  WORK_CHAT_BODY_BYTES, WORK_CHAT_ORCHESTRATOR_BODY_BYTES, type WorkChatInput, type WorkChatAnswer } from '../lib/work-chat.js'
import { runMeetingAskModel } from '../lib/meeting-ask-runner.js'
import { acquireMaintenanceWork, maintenanceAdmissionsOpen } from '../lib/maintenance-lifecycle.js'
import { appendPlanLog, type PlanLogRow } from '../lib/work-orchestrator/plan-log.js'
import { PLAN_LOG_PATH } from '../lib/work-orchestrator/runtime.js'

/** 6.83.0: one plan's log row. Ids and enums only (plan-log.ts). */
export function planLogRow(input: WorkChatInput, outcome: PlanLogRow['outcome'], answer: WorkChatAnswer | null, ms: number, now = new Date()): PlanLogRow {
  return {
    at: now.toISOString(), workID: input.workID, mode: input.mode, planner: input.planner ?? 'sonnet', effort: input.effort ?? WORK_CHAT_DEFAULT_EFFORT,
    orchestrator: input.orchestrator === true,
    sessions: input.sessions.map(s => ({ id: s.id, automatic: s.automatic, ...(s.available !== undefined ? { available: s.available } : {}),
      ...(s.reason ? { reason: s.reason } : {}), ...(s.discoveredBy ? { discoveredBy: s.discoveredBy } : {}) })),
    leftOut: (input.leftOut ?? []).map(l => ({ id: l.id, reason: l.reason })),
    usageAgeSec: Object.fromEntries((input.usage ?? []).map(u => [u.provider, u.ageSec])),
    usageState: Object.fromEntries((input.usage ?? []).map(u => [u.provider, u.state])),
    assignments: (answer?.assignments ?? []).map(a => ({ mode: a.mode ?? 'continue', target: a.mode === 'newSession' ? `new:${a.provider}` : a.sessionID ?? '' })),
    outcome, ms,
  }
}

const WORK_CHAT_DEPS = {run:runMeetingAskModel, admissions:maintenanceAdmissionsOpen, lease:()=>acquireMaintenanceWork('work_chat'),
  planLog:(row: PlanLogRow)=>appendPlanLog(PLAN_LOG_PATH(), row), now:()=>Date.now()}
export function createWorkChatRouter(given: Partial<typeof WORK_CHAT_DEPS> = {}) {
  // 6.83.0: a caller that passes only some deps (the tests pass run, admissions and lease) gets the rest by default.
  const deps={...WORK_CHAT_DEPS,...given}
  const router=Router(); let running=false
  router.use('/work/chat', (_req,res,next)=>{res.set('Cache-Control','private, no-store');next()})
  // 6.73.15: queueRounds means sessions may carry openWork, and the planner routes around sessions with earlier work open.
  // references means the input may carry read-only reference sessions (never targets).
  // 6.83.0: orchestrator 1 means a client may send the orchestrator input (POST /api/work/orchestrator/input) and get
  // fork and new-session assignments back (docs/work-orchestrator.md).
  router.get('/work/chat',(_req,res)=>res.json({protocolVersion:1,planner:'sonnet',planners:WORK_CHAT_PLANNERS,effort:WORK_CHAT_DEFAULT_EFFORT,efforts:WORK_CHAT_EFFORTS,automaticProviders:['claude','codex'],maxAssignments:WORK_CHAT_MAX_ASSIGNMENTS,contextItems:true,maxContextItems:WORK_CHAT_MAX_ITEMS,queueRounds:true,references:true,maxReferences:WORK_CHAT_MAX_REFERENCES,orchestrator:1}))
  router.post('/work/chat',async(req,res)=>{
    let input: WorkChatInput
    try {
      const limit=req.body?.orchestrator===true ? WORK_CHAT_ORCHESTRATOR_BODY_BYTES : WORK_CHAT_BODY_BYTES
      if (Buffer.byteLength(JSON.stringify(req.body))>limit) throw new Error(); input=parseWorkChatInput(req.body)
    }
    catch {return res.status(400).json({error:'invalid_work_chat'})}
    if (running || !deps.admissions()) return res.status(409).json({error:'work_chat_busy'})
    running=true
    const started=deps.now()
    let lease: ReturnType<typeof acquireMaintenanceWork> | undefined
    let outcome: PlanLogRow['outcome']='unavailable', answer: WorkChatAnswer | null=null
    const controller=new AbortController(); const abort=()=>controller.abort()
    res.on('close',abort)
    try {
      lease=deps.lease()
      // Planner and effort select how the model runs; they are not evidence, so they never reach the prompt.
      const {planner='sonnet',effort=WORK_CHAT_DEFAULT_EFFORT,...prompt}=input
      const orchestrator=input.orchestrator===true
      const system=orchestrator ? WORK_CHAT_SYSTEM+'\n\n'+WORK_CHAT_ORCHESTRATOR_RULES : WORK_CHAT_SYSTEM
      const out=await deps.run({engine:'claude',model:planner},JSON.stringify(prompt),system,controller.signal,undefined,{caller:'work_chat_'+input.mode},
        {effort,maxOutputTokens:orchestrator ? WORK_CHAT_ORCHESTRATOR_OUTPUT_TOKENS : WORK_CHAT_OUTPUT_TOKENS,maxThinkingTokens:WORK_CHAT_THINKING_TOKENS[effort],deadlineMs:WORK_CHAT_DEADLINE_MS})
      try { answer=parseWorkChatAnswer(out.text,input) } catch (e) { outcome='invalid_answer'; throw e }
      outcome='planned'
      if (!res.destroyed) return res.json({protocolVersion:1,...answer,model:out.model??`claude:${planner} (requested)`,effort})
      outcome='aborted'
    } catch {if (controller.signal.aborted && outcome==='unavailable') outcome='aborted'; if(!res.destroyed) return res.status(503).json({error:'work_chat_unavailable',message:'No assignment was dispatched. Your saved request can be retried.'})}
    finally {
      res.off('close',abort);lease?.release();running=false
      // 6.83.0: every plan is logged, whatever its outcome (plan-log.ts); a log failure never changes the answer.
      try { deps.planLog(planLogRow(input,outcome,answer,deps.now()-started)) } catch { /* observation only */ }
    }
  })
  return router
}
