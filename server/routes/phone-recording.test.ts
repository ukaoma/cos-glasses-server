import express from 'express'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { wavOf } from '../lib/__fixtures__/nemotron-helpers.js'
import type { Server } from 'node:http'
let root:string, server:Server, base:string, installed=true
let stream:typeof import('./transcribe-stream.js')
let parakeet:ReturnType<typeof vi.fn>; let whisper:ReturnType<typeof vi.fn>; let diarize:ReturnType<typeof vi.fn>;
const enroll=vi.fn(); const identify=vi.fn(()=>({speaker:'MU',similarity:0.64,embedding:new Float32Array(192).fill(0.1)})); const background:Promise<void>[]=[]
const signalListeners = new Map<NodeJS.Signals, Set<(...args:any[])=>void>>()
const id='phone_abcdef01-2345-6789-abcd-0123456789ab'
beforeEach(async()=>{
 for(const signal of ['SIGTERM','SIGINT'] as const)signalListeners.set(signal,new Set(process.listeners(signal)))
 root=mkdtempSync(join(tmpdir(),'cos-phone-route-')); process.env.COS_DATA_DIR=root; process.env.COS_IPHONE_MICROPHONE_MEETINGS='1'; vi.resetModules(); installed=true; enroll.mockClear(); identify.mockClear()
 vi.doMock('../lib/server-instance-id.js',()=>({getServerInstanceId:()=> 'server-mac'}))
 vi.doMock('../lib/parakeet.js',async original=>({...await original<typeof import('../lib/parakeet.js')>(),parakeetInstalled:()=>({installed,bytes:1}),transcribeParakeet:parakeet=vi.fn(async()=>({model:'parakeet-ultra',text:'We reviewed sproket roket and agreed on the launch plan.',words:[{word:'We',start:0,end:0.4}],processingSec:0.1,wallMs:120}))}))
 vi.doMock('../lib/whisper-local.js',async original=>({...await original<typeof import('../lib/whisper-local.js')>(),transcribeLocal:whisper=vi.fn(async()=>({text:'We reviewed the launch plan and agreed on a decision.',backend:'server'})),transcribeHighQuality:vi.fn(async()=>{throw Error('Whisper HQ forbidden in phone test')})}))
 vi.doMock('../lib/speaker-embeddings.js',async original=>({...await original<typeof import('../lib/speaker-embeddings.js')>(),AUTO_ENROLL_CANDIDATE_SIMILARITY:0.72,AUTO_ENROLL_THRESHOLD:0.88,identifySpeaker:identify,extractEmbedding:vi.fn((wav:Buffer)=>new Float32Array(wav.readInt16LE(44)>=0?[1,0]:[0,1])),isEmbeddingAvailable:()=>true,autoEnroll:enroll,getEmbeddingCount:()=>3}))
 vi.doMock('../lib/profile.js',()=>({loadProfileObject:()=>({}),getDomainKeywords:()=>({}),getVocabulary:()=>[],getOwnerName:()=> 'COS',getOwnerSpeakerLabel:()=> 'MU',getWhisperCorrections:()=>({'sproket roket':'Sprocket Rocket'})}))
 vi.doMock('../lib/vad-silero.js',()=>({isSileroAvailable:()=>false,measureSpeechSeconds:()=>null,trimSilence:vi.fn()}))
 vi.doMock('../lib/stt-live.js',async original=>({...await original<typeof import('../lib/stt-live.js')>(),decideQuiet:()=>({isQuiet:false,rms:400,speechSec:3,gate:'rms'}),asrFrontEnd:async(b:Buffer)=>b}))
 vi.doMock('../lib/nemotron-live.js',async original=>({...await original<typeof import('../lib/nemotron-live.js')>(),nemotronLive:{diarize:diarize=vi.fn(async()=>({ok:false,reason:'embedding_requested'})),record:vi.fn(),snapshot:()=>({})}}))
 vi.doMock('../lib/meeting-summary-persistence.js',()=>({enrichStandaloneMeeting:vi.fn(async()=>{})}))
 const {writeSttSettings,readSttSettings}=await import('../lib/stt-settings.js');writeSttSettings({...readSttSettings(),hq:'parakeet-ultra'});await mount()
})
async function mount(){
 stream=await import('./transcribe-stream.js'); const app=express(); app.use(express.json()); app.use('/api',stream.transcribeStreamRouter)
 const {createMeetingRouter}=await import('./meeting.js'); app.use('/api',createMeetingRouter({runBatch:async()=>({transcriptionQuality:'streaming'}),finalDiarize:vi.fn(async()=>({applied:false,reason:'test'} as any)),scheduleBackground:task=>{background.push(task)},emit:vi.fn()}))
 server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))}); const address=server.address() as {port:number}; base='http://127.0.0.1:'+address.port+'/api'
}
afterEach(async()=>{
 await Promise.allSettled(background.splice(0)); await new Promise<void>(resolve=>server?.listening ? server.close(()=>resolve()) : resolve()); vi.resetModules()
 for(const mod of ['parakeet','server-instance-id','whisper-local','speaker-embeddings','profile','vad-silero','stt-live','nemotron-live','meeting-summary-persistence']) vi.doUnmock('../lib/'+mod+'.js')
 for(const [signal,prior] of signalListeners)for(const listener of process.listeners(signal))if(!prior.has(listener))process.removeListener(signal,listener)
 delete process.env.COS_DATA_DIR; delete process.env.COS_IPHONE_MICROPHONE_MEETINGS; rmSync(root,{recursive:true,force:true})
})
async function call(path:string,body?:unknown,pin='server-mac'){
 const headers:Record<string,string>={};if(pin)headers['X-COS-Server-Instance']=pin
 if(body!==undefined) headers['Content-Type']=Buffer.isBuffer(body)?'audio/wav':'application/json'
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:Buffer.isBuffer(body)?new Uint8Array(body).buffer:JSON.stringify(body)})
 return {status:response.status,json:response.status===204?null:await response.json() as any}
}

