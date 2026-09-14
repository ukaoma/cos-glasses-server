/** Durable held naming: server-stored preview, per-copy receipts, explicit recovery. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { collectHeldSamples, discardHeldSamples, enrollHeldGroup, HeldGroupError, sampleKey, suggestProfile, previewDiscard, projectHeldEnrollment, type HeldSampleRef } from './held-voice-groups.js'
import { readVoiceProfiles, rawCosineSimilarity } from './speaker-embeddings.js'
import { getOwnerSpeakerLabel } from './profile.js'
import { coherentClusterContaining, VOICE_COHERENCE_FLOOR } from './voice-enrolment-selection.js'
import { readChunkEmbeddings } from './chunk-embedding-store.js'
import { findCosOperationsMeetingBySessionId, resolveCosOperationsDir } from './cos-operations-meetings.js'
import { MeetingStore } from './meeting-store.js'
import { appendCorrection, closeInterruptedCorrections, pendingCorrections, readCorrections, appliedCorrections, type CorrectionRow } from './meeting-corrections.js'
import { patchValue, relabelSpeakerPositions, undoSpeakerMarkdown, strippedTranscript, validatedRawMap, type SpeakerPatch } from './meeting-speaker-labels.js'
import { acquireMeetingSyncLock } from './meeting-sync-lock.js'

export const NAMING_CAPABILITIES = {preview:true,apply:true,undo:true,version:1} as const
const PREVIEW_TTL = 15 * 60 * 1000
const HIGH_COUNT = 25
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const plainRef = ({sessionId,chunkIndex}: HeldSampleRef) => ({sessionId,chunkIndex})
const foldName = (name: string) => name.normalize('NFKC').toLocaleLowerCase('und')
export function resolveStoredName(name: string): {name:string;owner:boolean} {
  const stored = readVoiceProfiles().profiles.filter(p=>foldName(p.name) === foldName(name.trim()))
  if (stored.length > 1) throw new HeldGroupError(400,'ambiguous_name','Multiple stored voices have that spelling. Rename the duplicate profiles first.',{names:stored.map(p=>p.name)})
  const owner = getOwnerSpeakerLabel()
  const isOwner = foldName(owner) === foldName(name.trim()) || (stored[0] && foldName(stored[0].name) === foldName(owner))
  return {name:isOwner ? owner : stored[0]?.name ?? name.trim(),owner:!!isOwner}
}
function voiceVersion(name: string) {
  const path = dataPath('voice-profiles.json')
  const profiles = readVoiceProfiles().profiles
  return {storeMtime:existsSync(path)?statSync(path).mtimeMs:0,profileCount:profiles.length,targetSamples:profiles.find(p=>p.name===name)?.embeddings.length ?? 0}
}
function evidenceVersion(refs:HeldSampleRef[]) {
  return hash([...new Set(refs.map(r=>r.sessionId))].sort().map(sessionId=>({sessionId,rows:readChunkEmbeddings(sessionId).rows.map(r=>({i:r.i,embedding:Array.from(r.embedding)})),cache:existsSync(dataPath('held-voice-embeddings',`${sessionId}.json`))?readFileSync(dataPath('held-voice-embeddings',`${sessionId}.json`),'utf8'):''})))
}
function assertMarkdownWords(before:string,after:string) {
  const clean=(s:string)=>s.replace(/\n?<!-- speaker-labels-newer-than-graph -->\n?/g,'')
  if(strippedTranscript(clean(before))!==strippedTranscript(clean(after)))throw new Error('Transcript word-preservation assertion failed')
}
function pruneExpiredPreviews() {
  const dir=dataPath('meeting-corrections')
  if(!existsSync(dir))return
  for(const f of readdirSync(dir).filter(f=>/^preview-[a-f0-9]+\.json$/.test(f)).slice(0,100)){
    try{const p=JSON.parse(readFileSync(join(dir,f),'utf8'));if(Date.parse(p.expiresAt)<Date.now())unlinkSync(join(dir,f))}catch{/* unreadable previews are rejected by their reader */}
  }
}
interface CopyPlan {
  copy:'local'|'operations'
  correctionRevision:number
  lifecycleRevision:number
  sidecarHash:string
  markdownHash:string
  rawMap:number[]
  blended:boolean
}
interface MeetingPlan {
  sessionId:string
  status:'ready'|'blocked'|'applied'|'failed'|'reverted'
  error?:string
  namedChunks:number[]
  widerChunks:number[]
  labelled:number
  roomRisk:boolean
  widerScores?:Array<{chunkIndex:number;similarity:number;agreeing:number;roomOnly:boolean}>
  playback:Array<{sessionId:string;chunkIndex:number;position:number}>
  copies:CopyPlan[]
}
interface StoredPreview {
  previewHash:string
  expiresAt:string
  speaker:string
  owner:boolean
  requiresListening:boolean
  voiceVersion:ReturnType<typeof voiceVersion>
  evidenceHash:string
  eligibleMembers:HeldSampleRef[]
  projectedVoiceHash:string
  plan:ReturnType<typeof enrollHeldGroup>
  members:HeldSampleRef[]
  meetings:MeetingPlan[]
  memberOutcomes:Array<HeldSampleRef & {status:string}>
}
interface CopyReceipt {
  copy:'local'|'operations'
  status:'pending'|'sidecar_written'|'applied'|'reverted'|'failed'
  error?:string
  patches:SpeakerPatch[]
  beforeSidecar:string
  afterSidecar:string
  beforeMarkdown:string
  afterMarkdown:string
  blended:boolean
}
interface BatchMeeting extends MeetingPlan { intentId:string;receipts:CopyReceipt[] }
export interface NamingMemberOutcome extends HeldSampleRef {
  status:'applied'|'no_transcript_position'|'skipped'|'failed'|'reverted'|'unknown'
  enrollmentStatus:'enrolled'|'represented'|'not_enrolled'|'unknown'
  labelStatus:'labelled'|'no_transcript_position'|'unchanged'|'failed'|'reverted'|'unknown'
  audioStatus:'deleted'|'retained'|'missing'|'unknown'
  position:number|null
  previewStatus?:string
  reason?:string
}
interface BatchRecord {
  batchId:string
  speaker:string
  at:string
  status:'pending'|'applied'|'partial'|'interrupted'|'reverted'
  previewHash:string
  members:HeldSampleRef[]
  requestedMembers?:HeldSampleRef[]
  memberOutcomes?:NamingMemberOutcome[]
  meetings:BatchMeeting[]
  enrolled:number
  profileEmbeddings?:number
  plan?:ReturnType<typeof enrollHeldGroup>
  deleted:number
  deleteMembers?:HeldSampleRef[]
  voiceVersion:ReturnType<typeof voiceVersion>
  lockMode:'sync'|'standalone'
}
function recordPath(kind:'preview'|'batch',id:string) {
  if (!/^[a-f0-9-]{16,80}$/.test(id)) throw new HeldGroupError(400,'invalid_handle','Invalid naming handle')
  return dataPath('meeting-corrections',`${kind}-${id}.json`)
}
function writeRecord(kind:'preview'|'batch',id:string,value:unknown) {
  if(kind==='batch') {
    const batch=value as BatchRecord
    if(batch.memberOutcomes)batch.memberOutcomes=batchMembers(batch)
  }
  const path=recordPath(kind,id)
  mkdirSync(dirname(path),{recursive:true,mode:0o700})
  durableAtomicWriteFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600})
}
function previewMemberStatus(p:StoredPreview,ref:HeldSampleRef):string {
  const key=sampleKey(ref)
  return p.memberOutcomes.find(o=>sampleKey(o)===key)?.status
    ??(p.plan.leftBehind.some(o=>sampleKey(o)===key)?'left_held':p.plan.notReady.some(o=>sampleKey(o)===key)?'not_ready':'missing')
}
function initialMemberOutcomes(p:StoredPreview):NamingMemberOutcome[] {
  return p.members.map(ref=>{
    const previewStatus=previewMemberStatus(p,ref),eligible=['ready','no_transcript_position'].includes(previewStatus)
    const position=p.meetings.find(m=>m.sessionId===ref.sessionId)?.copies[0]?.rawMap.indexOf(ref.chunkIndex)??-1
    return {...plainRef(ref),previewStatus,position:position<0?null:position,status:eligible?'unknown':'skipped',enrollmentStatus:eligible?'unknown':'not_enrolled',labelStatus:'unchanged',audioStatus:previewStatus==='missing'?'missing':'retained',...(!eligible?{reason:previewStatus}:{})}
  })
}
/** Preserve exact enrollment/deletion receipts; derive label completion from
 * durable meeting receipts, including partial writes and later Undo retries. */
