/** Explicit, offline publication of a reviewed derived view. Synchronous bounded
 * IO: call only in the guarded offline/worker lane, never on an HTTP thread.
 * No inference, base
 * edits, correction-ledger writes, enrollment, feature enablement or discovery.
 * A qualification receipt is a CALLER trust decision, not native authentication:
 * this module never turns self-hashed proposals into qualified evidence. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readPcm16Wav } from './speaker-shadow-timeline.js'
import { validateMacSpeakerCallPacket, validateMacSpeakerCallIntervalNativeSource, type MacSpeakerCallPacket } from './mac-speaker-call-view.js'
import type { MacSpeakerCallIntervalMembership } from './mac-speaker-call-interval-projection.js'

const SHA=/^[a-f0-9]{64}$/, MAX_ARTIFACT=16*1024*1024, MAX_FILES=6500
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex')
const digest=(v:unknown)=>sha(JSON.stringify(v))
const fail=(s:string):never=>{throw Error(`Mac speaker call store: ${s}`)}
export type MacSpeakerCallAdmissionPolicy='strict'|'anonymous-estimate'|'source-bound-intervals'
export type MacSpeakerCallFileRole='original'|'current'|'ledger'|'raw-pcm-manifest'|'cli'|'model-manifest'|'native-export'|'embedding-export'|'raw-audio'|'model-file'
export interface MacSpeakerCallFrozenFile {role:MacSpeakerCallFileRole;path:string;sha256:string|null}
export interface MacSpeakerCallRawPCMManifest {
  version:1;captureId:string
  rows:Array<{rawChunkIndex:number;path:string;wavSHA256:string;pcmSHA256:string;sampleCount:number}>
}
export interface MacSpeakerCallModelManifest {
  version:1;modelSHA256:string;files:Array<{path:string;sha256:string}>
}
/** Independently supplied by the trusted QA caller. No receipt-issuing helper
 * exists here. reviewer/reviewReceiptSHA256 identify the external decision. */
interface MacSpeakerCallQualificationBase {
  kind:'mac-speaker-call-qualified';captureId:string
  qualification:{status:'qualified';reviewer:string;reviewReceiptSHA256:string}
  sourceFilesSHA256:string
  bindings:{originalSHA256:string;currentSHA256:string;ledgerSHA256:string;rawPCMManifestSHA256:string;cliSHA256:string;modelSHA256:string;nativeExportSHA256:string;embeddingExportSHA256:string;sourceBindingSHA256:string;stateSHA256:string;packetSHA256:string;stateFileSHA256:string;packetFileSHA256:string}
}
/** Interval qualification is an explicit new decision. A legacy receipt can
 * never authorize interval membership, even when all file hashes still match. */
