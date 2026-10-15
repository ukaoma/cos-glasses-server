/** Same authenticated push-only key workflow as Jev. No key values or upstream bodies are returned. */
import { Router } from 'express'
import { existsSync, unlinkSync } from 'node:fs'
import { resetSubqDecisionClients } from '../lib/decision-provider.js'
import { saveSubqKey, subqKeyStatus, SUBQ_KEY_FILE, validateSubqKey } from '../lib/subq-key.js'
import { secureExistingPrivateFile } from '../lib/secure-user-config.js'
interface SubqKeyRouteDeps { status: typeof subqKeyStatus; save: (key:string)=>void; validate: typeof validateSubqKey; remove:()=>void; reset:()=>void }
export function createSubqKeyRouter(overrides: Partial<SubqKeyRouteDeps> = {}): Router {
  const deps:SubqKeyRouteDeps={status:()=>subqKeyStatus(),save:key=>saveSubqKey(key),validate:validateSubqKey,remove:()=>{secureExistingPrivateFile(SUBQ_KEY_FILE);if(existsSync(SUBQ_KEY_FILE))unlinkSync(SUBQ_KEY_FILE)},reset:resetSubqDecisionClients,...overrides}
  const router=Router();router.use('/subq-key',(_req,res,next)=>{res.set('Cache-Control','private, no-store');next()})
  router.get('/subq-key/status',(_req,res)=>res.json(deps.status()))
  router.post('/subq-key/set',async(req,res)=>{
    const raw=req.body?.key
    if (!req.body||typeof req.body!=='object'||Object.keys(req.body).some(k=>k!=='key')||typeof raw!=='string') return void res.status(400).json({error:{code:'invalid_subq_key',message:'Paste a SubQ API key.'}})
    const key=raw.trim()
    if(key.length<16||key.length>512||/[\s\x00-\x1f\x7f]/.test(key)) return void res.status(400).json({error:{code:'invalid_subq_key',message:'That does not look like a SubQ API key.'}})
    const check=await deps.validate(key)
    if(!check.ok)return void res.status(400).json({error:{code:'subq_key_not_accepted',message:check.reason,upstreamStatus:check.status}})
    try{deps.save(key);deps.reset()}catch{return void res.status(500).json({error:{code:'subq_key_not_saved',message:'The key could not be saved. Check the server data folder.'}})}
    res.json({ok:true,...deps.status()})
  })
  router.delete('/subq-key',(_req,res)=>{
    try{deps.remove();deps.reset()}catch{return void res.status(500).json({error:{code:'subq_key_not_removed',message:'The saved key could not be removed.'}})}
    res.json({ok:true,...deps.status()})
  })
  return router
}