const source={sourceType:'iphone_microphone',speakerPolicy:'anonymous'}
function upload(over:Record<string,string>={},audio=wavOf(6,()=>400),pin='server-mac'){
 const query=new URLSearchParams({sessionId:id,chunkIndex:'0',elapsed:'0',startTime:'1700000000000',speaker:'Ext',...source,...over})
 return call('/transcribe-stream?'+query,audio,pin)
}
it('advertises default-off and unavailable reasons without starting or changing an engine',async()=>{
 const {phoneMicrophoneMeetingsCapability:cap}=await import('../lib/phone-recording.js')
 delete process.env.COS_IPHONE_MICROPHONE_MEETINGS
 expect(cap('server-mac')).toMatchObject({...source,enabled:false,reason:'disabled',asrModel:'parakeet-ultra',dictionary:'server-profile-corrections'})
 expect((await upload()).json.reason).toBe('phone_microphone_disabled')
 expect(existsSync(join(root,'phone-recordings',id+'.json'))).toBe(false)
 process.env.COS_IPHONE_MICROPHONE_MEETINGS='1'
 installed=false;expect(cap('server-mac')).toMatchObject({enabled:false,reason:'parakeet_not_installed'});installed=true
 expect(cap(null)).toMatchObject({enabled:false,reason:'server_identity_unavailable'})
 const {writeSttSettings,readSttSettings}=await import('../lib/stt-settings.js'); const before=readSttSettings()
 writeSttSettings({...before,hq:'large-v3'})
 expect(cap('server-mac')).toMatchObject({enabled:false,reason:'parakeet_not_selected'})
 expect((await upload()).json.reason).toBe('phone_microphone_parakeet_not_selected')
 expect(readSttSettings().hq).toBe('large-v3'); expect(parakeet).not.toHaveBeenCalled();expect(whisper).not.toHaveBeenCalled()
})
it('rejects missing, conflicting and forged provenance before persistence or identity work',async()=>{
 for(const over of ([{sourceType:''},{sourceType:'mac_system_audio'},{speakerPolicy:''},{speakerPolicy:'standard'},{sessionId:'meeting_fake'},{sessionId:'phone_bad'},{speaker:'MU'},{eh:'MU'}] as Record<string,string>[]))expect((await upload(over)).status).toBe(400)
 expect((await upload({},undefined,'')).json.reason).toBe('server_identity_pin_required')
 expect((await upload({},undefined,'wrong')).json.reason).toBe('server_instance_mismatch')
 expect(existsSync(join(root,'phone-recordings',id+'.json'))).toBe(false);expect(stream.getSessionStartTime(id)).toBeNull()
 expect(identify).not.toHaveBeenCalled();expect(enroll).not.toHaveBeenCalled();expect(diarize).not.toHaveBeenCalled()
})
it('uses shared Parakeet and dictionary, persists source, never calls wearer/voiceprint/training, and retries exact chunks',async()=>{
 const {writeSttSettings,readSttSettings}=await import('../lib/stt-settings.js');writeSttSettings({...readSttSettings(),hq:'parakeet-ultra'})
 const done=await upload();expect(done.status).toBe(200);expect(done.json).toMatchObject({...source,sessionId:id,speaker:'Ext',canonical:true,asrProvider:'server-parakeet',model:'parakeet-ultra',text:'We reviewed Sprocket Rocket and agreed on the launch plan.'})
 expect(parakeet).toHaveBeenCalledWith(expect.any(Buffer),expect.objectContaining({model:'parakeet-ultra',lane:'interactive'}));expect(whisper).not.toHaveBeenCalled();expect(identify).not.toHaveBeenCalled();expect(enroll).not.toHaveBeenCalled();expect(diarize).not.toHaveBeenCalled()
 expect(stream.getSessionChunks(id)?.[0]).toMatchObject({...source,speaker:'Ext',elapsed:0,audioDurationMs:6000})
 const journal=JSON.parse(readFileSync(join(root,'active-sessions',id+'.json'),'utf8'));expect(journal).toMatchObject({...source,captureSource:{captureId:id,...source}})
 expect(existsSync(join(root,'session-audio',id,'_capture.json'))).toBe(true)
 expect((await upload()).status).toBe(200);expect(parakeet).toHaveBeenCalledTimes(1)
 expect((await upload({},wavOf(6,()=>401))).json.reason).toBe('phone_chunk_conflict')
 expect((await upload({elapsed:'1'})).json.reason).toBe('phone_chunk_conflict')
 for(const dir of ['chunk-embeddings','ext-audio'])expect(existsSync(join(root,dir,dir==='chunk-embeddings'?id+'.jsonl':id))).toBe(false)
})
it('retains audio on Parakeet failure, refuses conflicting retries, and never substitutes Whisper',async()=>{
 const {writeSttSettings,readSttSettings}=await import('../lib/stt-settings.js');writeSttSettings({...readSttSettings(),hq:'parakeet-ultra'})
 parakeet.mockRejectedValueOnce(new Error('fake unavailable'))
 const failed=await upload();expect(failed.status).toBe(503);expect(failed.json).toMatchObject({reason:'phone_parakeet_cli_failed',retryable:true})
 expect(stream.getMeetingSessionStatus(id)).toMatchObject({receivedCount:1,asrCompletedCount:0});expect(whisper).not.toHaveBeenCalled()
 expect((await upload({},wavOf(6,()=>401))).json.reason).toBe('phone_chunk_conflict')
 expect((await upload()).status).toBe(200);expect(parakeet).toHaveBeenCalledTimes(2)
})
it('saves once with source receipt, archive metadata and truthful export, and keeps shared Ask/files identity',async()=>{
 const {writeSttSettings,readSttSettings}=await import('../lib/stt-settings.js');writeSttSettings({...readSttSettings(),hq:'parakeet-ultra'});await upload()
 expect((await call('/meeting/save',{sessionId:id})).json.reason).toBe('phone_provenance_required')
 const saved=await call('/meeting/save',{sessionId:id,...source,finalChunkIndex:0});expect(saved.status).toBe(200);expect(saved.json).toMatchObject({...source,captureId:id,saved:true,receiptVersion:1})
 const retry=await call('/meeting/save',{sessionId:id,...source,finalChunkIndex:0});expect(retry.json).toMatchObject({...source,saved:true,replayed:true,filename:saved.json.filename})
 const {getMeetingStore}=await import('../lib/meeting-store.js');const actual=getMeetingStore().findBySessionId(id)!;const sidecar=JSON.parse(readFileSync(actual.sidecarPath,'utf8'));expect(sidecar).toMatchObject({...source,sessionId:id,captureSource:{captureId:id,...source}});expect(sidecar.speakers).toEqual([])
 const markdown=readFileSync(actual.filepath,'utf8');expect(markdown).toContain('| **Source** | iPhone Microphone |');expect(markdown).toContain('| **Capture source** | iphone_microphone |');expect(markdown).not.toContain('G2 Glasses')
 expect(JSON.parse(readFileSync(join(root,'meeting-audio',id,'_capture.json'),'utf8'))).toMatchObject({...source,captureId:id})
 const {ASK_SESSION}=await import('../lib/ask-session-id.js');expect(ASK_SESSION.test(id)).toBe(true)
 const {meetingContextKeys}=await import('../lib/meeting-context-keys.js');expect(meetingContextKeys({g2SessionId:id,sourceType:source.sourceType})).toEqual(['phone:'+id])
 expect((await call('/meeting/'+id+'/speaker-policy',{mode:'standard',expectedPolicyRevision:'unset'})).json.reason).toBe('phone_anonymous_capture')
 expect((await call('/meeting/'+id+'/backfill-enrolment',{speaker:'MU'})).json.reason).toBe('phone_anonymous_capture')
})
it('disables cosmetic preview and alternate/offline candidates for phone without decoding',async()=>{
 expect((await call('/transcribe-stream/preview?sessionId='+id+'&'+new URLSearchParams(source),wavOf(6,()=>400))).status).toBe(204)
 expect((await call('/transcribe-stream/offline-sessions/start',{sessionId:id,...source})).json.reason).toBe('phone_indexed_transport_required')
 expect((await call('/transcribe-stream/candidates',{sessionId:id,...source})).json.reason).toBe('phone_indexed_transport_required')
 expect(parakeet).not.toHaveBeenCalled();expect(whisper).not.toHaveBeenCalled()
})
it('preserves unmarked legacy G2 ingestion and rejects unprovenanced old phone captures',async()=>{
 const legacy=await call('/transcribe-stream?sessionId=meeting_legacy&chunkIndex=0&speaker=MU',wavOf(6,()=>400));expect(legacy.status).toBe(200);expect(whisper).toHaveBeenCalled()
 const {mkdirSync,writeFileSync}=await import('node:fs');mkdirSync(join(root,'session-audio',id),{recursive:true});writeFileSync(join(root,'session-audio',id,'chunk_0000.wav'),wavOf(6,()=>400))
 const {writeSttSettings,readSttSettings}=await import('../lib/stt-settings.js');writeSttSettings({...readSttSettings(),hq:'parakeet-ultra'})
 expect((await upload()).json.reason).toBe('phone_capture_provenance_missing')
 expect((await call('/meeting/orphans/'+id+'/recover',{})).json.reason).toBe('phone_capture_provenance_missing')
 expect(existsSync(join(root,'session-audio',id,'chunk_0000.wav'))).toBe(true)
})

