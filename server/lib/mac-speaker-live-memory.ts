/** Capture-long192d identity evidence. Pure transitions; never enrollment or text edits. */
import { checkSpeakerName } from './speaker-name.js'
import { isVoiceLabel } from './mac-voice-labels.js'
import { createHash } from 'node:crypto'
import { DEFAULT_MAC_SPEAKER_THRESHOLDS, createMacSpeakerMemory, validateMacSpeakerMemory, reconcileMacSpeakerObservation, matchMacSpeakerProfile, normalizedSpeakerEmbedding, normalizedSpeakerCosine,
  type MacSpeakerMemory, type MacSpeakerObservation, type MacSpeakerProfile } from './mac-speaker-reconcile.js'
import type { PreparedMacSpeakerWindow, MacWindowEmbeddingReceipt } from './mac-speaker-windows.js'
import { inspectMacSpeakerShadowCallSource, type MacShadowRepairInput } from './mac-speaker-shadow-repair.js'
import { exactOverlap } from './speaker-shadow-decide.js'
import { pyRoundInt } from './speaker-shadow-numeric.js'

const SHA=/^[a-f0-9]{64}$/
export const MAC_SPEAKER_LIVE_MAX_WINDOWS=256
/** Control accepts counters below10m; the last value is withdrawal-only. */
export const MAC_SPEAKER_LIVE_TERMINAL_REVISION=9999999
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
const seal=(state:MacSpeakerLiveState):MacSpeakerLiveState=>{
  if(state.revision>=MAC_SPEAKER_LIVE_TERMINAL_REVISION){state.revision=MAC_SPEAKER_LIVE_TERMINAL_REVISION;state.projections=[];state.voiceHighWater=99;state.withheldReason='revision_counter_exhausted';for(const identity of state.identities)identity.retired=true}
  const{stateSHA256:_hash,...body}=state;state.stateSHA256=hashMacSpeakerLive(body);return state}
