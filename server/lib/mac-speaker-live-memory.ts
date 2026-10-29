/** Capture-long192d identity evidence. Pure transitions; never enrollment or text edits. */
import { checkSpeakerName } from './speaker-name.js'
import { isVoiceLabel } from './mac-voice-labels.js'
import { createHash } from 'node:crypto'
import { DEFAULT_MAC_SPEAKER_THRESHOLDS, createMacSpeakerMemory, validateMacSpeakerMemory, reconcileMacSpeakerObservation, matchMacSpeakerProfile, normalizedSpeakerEmbedding, normalizedSpeakerCosine,
  type MacSpeakerMemory, type MacSpeakerObservation, type MacSpeakerProfile } from './mac-speaker-reconcile.js'
import type { PreparedMacSpeakerWindow, MacWindowEmbeddingReceipt } from './mac-speaker-windows.js'

const SHA=/^[a-f0-9]{64}$/
export const MAC_SPEAKER_LIVE_MAX_WINDOWS=256
export const hashMacSpeakerLive=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export interface MacSpeakerLiveSpan {
  rawChunkIndex:number;audioSHA256:string;pcmSHA256:string
  /** Capture-absolute, half-open samples at16kHz; exact whole original, never a crop. */
  startSample:number;endSample:number;identityId:string;displayLabel:string;profileName?:string;evidenceIds:string[]
}
export interface MacSpeakerLiveEvidence {
  window:PreparedMacSpeakerWindow;receipt:MacWindowEmbeddingReceipt
  /** Hash of the complete model/source/vector receipt, computed after owned child close. */
  nativeReceiptSHA256:string
  cohortId?:number
}
export interface MacSpeakerLiveState {
  version:1;captureId:string;generation:string;modelSHA256:string;profileSHA256:string;revision:number
  memory:MacSpeakerMemory;evidence:MacSpeakerLiveEvidence[]
  identities:Array<{cohortId:number;identityId:string;displayLabel:string;retired:boolean}>
  voiceHighWater:number;projections:MacSpeakerLiveSpan[];withheldReason:string|null;stateSHA256:string
}
const seal=(state:MacSpeakerLiveState):MacSpeakerLiveState=>{const{stateSHA256:_hash,...body}=state;state.stateSHA256=hashMacSpeakerLive(body);return state}
export function createMacSpeakerLiveState(captureId:string,generation:string,modelSHA256:string,profileSHA256:string,voiceHighWater=0):MacSpeakerLiveState {
  if(!generation||generation.length>200||!SHA.test(profileSHA256)||!Number.isSafeInteger(voiceHighWater)||voiceHighWater<0||voiceHighWater>99)throw Error('live_binding')
  return seal({version:1,captureId,generation,modelSHA256,profileSHA256,revision:0,memory:createMacSpeakerMemory(captureId,modelSHA256,{minimumSamples:320000}),evidence:[],identities:[],voiceHighWater,projections:[],withheldReason:null,stateSHA256:''})
}
function validEvidence(e:MacSpeakerLiveEvidence,state:MacSpeakerLiveState):void {
  const w=e.window,r=e.receipt
  if(!w||!r||!Number.isSafeInteger(w.startSample)||w.startSample<0||!Number.isSafeInteger(w.endSample)||!isVoiceLabel(w.originalVoiceHint)||!Array.isArray(w.sources)||!w.sources.length||w.sources.length>30||w.captureId!==state.captureId||r.modelSHA256!==state.modelSHA256||r.windowId!==w.id||r.windowBindingSHA256!==w.bindingSHA256
    ||r.sampleCount!==w.sampleCount||w.endSample-w.startSample!==w.sampleCount||w.sampleCount<448000||w.sampleCount>480000||!SHA.test(r.audioSHA256)||!SHA.test(r.pcmSHA256)
    ||!normalizedSpeakerEmbedding(r.embedding,192)||!Array.isArray(r.halfEmbeddings)||r.halfEmbeddings.length!==2||r.halfEmbeddings.some(v=>!normalizedSpeakerEmbedding(v,192)))throw Error('live_evidence_binding')
  const{id:_,bindingSHA256,...body}=w
  if(hashMacSpeakerLive(body)!==bindingSHA256||w.id!==`window_${bindingSHA256}`||e.nativeReceiptSHA256!==hashMacSpeakerLive({window:w,receipt:r}))throw Error('live_receipt_hash')
  let at=w.startSample,speech=0;const indices=new Set<number>(),hashes=new Set<string>()
  for(const s of w.sources){
    if(!Number.isSafeInteger(s.chunkIndex)||s.chunkIndex<0||s.startSample!==at||s.endSample-s.startSample!==s.sampleCount||!Number.isSafeInteger(s.sampleCount)||s.sampleCount<=0
      ||s.sampleRate!==16000||s.channels!==1||s.format!=='pcm_s16le'||s.verified!==true||!SHA.test(s.audioSHA256)||!SHA.test(s.pcmSHA256)||!SHA.test(s.textSHA256)||!SHA.test(s.segmentsSHA256)
      ||indices.has(s.chunkIndex)||hashes.has(s.pcmSHA256)||!Number.isSafeInteger(s.speechSamples)||s.speechSamples<0||s.speechSamples>s.sampleCount)throw Error('live_source_geometry')
    at=s.endSample;speech+=s.speechSamples;indices.add(s.chunkIndex);hashes.add(s.pcmSHA256)
  }
  if(at!==w.endSample||speech!==w.speechSamples||speech<320000)throw Error('live_source_speech')
}
export function validateMacSpeakerLiveState(state:MacSpeakerLiveState):void {
  if(!state||state.version!==1||!state.generation||!SHA.test(state.modelSHA256)||!SHA.test(state.profileSHA256)||!Number.isSafeInteger(state.revision)||state.revision<0||state.revision>=Number.MAX_SAFE_INTEGER-1
    ||!Array.isArray(state.evidence)||state.evidence.length>MAC_SPEAKER_LIVE_MAX_WINDOWS||!Array.isArray(state.identities)||state.identities.length>99||!Array.isArray(state.projections)||state.projections.length>8192
    ||!Number.isSafeInteger(state.voiceHighWater)||state.voiceHighWater<0||state.voiceHighWater>99||Buffer.byteLength(JSON.stringify(state))>8*1024*1024)throw Error('live_state_bound')
  const{stateSHA256,...body}=state;if(hashMacSpeakerLive(body)!==stateSHA256)throw Error('live_state_hash')
  validateMacSpeakerMemory(state.memory)
  if(hashMacSpeakerLive(state.memory.thresholds)!==hashMacSpeakerLive({...DEFAULT_MAC_SPEAKER_THRESHOLDS,minimumSamples:320000}))throw Error('live_threshold_drift')
  if(state.memory.captureId!==state.captureId||state.memory.modelSHA256!==state.modelSHA256||state.memory.thresholds.dimensions!==192||state.memory.thresholds.minimumSamples!==320000)throw Error('live_memory_binding')
  const seen=new Set<string>(),raw=new Set<number>(),pcm=new Set<string>()
  for(const e of state.evidence){validEvidence(e,state);if(e.cohortId!==undefined&&(!Number.isSafeInteger(e.cohortId)||!state.memory.identities.some(i=>i.id===e.cohortId)))throw Error('live_cohort_reference');if(seen.has(e.window.id))throw Error('live_duplicate_window');seen.add(e.window.id)
    for(const source of e.window.sources){if(raw.has(source.chunkIndex)||pcm.has(source.pcmSHA256))throw Error('live_duplicate_source');raw.add(source.chunkIndex);pcm.add(source.pcmSHA256)}}
  const ids=new Set<string>(),labels=new Set<string>(),cohorts=new Set<number>()
  for(const i of state.identities){if(ids.has(i.identityId)||labels.has(i.displayLabel)||cohorts.has(i.cohortId)||!/^acoustic_[a-f0-9]{64}$/.test(i.identityId)||!/^Voice [1-9]\d?$/.test(i.displayLabel)
      ||Number(i.displayLabel.slice(6))>state.voiceHighWater||!state.memory.identities.some(c=>c.id===i.cohortId)||typeof i.retired!=='boolean')throw Error('live_namespace');ids.add(i.identityId);labels.add(i.displayLabel);cohorts.add(i.cohortId)}
  const receipts=new Map(state.evidence.map(e=>[e.nativeReceiptSHA256,e])),projected=new Set<number>()
  for(const p of state.projections){
    const identity=state.identities.find(i=>i.identityId===p.identityId)
    if(!identity||identity.retired||projected.has(p.rawChunkIndex)||!Array.isArray(p.evidenceIds)||p.evidenceIds.length<2||p.evidenceIds.length>3||new Set(p.evidenceIds).size!==p.evidenceIds.length)throw Error('live_projection_identity')
    const support=p.evidenceIds.map(id=>receipts.get(id))
    if(support.some(e=>!e||e.cohortId!==identity.cohortId||!coherent(e)))throw Error('live_projection_support')
    const source=support.flatMap(e=>e!.window.sources).find(s=>s.chunkIndex===p.rawChunkIndex)
    if(!source||source.audioSHA256!==p.audioSHA256||source.pcmSHA256!==p.pcmSHA256||source.startSample!==p.startSample||source.endSample!==p.endSample)throw Error('live_projection_source')
    if(p.profileName!==undefined?typeof p.profileName!=='string'||!checkSpeakerName(p.profileName).ok||/^(?:ext|unknown|mu|speaker[\s_-]*\d+|voice[\s_-]*\d+)$/iu.test(p.profileName)||p.displayLabel!==p.profileName:p.displayLabel!==identity.displayLabel)throw Error('live_projection_label')
    projected.add(p.rawChunkIndex)
  }
  if(state.withheldReason!==null&&state.projections.length)throw Error('live_withheld_projection')
  // Every retained native witness assigned to memory must have the same exact
  // aggregate original as its corresponding evidence receipt.
  const expectedOriginals=state.evidence.filter(e=>e.cohortId!==undefined).map(e=>observation(state,e).original)
  if(hashMacSpeakerLive(expectedOriginals)!==hashMacSpeakerLive(state.memory.originals))throw Error('live_memory_lineage')
}
function observation(state:MacSpeakerLiveState,e:MacSpeakerLiveEvidence):MacSpeakerObservation {
  const w=e.window,r=e.receipt
  return{captureId:state.captureId,modelSHA256:state.modelSHA256,original:{chunkIndex:w.sources[0].chunkIndex,audioSHA256:r.audioSHA256,pcmSHA256:r.pcmSHA256,startSample:w.startSample,sampleCount:w.sampleCount},
    startSample:w.startSample,endSample:w.endSample,exclusiveSamples:w.speechSamples,purity:1,overlapSamples:0,mixedSpeakers:false,embedding:r.embedding}
}
/** Labels/segments establish scheduling hints only. Halves are dependent checks, never independent votes. */
function coherent(e:MacSpeakerLiveEvidence):boolean {const h=e.receipt.halfEmbeddings!;return normalizedSpeakerCosine(h[0],h[1])!>=.90&&h.every(v=>normalizedSpeakerCosine(v,e.receipt.embedding)!>=.90)}
function refresh(state:MacSpeakerLiveState,profiles:readonly MacSpeakerProfile[]):void {
  state.projections=[]
  if(state.withheldReason)return
  for(const cohort of state.memory.identities){
    if(cohort.voice===null)continue
    const group=state.evidence.filter(e=>e.cohortId===cohort.id)
    if(group.length<2||group.some(a=>group.some(b=>normalizedSpeakerCosine(a.receipt.embedding,b.receipt.embedding)!<.90)))continue
    const minimum=Math.min(...group.flatMap(a=>group.filter(b=>a!==b).map(b=>normalizedSpeakerCosine(a.receipt.embedding,b.receipt.embedding)!)))
    const outside=state.evidence.filter(e=>e.cohortId!==cohort.id)
    // Failed-half evidence can be compatible non-support only: BOTH dependent
    // halves must clear EVERY established full anchor and every other coherent
    // outsider (including unassigned singletons). It never supports/projects.
    const compatibleNonSupport=(o:MacSpeakerLiveEvidence):boolean=>{
      if(coherent(o))return false
      const competitors=outside.filter(other=>other!==o&&coherent(other))
      return o.receipt.halfEmbeddings!.every(half=>{
        const same=Math.min(...group.map(g=>normalizedSpeakerCosine(half,g.receipt.embedding)!))
        const different=Math.max(-1,...competitors.map(other=>normalizedSpeakerCosine(half,other.receipt.embedding)!))
        return same>=.90&&same-different>=.06
      })
    }
    // Every full observation remains a veto unless that narrow, non-support
    // compatibility check passes. Later coherent confusers revoke the exception.
    if(outside.some(o=>!compatibleNonSupport(o)&&group.some(g=>minimum-normalizedSpeakerCosine(g.receipt.embedding,o.receipt.embedding)!<.06)))continue
    let identity=state.identities.find(i=>i.cohortId===cohort.id)
    if(identity?.retired)continue
    if(!identity){
      if(state.voiceHighWater>=99){state.withheldReason='voice_namespace_exhausted';state.projections=[];return}
      const identityId=`acoustic_${hashMacSpeakerLive(group.slice(0,2).map(e=>e.nativeReceiptSHA256))}`
      identity={cohortId:cohort.id,identityId,displayLabel:`Voice ${++state.voiceHighWater}`,retired:false};state.identities.push(identity)
    }
    const named=matchMacSpeakerProfile(state.memory,group.map(e=>observation(state,e)),profiles)
    // MU remains an enrolled full-cohort competitor, never a human display claim.
    const profileName=named.reason==='matched_profile'&&named.label?.normalize('NFKC').trim().toLowerCase()!=='mu'?named.label??undefined:undefined
    for(const e of group)for(const s of e.window.sources)state.projections.push({rawChunkIndex:s.chunkIndex,audioSHA256:s.audioSHA256,pcmSHA256:s.pcmSHA256,startSample:s.startSample,endSample:s.endSample,
      identityId:identity.identityId,displayLabel:profileName??identity.displayLabel,...(profileName?{profileName}:{}),evidenceIds:[...new Set([...group.slice(0,2).map(x=>x.nativeReceiptSHA256),e.nativeReceiptSHA256])]})
  }
  state.projections.sort((a,b)=>a.rawChunkIndex-b.rawChunkIndex)
}
/** Immutable append; exact source overlaps/crops cannot supply a second witness. */
export function appendMacSpeakerLiveEvidence(input:MacSpeakerLiveState,evidence:MacSpeakerLiveEvidence,profiles:readonly MacSpeakerProfile[],reservedHighWater=input.voiceHighWater):MacSpeakerLiveState {
  validateMacSpeakerLiveState(input);validEvidence(evidence,input)
  validateMacSpeakerLiveProfiles(profiles,input.profileSHA256)
  const state=structuredClone(input)
  if(!Number.isSafeInteger(reservedHighWater)||reservedHighWater<state.voiceHighWater||reservedHighWater>99)throw Error('live_namespace_drift')
  state.voiceHighWater=reservedHighWater
  if(state.evidence.some(e=>e.window.id===evidence.window.id))return seal(state)
  if(state.evidence.length>=MAC_SPEAKER_LIVE_MAX_WINDOWS){state.withheldReason='evidence_budget_exhausted';state.projections=[];state.revision++;return seal(state)}
  const sources=state.evidence.flatMap(e=>e.window.sources)
  if(evidence.window.sources.some(s=>sources.some(p=>s.chunkIndex===p.chunkIndex||s.audioSHA256===p.audioSHA256||s.pcmSHA256===p.pcmSHA256||Math.max(s.startSample,p.startSample)<Math.min(s.endSample,p.endSample))))throw Error('live_repeated_or_crossed_source')
  const e=structuredClone(evidence);delete e.cohortId
  if(coherent(e)){
    const next=reconcileMacSpeakerObservation(state.memory,observation(state,e));state.memory=next.state
    if(next.decision.identityId!==undefined)e.cohortId=next.decision.identityId
  }
  state.evidence.push(e);refresh(state,profiles);state.revision++;return seal(state)
}
export function withholdMacSpeakerLiveState(input:MacSpeakerLiveState,reason:string):MacSpeakerLiveState {
  validateMacSpeakerLiveState(input);const state=structuredClone(input)
  if(!reason||reason.length>200)throw Error('live_withheld_reason')
  for(const i of state.identities)i.retired=true
  state.projections=[];state.withheldReason=reason;state.revision++;return seal(state)
}