function batchMembers(batch:BatchRecord):NamingMemberOutcome[] {
  if(!batch.memberOutcomes)return(batch.requestedMembers??batch.members).map(ref=>({...plainRef(ref),status:'unknown',enrollmentStatus:'unknown',labelStatus:'unknown',audioStatus:'unknown',position:null,reason:'legacy_receipt_has_no_member_outcome'}))
  return batch.memberOutcomes.map(member=>{
    if(!['ready','no_transcript_position'].includes(member.previewStatus??''))return member
    const meeting=batch.meetings.find(m=>m.sessionId===member.sessionId)
    if(!meeting)return member
    if(meeting.status==='reverted')return{...member,status:'reverted',labelStatus:member.position===null?'no_transcript_position':'reverted',reason:undefined}
    if(meeting.status==='failed'||meeting.error||meeting.receipts.some(r=>r.status==='failed'))return{...member,status:'failed',labelStatus:'failed',reason:meeting.error??'One or more meeting copies failed'}
    if(meeting.status==='applied')return{...member,status:member.position===null?'no_transcript_position':'applied',labelStatus:member.position===null?'no_transcript_position':'labelled',reason:member.enrollmentStatus==='not_enrolled'?'Selected voice sample was refused by the profile store':undefined}
    return{...member,status:'unknown',labelStatus:meeting.receipts.length?'unknown':'unchanged'}
  })
}
function readRecord<T>(kind:'preview'|'batch',id:string):T {
  try { return JSON.parse(readFileSync(recordPath(kind,id),'utf8')) as T }
  catch (e) {if(e instanceof HeldGroupError) throw e;throw new HeldGroupError(409,'preview_expired','This naming preview is unavailable. Preview again.')}
}
function assertFile(path:string) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) === 0) throw new Error('Meeting copy is missing, unsafe, or read-only')
  if (/ \d+(\.[A-Za-z0-9-]+)*\.(md|json)$/.test(path)) throw new Error('iCloud conflict copy is not canonical')
}
let sessionBusy:(sessionId:string)=>boolean=()=>false
export function setNamingSessionLiveness(check:(sessionId:string)=>boolean):void {sessionBusy=check}
interface ResolvedCopy {copy:'local'|'operations';sidecarPath:string;meetingPath:string;doc:Record<string,any>;raw:string;markdown:string;blended:boolean}
function checkedRevision(value:unknown):number {
  if(value===undefined||value===null)return 0
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error('Invalid meeting revision')
  return value
}
function resolveCopies(sessionId:string):ResolvedCopy[] {
  if(sessionBusy(sessionId)||existsSync(dataPath('meeting-finalization-jobs',`${sessionId}.json`)))throw new Error('Meeting is recording or finalizing; retry after it finishes')
  const local = new MeetingStore().findBySessionId(sessionId)
  if (!local) throw new Error('Local meeting copy is missing')
  const paths:Array<{copy:'local'|'operations';sidecarPath:string;meetingPath:string}> = [{copy:'local',sidecarPath:local.sidecarPath,meetingPath:local.filepath}]
  const operations = resolveCosOperationsDir()
  if (operations) {
    const found = findCosOperationsMeetingBySessionId(sessionId)
    if (!found) throw new Error('Operations meeting copy is missing; retry after sync')
    paths.push({copy:'operations',sidecarPath:found.sidecarPath,meetingPath:found.meetingPath})
  } else if (process.env.COS_OPERATIONS_DIR?.trim() || process.env.COS_SCRIPTS_DIR?.trim()) {
    // An explicitly configured but unavailable iCloud root is not standalone.
    throw new Error('Configured operations folder is unavailable; retry after sync')
  }
  return paths.map(p=>{
    assertFile(p.sidecarPath)
    const raw=readFileSync(p.sidecarPath,'utf8'),doc=JSON.parse(raw)
    if(doc.sessionId!==sessionId) throw new Error('Meeting identity changed')
    checkedRevision(doc.correctionRevision);checkedRevision(doc.lifecycleRevision)
    let meetingPath=p.meetingPath,blended=false
    if(!existsSync(meetingPath) && p.copy==='operations' && operations) {
      const parent = Array.isArray(doc.blended_into)?doc.blended_into[0]:doc.claimed_parent
      if(typeof parent!=='string') throw new Error('Operations markdown is missing')
      meetingPath=resolve(operations,parent)
      if(!meetingPath.startsWith(realpathSync(operations)+'/')) throw new Error('Unsafe blended parent path')
      blended=true
    }
    assertFile(meetingPath)
    const markdown=readFileSync(meetingPath,'utf8')
    if ((p.copy === 'local' && doc.finalizationState && doc.finalizationState !== 'complete') || doc.finalizationRequired === true || ['recording','saving','finalizing'].includes(doc.lifecycleState) || ['pending','running','queued'].includes(doc.enrichmentState) || doc.syncState === 'claimed') throw new Error('Meeting is recording, finalizing, or pending enrichment; retry after it finishes')
    if(/<!-- g2-hq-state: pending -->/.test(markdown)||['queued','running'].includes(doc.hqState)) throw new Error('HQ transcription is running; preview again after it finishes')
    return {...p,meetingPath,doc,raw,markdown,blended}
  })
}
const snapshot=(c:ResolvedCopy):CopyPlan=>({copy:c.copy,correctionRevision:Number(c.doc.correctionRevision??0),lifecycleRevision:Number(c.doc.lifecycleRevision??0),sidecarHash:hash(c.raw),markdownHash:hash(c.markdown),rawMap:validatedRawMap(c.doc),blended:c.blended})
function previewView(p:StoredPreview) {
  return {success:true,kind:'preview',...p.plan,dryRun:true,previewHash:p.previewHash,expiresAt:p.expiresAt,speaker:p.speaker,owner:p.owner,ownerWarning:p.owner?'This is the device owner. Listen and acknowledge before applying.':undefined,requiresListening:p.requiresListening,meetings:p.meetings,members:p.members.map(r=>({...r,status:previewMemberStatus(p,r)})),namingCapabilities:NAMING_CAPABILITIES,message:`Preview: ${p.plan.coherent} held samples; ${p.meetings.reduce((n,m)=>n+m.labelled,0)} transcript positions. ${p.requiresListening?'Listen to the wider matches before Apply.':''}`}
}
export function previewHeldNaming(name:string,members:HeldSampleRef[]) {
  pruneExpiredPreviews()
  const resolved=resolveStoredName(name)
  const plan=enrollHeldGroup(resolved.name,members,{dryRun:true})
  const core=plan.coreMembers??[]
  const only=new Map<string,Set<number>>()
  for(const r of core){const set=only.get(r.sessionId)??new Set<number>();set.add(r.chunkIndex);only.set(r.sessionId,set)}
  const held=collectHeldSamples({only,budgetMs:2000}).samples
  const vectors=new Map(held.map(s=>[sampleKey(s),s.embedding]))
  if(resolved.owner){
    const owner=readVoiceProfiles().profiles.find(p=>p.name===resolved.name)
    if(!owner || held.some(s=>!owner.embeddings.some(e=>rawCosineSimilarity(s.embedding,new Float32Array(e))>=0.65))) throw new HeldGroupError(422,'owner_similarity_low','These samples do not reach the owner verification floor (0.65). Nothing changed.')
  }
  const meetings:MeetingPlan[]=[], memberOutcomes:StoredPreview['memberOutcomes']=[]
  const resolvedMeetings=new Map<string,ResolvedCopy[]>()
  const unidentified=(copies:ResolvedCopy[],position:number)=>copies.every(c=>/^(ext|unknown|unidentified(?:\s+\d+)?|speaker\s*\d+)$/i.test(String(c.doc.chunks[position]?.speaker??'')))
  // First establish admissible named evidence across EVERY copy. A skipped
  // member never participates in either the enrollment projection or clustering.
  for(const sessionId of [...new Set(core.map(s=>s.sessionId))].sort()) {
    const refs=core.filter(s=>s.sessionId===sessionId)
    const meeting:MeetingPlan={sessionId,status:'ready',namedChunks:[],widerChunks:[],labelled:0,roomRisk:false,playback:[],copies:[]}
    try {
      if(pendingCorrections(sessionId).length) throw new Error('An interrupted correction needs review')
      const copies=resolveCopies(sessionId)
      meeting.copies=copies.map(snapshot)
      const raw=meeting.copies[0].rawMap
      if(meeting.copies.some(c=>JSON.stringify(c.rawMap)!==JSON.stringify(raw))) throw new Error('Meeting copies disagree on raw chunk mapping')
      if(copies.some(c=>hash(c.doc.chunks.map((row:any)=>row.speaker))!==hash(copies[0].doc.chunks.map((row:any)=>row.speaker))))throw new Error('Meeting copies disagree on speaker labels')
      for(const ref of refs) memberOutcomes.push({...ref,status:raw.includes(ref.chunkIndex)?unidentified(copies,raw.indexOf(ref.chunkIndex))?'ready':'no_longer_Ext':'no_transcript_position'})
      meeting.namedChunks=refs.map(r=>raw.indexOf(r.chunkIndex)).filter(i=>i>=0&&unidentified(copies,i))
      meeting.labelled=meeting.namedChunks.length
      // Prove the named edit before admitting the meeting as training evidence.
      for(const c of copies)if(meeting.labelled)relabelSpeakerPositions(c.doc,c.blended?'':c.markdown,meeting.namedChunks,resolved.name)
      resolvedMeetings.set(sessionId,copies)
    }catch(e){meeting.status='blocked';meeting.error=errorText(e);meeting.labelled=0;for(const ref of refs){const prior=memberOutcomes.find(o=>sampleKey(o)===sampleKey(ref));if(prior)prior.status='blocked';else memberOutcomes.push({...ref,status:'blocked'})}}
    meetings.push(meeting)
  }
  const eligibleMembers=core.filter(r=>['ready','no_transcript_position'].includes(memberOutcomes.find(o=>sampleKey(o)===sampleKey(r))?.status??''))
  const projection=eligibleMembers.length?projectHeldEnrollment(resolved.name,eligibleMembers):null
  const updated=projection?.profiles??readVoiceProfiles().profiles
  const projectedVoiceHash=hash(updated.map(p=>({name:p.name,embeddings:p.embeddings,sources:p.sources})))
  const augmented=updated.find(p=>p.name===resolved.name)
  const storedTarget=readVoiceProfiles().profiles.find(p=>p.name===resolved.name)
  for(const meeting of meetings){
    if(meeting.status!=='ready')continue
    const sessionId=meeting.sessionId,copies=resolvedMeetings.get(sessionId)!,raw=meeting.copies[0].rawMap
    const refs=eligibleMembers.filter(s=>s.sessionId===sessionId)
    if(!refs.length)continue
    const bank=[...new Map(readChunkEmbeddings(sessionId).rows.map(row=>[row.i,row])).values()]
    const seeds=refs.map(r=>vectors.get(sampleKey(r))).filter((v):v is Float32Array=>!!v)
    const seedRaw=new Set(refs.map(r=>r.chunkIndex))
    const candidates=bank.filter(r=>raw.includes(r.i)&&!seedRaw.has(r.i)&&unidentified(copies,raw.indexOf(r.i)))
      .filter(r=>!(storedTarget?.embeddings??[]).some(e=>rawCosineSimilarity(r.embedding,new Float32Array(e))>=0.999))
    const matches=candidates.flatMap(r=>{
      // Ordinary suggestions exclude the owner; deliberate owner naming keeps
      // the same scorer and adds the owner's stricter 0.65 verification gate.
      const suggestion=suggestProfile(r.embedding,updated,{ownerLabel:resolved.owner?undefined:getOwnerSpeakerLabel()})
      if(suggestion?.name!==resolved.name || (resolved.owner&&suggestion.similarity<0.65))return[]
      const agreeing=(augmented?.embeddings??[]).flatMap((e,i)=>rawCosineSimilarity(r.embedding,new Float32Array(e))>=VOICE_COHERENCE_FLOOR?[augmented?.sources?.[i]??'unknown']:[])
      const roomOnly=agreeing.length>0&&agreeing.every(source=>source.endsWith(`:${sessionId}`))
      return[{...r,suggestion,roomOnly}]
    })
    const cluster=coherentClusterContaining(seeds,matches.map(r=>r.embedding),VOICE_COHERENCE_FLOOR)
    const wider=cluster.members.filter(i=>i>=seeds.length).map(i=>matches[i-seeds.length])
    meeting.widerChunks=wider.map(r=>raw.indexOf(r.i))
    meeting.widerScores=wider.map(r=>({chunkIndex:r.i,similarity:r.suggestion.similarity,agreeing:r.suggestion.agreeing,roomOnly:r.roomOnly}))
    meeting.labelled=new Set([...meeting.namedChunks,...meeting.widerChunks]).size
    meeting.roomRisk=wider.some(r=>r.roomOnly)
    meeting.playback=[...new Set([...meeting.namedChunks,...meeting.widerChunks])].map(position=>({sessionId,position,chunkIndex:raw[position]}))
    for(const c of copies)if(meeting.labelled)relabelSpeakerPositions(c.doc,c.blended?'':c.markdown,[...meeting.namedChunks,...meeting.widerChunks],resolved.name)
  }
  const version=voiceVersion(resolved.name)
  const evidenceHash=evidenceVersion(members)
  const payload={evidenceHash,eligibleMembers,projectedVoiceHash,selectedMembers:projection?.selectedMembers??[],members:members.map(plainRef),resolvedName:resolved.name,perMeeting:meetings.map(m=>({sessionId:m.sessionId,perCopyRevs:m.copies,chunkLists:[m.namedChunks,m.widerChunks]})),voiceVersion:version,cluster:core}
  const previewHash=hash(payload)
  const preview:StoredPreview={previewHash,expiresAt:new Date(Date.now()+PREVIEW_TTL).toISOString(),speaker:resolved.name,owner:resolved.owner,requiresListening:meetings.some(m=>m.widerChunks.length>=HIGH_COUNT),voiceVersion:version,evidenceHash,eligibleMembers,projectedVoiceHash,plan,members:members.map(plainRef),meetings,memberOutcomes}
  writeRecord('preview',previewHash,preview)
  return previewView(preview)
}
function batchView(batch:BatchRecord) {
  return {success:true,...batch.plan,dryRun:false,kind:batch.status==='reverted'?'undone':'applied',batchId:batch.batchId,undoHandle:batch.batchId,speaker:batch.speaker,status:batch.status,partial:batch.status==='partial'||batch.status==='interrupted',members:batchMembers(batch),meetings:batch.meetings.map(m=>({...m,labelsNewerThanGraph:m.receipts.some(r=>['applied','sidecar_written','reverted'].includes(r.status)),receipts:m.receipts.map(r=>({copy:r.copy,status:r.status,error:r.error}))})),enrolled:batch.enrolled,profileEmbeddings:batch.profileEmbeddings??batch.plan?.profileEmbeddings??0,deleted:batch.deleted,lockMode:batch.lockMode,namingCapabilities:NAMING_CAPABILITIES,message:'Voice samples kept for training. Search refreshes at up to 10 meetings per sync; graph labels may lag.'}
}
let mutationBusy=false
export async function applyHeldNaming(name:string,members:HeldSampleRef[],previewHash:string,options:{confirm?:boolean;ownerAck?:boolean;listened?:boolean}={}) {
  if(!options.confirm) throw new HeldGroupError(400,'confirmation_required','Preview first, then confirm Apply.')
  const preview=readRecord<StoredPreview>('preview',previewHash)
  if(resolveStoredName(name).name!==preview.speaker||resolveStoredName(name).owner!==preview.owner||hash(members.map(plainRef))!==hash(preview.members)) throw new HeldGroupError(409,'preview_mismatch','The name or samples changed. Preview again.')
  if(preview.owner&&!options.ownerAck) throw new HeldGroupError(400,'owner_confirmation_required','Acknowledge that these samples are the device owner.')
  const prior=listNamingBatches().find(b=>b.previewHash===previewHash)
  if(prior) {
    if(prior.deleteMembers) {const missing=new Set(previewDiscard(prior.deleteMembers).missing.map(sampleKey));prior.deleted=missing.size;for(const member of prior.memberOutcomes??[])if(missing.has(sampleKey(member)))member.audioStatus='deleted';writeRecord('batch',prior.batchId,prior)}
    return batchView(prior)
  }
  if(Date.now()>Date.parse(preview.expiresAt)) throw new HeldGroupError(409,'preview_expired','The preview expired. Preview again.')
  if(preview.requiresListening&&!options.listened) throw new HeldGroupError(400,'listening_required','Listen to the wider matches before applying this many labels.')
  if(mutationBusy) throw new HeldGroupError(409,'naming_running','Another naming is running; retry.')
  mutationBusy=true
  let lock:Awaited<ReturnType<typeof acquireMeetingSyncLock>>|undefined
  try {
    try{lock=await acquireMeetingSyncLock()}catch(e){throw new HeldGroupError(409,'sync_running',errorText(e))}
    if(hash(voiceVersion(preview.speaker))!==hash(preview.voiceVersion)) throw new HeldGroupError(409,'voice_version_changed','Voice profiles changed. Preview again.')
    if(evidenceVersion(preview.members)!==preview.evidenceHash)throw new HeldGroupError(409,'evidence_changed','Voice evidence changed. Preview again.')
    // Re-read held membership, not just the unchanged profile mtime.
    const current=enrollHeldGroup(preview.speaker,preview.members,{dryRun:true})
    if(hash(current.coreMembers)!==hash(preview.plan.coreMembers)) throw new HeldGroupError(409,'members_changed','Held samples changed. Preview again.')
    const batch:BatchRecord={batchId:randomUUID(),speaker:preview.speaker,at:new Date().toISOString(),status:'pending',previewHash,members:preview.plan.coreMembers??[],requestedMembers:preview.members,memberOutcomes:initialMemberOutcomes(preview),meetings:preview.meetings.map(m=>({...m,intentId:randomUUID(),receipts:[]})),enrolled:0,deleted:0,voiceVersion:preview.voiceVersion,lockMode:lock.mode,plan:preview.plan}
    // Validate all copies at write-time before changing voice store or recording intents.
    for(const meeting of batch.meetings){
      if(meeting.status!=='ready')continue
      try{const copies=resolveCopies(meeting.sessionId);if(hash(copies.map(snapshot))!==hash(meeting.copies))throw new Error('Meeting changed since preview');if(pendingCorrections(meeting.sessionId).length)throw new Error('Another correction is pending')}
      catch(e){meeting.status='failed';meeting.error=errorText(e)}
    }
    const ready=new Set(batch.meetings.filter(m=>m.status==='ready').map(m=>m.sessionId))
    const eligible=preview.eligibleMembers.filter(r=>ready.has(r.sessionId))
    if(preview.meetings.some(m=>m.widerChunks.length>0)&&hash(eligible)!==hash(preview.eligibleMembers))throw new HeldGroupError(409,'eligible_evidence_changed','A meeting providing voice evidence changed. Preview again before wider labels apply.')
    if(eligible.length){const projected=projectHeldEnrollment(preview.speaker,eligible);if(preview.meetings.some(m=>m.widerChunks.length>0)&&hash(projected.profiles.map(p=>({name:p.name,embeddings:p.embeddings,sources:p.sources})))!==preview.projectedVoiceHash)throw new HeldGroupError(409,'projected_voice_changed','The projected voice changed. Preview again.')}
    if(!eligible.length) throw new HeldGroupError(409,'meetings_changed','No meeting can safely apply. Preview again.',{meetings:batch.meetings})
    writeRecord('batch',batch.batchId,batch)
    let enrollment:ReturnType<typeof enrollHeldGroup>
    try{enrollment=enrollHeldGroup(batch.speaker,eligible,{deleteAudio:false})}
    catch(e){
      batch.status='partial'
      // A known pre-write refusal differs from an interrupted/throwing store,
      // whose individual enrollment result cannot safely be reconstructed.
      if(e instanceof HeldGroupError&&['nothing_enrolled','speaker_model_unavailable','no_samples','incoherent'].includes(e.reason))for(const member of batch.memberOutcomes??[])if(member.enrollmentStatus==='unknown')member.enrollmentStatus='not_enrolled'
      for(const m of batch.meetings)if(m.status==='ready'){m.status='failed';m.error=errorText(e)}
      writeRecord('batch',batch.batchId,batch);throw e
    }
    batch.enrolled=enrollment.enrolled
    const accepted=new Set(enrollment.enrolledMembers?.map(sampleKey)),rejected=new Set(enrollment.rejectedMembers?.map(sampleKey)),represented=new Set(enrollment.coreMembers?.map(sampleKey))
    for(const member of batch.memberOutcomes??[]){const key=sampleKey(member);if(accepted.has(key))member.enrollmentStatus='enrolled';else if(rejected.has(key))member.enrollmentStatus='not_enrolled';else if(represented.has(key))member.enrollmentStatus='represented';else if(member.enrollmentStatus==='unknown')member.enrollmentStatus='not_enrolled'}
    batch.profileEmbeddings=readVoiceProfiles().profiles.find(p=>p.name===batch.speaker)?.embeddings.length??0
    writeRecord('batch',batch.batchId,batch)
    for(const meeting of batch.meetings){
      if(meeting.status!=='ready')continue
      const positions=[...new Set([...meeting.namedChunks,...meeting.widerChunks])].sort((a,b)=>a-b)
      const row:CorrectionRow={id:meeting.intentId,phase:'intent',at:batch.at,from:'held samples',to:batch.speaker,chunks:positions,scope:'meeting',source:`ext-group:${meeting.sessionId}`,batchId:batch.batchId}
      try{
        const copies=resolveCopies(meeting.sessionId)
        if(hash(copies.map(snapshot))!==hash(meeting.copies))throw new Error('Meeting changed at write-time')
        if(meeting.widerChunks.length){
          const bank=new Map(readChunkEmbeddings(meeting.sessionId).rows.map(r=>[r.i,r.embedding]))
          const actual=readVoiceProfiles().profiles
          for(const position of meeting.widerChunks){const emb=bank.get(meeting.copies[0].rawMap[position]);const suggestion=emb?suggestProfile(emb,actual,{ownerLabel:preview.owner?undefined:getOwnerSpeakerLabel()}):null;if(suggestion?.name!==batch.speaker||(preview.owner&&suggestion.similarity<0.65))throw new Error('Enrolled voice no longer supports a wider match; preview again')}
        }
        for(const c of copies){
          const edit=relabelSpeakerPositions(c.doc,c.blended?'':c.markdown,positions,batch.speaker,batch.batchId)
          meeting.receipts.push({copy:c.copy,status:'pending',patches:edit.patches,beforeSidecar:c.raw,afterSidecar:JSON.stringify(edit.doc,null,2)+'\n',beforeMarkdown:c.markdown,afterMarkdown:c.blended?c.markdown+(c.markdown.includes('<!-- speaker-labels-newer-than-graph -->')?'':'\n<!-- speaker-labels-newer-than-graph -->\n'):edit.markdown,blended:c.blended})
        }
        row.priorLabels=Object.fromEntries(positions.map(i=>[String(i),String(copies[0].doc.chunks[i].speaker??'')]))
        writeRecord('batch',batch.batchId,batch)
        if(!appendCorrection(meeting.sessionId,row))throw new Error('Cannot write correction intent')
        for(const receipt of meeting.receipts){
          // Resolve by sessionId AGAIN: preview paths and earlier paths are never authority.
          const current=resolveCopies(meeting.sessionId).find(c=>c.copy===receipt.copy)!
          if(current.raw!==receipt.beforeSidecar||current.markdown!==receipt.beforeMarkdown)throw new Error('Meeting changed immediately before copy write')
          durableAtomicWriteFileSync(current.sidecarPath,receipt.afterSidecar,{mode:0o600})
          receipt.status='sidecar_written';writeRecord('batch',batch.batchId,batch)
          assertMarkdownWords(receipt.beforeMarkdown,receipt.afterMarkdown)
          durableAtomicWriteFileSync(current.meetingPath,receipt.afterMarkdown,{mode:0o600})
          receipt.status='applied';writeRecord('batch',batch.batchId,batch)
        }
        if(!appendCorrection(meeting.sessionId,{...row,phase:'applied',proseStale:true}))throw new Error('Cannot record applied correction')
        if(positions.length&&!appendCorrection(meeting.sessionId,{...row,phase:'confirmed-chunks'}))throw new Error('Cannot record chunk confirmation')
        meeting.status='applied'
      }catch(e){meeting.status='failed';meeting.error=errorText(e);appendCorrection(meeting.sessionId,{...row,phase:'failed',error:meeting.error})}
      writeRecord('batch',batch.batchId,batch)
    }
    batch.status=batch.meetings.every(m=>m.status==='applied')?'applied':'partial'
    // This receipt is durable BEFORE deleting any audio, including a crash midway in deletion.
    writeRecord('batch',batch.batchId,batch)
    const applied=new Set(batch.meetings.filter(m=>m.status==='applied').map(m=>m.sessionId))
    batch.deleteMembers=(enrollment.coreMembers??[]).filter(r=>applied.has(r.sessionId))
    writeRecord('batch',batch.batchId,batch)
    const removed=new Set(discardHeldSamples(batch.deleteMembers).removed.map(sampleKey))
    batch.deleted=removed.size
    for(const member of batch.memberOutcomes??[])if(removed.has(sampleKey(member)))member.audioStatus='deleted'
    writeRecord('batch',batch.batchId,batch)
    return batchView(batch)
  }finally{lock?.release();mutationBusy=false}
}

