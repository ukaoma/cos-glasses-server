import{createHash}from'node:crypto'
import express from'express'
import type{Server}from'node:http'
import{pcm16ToWav}from'../lib/nemotron-segments.js'
import{afterEach,describe,it,expect,vi}from'vitest'
import{mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,statSync}from'node:fs'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{macSpeakerLiveFileStamp}from'../lib/mac-speaker-live.js'
import{planMacSpeakerWindows}from'../lib/mac-speaker-windows.js'
import{appendMacSpeakerLiveEvidence,createMacSpeakerLiveState,hashMacSpeakerLive}from'../lib/mac-speaker-live-memory.js'
const id='mac_11111111-1111-4111-8111-111111111111',h=(s:unknown)=>hashMacSpeakerLive(s),v=[1,...Array(191).fill(0)]
const initialListeners={SIGTERM:new Set(process.listeners('SIGTERM')),SIGINT:new Set(process.listeners('SIGINT'))}
const roots:string[]=[];let fault={write:false};let server:Server|undefined
afterEach(async()=>{if(server)await new Promise<void>(r=>server!.close(()=>r()));server=undefined;for(const signal of ['SIGTERM','SIGINT']as const)for(const listener of process.listeners(signal))if(!initialListeners[signal].has(listener))process.removeListener(signal,listener);vi.resetModules();vi.doUnmock('../lib/atomic-fs.js');vi.doUnmock('../lib/mac-speaker-live.js');vi.doUnmock('../lib/speaker-embeddings.js');for(const name of ['server-instance-id','whisper-local','stt-live','nemotron-live'])vi.doUnmock('../lib/'+name+'.js');vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
async function setup(root?:string,failRecovery=false){
 root??=realpathSync(mkdtempSync(join(tmpdir(),'mac-live-route-')));if(!roots.includes(root))roots.push(root)
 vi.stubEnv('COS_DATA_DIR',root);vi.stubEnv('COS_MAC_SPEAKER_LIVE','1');fault={write:failRecovery}
 const schedule=vi.fn()
 vi.doMock('../lib/server-instance-id.js',()=>({getServerInstanceId:()=> 'server-live-test'}))
 vi.doMock('../lib/whisper-local.js',()=>({transcribeLocal:async()=>({text:'We discussed the candidate qualification in detail.',backend:'test'}),applyCorrections:(s:string)=>s}))
 vi.doMock('../lib/stt-live.js',async original=>({...await original<typeof import('../lib/stt-live.js')>(),decideQuiet:()=>({isQuiet:false,rms:400,speechSec:6,gate:'rms'}),asrFrontEnd:async(b:Buffer)=>b}))
 vi.doMock('../lib/nemotron-live.js',async original=>({...await original<typeof import('../lib/nemotron-live.js')>(),nemotronLive:{diarize:vi.fn(async()=>({ok:false,reason:'embedding_requested'})),record:vi.fn(),snapshot:()=>({})}}))
 vi.doMock('../lib/atomic-fs.js',async()=>{const actual=await vi.importActual<typeof import('../lib/atomic-fs.js')>('../lib/atomic-fs.js');return{...actual,durableAtomicWriteFileSync:(...a:Parameters<typeof actual.durableAtomicWriteFileSync>)=>{if(fault.write)throw Error('injected persistence failure');return actual.durableAtomicWriteFileSync(...a)}}})
 vi.doMock('../lib/speaker-embeddings.js',()=>({AUTO_ENROLL_CANDIDATE_SIMILARITY:.72,identifySpeaker:vi.fn(()=>{throw Error('native forbidden')}),extractEmbedding:vi.fn(()=>{throw Error('native forbidden')}),isEmbeddingAvailable:()=>false,autoEnroll:vi.fn(()=>{throw Error('enrollment forbidden')}),speakerModelState:()=>({state:'missing'})}))
 // Exercise the actual route publication/recovery while forbidding queued native
 // work. Adapter scheduling/drain behavior is tested against real I/O separately.
 vi.doMock('../lib/mac-speaker-live.js',async()=>{const actual=await vi.importActual<typeof import('../lib/mac-speaker-live.js')>('../lib/mac-speaker-live.js');return{...actual,createMacSpeakerLiveScheduler:()=>({schedule,drain:async()=>{}})}})
 const stream=await import('./transcribe-stream.js')
 return{root,stream,schedule,path:join(root,'active-sessions',`${id}.json`)}
}
async function attach(stream:typeof import('./transcribe-stream.js'),anonymous=false){
 const s=stream.getSession(id)
 const raws=Array.from({length:10},(_,i)=>({chunkIndex:i,audioSHA256:h(['wav',i]),pcmSHA256:h(['pcm',i]),sampleRate:16000 as const,channels:1 as const,format:'pcm_s16le' as const,sampleCount:96000,verified:true as const}))
 s.chunks=raws.map(r=>({speaker:'Voice 1',text:`Exact original ${r.chunkIndex}`,elapsed:r.chunkIndex*6000,audioDurationMs:6000,audioSha256:r.audioSHA256,similarity:0,speakerPolicy:'high-confidence',words:[{word:'Exact',start:0,end:1}],segments:[{speaker:'Voice 1',text:`Exact original ${r.chunkIndex}`,startSec:0,endSec:6,similarity:0}]}))as any
 const indexed=s.chunks.map((c,i)=>({i,c})),plan=planMacSpeakerWindows({sidecar:{sessionId:id,chunkEntries:indexed.map(e=>({chunkIndex:e.i,chunk:e.c}))as any},rawChunks:raws,correctionHistory:'verified-clear'})
 const bytes=Buffer.from(JSON.stringify({profiles:anonymous?[]:[{name:'Avery Example',embeddings:[v]}]})),profileSHA256=createHash('sha256').update(bytes).digest('hex')
 const profiles=anonymous?[]:[{name:'Avery Example',embeddings:[v],profileSHA256}]
 let state=createMacSpeakerLiveState(id,s.speakerGeneration!,h('model'),profileSHA256,s.macSpeakerLive?.voiceHighWater??1)
 for(const window of plan.windows){const receipt={windowId:window.id,windowBindingSHA256:window.bindingSHA256,modelSHA256:h('model'),audioSHA256:h(['aggregate',window.id]),pcmSHA256:h(['aggregate-pcm',window.id]),sampleCount:window.sampleCount,embedding:v,halfEmbeddings:[v,v]as const};state=appendMacSpeakerLiveEvidence(state,{window,receipt,nativeReceiptSHA256:h({window,receipt})},profiles)}
 const pin=join(process.env.COS_DATA_DIR!,'fixture-pin');writeFileSync(pin,'frozen fixture inputs')
 stream.__macSpeakerLiveForTests.persist(id)
 const fileBindings=[{path:pin,exists:true,stamp:macSpeakerLiveFileStamp(statSync(pin,{bigint:true}))}]
 const compute=await import('../lib/mac-speaker-live-compute.js')
 const job=await compute.startMacSpeakerLiveCompute({captureId:id,generation:s.speakerGeneration!,modelSHA256:h('model'),profileSHA256,profileJSONBytes:Uint8Array.from(bytes),state,chunksIndexed:indexed as any,rawChunks:raws,sourceBindingSHA256:h(indexed),fileBindingsSHA256:h(fileBindings),revision:s.speakerRevision??0,previousDigest:s.speakerProjectionSHA256,voiceHighWater:s.macSpeakerLive?.voiceHighWater??1,humanHistory:false})
 const completed=await job.finish()
 const outcome={capability:completed.capability,fileBindings:[{path:pin,exists:true,stamp:macSpeakerLiveFileStamp(statSync(pin,{bigint:true}))}],state,reason:'qualified',latencyMs:7,plannedWindows:2,attemptedWindows:1,pendingWindows:0,completeEligibleSnapshot:true,rejectedChunks:0,sourceBindingSHA256:h(indexed)}
 return{s,indexed,outcome}
}
describe('actual Mac live route atomic publication and recovery',()=>{
 it('freezes a separate opt-in on new Mac captures only',async()=>{
  const{stream}=await setup();const s=stream.getSession(id);expect(s.speakerIdentityPolicy).toBe('mac-native-v1')
  vi.stubEnv('COS_MAC_SPEAKER_LIVE','0');expect(stream.getSession(id).speakerGeneration).toBe(s.speakerGeneration)
  expect(stream.getSession('mac_22222222-2222-4222-8222-222222222222').speakerIdentityPolicy).toBeUndefined();expect(stream.getSession('ordinary-capture').speakerIdentityPolicy).toBeUndefined()
 })
 it('queues matching only after a real Mac upload is durably canonical and skips legacy identification',async()=>{
  const{stream,path,schedule}=await setup(),app=express();app.use(express.json());app.use('/api',stream.transcribeStreamRouter)
  server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const base=`http://127.0.0.1:${(server.address()as any).port}/api`
  const headers={'X-COS-Server-Instance':'server-live-test','Content-Type':'application/json'}
  expect((await fetch(base+'/mac-recording/start',{method:'POST',headers,body:JSON.stringify({captureId:id,startTime:Date.now(),sourceType:'mac_system_audio'})})).status).toBe(200)
  schedule.mockImplementation(()=>{expect(JSON.parse(readFileSync(path,'utf8')).chunksIndexed[0].c.canonical).toBe(true)})
  const wav=pcm16ToWav(Buffer.alloc(192000,4),16000)
  const response=await fetch(base+`/mac-recording/${id}/chunks?chunkIndex=0&elapsed=6000`,{method:'POST',headers:{'X-COS-Server-Instance':'server-live-test','Content-Type':'audio/wav'},body:new Uint8Array(wav)})
  expect(response.status).toBe(200);expect((await response.json()as any).canonical).toBe(true);expect(schedule).toHaveBeenCalledWith(id)
  const speaker=await import('../lib/speaker-embeddings.js');expect(speaker.identifySpeaker).not.toHaveBeenCalled();expect(speaker.extractEmbedding).not.toHaveBeenCalled();expect(speaker.autoEnroll).not.toHaveBeenCalled()
 })
 it('refuses an orphaned admitted capture instead of resetting its generation',async()=>{
  const{stream}=await setup();const registry=await import('../lib/mac-recording.js')
  registry.registerMacRecording({captureId:id,startTime:Date.now(),sourceType:'mac_system_audio'})
  expect(()=>stream.getSession(id)).toThrow('Capture state is unavailable')
  vi.stubEnv('COS_MAC_SPEAKER_LIVE','0');expect(()=>stream.getSession(id)).toThrow('Capture state is unavailable')
 })
 it('persists a full replacement with matching revisions before publishing claims',async()=>{
  const{stream,path}=await setup(),{s,indexed,outcome}=await attach(stream),before=JSON.stringify(s.chunks)
  stream.__macSpeakerLiveForTests.persist(id);expect(stream.__macSpeakerLiveForTests.commit(id,outcome)).toBe(true)
  const disk=JSON.parse(readFileSync(path,'utf8'))
  expect(disk.chunksIndexed).toEqual(indexed);expect(JSON.stringify(s.chunks)).toBe(before)
  expect(disk.speakerProjectedChunksIndexed.every((e:any)=>e.c.speaker==='Avery Example')).toBe(true)
  expect(disk.speakerProjectedChunksIndexed.every((e:any)=>e.c.similarity===0)).toBe(true)
  expect(disk.speakerRevision).toBe(disk.macSpeakerLive.revision);expect(stream.getMacSpeakerLiveSaveSnapshot(id)?.state.projections).toHaveLength(10)
 })
 it('does not publish a certified positive if the feature closes before commit',async()=>{
  const{stream,path}=await setup(),{outcome}=await attach(stream)
  vi.stubEnv('COS_MAC_SPEAKER_LIVE','0');expect(stream.__macSpeakerLiveForTests.commit(id,outcome)).toBe(true)
  const disk=JSON.parse(readFileSync(path,'utf8'));expect(disk.macSpeakerLive).toBeUndefined();expect(disk.speakerProjectedChunksIndexed).toEqual(disk.chunksIndexed);expect(disk.macSpeakerLiveStatus.completeEligibleSnapshot).toBe(false)
 })
 it('rejects stale source snapshots and rolls state back on failed publication',async()=>{
  const{stream,path}=await setup(),{s,outcome}=await attach(stream)
  stream.__macSpeakerLiveForTests.persist(id);const before=readFileSync(path,'utf8'),revision=s.speakerRevision
  s.chunks[0].text+=' edited';expect(stream.__macSpeakerLiveForTests.commit(id,outcome)).toBe(false);s.chunks[0].text=s.chunks[0].text.replace(' edited','')
  fault.write=true;expect(stream.__macSpeakerLiveForTests.commit(id,outcome)).toBe(false);fault.write=false
  expect(s.macSpeakerLive).toBeUndefined();expect(s.speakerRevision).toBe(revision);expect(readFileSync(path,'utf8')).toBe(before)
 })
 it('withdraws claims when a later source becomes human protected',async()=>{
  const{stream,path}=await setup(),{s,outcome}=await attach(stream);stream.__macSpeakerLiveForTests.commit(id,outcome)
  const prior=s.speakerRevision!;(s.chunks[0].segments![0]as any).manuallyCorrected=true
  stream.__macSpeakerLiveForTests.persist(id)
  const disk=JSON.parse(readFileSync(path,'utf8'));expect(disk.speakerRevision).toBeGreaterThan(prior);expect(disk.macSpeakerLive).toBeUndefined();expect(disk.speakerProjectedChunksIndexed[0].c.segments[0].manuallyCorrected).toBe(true)
 })
 it('clears the public overlay and refuses background extraction when the opt-in is disabled',async()=>{
  const{stream,path}=await setup(),{outcome}=await attach(stream);stream.__macSpeakerLiveForTests.commit(id,outcome)
  const prior=JSON.parse(readFileSync(path,'utf8')).speakerRevision
  vi.stubEnv('COS_MAC_SPEAKER_LIVE','0');expect(stream.__macSpeakerLiveForTests.snapshot(id)).toBeNull()
  stream.__macSpeakerLiveForTests.persist(id);const disk=JSON.parse(readFileSync(path,'utf8'))
  expect(disk.speakerRevision).toBeGreaterThan(prior);expect(disk.macSpeakerLive).toBeUndefined();expect(disk.speakerProjectedChunksIndexed).toEqual(disk.chunksIndexed);expect(stream.getMacSpeakerLiveSaveSnapshot(id)).toBeNull()
 })
 it('withdraws a conflicting projection instead of leaving the previous cached labels',async()=>{
  const{stream,path}=await setup(),{s,outcome}=await attach(stream,true)
  stream.__macSpeakerLiveForTests.commit(id,outcome)
  const label=s.macSpeakerLive!.projections[0].displayLabel
  const prior=s.speakerRevision!;s.chunks.push({speaker:label,text:'Unrelated original',elapsed:60000,similarity:0,audioDurationMs:6000,audioSha256:h('later')})
  stream.__macSpeakerLiveForTests.persist(id);const disk=JSON.parse(readFileSync(path,'utf8'))
  expect(disk.speakerRevision).toBeGreaterThan(prior);expect(disk.macSpeakerLive).toBeUndefined();expect(disk.speakerProjectedChunksIndexed).toEqual(disk.chunksIndexed)
 })
 it('invalidates old completeness on newly accepted source and late resource edits',async()=>{
  const{stream,path}=await setup(),{s,outcome}=await attach(stream);stream.__macSpeakerLiveForTests.commit(id,outcome)
  writeFileSync(outcome.fileBindings[0].path,'resource changed');expect(stream.getMacSpeakerLiveSaveSnapshot(id)).toBeNull()
  stream.__macSpeakerLiveForTests.persist(id);expect(JSON.parse(readFileSync(path,'utf8')).macSpeakerLive).toBeUndefined()
  const fresh=await attach(stream);stream.__macSpeakerLiveForTests.commit(id,fresh.outcome)
  fresh.s.chunks.push({speaker:'Ext',text:'New accepted words',elapsed:60000,audioDurationMs:6000,similarity:0,audioSha256:h('new')})
  expect(stream.getMacSpeakerLiveSaveSnapshot(id)).toBeNull();stream.__macSpeakerLiveForTests.persist(id)
  const disk=JSON.parse(readFileSync(path,'utf8'));expect(disk.macSpeakerLive).toBeUndefined();expect(disk.speakerProjectedChunksIndexed).toEqual(disk.chunksIndexed);expect(disk.macSpeakerLiveStatus.reason).toBe('new_source_pending')
 })
 it('refuses recovery adoption when its mandatory clear cannot be persisted',async()=>{
  const first=await setup(),{outcome}=await attach(first.stream);first.stream.__macSpeakerLiveForTests.commit(id,outcome);vi.resetModules()
  const second=await setup(first.root,true);fault.write=false
  expect(second.stream.__sessionsForTests.has(id)).toBe(false)
  expect(()=>readFileSync(second.path)).toThrow()
 })
 it('recovers a valid original-only replacement before revalidation, including corrupt prior state',async()=>{
  const first=await setup(),{outcome}=await attach(first.stream);first.stream.__macSpeakerLiveForTests.commit(id,outcome)
  const disk=JSON.parse(readFileSync(first.path,'utf8'));disk.macSpeakerLive.projections[0].rawChunkIndex=999
  writeFileSync(first.path,JSON.stringify(disk));vi.resetModules()
  const second=await setup(first.root),restored=JSON.parse(readFileSync(second.path,'utf8'))
  expect(restored.speakerRevision).toBeGreaterThan(disk.speakerRevision);expect(restored.macSpeakerLive).toBeUndefined();expect(restored.macSpeakerLiveRetainedState.projections[0].rawChunkIndex).toBe(999)
  expect(restored.speakerProjectedChunksIndexed).toEqual(restored.chunksIndexed);expect(restored.macSpeakerLiveStatus.completeEligibleSnapshot).toBe(false)
  expect(second.stream.getMacSpeakerLiveSaveSnapshot(id)).toBeNull()
 })
})