it('restores admitted provenance across a real module restart and deduplicates replay before the next chunk',async()=>{
 expect((await upload()).status).toBe(200)
 await new Promise<void>(resolve=>server.close(()=>resolve()));vi.resetModules();parakeet.mockClear();await mount()
 expect(stream.getSessionChunks(id)?.[0]).toMatchObject({...source,speaker:'Ext'})
 expect((await upload()).status).toBe(200);expect(parakeet).not.toHaveBeenCalled()
 expect((await upload({chunkIndex:'1',elapsed:'6000'})).status).toBe(200);expect(parakeet).toHaveBeenCalledTimes(1)
 expect((await call('/meeting/sessions/'+id+'/status')).json).toMatchObject({...source,state:'active',asrCompletedCount:2})
 expect((await call('/meeting/sessions/'+id+'/stop',{finalChunkIndex:1,serverInstanceId:'server-mac'})).json.reason).toBe('phone_provenance_required')
})
it('retains corrupt or missing phone provenance after restart instead of adopting it as G2',async()=>{
 const {mkdirSync,writeFileSync}=await import('node:fs');mkdirSync(join(root,'session-audio',id),{recursive:true});writeFileSync(join(root,'session-audio',id,'chunk_0000.wav'),wavOf(6,()=>400))
 writeFileSync(join(root,'active-sessions',id+'.json'),JSON.stringify({sessionId:id,startTime:Date.now(),lastActivityAt:Date.now(),chunks:[{text:'Old capture words',speaker:'MU',elapsed:0,similarity:1}]}))
 await new Promise<void>(resolve=>server.close(()=>resolve()));vi.resetModules();await mount()
 expect(stream.getSessionChunks(id)).toBeNull();expect((await call('/meeting/sessions/'+id+'/status')).json.reason).toBe('phone_capture_provenance_missing')
 expect((await call('/meeting/save',{sessionId:id,...source})).json.reason).toBe('phone_capture_provenance_missing')
 expect(parakeet).not.toHaveBeenCalled();expect(identify).not.toHaveBeenCalled();expect(enroll).not.toHaveBeenCalled()
 expect(readdirSync(join(root,'unsaved-audio')).length).toBeGreaterThan(0)
})