export function listNamingBatches():BatchRecord[]{
  const dir=dataPath('meeting-corrections')
  if(!existsSync(dir))return[]
  return readdirSync(dir).filter(f=>/^batch-[a-f0-9-]+\.json$/.test(f)).flatMap(f=>{try{return[JSON.parse(readFileSync(join(dir,f),'utf8')) as BatchRecord]}catch{return[]}}).sort((a,b)=>b.at.localeCompare(a.at))
}
export function namingBatchList(){return{namingCapabilities:NAMING_CAPABILITIES,batches:listNamingBatches().map(b=>({...batchView(b),previewHash:b.previewHash}))}}
export function recoverInterruptedNaming():number {
  const closed=closeInterruptedCorrections()
  for(const batch of listNamingBatches())if(batch.status==='pending'){batch.status='interrupted';for(const m of batch.meetings)if(m.status==='ready'){m.status='failed';m.error='Interrupted naming — review to resume or revert'}writeRecord('batch',batch.batchId,batch)}
  return closed
}
export function resumeHeldNaming(batchId:string){
  const batch=readRecord<BatchRecord>('batch',batchId)
  const pending=batch.members.filter(r=>batch.meetings.find(m=>m.sessionId===r.sessionId)?.status!=='applied')
  if(batch.meetings.some(m=>m.receipts.some(r=>r.status==='sidecar_written'||r.status==='pending'&&r.beforeSidecar!==r.afterSidecar)))throw new HeldGroupError(409,'revert_required','This interrupted naming may have written a copy. Undo it before previewing again.')
  return previewHeldNaming(batch.speaker,pending)
}
export async function undoHeldNaming(batchId:string,confirm:boolean){
  if(!confirm)throw new HeldGroupError(400,'confirmation_required','Confirm Undo to restore these labels. Enrolled voice samples stay kept.')
  const batch=readRecord<BatchRecord>('batch',batchId)
  if(batch.status==='reverted')return{...batchView(batch),samplesKept:true,audioRestored:false}
  if(mutationBusy)throw new HeldGroupError(409,'naming_running','Another naming is running; retry.')
  mutationBusy=true
  let lock:Awaited<ReturnType<typeof acquireMeetingSyncLock>>|undefined
  try{
    try{lock=await acquireMeetingSyncLock()}catch(e){throw new HeldGroupError(409,'sync_running',errorText(e))}
    for(const meeting of batch.meetings){
      if(!meeting.receipts.length)continue
      const undoId=randomUUID(),row:CorrectionRow={id:undoId,phase:'intent',at:new Date().toISOString(),from:batch.speaker,to:'prior labels',chunks:[...meeting.namedChunks,...meeting.widerChunks],scope:'meeting',batchId:batch.batchId,source:'undo'}
      try{
        const later=appliedCorrections(meeting.sessionId).filter(r=>r.batchId!==batchId&&r.at>=batch.at)
        if(later.some(r=>r.chunks.length===0||r.chunks.some(i=>row.chunks.includes(i))))throw new Error('A later batch touched these positions; undo it first')
        if(!appendCorrection(meeting.sessionId,row))throw new Error('Cannot record undo intent')
        for(const receipt of meeting.receipts){
          if(receipt.status==='reverted')continue
          try{
            const c=resolveCopies(meeting.sessionId).find(c=>c.copy===receipt.copy)
            if(!c)throw new Error('Meeting copy missing')
            const doc=structuredClone(c.doc)
            const before=JSON.parse(receipt.beforeSidecar)
            if(c.raw!==receipt.beforeSidecar){
              for(const patch of [...receipt.patches].reverse())patchValue(doc,patch,true)
              doc.speakers=[...new Set(doc.chunks.map((ch:any)=>ch.speaker).filter(Boolean))]
              doc.correctionRevision=Number(doc.correctionRevision??0)+1
              doc.labelsNewerThanGraph=true
            }
            const md=receipt.blended?(c.markdown.includes('<!-- speaker-labels-newer-than-graph -->')?c.markdown:c.markdown+'\n<!-- speaker-labels-newer-than-graph -->\n'):undoSpeakerMarkdown(receipt.beforeMarkdown,receipt.afterMarkdown,c.markdown,doc.speakers??[])
            const clean=(s:string)=>s.replace(/\n?<!-- speaker-labels-newer-than-graph -->\n?/g,'')
            if(strippedTranscript(clean(md))!==strippedTranscript(clean(c.markdown)))throw new Error('Undo word-preservation assertion failed')
            assertFile(c.sidecarPath);assertFile(c.meetingPath)
            durableAtomicWriteFileSync(c.sidecarPath,JSON.stringify(c.raw===receipt.beforeSidecar?before:doc,null,2)+'\n',{mode:0o600})
            durableAtomicWriteFileSync(c.meetingPath,md,{mode:0o600})
            receipt.status='reverted';delete receipt.error;writeRecord('batch',batch.batchId,batch)
          }catch(e){receipt.status='failed';receipt.error=errorText(e)}
        }
        if(meeting.receipts.every(r=>r.status==='reverted')){if(!appendCorrection(meeting.sessionId,{...row,phase:'reverted'}))throw new Error('Cannot record undo outcome');meeting.status='reverted';delete meeting.error}
        else throw new Error('One or more meeting copies could not be restored')
      }catch(e){meeting.error=errorText(e);appendCorrection(meeting.sessionId,{...row,phase:'failed',error:meeting.error})}
      writeRecord('batch',batch.batchId,batch)
    }
    batch.status=batch.meetings.filter(m=>m.receipts.length).every(m=>m.status==='reverted')?'reverted':'partial'
    writeRecord('batch',batch.batchId,batch)
    return{...batchView(batch),kind:'undone',samplesKept:true,audioRestored:false}
  }finally{lock?.release();mutationBusy=false}
}