export type MacSpeakerCallQualification=MacSpeakerCallQualificationBase&(
  {version:1;policy:'fluid256-call-view-v1';admissionPolicy:'strict'|'anonymous-estimate';intervalMembership?:never;intervalSupportSHA256?:never;timelinePCMSHA256?:never}
  |{version:2;policy:'fluid256-call-interval-view-v1';admissionPolicy:'source-bound-intervals';intervalMembership:MacSpeakerCallIntervalMembership;intervalSupportSHA256:string;timelinePCMSHA256:string}
)
export interface MacSpeakerCallPublicationInput {
  captureId:string;transactionRoot:string;packetPath:string;statePath:string
  packetJSON:string;stateJSON:string
  expectedPacketSHA256:string|null;expectedStateFileSHA256:string|null
  sources:MacSpeakerCallFrozenFile[]
  qualificationReceipt:{path:string;expectedSHA256:string}
}
export interface MacSpeakerCallStoreOptions {
  /** Explicit dead-PID lock reclamation only; never kills/reclaims a live owner. */
  resume?:boolean
  /** Deterministic fault seams for private tests; called before the final CAS. */
  beforeWrite?:(index:number)=>void;afterWrite?:(index:number)=>void
}
type Image={path:string;before:string;after:string;beforeSHA256:string|null;afterSHA256:string}
type Intent={version:1;captureId:string;directory:string;root:string;lockPath:string;captureLockPath:string;sources:MacSpeakerCallFrozenFile[];qualification:{path:string;sha256:string};images:Image[];owned:Array<{name:string;sha256:string}>}
type Journal={version:1;intentSHA256:string;phase:'prepared'|'applying'|'applied'|'undoing'|'reverted'|'partial';completed:number[];journalSHA256:string}
const roleLimit=(role:MacSpeakerCallFileRole)=>({original:32,current:32,ledger:8,'raw-pcm-manifest':16,cli:256,'model-manifest':16,'native-export':64,'embedding-export':96,'raw-audio':1,'model-file':1024}[role]*1024*1024)
const ROLES=new Set<MacSpeakerCallFileRole>(['original','current','ledger','raw-pcm-manifest','cli','model-manifest','native-export','embedding-export','raw-audio','model-file'])
const uniqueRoles=['original','current','ledger','raw-pcm-manifest','cli','model-manifest','native-export','embedding-export'] as const
const budget=()=>{const deadline=Date.now()+60000;return()=>{if(Date.now()>deadline)fail('operation deadline')}}
function canonicalDir(path:string):string {
  if(typeof path!=='string'||!isAbsolute(path)||path.length>4096||resolve(path)!==path||path==='/'||realpathSync(path)!==path||!lstatSync(path).isDirectory())fail('canonical directory required')
  return path
}
function safePath(path:string):string {
  if(typeof path!=='string'||!isAbsolute(path)||path.length>4096||resolve(path)!==path)fail('absolute canonical path required')
  canonicalDir(dirname(path));return path
}
type Stamp={dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number}
const stamp=(s:Stamp):Stamp=>({dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs})
function read(path:string,limit:number,check:()=>void,capture=true,absent=false):{hash:string;bytes:Buffer;stamp:Stamp}|null {
  safePath(path);let fd:number
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)}catch(e){if(absent&&(e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}
  try{
    const first=fstatSync(fd);if(!first.isFile()||first.size>limit||realpathSync(path)!==path)fail('unsafe/oversized file')
    const hash=createHash('sha256'),parts:Buffer[]=[],buffer=Buffer.allocUnsafe(65536);let total=0
    for(;;){check();const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;total+=n;if(total>limit)fail('file grew');hash.update(buffer.subarray(0,n));if(capture)parts.push(Buffer.from(buffer.subarray(0,n)))}
    const after=fstatSync(fd),atPath=lstatSync(path)
    if(total!==first.size||after.size!==first.size||after.mtimeMs!==first.mtimeMs||after.ctimeMs!==first.ctimeMs||atPath.ino!==after.ino||atPath.dev!==after.dev||atPath.isSymbolicLink())fail('file drift during read')
    return{hash:hash.digest('hex'),bytes:capture?Buffer.concat(parts):Buffer.alloc(0),stamp:stamp(after)}
  }finally{closeSync(fd)}
}
function syncDir(dir:string){canonicalDir(dir);const fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{fsyncSync(fd)}finally{closeSync(fd)}}
function writeNew(path:string,bytes:Buffer|string,mode=0o400){safePath(path);const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_NONBLOCK,mode);try{writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}syncDir(dirname(path))}
function publish(path:string,bytes:Buffer|null,beforeRename:()=>void=()=>{}){
  safePath(path)
  if(bytes===null){beforeRename();unlinkSync(path);syncDir(dirname(path));return}
  const temp=join(dirname(path),`.speaker-call-${randomUUID()}.tmp`)
  try{writeNew(temp,bytes,0o600);safePath(path);beforeRename();renameSync(temp,path);syncDir(dirname(path))}catch(e){try{unlinkSync(temp)}catch{}throw e}
}
function json(bytes:Buffer){return JSON.parse(bytes.toString('utf8')) as Record<string,any>}
function same(a:unknown,b:unknown){return digest(a)===digest(b)}
/** Canonical inventory digest only. It grants no qualification. */
export function hashMacSpeakerCallFileInventory(files:readonly MacSpeakerCallFrozenFile[]):string {
  return digest([...files].sort((a,b)=>a.role<b.role?-1:a.role>b.role?1:a.path<b.path?-1:a.path>b.path?1:0))
}
function pinShape(files:MacSpeakerCallFrozenFile[]){
  if(!Array.isArray(files)||files.length>MAX_FILES)fail('source file bound')
  const seen=new Set<string>()
  for(const f of files){if(!f||!ROLES.has(f.role)||!SHA.test(f.sha256??'')&&!(f.role==='ledger'&&f.sha256===null)||seen.has(`${f.role}:${f.path}`))fail('source pin schema');safePath(f.path);seen.add(`${f.role}:${f.path}`)}
  for(const role of uniqueRoles)if(files.filter(f=>f.role===role).length!==1)fail('required source role')
  const byPath=new Map<string,string|null>()
  for(const f of files){if(byPath.has(f.path)&&byPath.get(f.path)!==f.sha256)fail('conflicting source alias');byPath.set(f.path,f.sha256)}
}
function verifyFiles(files:MacSpeakerCallFrozenFile[],check:()=>void){
  pinShape(files);const bodies=new Map<MacSpeakerCallFileRole,Buffer>(),stamps=new Map<string,Stamp|null>()
  const rawPin=files.find(f=>f.role==='raw-pcm-manifest')!,modelPin=files.find(f=>f.role==='model-manifest')!
  const rawRead=read(rawPin.path,roleLimit(rawPin.role),check)!,modelRead=read(modelPin.path,roleLimit(modelPin.role),check)!
  if(rawRead.hash!==rawPin.sha256||modelRead.hash!==modelPin.sha256)fail('manifest drift')
  const raw=json(rawRead.bytes),model=json(modelRead.bytes)
  if(raw.version!==1||!Array.isArray(raw.rows)||!raw.rows.length||raw.rows.length>6000||model.version!==1||!Array.isArray(model.files)||!model.files.length||model.files.length>100)fail('manifest schema')
  const rawFiles=files.filter(f=>f.role==='raw-audio'),modelFiles=files.filter(f=>f.role==='model-file')
  if(rawFiles.length!==raw.rows.length||modelFiles.length!==model.files.length)fail('complete manifest inventory required')
  for(const[r,i]of raw.rows.map((r:any,i:number)=>[r,i]))if(r.rawChunkIndex!==i||!SHA.test(r.wavSHA256)||!SHA.test(r.pcmSHA256)||!Number.isSafeInteger(r.sampleCount)||r.sampleCount<=0||r.sampleCount>480000||!rawFiles.some(f=>f.path===r.path&&f.sha256===r.wavSHA256))fail('raw manifest binding')
  if(new Set(raw.rows.map((r:any)=>r.path)).size!==raw.rows.length||new Set(model.files.map((r:any)=>r.path)).size!==model.files.length)fail('duplicate manifest paths')
  for(const m of model.files)if(!SHA.test(m.sha256)||!modelFiles.some(f=>f.path===m.path&&f.sha256===m.sha256))fail('model manifest binding')
  let totalBytes=0
  for(const f of files){
    const capture=!['cli','model-file'].includes(f.role),result=read(f.path,roleLimit(f.role),check,capture,f.sha256===null)
    if((result?.hash??null)!==f.sha256)fail('frozen source drift')
    stamps.set(f.path,result?.stamp??null)
    if(result&&capture){totalBytes+=result.bytes.length;if(totalBytes>512*1024*1024)fail('source byte budget');if(uniqueRoles.includes(f.role as any))bodies.set(f.role,result.bytes)}
    if(f.role==='raw-audio'){
      const r=raw.rows.find((r:any)=>r.path===f.path),pcm=readPcm16Wav(result!.bytes)
      if(pcm.sampleCount!==r.sampleCount||sha(pcm.pcm)!==r.pcmSHA256)fail('raw PCM drift')
    }
  }
  return{bodies,raw,model,stamps}
}
function immediateFence(stamps:Map<string,Stamp|null>){
  for(const[path,expected]of stamps){safePath(path);let actual:ReturnType<typeof lstatSync>|null=null;try{actual=lstatSync(path)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
    if(expected===null?actual!==null:!actual||actual.isSymbolicLink()||!actual.isFile()||!same(stamp(actual),expected))fail('immediate source stamp drift')}
}
function verifyQualified(packetBytes:Buffer,stateBytes:Buffer,qualification:Buffer,files:MacSpeakerCallFrozenFile[],verified:ReturnType<typeof verifyFiles>,captureId:string){
  const p=json(packetBytes),s=json(stateBytes),q=json(qualification) as MacSpeakerCallQualification
  const legacy=q.version===1&&q.policy==='fluid256-call-view-v1'&&['strict','anonymous-estimate'].includes(q.admissionPolicy)&&q.intervalMembership===undefined&&q.intervalSupportSHA256===undefined&&q.timelinePCMSHA256===undefined
  const interval=q.version===2&&q.policy==='fluid256-call-interval-view-v1'&&q.admissionPolicy==='source-bound-intervals'&&['accepted-only','native-exclusive-members'].includes(q.intervalMembership)&&SHA.test(q.intervalSupportSHA256)&&SHA.test(q.timelinePCMSHA256)
  if(!legacy&&!interval||q.kind!=='mac-speaker-call-qualified'||q.captureId!==captureId||q.qualification?.status!=='qualified'||typeof q.qualification.reviewer!=='string'||!q.qualification.reviewer.trim()||q.qualification.reviewer.length>200||!SHA.test(q.qualification.reviewReceiptSHA256)||q.sourceFilesSHA256!==hashMacSpeakerCallFileInventory(files))fail('independent qualification receipt required')
  if(p.version!==(interval?2:1)||p.policy!==q.policy||p.admission!=='qualified'||p.projectionPolicy!==q.admissionPolicy||!interval&&p.intervalSupport!==undefined||s.version!==1||s.policy!=='fluid256-recurrence-v1'||p.captureId!==captureId||s.captureId!==captureId||p.generation!==s.generation||typeof p.generation!=='string'||!p.generation||p.generation.length>128||p.revision!==s.revision||!Number.isSafeInteger(s.revision)||s.revision<1||s.revision>=9999999)fail('qualified packet/state policy')
  const{packetSHA256,...pb}=p,{stateSHA256,...sb}=s
  if(packetSHA256!==digest(pb)||stateSHA256!==digest(sb)||p.stateSHA256!==stateSHA256||!same(p.groups,s.groups)||!same(p.rawBindings,s.rawBindings)||p.modelSHA256!==s.modelSHA256||p.cliSHA256!==s.cliSHA256||p.sourceBindingSHA256!==s.sourceBindingSHA256||p.provenance?.speakerPurityVerified!==false||p.provenance?.nativeAuthenticated!==false||s.provenance?.nativeAuthenticated!==false||s.provenance?.productionQualified!==false)fail('packet/state integrity')
  const body=(role:MacSpeakerCallFileRole)=>verified.bodies.get(role)!,pin=(role:MacSpeakerCallFileRole)=>files.find(f=>f.role===role)!
  const expected={originalSHA256:sha(body('original')),currentSHA256:sha(body('current')),ledgerSHA256:sha(body('ledger')??''),rawPCMManifestSHA256:pin('raw-pcm-manifest').sha256!,cliSHA256:pin('cli').sha256!,modelSHA256:s.modelSHA256,nativeExportSHA256:sha(body('native-export')),embeddingExportSHA256:sha(body('embedding-export')),sourceBindingSHA256:s.sourceBindingSHA256,stateSHA256,packetSHA256,stateFileSHA256:sha(stateBytes),packetFileSHA256:sha(packetBytes)}
  if(!same(q.bindings,expected)||Object.values(expected).some(h=>!SHA.test(h))||p.baseSHA256!==expected.currentSHA256||p.ledgerSHA256!==expected.ledgerSHA256||s.cliSHA256!==expected.cliSHA256||verified.raw.captureId!==captureId||verified.model.modelSHA256!==s.modelSHA256||json(body('current')).sessionId!==captureId||json(body('original')).sessionId!==captureId)fail('qualification/source bindings')
  if(!Array.isArray(s.rawBindings)||s.rawBindings.length!==verified.raw.rows.length||s.rawBindings.some((r:any,i:number)=>{const v=verified.raw.rows[i];return r.rawChunkIndex!==i||r.audioSHA256!==v.wavSHA256||r.pcmSHA256!==v.pcmSHA256||r.endSample-r.startSample!==v.sampleCount}))fail('qualified raw manifest')
  for(const role of ['original','current'] as const){const doc=json(body(role));if(doc.finalizationState!=='complete'||doc.sourceType!=='mac_system_audio'||doc.active||doc.isActive||doc.claimPending||!Array.isArray(doc.chunkEntries)||doc.chunkEntries.length!==s.rawBindings.length)fail('closed source required')
    for(const[e,i]of doc.chunkEntries.map((e:any,i:number)=>[e,i])){const r=s.rawBindings[i];if(e.chunkIndex!==i||!e.chunk||e.chunk.audioSha256&&e.chunk.audioSha256!==r.audioSHA256||!Number.isFinite(e.chunk.elapsed)||Math.floor(e.chunk.elapsed*16+.5)!==r.startSample||role==='original'&&digest(e.chunk)!==r.originalRowSHA256)fail('raw source geometry binding')}}
  if(s.provenance.originalSHA256!==expected.originalSHA256||s.provenance.currentSHA256!==expected.currentSHA256||s.provenance.ledgerSHA256!==expected.ledgerSHA256||s.provenance.nativeSHA256!==expected.nativeExportSHA256||s.provenance.embeddingsSHA256!==expected.embeddingExportSHA256)fail('state source provenance')
  if(interval&&q.version===2){
    // The trusted caller supplies qualification; the store independently checks
    // packet geometry against the pinned native export, not a self-hashed list.
    validateMacSpeakerCallPacket(body('current').toString('utf8'),(body('ledger')??Buffer.alloc(0)).toString('utf8'),p as MacSpeakerCallPacket)
    const support=p.intervalSupport
    if(!support||support.membership!==q.intervalMembership||support.supportSHA256!==q.intervalSupportSHA256||support.timelinePCMSHA256!==q.timelinePCMSHA256||support.nativeSHA256!==expected.nativeExportSHA256)fail('qualified interval evidence binding')
    validateMacSpeakerCallIntervalNativeSource(p as MacSpeakerCallPacket,body('native-export').toString('utf8'))
    if(!Array.isArray(s.identities)||!Array.isArray(s.groups)||s.groups.some((g:any)=>{const id=s.identities.find((i:any)=>i.identityId===g.identityId&&!i.retired);return !id||!Number.isSafeInteger(id.ordinal)||p.displayLabels[g.identityId]!==`Anonymous group ${id.ordinal}`}))fail('qualified anonymous identity display')
  }
}
function lock(path:string,directory:string,resume=false){
  const old=read(path,4096,()=>{},true,true)
  if(old){
    if(!resume)fail('existing capture lock requires explicit resume')
    const value=json(old.bytes);if(!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.token!=='string')fail('invalid capture lock')
    try{process.kill(value.pid,0);fail('capture lock owner alive')}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}
    if(read(path,4096,()=>{})!.hash!==old.hash)fail('lock drift');unlinkSync(path);syncDir(dirname(path))
  }
  const bytes=JSON.stringify({pid:process.pid,directory,token:randomUUID()});writeNew(path,bytes,0o600)
  return()=>{if(read(path,4096,()=>{})?.hash!==sha(bytes))fail('lock owner drift');unlinkSync(path);syncDir(dirname(path))}
}
function locks(targetPath:string,capturePath:string,directory:string,resume=false){
  const target=lock(targetPath,directory,resume);let capture:()=>void
  try{capture=lock(capturePath,directory,resume)}catch(e){target();throw e}
  return()=>{try{capture()}finally{target()}}
}
function sealedJournal(j:Omit<Journal,'journalSHA256'>):Journal{return{...j,journalSHA256:digest(j)}}
function checkJournal(bytes:Buffer,intentSHA256:string):Journal{
  const j=json(bytes) as Journal,{journalSHA256,...body}=j
  if(j.version!==1||j.intentSHA256!==intentSHA256||journalSHA256!==digest(body)||!['prepared','applying','applied','undoing','reverted','partial'].includes(j.phase)||!Array.isArray(j.completed)||j.completed.some(i=>i!==0&&i!==1)||new Set(j.completed).size!==j.completed.length)fail('journal integrity')
  return j
}
function targets(intent:Intent,check:()=>void){return intent.images.map(i=>{const r=read(i.path,MAX_ARTIFACT,check,true,true),h=r?.hash??null;if(h!==i.beforeSHA256&&h!==i.afterSHA256)fail('target CAS conflict');return h})}
function owned(intent:Intent,check:()=>void){for(const image of intent.owned)if(read(join(intent.directory,image.name),MAX_ARTIFACT,check)!.hash!==image.sha256)fail('owned proof/image drift')}
function shapeIntent(intent:Intent,directory:string){
  if(intent.version!==1||intent.directory!==directory||canonicalDir(intent.root)!==dirname(directory)||!/^mac_[A-Za-z0-9_-]{1,100}$/.test(intent.captureId)||!Array.isArray(intent.images)||intent.images.length!==2||!Array.isArray(intent.owned)||intent.owned.length!==5)fail('intent schema')
  pinShape(intent.sources);const current=intent.sources.find(f=>f.role==='current')!.path,stem=current.replace(/\.g2-chunks\.json$/,'')
  if(stem===current||intent.images[0].path!==`${stem}.speaker-call.json`||intent.images[1].path!==`${stem}.speaker-call-state.json`||intent.lockPath!==join(dirname(current),`.${intent.captureId}.speaker-call.lock`)||intent.captureLockPath!==join(intent.root,`.speaker-call.capture.${intent.captureId}.lock`))fail('target scope')
  const paths=new Set(intent.sources.map(f=>f.path));paths.add(intent.qualification.path)
  for(const[i,image]of intent.images.entries())if(paths.has(image.path)||image.before!==`${i}.before`||image.after!==`${i}.after`||!SHA.test(image.afterSHA256)||image.beforeSHA256!==null&&!SHA.test(image.beforeSHA256))fail('target/image schema')
  const names=['0.before','0.after','1.before','1.after','qualification.json'];if(!same(intent.owned.map(x=>x.name).sort(),names.sort())||intent.owned.some(x=>!SHA.test(x.sha256)))fail('owned schema')
  for(const i of intent.images)if(intent.owned.find(x=>x.name===i.before)?.sha256!==(i.beforeSHA256??sha(''))||intent.owned.find(x=>x.name===i.after)?.sha256!==i.afterSHA256)fail('image/proof binding')
  if(intent.owned.find(x=>x.name==='qualification.json')?.sha256!==intent.qualification.sha256)fail('qualification/proof binding')
  if(!SHA.test(intent.qualification.sha256))fail('qualification schema')
}
/** Prepare immutable before/after images and durable intent. Sources and base
 * bytes are never written. The explicit receipt is verified again on execution. */