it('admits the timestamped UUID contract and refuses an ID whose embedded origin differs',async()=>{
 const timestamped='phone_1700000000000_abcdef01-2345-6789-abcd-0123456789ab'
 expect((await upload({sessionId:timestamped})).status).toBe(200)
 const {ASK_SESSION}=await import('../lib/ask-session-id.js');expect(ASK_SESSION.test(timestamped)).toBe(true);expect(ASK_SESSION.test('phone_1700000000000_anything')).toBe(false)
 expect((await upload({sessionId:'phone_1700000000001_abcdef01-2345-6789-abcd-0123456789ab'})).json.reason).toBe('phone_capture_conflict')
})
it('keeps phone HQ strictly Parakeet with no second opinion or resolver after global choices change',async()=>{
 await upload();const {writeSttSettings,readSttSettings}=await import('../lib/stt-settings.js');writeSttSettings({...readSttSettings(),hq:'large-v3'})
 const {currentHqJobPlan}=await import('../lib/meeting-batch-transcribe.js');expect(currentHqJobPlan(id)).toMatchObject({engine:'parakeet-ultra',strictPrimary:true,secondOpinion:'off',resolver:false})
 const {assertVoiceEvidenceSource}=await import('../lib/voice-evidence-guard.js');expect(assertVoiceEvidenceSource([id])?.body.reason).toBe('phone_anonymous_capture')
})

