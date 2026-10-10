// Manual opt-in canary. Real Haiku, invented speech, private data/home and ephemeral loopback port.
// Run: COS_DATA_DIR=<scratch>/data node --import tsx/esm server/scripts/live-cos-ask-canary.ts <compiled-helper> <receipt.json>
import express from 'express'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { requireApiToken } from '../lib/api-auth.js'
import { liveCosAskRouter } from '../routes/live-cos-ask.js'
const [helper, receiptPath] = process.argv.slice(2)
if (!helper || !receiptPath || !process.env.COS_DATA_DIR?.startsWith('/tmp/')) throw new Error('Pass a compiled helper, receipt path and private /tmp COS_DATA_DIR')
const home = mkdtempSync('/tmp/cos-ask-canary-home-')
const token = randomBytes(32).toString('hex')
mkdirSync(join(home, '.cos-glasses'), { mode: 0o700 })
writeFileSync(join(home, '.cos-glasses/.env'), `COS_API_TOKEN=${token}\n`, { mode: 0o600 })
const app = express()
let receivedAsk = false
app.use((req, _res, next) => { if (req.path === '/api/meetings/live-ask') receivedAsk = true; next() })
app.use('/api', requireApiToken(token))
app.get('/api/health', (_req,res)=>res.json({ok:true}))
app.use(express.json({limit:'1mb'}))
app.use('/api',liveCosAskRouter)
const server = app.listen(0,'127.0.0.1')
await new Promise<void>(r=>server.once('listening',r))
const port = (server.address() as any).port
const request={sessionId:'meeting_123_native_canary',action:'actions',question:'Action items',elapsedMs:90000,turns:[
{id:0,elapsedMs:10000,speaker:'Maya',text:'I will send the launch draft to Jordan by Friday.'},
{id:1,elapsedMs:45000,speaker:'Jordan',text:'I will review the draft. We have not agreed on a review deadline.'}
]}
const started=Date.now()
try {
 const out=await new Promise<string>((resolve,reject)=>{
   const child=spawn(helper,['live-cos-ask'],{env:{...process.env,COS_CONTROL_TEST_HOME:home,COS_CONTROL_TEST_API_PORT:String(port)},stdio:['pipe','pipe','pipe']})
   let stdout='',stderr=''
   child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b)
   child.on('error',reject)
   child.on('close',code=>{if(code!==0||stderr) reject(new Error('Helper failed'));else resolve(stdout)})
   child.stdin.end(JSON.stringify(request))
 })
 const value=JSON.parse(out)
 if (!value.ok) console.log(JSON.stringify({helperOK:value.ok,message:value.message}))
 if (!receivedAsk || !value.ok || !value.details.sources.some((s:any)=>s.kind==='transcript') || !value.details.model.includes('haiku')) throw new Error('Canary did not return grounded Haiku answer')
 const receipt={status:'passed',milliseconds:Date.now()-started,transport:'compiled helper + pairing-authenticated fixture API + real Haiku',fixtureOnly:true,...value.details}
 writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n')
 console.log(JSON.stringify({status:receipt.status,milliseconds:receipt.milliseconds,model:receipt.model,sources:receipt.sources.length}))
} finally { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); rmSync(home,{recursive:true,force:true}) }