export function prepareMacSpeakerCallPublication(input:MacSpeakerCallPublicationInput,options:MacSpeakerCallStoreOptions={}):string {
  const check=budget(),root=canonicalDir(input.transactionRoot)
  if(!/^mac_[A-Za-z0-9_-]{1,100}$/.test(input.captureId)||Buffer.byteLength(input.packetJSON)>MAX_ARTIFACT||Buffer.byteLength(input.stateJSON)>MAX_ARTIFACT)fail('publication bound')
  const directory=join(root,`${input.captureId}-${randomUUID()}`),current=input.sources.find(f=>f.role==='current')
  if(!current)return fail('current source required')
  const lockPath=join(dirname(safePath(current.path)),`.${input.captureId}.speaker-call.lock`),captureLockPath=join(root,`.speaker-call.capture.${input.captureId}.lock`),release=locks(lockPath,captureLockPath,directory,options.resume)
  try{
    pinShape(input.sources)
    const packet=Buffer.from(input.packetJSON),state=Buffer.from(input.stateJSON),qualified=read(input.qualificationReceipt.path,1024*1024,check)!
    if(qualified.hash!==input.qualificationReceipt.expectedSHA256)fail('qualification receipt drift')
    const verified=verifyFiles(input.sources,check);verifyQualified(packet,state,qualified.bytes,input.sources,verified,input.captureId)
    const before=[input.packetPath,input.statePath].map(p=>read(p,MAX_ARTIFACT,check,true,true))
    if((before[0]?.hash??null)!==input.expectedPacketSHA256||(before[1]?.hash??null)!==input.expectedStateFileSHA256)fail('initial target CAS')
    const intent:Intent={version:1,captureId:input.captureId,directory,root,lockPath,captureLockPath,sources:structuredClone(input.sources),qualification:{path:input.qualificationReceipt.path,sha256:qualified.hash},images:[input.packetPath,input.statePath].map((path,i)=>({path,before:`${i}.before`,after:`${i}.after`,beforeSHA256:before[i]?.hash??null,afterSHA256:sha(i?state:packet)})),owned:[]}
    intent.owned=[...intent.images.flatMap((i,n)=>[{name:i.before,sha256:sha(before[n]?.bytes??Buffer.alloc(0))},{name:i.after,sha256:i.afterSHA256}]),{name:'qualification.json',sha256:qualified.hash}]
    shapeIntent(intent,directory);options.beforeWrite?.(-1)
    // Recheck ALL source/proof/target bytes immediately before durable intent.
    verifyFiles(intent.sources,check);if(read(intent.qualification.path,1024*1024,check)!.hash!==qualified.hash)fail('qualification receipt drift');if(targets(intent,check).some((h,i)=>h!==intent.images[i].beforeSHA256))fail('preparation target CAS')
    mkdirSync(directory,{mode:0o700});syncDir(root)
    for(const[i,image]of intent.images.entries()){writeNew(join(directory,image.before),before[i]?.bytes??Buffer.alloc(0));writeNew(join(directory,image.after),i?state:packet)}
    writeNew(join(directory,'qualification.json'),qualified.bytes)
    const finalSources=verifyFiles(intent.sources,check),finalReceipt=read(intent.qualification.path,1024*1024,check)!
    if(finalReceipt.hash!==qualified.hash)fail('qualification receipt drift');if(targets(intent,check).some((h,i)=>h!==intent.images[i].beforeSHA256))fail('preparation target CAS');owned(intent,check);immediateFence(finalSources.stamps);immediateFence(new Map([[intent.qualification.path,finalReceipt.stamp]]))
    const intentBytes=JSON.stringify(intent);writeNew(join(directory,'intent.json'),intentBytes)
    writeNew(join(directory,'transaction.json'),JSON.stringify(sealedJournal({version:1,intentSHA256:sha(intentBytes),phase:'prepared',completed:[]})),0o600)
    return directory
  }finally{release()}
}
/** Recover a torn two-artifact save by exact bytes. Reader admission depends on
 * the self-contained packet; HTTP must never combine this file with mixed state. */