it('lets a pristine offline phone reconcile missing before its first upload, but never admits that ID by status',async()=>{
 const status=await call('/meeting/sessions/'+id+'/status?'+new URLSearchParams(source))
 expect(status.status).toBe(200);expect(status.json).toMatchObject({...source,state:'missing',provenanceState:'not_admitted'})
 expect(existsSync(join(root,'phone-recordings',id+'.json'))).toBe(false)
 expect((await upload()).status).toBe(200)
})
it('refuses a saved receipt with lost source metadata rather than duplicating or mislabelling the recording',async()=>{
 await upload();await call('/meeting/save',{sessionId:id,...source,finalChunkIndex:0})
 const {getMeetingStore}=await import('../lib/meeting-store.js');const saved=getMeetingStore().findBySessionId(id)!;const data=JSON.parse(readFileSync(saved.sidecarPath,'utf8'));delete data.sourceType
 const {writeFileSync}=await import('node:fs');writeFileSync(saved.sidecarPath,JSON.stringify(data))
 expect((await call('/meeting/save',{sessionId:id,...source})).json.reason).toBe('phone_saved_metadata_unreadable')
})

it('lets the stranded sweep save through the same pinned anonymous phone contract',async()=>{
 await upload();const {promoteStrandedSession}=await import('../lib/stranded-session-actions.js');const fetchImpl=vi.fn(async(url:unknown,init?:RequestInit)=>{
   expect(JSON.parse(init?.body as string)).toMatchObject({...source,sessionId:id})
   expect(init?.headers).toMatchObject({'X-COS-Server-Instance':'server-mac','X-COS-Recording-Origin':'stranded-sweep'})
   return new Response(JSON.stringify({filename:'phone-saved.md'}),{status:200})
 })
 expect(await promoteStrandedSession(id,{port:1,token:'test',fetchImpl})).toMatchObject({ok:true,filename:'phone-saved.md'})
})

