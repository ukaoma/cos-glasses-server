/** Pure computation entry. No filesystem, native models, enrollment or writes. */
import { createHash } from 'node:crypto'
import { hasMacSpeakerProtectedRows } from './mac-speaker-protection.js'
import { isMainThread, parentPort } from 'node:worker_threads'
import { planMacSpeakerWindows, type VerifiedMacRawChunk, type PreparedMacSpeakerWindow, type MacWindowEmbeddingReceipt } from './mac-speaker-windows.js'
import { createMacSpeakerLiveState, appendMacSpeakerLiveEvidence, refreshMacSpeakerLiveState, validateMacSpeakerLiveState, validateMacSpeakerLiveProfiles, withholdMacSpeakerLiveState, hashMacSpeakerLive, type MacSpeakerLiveState } from './mac-speaker-live-memory.js'
import { prepareMacSpeakerLivePublication } from './mac-speaker-live-store.js'
import type { MacSpeakerProfile } from './mac-speaker-reconcile.js'
import type { SidecarEntry } from './nemotron-final.js'
import type { MacSpeakerLiveSourceChunk } from './mac-speaker-live-projection.js'
export interface MacSpeakerLiveComputeInput {
  captureId:string;generation:string;sourceBindingSHA256:string;fileBindingsSHA256:string;revision:number;previousDigest?:string;voiceHighWater:number
  state?:MacSpeakerLiveState;modelSHA256:string;profileSHA256:string;profileJSONBytes:Uint8Array
  chunksIndexed:readonly {i:number;c:Record<string,unknown>}[];rawChunks:VerifiedMacRawChunk[];humanHistory:boolean
}
export interface MacSpeakerLiveComputePrepared {window?:PreparedMacSpeakerWindow;plannedWindows:number;pendingWindows:number;rejectedChunks:number;reason?:string}
export type MacSpeakerLivePreparedPublication=ReturnType<typeof prepareMacSpeakerLivePublication>
export interface MacSpeakerLiveComputeResult {
  state:MacSpeakerLiveState;publication:MacSpeakerLivePreparedPublication;reason:string;plannedWindows:number;pendingWindows:number;rejectedChunks:number;completeEligibleSnapshot:boolean
}
export function prepareMacSpeakerLiveCompute(input:MacSpeakerLiveComputeInput){
  if(input.profileJSONBytes.byteLength>32*1024*1024||input.chunksIndexed.length>8192||input.rawChunks.length>8192||hashMacSpeakerLive(input.chunksIndexed)!==input.sourceBindingSHA256)throw Error('compute_input_binding')
  if(createHash('sha256').update(input.profileJSONBytes).digest('hex')!==input.profileSHA256)throw Error('compute_profile_bytes_changed')
  const parsed=JSON.parse(Buffer.from(input.profileJSONBytes).toString()) as {profiles?:MacSpeakerProfile[]}
  if(!Array.isArray(parsed.profiles))throw Error('profile_cohort_invalid')
  const profiles=parsed.profiles.map(p=>({...p,profileSHA256:input.profileSHA256}));validateMacSpeakerLiveProfiles(profiles,input.profileSHA256)
  let state=input.state
  if(state){try{validateMacSpeakerLiveState(state);if(state.captureId!==input.captureId||state.generation!==input.generation)throw Error('capture_generation_drift')}catch{state=withholdMacSpeakerLiveState(createMacSpeakerLiveState(input.captureId,input.generation,input.modelSHA256,input.profileSHA256,99),'recovered_state_invalid')}}
  state??=createMacSpeakerLiveState(input.captureId,input.generation,input.modelSHA256,input.profileSHA256,input.voiceHighWater)
  if(state.modelSHA256!==input.modelSHA256||state.profileSHA256!==input.profileSHA256)state=withholdMacSpeakerLiveState(state,'model_or_profile_drift')
  if(input.humanHistory||input.chunksIndexed.some(e=>hasMacSpeakerProtectedRows(e.c)))state=withholdMacSpeakerLiveState(state,'human_history')
  const plan=state.withheldReason?null:planMacSpeakerWindows({sidecar:{sessionId:input.captureId,chunkEntries:input.chunksIndexed.map(e=>({chunkIndex:e.i,chunk:e.c}))as unknown as SidecarEntry[]},rawChunks:input.rawChunks,correctionHistory:'verified-clear'})
  if(plan&&state.evidence.some(e=>!plan.windows.some(w=>w.id===e.window.id)))throw Error('retained_source_plan_drift')
  const pending=plan?.windows.filter(w=>!state!.evidence.some(e=>e.window.id===w.id))??[]
  const prepared:MacSpeakerLiveComputePrepared={...(pending[0]?{window:pending[0]}:{}),plannedWindows:plan?.windows.length??0,pendingWindows:pending.length,rejectedChunks:plan?.rejected.reduce((n,r)=>n+r.chunkIndexes.length,0)??0,...(state.withheldReason?{reason:state.withheldReason}:{})}
  let finished=false
  return{prepared,finish(receipt?:MacWindowEmbeddingReceipt):MacSpeakerLiveComputeResult{
    if(finished)throw Error('compute_already_finished');finished=true
    let remaining=pending.length
    if(receipt){if(!pending[0]||receipt.windowId!==pending[0].id)throw Error('compute_unrequested_receipt')
      state=appendMacSpeakerLiveEvidence(state!,{window:pending[0],receipt,nativeReceiptSHA256:hashMacSpeakerLive({window:pending[0],receipt})},profiles,input.voiceHighWater);remaining--
    }else if(!pending.length)state=refreshMacSpeakerLiveState(state!,profiles)
    const complete=!state!.withheldReason&&remaining===0
    const publication=prepareMacSpeakerLivePublication({captureId:input.captureId,generation:input.generation,chunksIndexed:input.chunksIndexed as {i:number;c:MacSpeakerLiveSourceChunk&Record<string,unknown>}[],state,validated:complete,revision:input.revision,previousDigest:input.previousDigest})
    state=publication.macSpeakerLive??state!
    return{state,publication,reason:state.withheldReason??(remaining?'eligible_evidence_pending':state.projections.length?'qualified':'no_qualified_identity'),plannedWindows:prepared.plannedWindows,pendingWindows:remaining,rejectedChunks:prepared.rejectedChunks,completeEligibleSnapshot:complete}
  }}
}
if(!isMainThread&&parentPort){
  const port=parentPort;let job:string|undefined,computation:ReturnType<typeof prepareMacSpeakerLiveCompute>|undefined
  port.on('message',(message:{id:number;job:string;op:string;input?:MacSpeakerLiveComputeInput;receipt?:MacWindowEmbeddingReceipt})=>{
    try{
      if(message.op==='prepare'){if(computation)throw Error('compute_duplicate_prepare');job=message.job;computation=prepareMacSpeakerLiveCompute(message.input!);port.postMessage({id:message.id,job,ok:true,value:computation.prepared})}
      else if(message.op==='finish'){if(!computation||job!==message.job)throw Error('compute_job_binding');port.postMessage({id:message.id,job,ok:true,value:computation.finish(message.receipt)})}
      else throw Error('compute_unknown_operation')
    }catch(error){port.postMessage({id:message.id,job:message.job,ok:false,error:error instanceof Error?error.message:'compute_failed'})}
  })
}
