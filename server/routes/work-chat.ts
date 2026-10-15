import { Router } from 'express'
import { parseWorkChatInput, parseWorkChatAnswer, WORK_CHAT_SYSTEM, WORK_CHAT_PLANNERS } from '../lib/work-chat.js'
import { runMeetingAskModel } from '../lib/meeting-ask-runner.js'
import { acquireMaintenanceWork, maintenanceAdmissionsOpen } from '../lib/maintenance-lifecycle.js'
export function createWorkChatRouter(deps = {run:runMeetingAskModel, admissions:maintenanceAdmissionsOpen, lease:()=>acquireMaintenanceWork('work_chat')}) {
  const router=Router(); let running=false
  router.use('/work/chat', (_req,res,next)=>{res.set('Cache-Control','private, no-store');next()})
  router.get('/work/chat',(_req,res)=>res.json({protocolVersion:1,planner:'sonnet',planners:WORK_CHAT_PLANNERS,automaticProviders:['claude','codex'],maxAssignments:3}))
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
      // The planner choice selects the model only; it is not evidence, so it never reaches the prompt.
      const {planner='sonnet',...prompt}=input
      const out=await deps.run({engine:'claude',model:planner},JSON.stringify(prompt),WORK_CHAT_SYSTEM,controller.signal,undefined,{caller:'work_chat_'+input.mode})
      const answer=parseWorkChatAnswer(out.text,input)
      if (!res.destroyed) return res.json({protocolVersion:1,...answer,model:out.model??`claude:${planner} (requested)`})
    } catch {if(!res.destroyed) return res.status(503).json({error:'work_chat_unavailable',message:'No assignment was dispatched. Your saved request can be retried.'})}
    finally {res.off('close',abort);lease?.release();running=false}
  })
  return router
}