it('recovers quarantined phone audio through shared strict HQ, dictionary and anonymous saved meeting',async()=>{
 await upload();stream.deleteSession(id,{preserveAudio:true})
 const {quarantineSessionAudio,listUnsavedCaptures}=await import('../lib/unsaved-audio-quarantine.js');const quarantined=quarantineSessionAudio(join(root,'session-audio',id),'test_phone_recovery')!;expect(quarantined).toBeTruthy()
 expect(listUnsavedCaptures().find(c=>c.sessionId===id)).toMatchObject({sourceType:'iphone_microphone',provenanceState:'admitted'})
 const recovery=await call('/meeting/orphans/'+id+'/recover',{});expect(recovery.status).toBe(202);await Promise.allSettled(background.splice(0))
 const {getMeetingStore}=await import('../lib/meeting-store.js');const saved=getMeetingStore().findBySessionId(id)!;expect(saved).toMatchObject({sourceType:'iphone_microphone',captureId:id})
 const sidecar=JSON.parse(readFileSync(saved.sidecarPath,'utf8'));expect(sidecar).toMatchObject({...source,captureSource:{...source,captureId:id}});expect(sidecar.chunks.every((c:any)=>c.speaker==='Ext'&&c.speakerPolicy==='anonymous')).toBe(true)
 expect(readFileSync(saved.filepath,'utf8')).toContain('Sprocket Rocket');expect(parakeet).toHaveBeenLastCalledWith(expect.any(Buffer),expect.objectContaining({lane:'batch',model:'parakeet-ultra'}));expect(whisper).not.toHaveBeenCalled();expect(identify).not.toHaveBeenCalled();expect(enroll).not.toHaveBeenCalled()
 expect(existsSync(join(quarantined,'_batch_pending.marker'))).toBe(false);expect(existsSync(join(quarantined,'_capture.json'))).toBe(true)
})

