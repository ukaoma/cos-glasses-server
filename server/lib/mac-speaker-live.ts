/** Async read-only live extraction adapter. The route owns durable publication;
 * this module never writes recordings, profiles, corrections or transcripts. */
import { constants, lstatSync, type BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { dataPath } from './data-dir.js'
import { type VerifiedMacRawChunk, type MacWindowEmbeddingReceipt } from './mac-speaker-windows.js'
import { extractQualifiedMacWindow } from './mac-speaker-profile-extractor.js'
import { readPcm16Mono, pcm16ToWav } from './nemotron-segments.js'
import { startMacSpeakerLiveCompute, type MacSpeakerLivePublicationCapability } from './mac-speaker-live-compute.js'
import { hashMacSpeakerLive, type MacSpeakerLiveState } from './mac-speaker-live-memory.js'
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const yieldLoop=()=>new Promise<void>(resolve=>setImmediate(resolve))
async function shaYielding(bytes:Buffer):Promise<string>{const hash=createHash('sha256');for(let at=0;at<bytes.length;at+=1024*1024){hash.update(bytes.subarray(at,at+1024*1024));await yieldLoop()}return hash.digest('hex')}
export const macSpeakerLiveEnabled=(env:NodeJS.ProcessEnv=process.env):boolean=>env.COS_MAC_SPEAKER_LIVE==='1'
export interface MacSpeakerLiveInput {
  captureId:string;generation:string;audioDir:string;ledgerPath:string
  chunksIndexed:readonly {i:number;c:Record<string,unknown>}[]
  state?:MacSpeakerLiveState;voiceHighWater:number;revision?:number;previousDigest?:string
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
  completeEligibleSnapshot:boolean;rejectedChunks:number;sourceBindingSHA256:string;fileBindings:MacSpeakerLiveFileBinding[];capability?:MacSpeakerLivePublicationCapability
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
  const value={stamp,hash:await shaYielding(bytes),...(pcm?{raw:{pcmSHA256:sha(pcm),sampleCount:pcm.length/2}}:{})}
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
    const hash=await shaYielding(bytes)
    pins.set(path,{stamp:stampOf(before),hash,...(prior?.hash===hash&&prior.raw?{raw:prior.raw}:{})})
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
  let compute:Awaited<ReturnType<typeof startMacSpeakerLiveCompute>>|undefined,capability:MacSpeakerLivePublicationCapability|undefined,fileBindings:MacSpeakerLiveFileBinding[]=[],state=input.state,plannedWindows=0,attemptedWindows=0,pendingWindows=0,rejectedChunks=0,owns=false
  const result=(reason:string,completeEligibleSnapshot=false):MacSpeakerLiveOutcome=>({state,reason,latencyMs:now()-start,plannedWindows,attemptedWindows,pendingWindows,completeEligibleSnapshot,rejectedChunks,sourceBindingSHA256,fileBindings,capability})
  try{
    const admitted=()=> (deps.admit??(()=>macSpeakerLiveEnabled()))(input.captureId)
    if(!admitted())return result('live_admission_closed')
    if(input.chunksIndexed.length>8192)throw Error('raw_source_budget_exhausted')
    const ledger=await ledgerBytes(input.ledgerPath)
    const runtime=await(deps.runtime??defaultRuntime)();if(!runtime)throw Error('model_unavailable')
    const profileBytes=await readBounded(runtime.profilesPath,32*1024*1024),profileSHA256=await shaYielding(profileBytes)
    const initialProfileStamp=pins.get(runtime.profilesPath)!.stamp
    const modelPin=await pinned(runtime.modelPath,128*1024*1024),modelSHA256=modelPin.hash
    const initialLedgerStamp=ledger!==null?pins.get(input.ledgerPath)!.stamp:undefined
    await yieldLoop()
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
    fileBindings=[{path:runtime.modelPath,exists:true,stamp:modelPin.stamp},{path:runtime.profilesPath,exists:true,stamp:initialProfileStamp},
      ...[...bindings].map(([index,binding])=>({path:join(input.audioDir,`chunk_${String(index).padStart(4,'0')}.wav`),exists:true,stamp:binding.stamp}))]
    fileBindings.push({path:input.ledgerPath,exists:ledger!==null,...(ledger!==null?{stamp:initialLedgerStamp}:{})})
    compute=await startMacSpeakerLiveCompute({captureId:input.captureId,generation:input.generation,sourceBindingSHA256,fileBindingsSHA256:hashMacSpeakerLive(fileBindings),revision:input.revision??0,previousDigest:input.previousDigest,
      voiceHighWater:input.voiceHighWater,state:input.state,modelSHA256,profileSHA256,profileJSONBytes:new Uint8Array(profileBytes.buffer,profileBytes.byteOffset,profileBytes.byteLength),chunksIndexed:input.chunksIndexed,rawChunks:raw,humanHistory:!!ledger?.toString().trim()},
      {timeoutMs:Math.max(1,Math.min(5000,15000-(now()-start)))})
    const prepared=compute.prepared;plannedWindows=prepared.plannedWindows;pendingWindows=prepared.pendingWindows;rejectedChunks=prepared.rejectedChunks
    let receipt:MacWindowEmbeddingReceipt|undefined
    if(prepared.window){
      if(busy)return result('native_lane_busy')
      busy=true;owns=true;const window=prepared.window,buffers:Buffer[]=[]
      for(const source of window.sources){const wav=await readBounded(join(input.audioDir,`chunk_${String(source.chunkIndex).padStart(4,'0')}.wav`),960044);if(sha(wav)!==source.audioSHA256)throw Error('raw_audio_drift');buffers.push(pcmOf(wav))}
      const pcm=Buffer.concat(buffers);attemptedWindows++
      if(!admitted())return result('live_admission_closed')
      const vectors=await(deps.extract??extractQualifiedMacWindow)(pcm,runtime.modelPath,Math.max(1,Math.min(8000,15000-(now()-start))))
      if(vectors)receipt={windowId:window.id,windowBindingSHA256:window.bindingSHA256,modelSHA256,audioSHA256:sha(pcm16ToWav(pcm,16000)),pcmSHA256:sha(pcm),sampleCount:pcm.length/2,embedding:vectors[0],halfEmbeddings:[vectors[1],vectors[2]]}
    }
    const finished=await compute.finish(receipt)
    state=finished.state;capability=finished.capability;pendingWindows=finished.pendingWindows
    // Final complete source/model/profile/history CAS, before route publication.
    if(await shaYielding(await readBounded(runtime.profilesPath,32*1024*1024))!==profileSHA256||(await pinned(runtime.modelPath,128*1024*1024)).hash!==modelSHA256
      ||hashMacSpeakerLive(await ledgerBytes(input.ledgerPath))!==hashMacSpeakerLive(ledger))throw Error('model_profile_or_history_changed')
    for(const[index,expected]of bindings){if((await pinned(join(input.audioDir,`chunk_${String(index).padStart(4,'0')}.wav`),960044,true)).hash!==expected.hash)throw Error('raw_audio_drift');await yieldLoop();if(now()-start>15000)throw Error('live_pass_deadline')}
    assertMacSpeakerLivePublicationBindings(fileBindings)
    if(!admitted())throw Error('live_admission_closed')
    if(now()-start>15000)throw Error('live_pass_deadline')
    return result(prepared.window&&!receipt?'extraction_unavailable':finished.reason,finished.completeEligibleSnapshot)
  }catch(error){
    const reason=error instanceof Error?error.message:'live_unavailable'
    state=undefined;capability=undefined
    return result(reason)
  }finally{await compute?.close();if(owns)busy=false}
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