/** Offline/replay seam: caller must independently prove the canonical full source
 * universe. Completeness here is only relative to supplied source-bound receipts. */
export function replayMacSpeakerLiveEvidence(input:{captureId:string;generation:string;modelSHA256:string;profileSHA256:string;voiceHighWater?:number;evidence:readonly MacSpeakerLiveEvidence[];profiles:readonly MacSpeakerProfile[]}):MacSpeakerLiveState {
  let state=createMacSpeakerLiveState(input.captureId,input.generation,input.modelSHA256,input.profileSHA256,input.voiceHighWater)
  if(input.evidence.length>MAC_SPEAKER_LIVE_MAX_WINDOWS)return withholdMacSpeakerLiveState(state,'evidence_budget_exhausted')
  for(const e of input.evidence)state=appendMacSpeakerLiveEvidence(state,e,input.profiles)
  return state
}

export function validateMacSpeakerLiveProfiles(profiles:readonly MacSpeakerProfile[],profileSHA256:string):void {
  if(!Array.isArray(profiles)||profiles.length>1024||profiles.some(p=>!p||p.profileSHA256!==profileSHA256))throw Error('live_profile_drift')
  const aliases=new Set<string>();let count=0
  for(const p of profiles){const alias=p.name?.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase()
    if(!checkSpeakerName(p.name).ok||/^(?:ext|unknown|speaker[\s_-]*(?:\d+|n)|voice[\s_-]*(?:\d+|n))$/iu.test(p.name)||aliases.has(alias)||!Array.isArray(p.embeddings)||!p.embeddings.length||p.embeddings.length>128||p.embeddings.some((v:readonly number[])=>!normalizedSpeakerEmbedding(v,192)))throw Error('live_profile_cohort_invalid')
    aliases.add(alias);count+=p.embeddings.length
  }
  if(count>8192)throw Error('live_profile_cohort_invalid')
}
/** Advance only the public snapshot cursor (e.g. source/manual revocation). */
export function advanceMacSpeakerLiveRevision(input:MacSpeakerLiveState):MacSpeakerLiveState {
  validateMacSpeakerLiveState(input);const state=structuredClone(input);state.revision++;return seal(state)
}
export function refreshMacSpeakerLiveState(input:MacSpeakerLiveState,profiles:readonly MacSpeakerProfile[]):MacSpeakerLiveState {
  validateMacSpeakerLiveState(input);validateMacSpeakerLiveProfiles(profiles,input.profileSHA256);const state=structuredClone(input);refresh(state,profiles);return seal(state)
}
