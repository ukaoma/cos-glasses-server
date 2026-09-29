/** Local qualification adapter for the actual WorkReviewRuntime. The installed server
 * stays untouched. Only Ollama is eligible: public query admission strips trusted
 * read-only dispatch. All task/source reads go to the existing authenticated API. */
import express from 'express'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, lstatSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { WorkReviewStore } from '../lib/work-review-store.js'
import { WorkReviewRuntime } from '../lib/work-review-runtime.js'
import { createWorkReviewsRouter } from '../routes/work-reviews.js'
import { createWorkBoardRouter } from '../routes/work-board.js'
import { createWorkIntakeRouter } from '../routes/work-intake.js'
import { WorkIntakeStore, createOptionalWorkIntakeStore } from '../lib/work-intake-store.js'
import { createJevRouter } from '../routes/jev.js'
import { JevClient } from '../lib/jev.js'
import { pythonBridgeAvailable } from '../lib/python-bridge.js'
import { listBoard } from '../lib/task-store.js'
import type { MeetingDetail } from '../lib/meeting-store.js'
import type { QueryJobSnapshot } from '../lib/query-job-types.js'

const root = resolve(process.env.COS_WORK_REVIEW_CANDIDATE_HOME || '')
if (!process.env.COS_WORK_REVIEW_CANDIDATE_HOME || root === '/') throw new Error('Explicit private candidate home required')
// Launcher creates the root; validate every existing component before any write.
const canonicalRoot = realpathSync(root)
const candidateBase = join(homedir(), 'Library/Application Support/COS Control/candidates')
const canonicalBase = existsSync(candidateBase) ? realpathSync(candidateBase) : candidateBase
if (!(canonicalRoot.startsWith(canonicalBase + '/') || /^\/private\/tmp\/cos-work-(redesign|review)-[A-Za-z0-9_.-]+$/.test(canonicalRoot))) throw new Error('Use a COS candidate or private canary root')
let component = '/'
for(const segment of root.split('/').filter(Boolean)) {
  component = join(component,segment)
  if(component === '/tmp')continue // macOS system symlink to /private/tmp
  if(lstatSync(component).isSymbolicLink())throw new Error('Candidate ancestors must not be symlinks')
}
const info = lstatSync(root)
if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Candidate home must be private and owned')
const port = Number(process.env.COS_WORK_REVIEW_CANDIDATE_PORT || 3157)
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3141,3143].includes(port)) throw new Error('Use a nonproduction loopback port')
const envPath = join(homedir(), '.cos-glasses', '.env')
const envInfo = lstatSync(envPath)
if (!envInfo.isFile() || envInfo.isSymbolicLink() || envInfo.uid !== process.getuid?.() || (envInfo.mode & 0o077)) throw new Error('Unsafe installed token file')
const upstreamToken = readFileSync(envPath,'utf8').split('\n').find(x => x.startsWith('COS_API_TOKEN='))?.slice(14).trim()
if (!upstreamToken || upstreamToken.length < 16) throw new Error('Installed pairing unavailable')
const tokenFile = join(root,'candidate-token')
let token: string
if (existsSync(tokenFile)) {
  const t=lstatSync(tokenFile)
  if(!t.isFile() || t.isSymbolicLink() || t.uid!==process.getuid?.() || (t.mode & 0o077) || t.size!==64) throw new Error('Unsafe candidate token')
  token=readFileSync(tokenFile,'utf8')
  if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid candidate token')
} else { token=randomBytes(32).toString('hex');writeFileSync(tokenFile,token,{mode:0o600,flag:'wx'}) }
async function upstream(path:string, body?:unknown):Promise<any> {
  const response=await fetch(`http://127.0.0.1:3141${path}`,{method:body?'POST':'GET',headers:{'X-COS-Token':upstreamToken!,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30_000)})
  if(response.status===404 && path.startsWith('/api/query-jobs/by-client/')) return {job:null}
  if(!response.ok) throw new Error(`Upstream ${response.status} at ${path.split('?')[0]}`)
  return response.json()
}
const counter=await upstream('/api/message-counter')
const runtime=new WorkReviewRuntime({
  store:new WorkReviewStore(join(root,'reviews')),
  resolveMeeting:async descriptor=> {
    if(process.env.COS_WORK_REVIEW_SYNTHETIC==='1' && descriptor.recordId==='qa:work-review-canary') return {
      recordId:'qa:work-review-canary', title:'Synthetic website review', domain:'personal', month:'2026-09', filename:'2026-09-27_Work_Review_Canary.md',
      sourceContent:'Synthetic QA meeting. Alex will draft a clearer homepage call to action and check mobile spacing. Done when the draft is available for review. No publication or external messages are authorized.',sourceTruncated:false,
      attendees:['Alex'],actions:[],actionItems:[{task:'Draft a clearer homepage call to action and check mobile spacing',owner:'Alex'}],decisions:[],sources:[]
    } as unknown as MeetingDetail
    const data=await upstream('/api/meetings/detail?'+new URLSearchParams({domain:descriptor.domain,month:descriptor.month,filename:descriptor.filename}))
    return (data.meeting ?? data.detail ?? data) as MeetingDetail
  },
  listTasks:async()=> process.env.COS_WORK_REVIEW_SYNTHETIC==='1' ? [] : (await upstream('/api/tasks')).tasks,
  models:async()=> {
    const [health,catalog]=await Promise.all([upstream('/api/health'),upstream('/api/models')])
    return [{id:'ollama',provider:'ollama',title:'Ollama · configured local model',available:health.features?.ollama===true && catalog.ollamaReady===true,reason:'Local candidate review uses the configured text-only Ollama route.'}]
  },
  currentMessageEra:()=>counter.era,
  jobs:{submit:async request=> {
    const value=request as Record<string,unknown>
    if(value.model!=='ollama') throw new Error('Candidate adapter permits text-only Ollama reviews')
    const {dispatch:_dispatch,...body}=value
    return upstream('/api/query-jobs',body)
  },getByClientGeneration:async(id,generation)=>(await upstream(`/api/query-jobs/by-client/${encodeURIComponent(id)}?generation=${generation}`)).job as QueryJobSnapshot|null},
  intervalMs:2000,
})
await runtime.start()
const app=express()
// Producer intake batches (up to 200 items, ~140 KB measured) need more room than review requests; production allows 10 MB.
app.use('/api/work-intake/items',express.json({limit:'1mb'}))
// Session advice carries up to 80 sessions (Control keeps it under ~57 KB); 66 real sessions measured 20 KB.
app.use('/api/work-board/session-recommendation',express.json({limit:'128kb'}))
app.use(express.json({limit:'16kb'}));
app.use((req,res,next)=> { const raw=Buffer.from(req.get('X-COS-Token')||''); const expected=Buffer.from(token);if(raw.length!==expected.length || !timingSafeEqual(raw,expected))return res.status(401).json({error:'unauthorized'});next() })
app.use('/api',createWorkReviewsRouter(runtime))
const boardList=async()=>pythonBridgeAvailable()?listBoard():(await upstream('/api/tasks')).tasks
const savedMeeting=async(descriptor:{domain:string,month:string,filename:string})=> {
  const data=await upstream('/api/meetings/detail?'+new URLSearchParams({domain:descriptor.domain,month:descriptor.month,filename:descriptor.filename}))
  return (data.meeting ?? data.detail ?? data) as MeetingDetail
}
app.use('/api',createWorkBoardRouter({list:boardList,resolveMeeting:savedMeeting}))
// Work intake (6.57.0) keeps its own journal in the candidate home; the installed server's journal is never opened.
// Without the COS bridge, accepts refuse as read-only instead of reaching for the installed task store.
const intake=createOptionalWorkIntakeStore(()=>new WorkIntakeStore(join(root,'work-intake')))  // a bad journal answers 503, the candidate stays up
app.use('/api',createWorkIntakeRouter({store:intake,list:boardList,resolveMeeting:savedMeeting,
  ...(pythonBridgeAvailable()?{}:{capabilities:async()=>({linkWrites:false,cardCreation:false})})}))
// Jev key status and Continue/Fork/New advice, against the same board. The key is READ from the installed server
// (saved or env); the candidate never sets or removes it, and counts its own spend in the candidate home.
app.use('/api/jev-key',(req,res,next)=>req.method==='GET'?next():res.status(403).json({error:{code:'candidate_read_only',message:'Set the Jev key in the installed COS Control.'}}))
app.use('/api',createJevRouter({list:boardList,jev:new JevClient(fetch,()=>new Date(),join(root,'jev-usage.json')),review:async id=>runtime.peek(id)}))
const server=app.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,port,tokenFile,mode:'local-candidate',provider:'ollama'})))
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{server.close();intake?.close();void runtime.close().then(()=>process.exit(0))})