export function createMacSpeakerLiveState(captureId:string,generation:string,modelSHA256:string,profileSHA256:string,voiceHighWater=0):MacSpeakerLiveState {
  if(!generation||generation.length>128||!SHA.test(profileSHA256)||!Number.isSafeInteger(voiceHighWater)||voiceHighWater<0||voiceHighWater>99)throw Error('live_binding')
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
  if(!state||state.version!==1||typeof state.generation!=='string'||!state.generation||state.generation.length>128||!SHA.test(state.modelSHA256)||!SHA.test(state.profileSHA256)||!Number.isSafeInteger(state.revision)||state.revision<0||state.revision>MAC_SPEAKER_LIVE_TERMINAL_REVISION
    ||!Array.isArray(state.evidence)||state.evidence.length>MAC_SPEAKER_LIVE_MAX_WINDOWS||!Array.isArray(state.identities)||state.identities.length>99||!Array.isArray(state.projections)||state.projections.length>8192
    ||!Number.isSafeInteger(state.voiceHighWater)||state.voiceHighWater<0||state.voiceHighWater>99||Buffer.byteLength(JSON.stringify(state))>8*1024*1024)throw Error('live_state_bound')
  if(state.revision===MAC_SPEAKER_LIVE_TERMINAL_REVISION&&(state.projections.length||state.voiceHighWater!==99||!state.withheldReason||state.identities.some(i=>!i.retired)))throw Error('live_terminal_revision')
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
  // Rebuild deterministic receipt membership, rather than trusting a caller-
  // recomputed unkeyed state hash or arbitrary cohort references on recovery.
  let rebuilt=createMacSpeakerMemory(state.captureId,state.modelSHA256,{minimumSamples:320000})
  for(const e of state.evidence){
    let expected:number|undefined
    if(coherent(e)){const next=reconcileMacSpeakerObservation(rebuilt,observation(state,e));rebuilt=next.state;expected=next.decision.identityId}
    if(expected!==e.cohortId)throw Error('live_receipt_membership')
  }
  if(hashMacSpeakerLive(rebuilt)!==hashMacSpeakerLive(state.memory))throw Error('live_memory_replay')
  for(const identity of state.identities){const group=state.evidence.filter(e=>e.cohortId===identity.cohortId)
    if(group.length<2||identity.identityId!==`acoustic_${hashMacSpeakerLive(group.slice(0,2).map(e=>e.nativeReceiptSHA256))}`)throw Error('live_identity_lineage')
  }
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
  validateMacSpeakerLiveState(input);if(input.revision===MAC_SPEAKER_LIVE_TERMINAL_REVISION)return structuredClone(input)
  validEvidence(evidence,input)
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

/** Separate model space and candidate protocol. This does NOT enable the192d
 * runtime or authenticate native execution. Consumers must verify the complete
 * source/native packet and run this full-cohort work OFF the HTTP/main thread. */
export interface MacSpeaker256SnapshotInput extends MacShadowRepairInput {
  generation:string
  /** Optimistic concurrency fence; mandatory when transitioning an existing state. */
  expectedStateSHA256?:string
}
export interface MacSpeaker256Witness {
  evidenceId:string;startSample:number;endSample:number;originalVoice:string
  rawChunkIndices:number[];pcmSHA256s:string[]
}
export interface MacSpeaker256Interval {
  rawChunkIndex:number;audioSHA256:string;pcmSHA256:string;startSample:number;endSample:number
  originalVoice:string;identityId:string;evidenceIds:string[]
  /** Machine localization agreement, never independently verified speaker purity. */
  timingBasis:'native-exclusive-intersect-machine-production'
}
export interface MacSpeaker256Group {
  identityId:string;nativeCluster:string;memberVoices:string[];keepVoiceHint:string;groupSHA256:string
  witnesses:MacSpeaker256Witness[];intervals:MacSpeaker256Interval[]
}
interface MacSpeaker256RawBinding {
  rawChunkIndex:number;audioSHA256:string;pcmSHA256:string;startSample:number;endSample:number;originalRowSHA256:string
}
export interface MacSpeaker256State {
  version:1;policy:'fluid256-recurrence-v1';captureId:string;generation:string;modelSHA256:string;cliSHA256:string
  sourceBindingSHA256:string;snapshotSHA256:string;revision:number;identityHighWater:number
  identities:Array<{identityId:string;ordinal:number;retired:boolean;birthSnapshotSHA256:string;birthGroupSHA256:string;birthIntervals:MacSpeaker256Interval[];lastIntervals:MacSpeaker256Interval[]}>
  groups:MacSpeaker256Group[];withdrawn:Array<{identityId:string;reason:string}>
  withheld:Array<{rawChunkIndex:number;startSample:number;endSample:number;reason:string}>
  rawBindings:MacSpeaker256RawBinding[]
  coverage:{rawOriginals:number;textOriginals:number;protectedOriginals:number;acceptedRecurrenceGroups:number;independentQualifiedGroups:number;machineSpeechSamples:number;supportedSamples:number}
  /** Hash integrity only; native qualification belongs to the trusted producer. */
  provenance:{nativeAuthenticated:false;productionQualified:false;originalSHA256:string;currentSHA256:string;ledgerSHA256:string;nativeSHA256:string;embeddingsSHA256:string}
  excludedEmbeddingWindows:Array<{originalIndex:number;startTime:number;endTime:number;windowSHA256:string;reason:'window-crosses-capture-end'}>
  stateSHA256:string
}
const FLUID256_POLICY='fluid256-recurrence-v1' as const
const fluidHash=(value:string)=>createHash('sha256').update(value).digest('hex')
const fluidSeal=(s:MacSpeaker256State)=>{const{stateSHA256:_,...body}=s;s.stateSHA256=hashMacSpeakerLive(body);return s}
const fluidFail=(reason:string):never=>{throw Error(`fluid256_${reason}`)}
const fluidGroupBody=(g:MacSpeaker256Group)=>({nativeCluster:g.nativeCluster,memberVoices:g.memberVoices,keepVoiceHint:g.keepVoiceHint,witnesses:g.witnesses,
  intervals:g.intervals.map(({identityId:_,...i})=>i)})
const fluidOverlap=(a:readonly MacSpeaker256Interval[],b:readonly MacSpeaker256Interval[])=>a.some(x=>b.some(y=>x.rawChunkIndex===y.rawChunkIndex&&x.audioSHA256===y.audioSHA256&&x.pcmSHA256===y.pcmSHA256&&Math.max(x.startSample,y.startSample)<Math.min(x.endSample,y.endSample)))
function fluidShape(state:MacSpeaker256State):void {
  if(!state||state.version!==1||state.policy!==FLUID256_POLICY||typeof state.captureId!=='string'||!/^mac_/.test(state.captureId)||state.captureId.length>200||typeof state.generation!=='string'||!state.generation||state.generation.length>128
    ||![state.modelSHA256,state.cliSHA256,state.sourceBindingSHA256,state.snapshotSHA256,state.stateSHA256].every(x=>SHA.test(x))
    ||!Number.isSafeInteger(state.revision)||state.revision<1||state.revision>=MAC_SPEAKER_LIVE_TERMINAL_REVISION||!Number.isSafeInteger(state.identityHighWater)||state.identityHighWater<0||state.identityHighWater>1024
    ||!Array.isArray(state.identities)||state.identities.length!==state.identityHighWater||!Array.isArray(state.groups)||state.groups.length>99||!Array.isArray(state.rawBindings)||state.rawBindings.length>6000
    ||!Array.isArray(state.withheld)||state.withheld.length>100000||!Array.isArray(state.withdrawn)||state.withdrawn.length>1024||Buffer.byteLength(JSON.stringify(state))>16*1024*1024)fluidFail('state_bound')
  const{stateSHA256,...body}=state;if(hashMacSpeakerLive(body)!==stateSHA256)fluidFail('state_hash')
  const raw=new Map(state.rawBindings.map(r=>[r.rawChunkIndex,r]))
  if(raw.size!==state.rawBindings.length)fluidFail('raw_binding')
  for(const[r,i]of state.rawBindings.map((r,i)=>[r,i] as const))if(r.rawChunkIndex!==i||![r.audioSHA256,r.pcmSHA256,r.originalRowSHA256].every(x=>SHA.test(x))||!Number.isSafeInteger(r.startSample)||!Number.isSafeInteger(r.endSample)||r.startSample<0||r.endSample<=r.startSample)fluidFail('raw_binding')
  const validSpan=(span:MacSpeaker256Interval,identityId:string)=>{
    const r=raw.get(span.rawChunkIndex)
    return r&&span.identityId===identityId&&span.audioSHA256===r.audioSHA256&&span.pcmSHA256===r.pcmSHA256&&Number.isSafeInteger(span.startSample)&&Number.isSafeInteger(span.endSample)&&span.startSample>=r.startSample&&span.endSample<=r.endSample&&span.endSample>span.startSample
      &&span.timingBasis==='native-exclusive-intersect-machine-production'&&isVoiceLabel(span.originalVoice)&&Array.isArray(span.evidenceIds)&&span.evidenceIds.length===2&&span.evidenceIds.every(h=>SHA.test(h))&&span.evidenceIds[0]!==span.evidenceIds[1]
  }
  const ids=new Set<string>()
  for(const[i,id]of state.identities.entries()){
    if(id.ordinal!==i+1||!/^fluid256_[a-f0-9]{64}$/.test(id.identityId)||ids.has(id.identityId)||typeof id.retired!=='boolean'||!Array.isArray(id.lastIntervals)||!id.lastIntervals.length||id.lastIntervals.length>40000||!Array.isArray(id.birthIntervals)||!id.birthIntervals.length||id.birthIntervals.length>40000
      ||!SHA.test(id.birthSnapshotSHA256)||!SHA.test(id.birthGroupSHA256)||id.identityId!==`fluid256_${hashMacSpeakerLive({captureId:state.captureId,generation:state.generation,snapshotSHA256:id.birthSnapshotSHA256,groupSHA256:id.birthGroupSHA256,ordinal:id.ordinal})}`)fluidFail('namespace')
    if([...id.birthIntervals,...id.lastIntervals].some(span=>!validSpan(span,id.identityId)))fluidFail('identity_interval_binding')
    ids.add(id.identityId)
  }
  const groups=new Set<string>()
  for(const group of state.groups){
    const identity=state.identities.find(i=>i.identityId===group.identityId)
    if(!identity||identity.retired||groups.has(group.identityId)||group.groupSHA256!==hashMacSpeakerLive(fluidGroupBody(group))||group.witnesses.length!==2||!group.intervals.length
      ||hashMacSpeakerLive(group.intervals)!==hashMacSpeakerLive(identity.lastIntervals)||!fluidOverlap(group.intervals,identity.birthIntervals))fluidFail('group_binding')
    const[a,b]=group.witnesses
    if(a.evidenceId===b.evidenceId||a.originalVoice===b.originalVoice||Math.max(a.startSample,b.startSample)<Math.min(a.endSample,b.endSample)
      ||a.rawChunkIndices.some(r=>b.rawChunkIndices.includes(r))||a.pcmSHA256s.some(h=>b.pcmSHA256s.includes(h)))fluidFail('dependent_witnesses')
    for(const span of group.intervals)if(!validSpan(span,group.identityId)||hashMacSpeakerLive(span.evidenceIds)!==hashMacSpeakerLive(group.witnesses.map(w=>w.evidenceId)))fluidFail('interval_binding')
    groups.add(group.identityId)
  }
  if(state.identities.some(id=>id.retired===groups.has(id.identityId)))fluidFail('active_namespace')
  const withdrawals=new Set<string>()
  for(const w of state.withdrawn){if(withdrawals.has(w.identityId)||!state.identities.some(id=>id.identityId===w.identityId&&id.retired)||w.reason!=='recurrence-withdrawn-or-split-merge')fluidFail('withdrawal_binding');withdrawals.add(w.identityId)}
}
type FluidCandidate=Omit<MacSpeaker256Group,'identityId'>
function fluidCandidates(input:MacSpeaker256SnapshotInput){
  if(typeof input.generation!=='string'||!input.generation||input.generation.length>128)fluidFail('generation')
  const{generation:_,expectedStateSHA256:__,...source}=input
  // Full-source inspection binds exports, protects human/prior-proof labels and
  // rejects source/schema/clock drift before the unchanged full-cohort decision.
  const inspected=inspectMacSpeakerShadowCallSource(source)
  const{original,current,entries,production,embeddings,decision:D}=inspected
  const protectedRaw=new Set(inspected.protection),raw=new Map(input.rawAudio.map(r=>[r.rawChunkIndex,r])),placed=new Map(input.timeline.rows.map(r=>[r.rawChunkIndex,r]))
  const currentRaw=new Map<number,Record<string,any>>(current.chunkEntries.map((e:any)=>[e.chunkIndex,e.chunk]))
  const rows=(c:any)=>[c,...(c.segments??[]),...(c.finalSegments??[]),...(c.words??[]).filter((r:any)=>'speaker'in r)]
  const sourceRows=entries.map(e=>{const r=raw.get(e.chunkIndex)!,p=placed.get(e.chunkIndex)!;return{rawChunkIndex:e.chunkIndex,audioSHA256:r.wavSHA256,pcmSHA256:r.pcmSHA256,startSample:p.startSample,endSample:p.startSample+p.sampleCount,originalRowSHA256:hashMacSpeakerLive(e.chunk)}})
  const segmentsByRaw=new Map<number,Array<[number,number,string]>>()
  for(let i=0;i<production.segs.length;i++){const id=production.sources[i].chunkIndex,list=segmentsByRaw.get(id)??[];list.push([...production.segs[i]]);segmentsByRaw.set(id,list)}
  // Overlapping machine segments are ambiguous localization, not extra speech
  // seconds or independent evidence. Refuse rather than double-count them.
  for(const list of segmentsByRaw.values()){
    list.sort((a,b)=>a[0]-b[0]||a[1]-b[1])
    for(let i=1;i<list.length;i++)if(list[i][0]<list[i-1][1])fluidFail('production_overlap')
  }
  const clean=(index:number,voice:string)=>{const e=entries[index],p=placed.get(index)!,now=currentRaw.get(index)!;return !protectedRaw.has(index)&&p.usedSampleCount===p.sampleCount
    &&rows(e.chunk).every(r=>r.speaker===voice)&&rows(now).every(r=>r.speaker===voice)&&hashMacSpeakerLive(rows(e.chunk))===hashMacSpeakerLive(rows(now))}
  const candidates:FluidCandidate[]=[],withheld:MacSpeaker256State['withheld']=[];let accepted=0,machineSpeechSamples=0
  const acceptedVoices=new Map<string,{cluster:string;hint:string;members:string[]}>()
  for(const g of D.groups){if(!g.anchor||!g.mergedIntoAnchor.length)continue;accepted++;const members=[g.anchor,...g.mergedIntoAnchor].sort();for(const voice of members)acceptedVoices.set(voice,{cluster:g.cluster,hint:g.anchor,members})}
  const uniqueGroups=[...new Map([...acceptedVoices.values()].map(g=>[g.cluster,g])).values()]
  for(const group of uniqueGroups){
    const witnesses:MacSpeaker256Witness[]=[]
    for(const e of embeddings){
      if(`S${e.cluster+1}`!==group.cluster)continue
      const lo=pyRoundInt(e.startTime*16000),hi=pyRoundInt(e.endTime*16000)
      if(hi<=lo||[...exactOverlap(lo,hi,D.index)].some(([key])=>key!==group.cluster))continue
      const touched=sourceRows.filter(r=>r.startSample<hi&&r.endSample>lo)
      if(!touched.length)continue
      const speech=production.segs.flatMap((s,i)=>s[0]<hi&&s[1]>lo?[{segment:s,raw:production.sources[i].chunkIndex}]:[])
      const voices=new Set(speech.map(s=>s.segment[2]));if(voices.size!==1)continue
      const voice=[...voices][0];if(!group.members.includes(voice)||speech.some(s=>!clean(s.raw,voice))||touched.some(r=>!clean(r.rawChunkIndex,voice)))continue
      // The unchanged port attributes embeddings at50percent production coverage.
      // Repeated/overlapping exports are still only ONE source witness below.
      const speechSamples=speech.reduce((n,s)=>n+Math.max(0,Math.min(hi,s.segment[1])-Math.max(lo,s.segment[0])),0)
      if(speechSamples<.5*(hi-lo))continue
      witnesses.push({evidenceId:hashMacSpeakerLive({modelSHA256:input.cohort.modelSHA256,cliSHA256:input.cohort.cliSHA256,embedding:e,raw:touched}),startSample:lo,endSample:hi,originalVoice:voice,rawChunkIndices:touched.map(r=>r.rawChunkIndex),pcmSHA256s:touched.map(r=>r.pcmSHA256)})
    }
    witnesses.sort((a,b)=>a.startSample-b.startSample||a.endSample-b.endSample||a.evidenceId.localeCompare(b.evidenceId))
    let pair:MacSpeaker256Witness[]|undefined
    for(let i=0;i<witnesses.length&&!pair;i++)for(let j=i+1;j<witnesses.length;j++){
      const a=witnesses[i],b=witnesses[j]
      if(a.originalVoice!==b.originalVoice&&a.endSample<=b.startSample&&!a.rawChunkIndices.some(r=>b.rawChunkIndices.includes(r))&&!a.pcmSHA256s.some(h=>b.pcmSHA256s.includes(h))){pair=[a,b];break}
    }
    if(!pair)continue
    const intervals:MacSpeaker256Interval[]=[]
    for(const e of entries){
      const voice=e.chunk.speaker as string;if(!group.members.includes(voice)||!clean(e.chunkIndex,voice))continue
      const r=raw.get(e.chunkIndex)!
      for(const[lo,hi,label]of segmentsByRaw.get(e.chunkIndex)??[]){
        if(label!==voice)continue
        const boundaries=new Set<number>([lo,hi]);for(const[a,b]of D.index.overlapping(lo,hi)){boundaries.add(Math.max(lo,a));boundaries.add(Math.min(hi,b))}
        const points=[...boundaries].sort((a,b)=>a-b)
        for(let i=0;i+1<points.length;i++){const startSample=points[i],endSample=points[i+1],cover=exactOverlap(startSample,endSample,D.index)
          if(cover.size===1&&cover.has(group.cluster))intervals.push({rawChunkIndex:e.chunkIndex,audioSHA256:r.wavSHA256,pcmSHA256:r.pcmSHA256,startSample,endSample,originalVoice:voice,identityId:'',evidenceIds:pair.map(w=>w.evidenceId),timingBasis:'native-exclusive-intersect-machine-production'})
        }
      }
    }
    intervals.sort((a,b)=>a.rawChunkIndex-b.rawChunkIndex||a.startSample-b.startSample||a.endSample-b.endSample)
    if(!intervals.length)continue
    const body={nativeCluster:group.cluster,memberVoices:group.members,keepVoiceHint:group.hint,witnesses:pair,intervals}
    const groupSHA256=hashMacSpeakerLive(fluidGroupBody({...body,identityId:'',groupSHA256:''}))
    candidates.push({...body,groupSHA256})
  }
  for(const e of entries){
    for(const[lo,hi]of segmentsByRaw.get(e.chunkIndex)??[]){
      machineSpeechSamples+=hi-lo
      const spans=candidates.flatMap(g=>g.intervals.filter(i=>i.rawChunkIndex===e.chunkIndex&&i.startSample<hi&&i.endSample>lo))
      const points=[...new Set([lo,hi,...spans.flatMap(i=>[Math.max(lo,i.startSample),Math.min(hi,i.endSample)])])].sort((a,b)=>a-b)
      for(let i=0;i+1<points.length;i++)if(!spans.some(s=>s.startSample<=points[i]&&s.endSample>=points[i+1]))withheld.push({rawChunkIndex:e.chunkIndex,startSample:points[i],endSample:points[i+1],reason:protectedRaw.has(e.chunkIndex)?'protected-source':'no-independent-exclusive-recurrence'})
    }
  }
  return{captureId:original.sessionId as string,candidates,withheld,sourceRows,excludedEmbeddingWindows:inspected.excludedEmbeddingWindows,coverage:{rawOriginals:entries.length,textOriginals:original.chunks.length,protectedOriginals:protectedRaw.size,acceptedRecurrenceGroups:accepted,independentQualifiedGroups:candidates.length,machineSpeechSamples,supportedSamples:candidates.reduce((n,g)=>n+g.intervals.reduce((m,i)=>m+i.endSample-i.startSample,0),0)}}
}
/** Whole supplied-snapshot reconciliation, never a global old-label rename.
 * The trusted caller must prove full native/source completeness independently. */
export function reconcileMacSpeaker256Snapshot(previous:MacSpeaker256State|null,input:MacSpeaker256SnapshotInput):MacSpeaker256State {
  const evaluated=fluidCandidates(input),snapshotSHA256=hashMacSpeakerLive({sourceBindingSHA256:input.sourceBindingSHA256,generation:input.generation,policy:FLUID256_POLICY})
  if(previous){
    fluidShape(previous)
    if(input.expectedStateSHA256!==previous.stateSHA256)fluidFail('state_cas')
    if(previous.captureId!==evaluated.captureId||previous.generation!==input.generation||previous.modelSHA256!==input.cohort.modelSHA256||previous.cliSHA256!==input.cohort.cliSHA256)fluidFail('model_or_capture_drift')
    if(previous.rawBindings.some((r,i)=>hashMacSpeakerLive(r)!==hashMacSpeakerLive(evaluated.sourceRows[i])))fluidFail('original_source_drift')
    if(previous.snapshotSHA256===snapshotSHA256){validateMacSpeaker256State(previous,input);return structuredClone(previous)}
    if(previous.revision>=MAC_SPEAKER_LIVE_TERMINAL_REVISION-1)fluidFail('revision_exhausted')
  }else if(input.expectedStateSHA256!==undefined)fluidFail('unexpected_state_cas')
  const identities=structuredClone(previous?.identities??[]),groups:MacSpeaker256Group[]=[],withdrawn:MacSpeaker256State['withdrawn']=[],withheld=[...evaluated.withheld]
  let identityHighWater=previous?.identityHighWater??0
  const old=previous?.groups??[]
  const oldLinks=old.map(g=>evaluated.candidates.flatMap((n,i)=>fluidOverlap(g.intervals,n.intervals)?[i]:[]))
  const newLinks=evaluated.candidates.map(g=>old.flatMap((o,i)=>fluidOverlap(g.intervals,o.intervals)?[i]:[]))
  for(let i=0;i<evaluated.candidates.length;i++){
    const candidate=evaluated.candidates[i],links=newLinks[i]
    const ambiguous=links.length>1||links.some(j=>oldLinks[j].length!==1)||identities.some(id=>id.retired&&fluidOverlap(id.lastIntervals,candidate.intervals))
    if(ambiguous){for(const span of candidate.intervals)withheld.push({rawChunkIndex:span.rawChunkIndex,startSample:span.startSample,endSample:span.endSample,reason:'split-merge-or-retired-lineage'});continue}
    let identity=links.length?identities.find(id=>id.identityId===old[links[0]].identityId):undefined
    if(!identity){
      if(identityHighWater>=1024)fluidFail('identity_budget_exhausted')
      const ordinal=++identityHighWater,identityId=`fluid256_${hashMacSpeakerLive({captureId:evaluated.captureId,generation:input.generation,snapshotSHA256,groupSHA256:candidate.groupSHA256,ordinal})}`
      identity={identityId,ordinal,retired:false,birthSnapshotSHA256:snapshotSHA256,birthGroupSHA256:candidate.groupSHA256,birthIntervals:candidate.intervals.map(i=>({...i,identityId})),lastIntervals:[]};identities.push(identity)
    }
    const intervals=candidate.intervals.map(i=>({...i,identityId:identity!.identityId}));identity.lastIntervals=intervals
    groups.push({...candidate,identityId:identity.identityId,intervals})
  }
  for(const identity of identities)if(!identity.retired&&!groups.some(g=>g.identityId===identity.identityId)){
    identity.retired=true;withdrawn.push({identityId:identity.identityId,reason:'recurrence-withdrawn-or-split-merge'})
  }
  const supportedSamples=groups.reduce((n,g)=>n+g.intervals.reduce((m,i)=>m+i.endSample-i.startSample,0),0)
  const state=fluidSeal({version:1,policy:FLUID256_POLICY,captureId:evaluated.captureId,generation:input.generation,modelSHA256:input.cohort.modelSHA256,cliSHA256:input.cohort.cliSHA256,sourceBindingSHA256:input.sourceBindingSHA256,snapshotSHA256,
    revision:(previous?.revision??0)+1,identityHighWater,identities,groups,withdrawn,withheld,rawBindings:evaluated.sourceRows,coverage:{...evaluated.coverage,supportedSamples},
    provenance:{nativeAuthenticated:false,productionQualified:false,originalSHA256:fluidHash(input.originalJSON),currentSHA256:fluidHash(input.currentJSON),ledgerSHA256:fluidHash(input.ledgerJSONL),nativeSHA256:fluidHash(input.cohort.nativeJSON),embeddingsSHA256:fluidHash(input.cohort.embeddingsJSON)},excludedEmbeddingWindows:evaluated.excludedEmbeddingWindows,stateSHA256:''})
  fluidShape(state);return state
}
/** Recompute current complete-cohort membership/intervals; a resealed hash alone
 * cannot invent acoustic support or move an interval on restart. */
export function validateMacSpeaker256State(state:MacSpeaker256State,input:MacSpeaker256SnapshotInput):void {
  fluidShape(state);const expected=fluidCandidates(input)
  if(state.captureId!==expected.captureId||state.generation!==input.generation||state.sourceBindingSHA256!==input.sourceBindingSHA256||state.modelSHA256!==input.cohort.modelSHA256||state.cliSHA256!==input.cohort.cliSHA256
    ||state.snapshotSHA256!==hashMacSpeakerLive({sourceBindingSHA256:input.sourceBindingSHA256,generation:input.generation,policy:FLUID256_POLICY})||hashMacSpeakerLive(state.rawBindings)!==hashMacSpeakerLive(expected.sourceRows))fluidFail('snapshot_binding')
  for(const g of state.groups){
    const candidate=expected.candidates.find(c=>c.groupSHA256===g.groupSHA256)
    if(!candidate||hashMacSpeakerLive(fluidGroupBody(g))!==hashMacSpeakerLive(fluidGroupBody({...candidate,identityId:''})))fluidFail('membership_or_interval_drift')
  }
  const supportedSamples=state.groups.reduce((n,g)=>n+g.intervals.reduce((m,i)=>m+i.endSample-i.startSample,0),0)
  const withheld=[...expected.withheld,...expected.candidates.filter(c=>!state.groups.some(g=>g.groupSHA256===c.groupSHA256)).flatMap(c=>c.intervals.map(i=>({rawChunkIndex:i.rawChunkIndex,startSample:i.startSample,endSample:i.endSample,reason:'split-merge-or-retired-lineage'})))]
  const provenance={nativeAuthenticated:false,productionQualified:false,originalSHA256:fluidHash(input.originalJSON),currentSHA256:fluidHash(input.currentJSON),ledgerSHA256:fluidHash(input.ledgerJSONL),nativeSHA256:fluidHash(input.cohort.nativeJSON),embeddingsSHA256:fluidHash(input.cohort.embeddingsJSON)}
  if(hashMacSpeakerLive(state.coverage)!==hashMacSpeakerLive({...expected.coverage,supportedSamples})||hashMacSpeakerLive(state.excludedEmbeddingWindows)!==hashMacSpeakerLive(expected.excludedEmbeddingWindows)
    ||hashMacSpeakerLive(state.withheld)!==hashMacSpeakerLive(withheld)||hashMacSpeakerLive(state.provenance)!==hashMacSpeakerLive(provenance))fluidFail('coverage_or_provenance_drift')
}