it('returns an anonymous durable empty completion and preserves its strict policy on HQ entries',async()=>{
 parakeet.mockResolvedValueOnce({model:'parakeet-ultra',text:'',words:[],processingSec:0.1,wallMs:120})
 const done=await upload();expect(done.status).toBe(200);expect(done.json).toMatchObject({...source,speaker:'Ext',canonical:false,asrCompleted:true})
 expect(stream.getSessionChunkEntries(id)?.[0].chunk).toMatchObject({...source,speaker:'Ext',text:''})
 expect((await upload()).status).toBe(200);expect(parakeet).toHaveBeenCalledTimes(1);expect(identify).not.toHaveBeenCalled()
})
it('serializes phone uploads while ASR is pending and accepts a clean retry after receipt',async()=>{
 let release!:(value:unknown)=>void
 parakeet.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
 const first=upload();await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
 expect((await upload()).json.reason).toBe('phone_chunk_in_progress')
 release({model:'parakeet-ultra',text:'The product launch remains on schedule.',words:[],processingSec:0.1,wallMs:120})
 expect((await first).status).toBe(200);expect((await upload()).status).toBe(200);expect(parakeet).toHaveBeenCalledTimes(1)
})
it('refuses corrupt registry and unsupported audio/index before another model call, retaining accepted bytes',async()=>{
 expect((await upload({chunkIndex:'0junk'})).json.reason).toBe('invalid_chunk_index')
 const stereo=wavOf(6,()=>400);stereo.writeUInt16LE(2,22)
 expect((await upload({},stereo)).json.reason).toBe('invalid_phone_audio')
 expect(existsSync(join(root,'phone-recordings',id+'.json'))).toBe(false)
 await upload();const {writeFileSync}=await import('node:fs');writeFileSync(join(root,'phone-recordings',id+'.json'),'{broken')
 expect((await upload({chunkIndex:'1',elapsed:'6000'})).json.reason).toBe('phone_capture_metadata_unreadable')
 expect(existsSync(join(root,'session-audio',id,'chunk_0000.wav'))).toBe(true);expect(existsSync(join(root,'session-audio',id,'chunk_0001.wav'))).toBe(false);expect(parakeet).toHaveBeenCalledTimes(1)
})
it('refuses new audio after a durable save even if a crash left its registry apparently open',async()=>{
 await upload();const {getMeetingStore}=await import('../lib/meeting-store.js')
 getMeetingStore().save({sessionId:id,transcript:stream.getSessionTranscript(id)!,startTime:1700000000000,durationMs:6000,chunks:stream.getSessionChunks(id)!,chunkEntries:stream.getSessionChunkEntries(id)!})
 const path=join(root,'phone-recordings',id+'.json');const metadata=JSON.parse(readFileSync(path,'utf8'));delete metadata.closedAt;const {writeFileSync}=await import('node:fs');writeFileSync(path,JSON.stringify(metadata))
 expect((await upload({chunkIndex:'1',elapsed:'6000'})).json.reason).toBe('session_closed');expect(parakeet).toHaveBeenCalledTimes(1)
})

it('keeps phone library/context identity distinct from Mac and rejects cross-source key aliases',async()=>{
 const {meetingContextKeys,MEETING_CONTEXT_KEY}=await import('../lib/meeting-context-keys.js')
 expect(meetingContextKeys({g2SessionId:id})).toEqual([])
 expect(meetingContextKeys({g2SessionId:'meeting_legacy',sourceType:source.sourceType})).toEqual([])
 expect(MEETING_CONTEXT_KEY.test('g2:'+id)).toBe(false);expect(MEETING_CONTEXT_KEY.test('phone:meeting_legacy')).toBe(false);expect(MEETING_CONTEXT_KEY.test('phone:'+id)).toBe(true)
 const {isMacCaptureId,withMacStoreRows}=await import('./meetings.js');expect(isMacCaptureId(id)).toBe(false)
 const row={sessionId:id,filename:'2026-10-26_iPhone.md',date:'2026-10-26',sourceType:'iphone_microphone'} as any
 expect(withMacStoreRows([], [row], 10)).toMatchObject([{sessionId:id,sourceType:'iphone_microphone',librarySource:'standalone_recordings'}])
 expect(withMacStoreRows([], [{...row,sourceType:undefined}],10)).toEqual([])
})