export function executeMacSpeakerCallPublication(directory:string,mode:'apply'|'undo',options:MacSpeakerCallStoreOptions={}):{phase:'applied'|'reverted';directory:string} {
  canonicalDir(directory);const check=budget(),intentFile=join(directory,'intent.json'),journalFile=join(directory,'transaction.json'),intentRead=read(intentFile,4*1024*1024,check)!,intent=json(intentRead.bytes) as Intent
  shapeIntent(intent,directory);let journalRead=read(journalFile,65536,check)!,journal=checkJournal(journalRead.bytes,intentRead.hash)
  const release=locks(intent.lockPath,intent.captureLockPath,directory,options.resume)
  try{
    const assertOwned=()=>{check();if(read(intentFile,4*1024*1024,check)!.hash!==intentRead.hash||read(journalFile,65536,check)!.hash!==journalRead.hash)fail('intent/journal drift');owned(intent,check)}
    const verify=()=>{assertOwned();const verified=verifyFiles(intent.sources,check),q=read(intent.qualification.path,1024*1024,check)!;if(q.hash!==intent.qualification.sha256)fail('qualification receipt drift');verifyQualified(read(join(directory,'0.after'),MAX_ARTIFACT,check)!.bytes,read(join(directory,'1.after'),MAX_ARTIFACT,check)!.bytes,q.bytes,intent.sources,verified,intent.captureId);targets(intent,check);assertOwned();verified.stamps.set(intent.qualification.path,q.stamp);immediateFence(verified.stamps);return verified.stamps}
    const save=(phase:Journal['phase'],completed:number[],sourceStamps?:Map<string,Stamp|null>)=>{
      assertOwned()
      const intended=sealedJournal({version:1,intentSHA256:intentRead.hash,phase,completed}),bytes=Buffer.from(JSON.stringify(intended))
      publish(journalFile,bytes,()=>{assertOwned();if(sourceStamps)immediateFence(sourceStamps)})
      const written=read(journalFile,65536,check)!
      // A post-rename replacement belongs to another writer. Never adopt its
      // bytes as our next CAS baseline or overwrite them in failure recovery.
      if(written.hash!==sha(bytes))fail('journal publication readback drift')
      journal=intended;journalRead=written
    }
    verify()
    const initial=targets(intent,check)
    if(journal.phase==='prepared'&&initial.some((h,i)=>h!==intent.images[i].beforeSHA256)||journal.phase==='applied'&&initial.some((h,i)=>h!==intent.images[i].afterSHA256))fail('journal/target ownership CAS')
    if(['partial','applying','undoing'].includes(journal.phase)&&!options.resume)fail('partial intent requires explicit resume')
    if(mode==='apply'&&journal.phase==='reverted')fail('reverted transaction cannot be reapplied')
    const terminal=mode==='apply'?'applied':'reverted'
    if(journal.phase===terminal){if(targets(intent,check).some((h,i)=>h!==(mode==='apply'?intent.images[i].afterSHA256:intent.images[i].beforeSHA256)))fail('completed target drift');return{phase:terminal,directory}}
    save(mode==='apply'?'applying':'undoing',[])
    try{
      for(const[i,image]of intent.images.entries()){
        options.beforeWrite?.(i);const stamps=verify()
        const desired=mode==='apply'?image.afterSHA256:image.beforeSHA256,currentRead=read(image.path,MAX_ARTIFACT,check,true,true),current=currentRead?.hash??null
        if(current!==desired){const bytes=mode==='apply'?read(join(directory,image.after),MAX_ARTIFACT,check)!.bytes:desired===null?null:read(join(directory,image.before),MAX_ARTIFACT,check)!.bytes;publish(image.path,bytes,()=>{assertOwned();immediateFence(stamps);immediateFence(new Map([[image.path,currentRead?.stamp??null]]))})}
        options.afterWrite?.(i);verify();save(mode==='apply'?'applying':'undoing',[...journal.completed,i])
      }
      const finalStamps=verify();if(targets(intent,check).some((h,i)=>h!==(mode==='apply'?intent.images[i].afterSHA256:intent.images[i].beforeSHA256)))fail('final target drift')
      for(const image of intent.images)finalStamps.set(image.path,read(image.path,MAX_ARTIFACT,check,true,true)?.stamp??null)
      save(terminal,[0,1],finalStamps);return{phase:terminal,directory}
    }catch(e){try{assertOwned();save('partial',journal.completed)}catch{/* preserve externally changed journal/proofs exactly */}throw e}
  }finally{release()}
}