/** Profile merge fan-out uses the exact correction primitive and receipts, with
 * enrolment/audio deletion off. Dry run neither records a preview nor writes a ledger. */
export async function renameMeetingSpeaker(sessionId:string,from:string,to:string,options:{apply?:boolean;operationsDir?:string;expectedSidecarPath?:string}={}) : Promise<{copies:Array<{sidecarPath:string;meetingPath:string;labels:number;transcript:number;attendees:number;unresolvedTurns:number}>;batchId?:string;error?:string}> {
  if(options.operationsDir && resolveCosOperationsDir()!==realpathSync(options.operationsDir)) throw new Error('Operations root differs from the requested fan-out root')
  if(from===to||!from.trim()||!to.trim())return{copies:[]}
  if(options.apply&&mutationBusy)throw new Error('Another naming is running; retry')
  let lock:Awaited<ReturnType<typeof acquireMeetingSyncLock>>|undefined
  let batch:BatchRecord|undefined
  let row:CorrectionRow|undefined
  if(options.apply)mutationBusy=true
  try{
    if(options.apply)lock=await acquireMeetingSyncLock()
    if(pendingCorrections(sessionId).length)throw new Error('An interrupted correction needs review')
    const copies=resolveCopies(sessionId)
    const operations=copies.find(c=>c.copy==='operations')
    if(options.expectedSidecarPath && (!operations || realpathSync(operations.sidecarPath)!==realpathSync(options.expectedSidecarPath)))throw new Error('Session resolves to a different sidecar; duplicate or archived copy')
    const maps=copies.map(c=>validatedRawMap(c.doc))
    if(maps.some(map=>hash(map)!==hash(maps[0])))throw new Error('Meeting copies disagree on raw mapping')
    const positions:number[]=copies[0].doc.chunks.flatMap((c:any,i:number)=>c.speaker===from?[i]:[])
    // Repair historical chunks-only renames too: HQ words still carry `from`
    // even when the compacted chunk already says `to` (the 6.27.10 trap).
    for(const c of copies)for(const segment of c.doc.batchSegments??[])for(const word of segment.speakerWords??[]){
      if(word.speaker!==from)continue
      const absolute=Number(segment.startElapsed??0)+Number(word.start)*1000
      let position=-1,distance=Infinity
      const raw=validatedRawMap(c.doc)
      raw.forEach((index,i)=>{if(index<segment.startChunkIdx||index>segment.endChunkIdx)return;const d=Math.abs(Number(c.doc.chunks[i].elapsed)-absolute);if(d<distance){distance=d;position=i}})
      if(distance>3500||position<0)throw new Error('Old HQ speaker has no safe raw chunk mapping')
      if(![from,to].includes(c.doc.chunks[position].speaker))throw new Error('HQ speaker conflicts with an unrelated named chunk')
      if(!positions.includes(position))positions.push(position)
    }
    positions.sort((a,b)=>a-b)
    if(!positions.length)return{copies:[]}
    if(copies.some(c=>positions.some((i:number)=>![from,to].includes(c.doc.chunks[i]?.speaker))))throw new Error('Meeting copies disagree on prior speaker labels')
    const batchId=randomUUID()
    const edits=copies.map(c=>relabelSpeakerPositions(c.doc,c.blended?'':c.markdown,positions,to,batchId))
    const results=copies.map((c,i)=>({sidecarPath:c.sidecarPath,meetingPath:c.meetingPath,labels:positions.length,transcript:edits[i].transcript,attendees:edits[i].attendees,unresolvedTurns:edits[i].unresolvedTurns}))
    if(!options.apply)return{copies:results}
    row={id:randomUUID(),phase:'intent',at:new Date().toISOString(),from,to,chunks:positions,scope:'meeting',batchId,source:'profile-merge',priorLabels:Object.fromEntries(positions.map((i:number)=>[String(i),String(copies[0].doc.chunks[i].speaker??'')]))}
    const meeting:BatchMeeting={sessionId,status:'ready',namedChunks:positions,widerChunks:[],labelled:positions.length,roomRisk:false,playback:positions.map((position:number)=>({sessionId,position,chunkIndex:maps[0][position]})),copies:copies.map(snapshot),intentId:row.id,receipts:copies.map((c,i)=>({copy:c.copy,status:'pending',patches:edits[i].patches,beforeSidecar:c.raw,afterSidecar:JSON.stringify(edits[i].doc,null,2)+'\n',beforeMarkdown:c.markdown,afterMarkdown:c.blended?c.markdown+(c.markdown.includes('<!-- speaker-labels-newer-than-graph -->')?'':'\n<!-- speaker-labels-newer-than-graph -->\n'):edits[i].markdown,blended:c.blended}))}
    batch={batchId,speaker:to,at:row.at,status:'pending',previewHash:'',members:[],meetings:[meeting],enrolled:0,deleted:0,voiceVersion:voiceVersion(to),lockMode:lock!.mode}
    writeRecord('batch',batchId,batch)
    if(!appendCorrection(sessionId,row))throw new Error('Cannot write correction intent')
    for(const receipt of meeting.receipts){
      const c=resolveCopies(sessionId).find(c=>c.copy===receipt.copy)!
      if(c.raw!==receipt.beforeSidecar||c.markdown!==receipt.beforeMarkdown)throw new Error('Meeting changed before copy write')
      durableAtomicWriteFileSync(c.sidecarPath,receipt.afterSidecar,{mode:0o600});receipt.status='sidecar_written';writeRecord('batch',batchId,batch)
      assertMarkdownWords(receipt.beforeMarkdown,receipt.afterMarkdown)
      durableAtomicWriteFileSync(c.meetingPath,receipt.afterMarkdown,{mode:0o600});receipt.status='applied';writeRecord('batch',batchId,batch)
    }
    if(!appendCorrection(sessionId,{...row,phase:'applied',proseStale:true}))throw new Error('Cannot record applied correction')
    if(!appendCorrection(sessionId,{...row,phase:'confirmed-chunks'}))throw new Error('Cannot record chunk confirmation')
    meeting.status='applied';batch.status='applied';writeRecord('batch',batchId,batch)
    return{copies:results,batchId}
  }catch(e){
    if(batch){batch.status='partial';batch.meetings[0].status='failed';batch.meetings[0].error=errorText(e);writeRecord('batch',batch.batchId,batch)}
    if(row)appendCorrection(sessionId,{...row,phase:'failed',error:errorText(e)})
    throw e
  }finally{lock?.release();if(options.apply)mutationBusy=false}
}
