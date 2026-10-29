/** Async read-only live extraction adapter. The route owns durable publication;
 * this module never writes recordings, profiles, corrections or transcripts. */
import { constants, lstatSync, type BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { dataPath } from './data-dir.js'
import { planMacSpeakerWindows, type VerifiedMacRawChunk, type MacWindowEmbeddingReceipt } from './mac-speaker-windows.js'
import { extractQualifiedMacWindow } from './mac-speaker-profile-extractor.js'
import { readPcm16Mono, pcm16ToWav } from './nemotron-segments.js'
import { hasMacSpeakerProtectedRows } from './mac-speaker-protection.js'
import { appendMacSpeakerLiveEvidence, createMacSpeakerLiveState, hashMacSpeakerLive, refreshMacSpeakerLiveState, validateMacSpeakerLiveState, validateMacSpeakerLiveProfiles, withholdMacSpeakerLiveState, type MacSpeakerLiveState } from './mac-speaker-live-memory.js'
import type { MacSpeakerProfile } from './mac-speaker-reconcile.js'
import type { SidecarEntry } from './nemotron-final.js'
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const yieldLoop=()=>new Promise<void>(resolve=>setImmediate(resolve))
export const macSpeakerLiveEnabled=(env:NodeJS.ProcessEnv=process.env):boolean=>env.COS_MAC_SPEAKER_LIVE==='1'
export interface MacSpeakerLiveInput {
  captureId:string;generation:string;audioDir:string;ledgerPath:string
  chunksIndexed:readonly {i:number;c:Record<string,unknown>}[]
  state?:MacSpeakerLiveState;voiceHighWater:number
}
export interface MacSpeakerLiveFileBinding {path:string;exists:boolean;stamp?:string}
export const macSpeakerLiveFileStamp=(s:BigIntStats)=>[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(':')
/** No awaits between this cheap final CAS and the caller's atomic publication. */
export function assertMacSpeakerLivePublicationBindings(bindings:readonly MacSpeakerLiveFileBinding[]):void{
 if(!Array.isArray(bindings)||!bindings.length||bindings.length>8200)throw Error('live_publication_bindings_missing')
 for(const b of bindings){
  if(!b||typeof b.path!=='string'||typeof b.exists!=='boolean')throw Error('live_publication_binding_invalid')
  let stat:BigIntStats|undefined;try{stat=lstatSync(b.path,{bigint:true})}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  if(b.exists?(!stat?.isFile()||macSpeakerLiveFileStamp(stat)!==b.stamp):stat!==undefined)throw Error('live_publication_source_changed')
 }
}
export interface MacSpeakerLiveOutcome {
  state?:MacSpeakerLiveState;reason:string;latencyMs:number;plannedWindows:number;attemptedWindows:number;pendingWindows:number
  /** Completeness of this snapshot's canonical eligible plan, never every second of speech. */
  completeEligibleSnapshot:boolean;rejectedChunks:number;sourceBindingSHA256:string;fileBindings:MacSpeakerLiveFileBinding[]
}
export interface MacSpeakerLiveDeps {
  runtime?:()=>Promise<{modelPath:string;profilesPath:string}|null>
  extract?:(pcm:Buffer,modelPath:string,timeoutMs:number)=>Promise<readonly number[][]|null>
  now?:()=>number
  /** Rechecked immediately before child launch; offline tests supply explicit admission. */
  admit?:(captureId:string)=>boolean
}
// Pins are an I/O optimization only: every use reopens O_NOFOLLOW and checks
// inode/ctime/mtime/size. Changed metadata always causes fresh bytes+hash. Final
// CAS checks each same pin again; no elapsed-time trust or caller-provided hash.
const pins=new Map<string,{stamp:string;hash:string;raw?:{pcmSHA256:string;sampleCount:number}}>()
const stampOf=macSpeakerLiveFileStamp
async function pinned(path:string,max:number,raw=false):Promise<{stamp:string;hash:string;raw?:{pcmSHA256:string;sampleCount:number}}>{
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try{const before=await f.stat({bigint:true});if(!before.isFile()||before.size>BigInt(max))throw Error('unsafe_or_oversized_source')
  const stamp=stampOf(before),prior=pins.get(path)
  if(prior?.stamp===stamp&&(!raw||prior.raw))return prior
  const storage=Buffer.alloc(Number(before.size)+1);let offset=0
  while(offset<storage.length){const{bytesRead}=await f.read(storage,offset,storage.length-offset,null);if(!bytesRead)break;offset+=bytesRead}
  const bytes=storage.subarray(0,offset),after=await f.stat({bigint:true})
  if(bytes.length!==Number(before.size)||stampOf(after)!==stamp)throw Error('source_changed_during_read')
  const pcm=raw?pcmOf(bytes):undefined
  const value={stamp,hash:sha(bytes),...(pcm?{raw:{pcmSHA256:sha(pcm),sampleCount:pcm.length/2}}:{})}
  if(pins.size>=10000)pins.delete(pins.keys().next().value!);pins.set(path,value);return value
 }finally{await f.close()}
}
async function readBounded(path:string,max:number):Promise<Buffer>{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{
    const before=await file.stat({bigint:true});if(!before.isFile()||before.size>BigInt(max))throw Error('unsafe_or_oversized_source')
    const buffer=Buffer.alloc(Number(before.size)+1);let offset=0
    while(offset<buffer.length){const{bytesRead}=await file.read(buffer,offset,buffer.length-offset,null);if(!bytesRead)break;offset+=bytesRead}
    const after=await file.stat({bigint:true})
    if(offset!==Number(before.size)||stampOf(after)!==stampOf(before))throw Error('source_changed_during_read')
    const bytes=buffer.subarray(0,offset),prior=pins.get(path)
    if(pins.size>=10000)pins.delete(pins.keys().next().value!)
    pins.set(path,{stamp:stampOf(before),hash:sha(bytes),...(prior?.hash===sha(bytes)&&prior.raw?{raw:prior.raw}:{})})
    return bytes
  }finally{await file.close()}
}
async function ledgerBytes(path:string):Promise<Buffer|null>{try{return await readBounded(path,1024*1024)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}}
function pcmOf(wav:Buffer):Buffer{
  if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.readUInt32LE(4)!==wav.length-8||wav.toString('ascii',8,12)!=='WAVE'||wav.toString('ascii',12,16)!=='fmt '||wav.readUInt32LE(16)!==16||wav.readUInt16LE(20)!==1
    ||wav.readUInt16LE(22)!==1||wav.readUInt32LE(24)!==16000||wav.readUInt16LE(34)!==16||wav.toString('ascii',36,40)!=='data'||wav.readUInt32LE(40)!==wav.length-44||(wav.length-44)%2)throw Error('invalid_raw_audio')
  const pcm=readPcm16Mono(wav);if(!pcm||pcm.sampleRate!==16000)throw Error('invalid_raw_audio');return pcm.pcm
}
async function defaultRuntime(){
 // speakerModelState()/isEmbeddingAvailable() initialize the legacy native
 // extractor synchronously. Candidate discovery here must never call either.
 const{speakerModelCandidates}=await import('./speaker-embeddings.js')
 for(const modelPath of speakerModelCandidates()){
  let file:Awaited<ReturnType<typeof open>>|undefined
  try{file=await open(modelPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await file.stat()
   if(info.isFile()&&info.size>=1000000&&info.size<=128*1024*1024)return{modelPath,profilesPath:dataPath('voice-profiles.json')}
  }catch{/* try the next configured local candidate */}finally{await file?.close()}
 }
 return null
}
let busy=false
/** One new disjoint window per invocation; the scheduler drains backlog without
 * blocking transcription. No sampled12-window plan and no first-N-success claim. */
export async function runMacSpeakerLivePass(input:MacSpeakerLiveInput,deps:MacSpeakerLiveDeps={}):Promise<MacSpeakerLiveOutcome>{
  const now=deps.now??Date.now,start=now(),sourceBindingSHA256=hashMacSpeakerLive(input.chunksIndexed)
  let fileBindings:MacSpeakerLiveFileBinding[]=[],state=input.state,plannedWindows=0,attemptedWindows=0,pendingWindows=0,rejectedChunks=0,owns=false
  const result=(reason:string,completeEligibleSnapshot=false):MacSpeakerLiveOutcome=>({state,reason,latencyMs:now()-start,plannedWindows,attemptedWindows,pendingWindows,completeEligibleSnapshot,rejectedChunks,sourceBindingSHA256,fileBindings})
  try{
    const admitted=()=> (deps.admit??(()=>macSpeakerLiveEnabled()))(input.captureId)
    if(!admitted())return result('live_admission_closed')
    if(state){validateMacSpeakerLiveState(state);if(state.captureId!==input.captureId||state.generation!==input.generation)throw Error('capture_generation_drift')}
    if(input.chunksIndexed.length>8192)throw Error('raw_source_budget_exhausted')
    const ledger=await ledgerBytes(input.ledgerPath)
    if(ledger?.toString().trim()||input.chunksIndexed.some(e=>hasMacSpeakerProtectedRows(e.c))){if(state)state=withholdMacSpeakerLiveState(state,'human_history');return result('human_history')}
    const runtime=await(deps.runtime??defaultRuntime)();if(!runtime)throw Error('model_unavailable')
    const profileBytes=await readBounded(runtime.profilesPath,32*1024*1024),profileSHA256=sha(profileBytes)
    const initialProfileStamp=pins.get(runtime.profilesPath)!.stamp
    const modelPin=await pinned(runtime.modelPath,128*1024*1024),modelSHA256=modelPin.hash
    const initialLedgerStamp=ledger!==null?pins.get(input.ledgerPath)!.stamp:undefined
    await yieldLoop()
    const parsed=JSON.parse(profileBytes.toString()) as {profiles?:Array<{name:string;embeddings:number[][]}>}
    if(!Array.isArray(parsed.profiles))throw Error('profile_cohort_invalid')
    const profiles:MacSpeakerProfile[]=parsed.profiles.map(p=>({...p,profileSHA256}));validateMacSpeakerLiveProfiles(profiles,profileSHA256)
    if(state&&(state.modelSHA256!==modelSHA256||state.profileSHA256!==profileSHA256))throw Error('model_or_profile_drift')
    state??=createMacSpeakerLiveState(input.captureId,input.generation,modelSHA256,profileSHA256,input.voiceHighWater)
    if(state.withheldReason)return result(state.withheldReason)
    const raw:VerifiedMacRawChunk[]=[],bindings=new Map<number,{hash:string;stamp:string}>()
    for(const entry of input.chunksIndexed){
      if(!Number.isSafeInteger(entry.i)||entry.i<0||entry.i>=10000)throw Error('invalid_raw_index')
      // Unhashed legacy placeholders cannot become support; planner reports them.
      if(typeof entry.c.audioSha256!=='string')continue
      const binding=await pinned(join(input.audioDir,`chunk_${String(entry.i).padStart(4,'0')}.wav`),960044,true),audioSHA256=binding.hash
      if(audioSHA256!==entry.c.audioSha256)throw Error('raw_audio_drift')
      bindings.set(entry.i,{hash:audioSHA256,stamp:binding.stamp})
      raw.push({chunkIndex:entry.i,audioSHA256,pcmSHA256:binding.raw!.pcmSHA256,sampleRate:16000,channels:1,format:'pcm_s16le',sampleCount:binding.raw!.sampleCount,verified:true})
      await yieldLoop();if(now()-start>15000)throw Error('live_pass_deadline')
    }
    const plan=planMacSpeakerWindows({sidecar:{sessionId:input.captureId,chunkEntries:input.chunksIndexed.map(e=>({chunkIndex:e.i,chunk:e.c})) as unknown as SidecarEntry[]},rawChunks:raw,correctionHistory:'verified-clear'})
    plannedWindows=plan.windows.length;rejectedChunks=plan.rejected.reduce((n,r)=>n+r.chunkIndexes.length,0)
    // Restored evidence must remain in the recomputed canonical universe.
    if(state.evidence.some(e=>!plan.windows.some(w=>w.id===e.window.id)))throw Error('retained_source_plan_drift')
    const pending=plan.windows.filter(w=>!state!.evidence.some(e=>e.window.id===w.id));pendingWindows=pending.length
    if(pending.length){
      if(busy)return result('native_lane_busy')
      busy=true;owns=true;const window=pending[0],buffers:Buffer[]=[]
      for(const source of window.sources){const wav=await readBounded(join(input.audioDir,`chunk_${String(source.chunkIndex).padStart(4,'0')}.wav`),960044);if(sha(wav)!==source.audioSHA256)throw Error('raw_audio_drift');buffers.push(pcmOf(wav))}
      const pcm=Buffer.concat(buffers);attemptedWindows++
      if(!admitted())return result('live_admission_closed')
      const vectors=await(deps.extract??extractQualifiedMacWindow)(pcm,runtime.modelPath,Math.max(1,Math.min(8000,15000-(now()-start))))
      if(!vectors)return result('extraction_unavailable')
      const receipt:MacWindowEmbeddingReceipt={windowId:window.id,windowBindingSHA256:window.bindingSHA256,modelSHA256,audioSHA256:sha(pcm16ToWav(pcm,16000)),pcmSHA256:sha(pcm),sampleCount:pcm.length/2,embedding:vectors[0],halfEmbeddings:[vectors[1],vectors[2]]}
      state=appendMacSpeakerLiveEvidence(state,{window,receipt,nativeReceiptSHA256:hashMacSpeakerLive({window,receipt})},profiles,input.voiceHighWater)
      pendingWindows--
    }else state=refreshMacSpeakerLiveState(state,profiles)
    // Final complete source/model/profile/history CAS, before route publication.
    if(sha(await readBounded(runtime.profilesPath,32*1024*1024))!==profileSHA256||(await pinned(runtime.modelPath,128*1024*1024)).hash!==modelSHA256
      ||hashMacSpeakerLive(await ledgerBytes(input.ledgerPath))!==hashMacSpeakerLive(ledger))throw Error('model_profile_or_history_changed')
    for(const[index,expected]of bindings){if((await pinned(join(input.audioDir,`chunk_${String(index).padStart(4,'0')}.wav`),960044,true)).hash!==expected.hash)throw Error('raw_audio_drift');await yieldLoop();if(now()-start>15000)throw Error('live_pass_deadline')}
    // Keep INITIAL verified inode/time pins. Equal bytes restored after a
    // mutation cannot prove what the owned native child actually loaded.
    fileBindings=[{path:runtime.modelPath,exists:true,stamp:modelPin.stamp},{path:runtime.profilesPath,exists:true,stamp:initialProfileStamp},
      ...[...bindings].map(([index,binding])=>({path:join(input.audioDir,`chunk_${String(index).padStart(4,'0')}.wav`),exists:true,stamp:binding.stamp}))]
    fileBindings.push({path:input.ledgerPath,exists:ledger!==null,...(ledger!==null?{stamp:initialLedgerStamp}:{})})
    assertMacSpeakerLivePublicationBindings(fileBindings)
    validateMacSpeakerLiveState(state)
    return result(state.withheldReason??(pendingWindows?'eligible_evidence_pending':state.projections.length?'qualified':'no_qualified_identity'),pendingWindows===0)
  }catch(error){
    const reason=error instanceof Error?error.message:'live_unavailable'
    if(state){try{state=withholdMacSpeakerLiveState(state,reason.slice(0,200))}catch{state=undefined}}
    return result(reason)
  }finally{if(owns)busy=false}
}
/** Coalescing async runner; no spin on unavailable models or failed extraction. */
export function createMacSpeakerLiveScheduler(deps:{snapshot:(captureId:string)=>MacSpeakerLiveInput|null;commit:(captureId:string,outcome:MacSpeakerLiveOutcome)=>boolean;runtime?:MacSpeakerLiveDeps;lease?:()=>{release():void}}){
  const pending=new Set<string>();let running=false
  const pump=async()=>{if(running)return;running=true;try{
    while(pending.size){const id=pending.values().next().value!;pending.delete(id);const input=deps.snapshot(id);if(!input)continue
      let lease:{release():void}|undefined
      try{
        lease=deps.lease?.()
        const outcome=await runMacSpeakerLivePass(input,deps.runtime)
        const applied=deps.commit(id,outcome)
        if(applied&&outcome.state&&outcome.reason==='eligible_evidence_pending')pending.add(id)
      }catch{/* Closed maintenance admission defers work until a new capture event. */}finally{lease?.release()}
      await yieldLoop()
    }
  }finally{running=false}}
  return{schedule(captureId:string){pending.add(captureId);setImmediate(()=>{void pump().catch(()=>{})})},async drain(){await pump();while(running)await new Promise<void>(r=>setTimeout(r,5))}}
}
