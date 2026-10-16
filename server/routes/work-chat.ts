import { Router } from 'express'
import { parseWorkChatInput, parseWorkChatAnswer, WORK_CHAT_SYSTEM, WORK_CHAT_PLANNERS, WORK_CHAT_EFFORTS, WORK_CHAT_DEFAULT_EFFORT,
  WORK_CHAT_OUTPUT_TOKENS, WORK_CHAT_THINKING_TOKENS, WORK_CHAT_DEADLINE_MS, WORK_CHAT_MAX_ASSIGNMENTS, WORK_CHAT_MAX_ITEMS, WORK_CHAT_MAX_REFERENCES } from '../lib/work-chat.js'
import { runMeetingAskModel } from '../lib/meeting-ask-runner.js'
import { acquireMaintenanceWork, maintenanceAdmissionsOpen } from '../lib/maintenance-lifecycle.js'
export function createWorkChatRouter(deps = {run:runMeetingAskModel, admissions:maintenanceAdmissionsOpen, lease:()=>acquireMaintenanceWork('work_chat')}) {
  const router=Router(); let running=false
  router.use('/work/chat', (_req,res,next)=>{res.set('Cache-Control','private, no-store');next()})
  // 6.73.15: queueRounds means sessions may carry openWork, and the planner routes around sessions with earlier work open.
  // references means the input may carry read-only reference sessions (never targets).
  router.get('/work/chat',(_req,res)=>res.json({protocolVersion:1,planner:'sonnet',planners:WORK_CHAT_PLANNERS,effort:WORK_CHAT_DEFAULT_EFFORT,efforts:WORK_CHAT_EFFORTS,automaticProviders:['claude','codex'],maxAssignments:WORK_CHAT_MAX_ASSIGNMENTS,contextItems:true,maxContextItems:WORK_CHAT_MAX_ITEMS,queueRounds:true,references:true,maxReferences:WORK_CHAT_MAX_REFERENCES}))
  router.post('/work/chat',async(req,res)=>{
    let input
    try { if (Buffer.byteLength(JSON.stringify(req.body))>100000) throw new Error(); input=parseWorkChatInput(req.body) }
    catch {return res.status(400).json({error:'invalid_work_chat'})}
    if (running || !deps.admissions()) return res.status(409).json({error:'work_chat_busy'})
    running=true
    let lease: ReturnType<typeof acquireMaintenanceWork> | undefined
    const controller=new AbortController(); const abort=()=>controller.abort()
    res.on('close',abort)
    try {
      lease=deps.lease()
      // Planner and effort select how the model runs; they are not evidence, so they never reach the prompt.
      const {planner='sonnet',effort=WORK_CHAT_DEFAULT_EFFORT,...prompt}=input
      const out=await deps.run({engine:'claude',model:planner},JSON.stringify(prompt),WORK_CHAT_SYSTEM,controller.signal,undefined,{caller:'work_chat_'+input.mode},
        {effort,maxOutputTokens:WORK_CHAT_OUTPUT_TOKENS,maxThinkingTokens:WORK_CHAT_THINKING_TOKENS[effort],deadlineMs:WORK_CHAT_DEADLINE_MS})
      const answer=parseWorkChatAnswer(out.text,input)
      if (!res.destroyed) return res.json({protocolVersion:1,...answer,model:out.model??`claude:${planner} (requested)`,effort})
    } catch {if(!res.destroyed) return res.status(503).json({error:'work_chat_unavailable',message:'No assignment was dispatched. Your saved request can be retried.'})}
    finally {res.off('close',abort);lease?.release();running=false}
  })
  return router
}
