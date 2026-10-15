import express from 'express'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { wavOf } from '../lib/__fixtures__/nemotron-helpers.js'
import type { Server } from 'node:http'
let root:string, server:Server, base:string
let stream:typeof import('./transcribe-stream.js')
const enroll=vi.fn(); const identify=vi.fn(()=>({speaker:'MU',similarity:0.64,embedding:new Float32Array(192).fill(0.1)})); const background:Promise<void>[]=[]
const id='mac_abcdef01-2345-6789-abcd-0123456789ab'
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'cos-mac-route-')); process.env.COS_DATA_DIR=root; vi.resetModules(); enroll.mockClear(); identify.mockClear()
 vi.doMock('../lib/server-instance-id.js',()=>({getServerInstanceId:()=> 'server-mac'}))
 vi.doMock('../lib/parakeet.js',async original=>({...await original<typeof import('../lib/parakeet.js')>(),transcribeParakeet:vi.fn(async()=>({model:'parakeet-ultra',text:'Parakeet heard the selected local engine clearly.',words:[{word:'Parakeet',start:0,end:0.4}],processingSec:0.1,wallMs:120}))}))
 vi.doMock('../lib/whisper-local.js',()=>({transcribeLocal:vi.fn(async()=>({text:'We reviewed the launch plan and agreed on a decision.',backend:'server'})),applyCorrections:(s:string)=>s}))
 vi.doMock('../lib/speaker-embeddings.js',async original=>({...await original<typeof import('../lib/speaker-embeddings.js')>(),AUTO_ENROLL_CANDIDATE_SIMILARITY:0.72,AUTO_ENROLL_THRESHOLD:0.88,identifySpeaker:identify,isEmbeddingAvailable:()=>true,autoEnroll:enroll,getEmbeddingCount:()=>3}))
 vi.doMock('../lib/profile.js',()=>({loadProfileObject:()=>({}),getDomainKeywords:()=>({}),getVocabulary:()=>[],getOwnerName:()=> 'COS',getOwnerSpeakerLabel:()=> 'MU',getWhisperCorrections:()=>''}))
 vi.doMock('../lib/vad-silero.js',()=>({isSileroAvailable:()=>false,measureSpeechSeconds:()=>null,trimSilence:vi.fn()}))
 vi.doMock('../lib/stt-live.js',async original=>({...await original<typeof import('../lib/stt-live.js')>(),decideQuiet:()=>({isQuiet:false,rms:400,speechSec:3,gate:'rms'}),asrFrontEnd:async(b:Buffer)=>b}))
 vi.doMock('../lib/nemotron-live.js',async original=>({...await original<typeof import('../lib/nemotron-live.js')>(),nemotronLive:{diarize:vi.fn(async()=>({ok:false,reason:'embedding_requested'})),record:vi.fn(),snapshot:()=>({})}}))
 vi.doMock('../lib/meeting-summary-persistence.js',()=>({enrichStandaloneMeeting:vi.fn(async()=>{})}))
 stream=await import('./transcribe-stream.js'); const app=express(); app.use(express.json()); app.use('/api',stream.transcribeStreamRouter)
 const {createMeetingRouter}=await import('./meeting.js'); app.use('/api',createMeetingRouter({runBatch:async()=>({transcriptionQuality:'streaming'}),finalDiarize:vi.fn(async()=>({applied:false,reason:'test'} as any)),scheduleBackground:task=>{background.push(task)},emit:vi.fn()}))
 server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))}); const address=server.address() as {port:number}; base='http://127.0.0.1:'+address.port+'/api'
})
afterEach(async()=>{
 await Promise.allSettled(background.splice(0)); await new Promise<void>(resolve=>server?.listening ? server.close(()=>resolve()) : resolve()); vi.resetModules()
 for(const mod of ['parakeet','server-instance-id','whisper-local','speaker-embeddings','profile','vad-silero','stt-live','nemotron-live','meeting-summary-persistence']) vi.doUnmock('../lib/'+mod+'.js')
 delete process.env.COS_DATA_DIR; rmSync(root,{recursive:true,force:true})
})
async function call(path:string,body?:unknown,pin='server-mac'){
 const headers:Record<string,string>={};if(pin)headers['X-COS-Server-Instance']=pin
 if(body!==undefined) headers['Content-Type']=Buffer.isBuffer(body)?'audio/wav':'application/json'
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:Buffer.isBuffer(body)?new Uint8Array(body).buffer:JSON.stringify(body)})
 return {status:response.status,json:await response.json() as any}
}
function start(pin='server-mac'){return call('/mac-recording/start',{captureId:id,startTime:1700000000000,sourceType:'mac_system_audio'},pin)}
it('discovers capability without starting recording and rejects missing/wrong pins without registry writes',async()=>{
 expect((await call('/mac-recording/capabilities')).json).toMatchObject({available:true,serverInstanceId:'server-mac',sourceType:'mac_system_audio',maxChunkMs:30000})
 expect(stream.getSessionStartTime(id)).toBeNull(); expect((await start('')).status).toBe(400); expect((await start('wrong')).status).toBe(409); expect(existsSync(join(root,'mac-recordings',id+'.json'))).toBe(false)
})
it('registers before first audio, refuses unregistered/invalid/bypass uploads, persists strict result and retries idempotently',async()=>{
 const wav=wavOf(6,()=>400); const path='/mac-recording/'+id+'/chunks?chunkIndex=0&elapsed=6000'
 expect((await call(path,wav)).json.reason).toBe('mac_capture_not_started'); expect((await start()).status).toBe(200); expect((await start()).json.replayed).toBe(true)
 expect((await call(path,Buffer.alloc(100))).json.reason).toBe('invalid_mac_audio')
 expect((await call('/transcribe-stream?sessionId='+id+'&chunkIndex=0',wav)).json.reason).toBe('mac_transport_required')
 const done=await call(path,wav); expect(done.status).toBe(200); expect(done.json).toMatchObject({sessionId:id,chunkIndex:0,serverInstanceId:'server-mac',asrCompleted:true,canonical:true,elapsed:0}); expect(stream.getSessionChunks(id)?.[0]).toMatchObject({speaker:'Ext',speakerPolicy:'high-confidence',elapsed:0,audioDurationMs:6000}); expect(enroll).not.toHaveBeenCalled(); expect(existsSync(join(root,'chunk-embeddings',id+'.jsonl'))).toBe(false); expect(existsSync(join(root,'ext-audio',id))).toBe(false)
 expect((await call(path,wav)).status).toBe(200); expect(identify).toHaveBeenCalledTimes(1); expect(identify.mock.calls[0]).toHaveLength(3); expect((identify.mock.calls[0] as unknown[])[2]).toMatchObject({minSimilarity:0.88,prioritizeOwner:false,event:'mac-system-audio'})
 expect((await call('/mac-recording/'+id+'/chunks?chunkIndex=0&elapsed=6001',wav)).json.reason).toBe('mac_chunk_conflict')
 expect((await call(path,wavOf(6,()=>401))).json.reason).toBe('mac_chunk_conflict')
 expect((await call('/mac-recording/'+id+'/chunks?chunkIndex=1&elapsed=1',wav)).json.reason).toBe('invalid_elapsed')
 expect((await call('/mac-recording/'+id+'/chunks?chunkIndex=1&elapsed=40000',Buffer.alloc(960046))).status).toBe(413)
})

it('requires full captured count and acknowledged tail before a pinned save, then opens the exact saved source and rejects capture reuse',async()=>{
 await start(); const wav=wavOf(6,()=>400); await call('/mac-recording/'+id+'/chunks?chunkIndex=0&elapsed=6000',wav)
 expect((await call('/meeting/save',{sessionId:id},'')).json.reason).toBe('server_identity_pin_required')
 expect((await call('/meeting/save',{sessionId:id})).json.reason).toBe('mac_chunk_count_required')
 expect((await call('/meeting/save',{sessionId:id,expectedChunkCount:2})).json.reason).toBe('mac_capture_incomplete')
 expect(stream.getSessionChunks(id)).not.toBeNull()
 const saved=await call('/meeting/save',{sessionId:id,expectedChunkCount:1,title:'Mac remote call',domain:'personal'})
 expect(saved.status).toBe(200); expect(saved.json).toMatchObject({saved:true,receiptVersion:1,serverInstanceId:'server-mac',sessionId:id,captureId:id,sourceType:'mac_system_audio',transferIntegrity:{completeness:100,received:1,expected:1}})
 await Promise.allSettled(background.splice(0))
 expect((await call('/meeting/sessions/'+id+'/status')).json).toMatchObject({state:'saved',serverInstanceId:'server-mac'})
 expect((await call('/meeting/save',{sessionId:id,expectedChunkCount:1})).json).toMatchObject({saved:true,replayed:true,filename:saved.json.filename,sessionId:id,captureId:id})
 expect((await start()).status).toBe(410)
 const sidecar=JSON.parse(readFileSync(join(root,saved.json.filepath.replace(/\.md$/,'.g2-chunks.json')),'utf8'))
 expect(sidecar).toMatchObject({sourceType:'mac_system_audio',captureSource:{captureId:id},chunks:[{speaker:'Ext',speakerPolicy:'high-confidence',elapsed:0,audioDurationMs:6000}]})
})

it('does not mistake raw receipt for ASR completion and keeps silence in the final captured duration',async()=>{
 await start(); const wav=wavOf(6,()=>400)
 const whisper=await import('../lib/whisper-local.js')
 vi.mocked(whisper.transcribeLocal).mockRejectedValueOnce(new Error('ASR unavailable'))
 const chunk='/mac-recording/'+id+'/chunks?chunkIndex=0&elapsed=6000'
 expect((await call(chunk,wav)).status).toBe(503)
 expect((await call('/meeting/save',{sessionId:id,expectedChunkCount:1})).json.reason).toBe('mac_capture_incomplete')
 expect((await call(chunk,wav)).status).toBe(200)
 vi.mocked(whisper.transcribeLocal).mockResolvedValueOnce({text:'',backend:'server'} as any)
 const silent=await call('/mac-recording/'+id+'/chunks?chunkIndex=1&elapsed=12000',wav)
 expect(silent.json).toMatchObject({sessionId:id,chunkIndex:1,asrCompleted:true,canonical:false})
 const saved=await call('/meeting/save',{sessionId:id,expectedChunkCount:2,domain:'personal'})
 expect(saved.status).toBe(200); await Promise.allSettled(background.splice(0))
 const sidecar=JSON.parse(readFileSync(join(root,saved.json.filepath.replace(/\.md$/,'.g2-chunks.json')),'utf8'))
 expect(sidecar.durationMs).toBe(12000)
})

it('restores admitted Mac source, exact timing and strict policy from durable active session on module reload',async()=>{
 await start(); await call('/mac-recording/'+id+'/chunks?chunkIndex=0&elapsed=6500',wavOf(6,()=>400))
 vi.resetModules(); const restarted=await import('./transcribe-stream.js'); const mac=await import('../lib/mac-recording.js')
 expect(mac.requireMacRecording(id)).toMatchObject({captureId:id,sourceType:'mac_system_audio',speakerPolicy:'high-confidence'})
 expect(restarted.getSessionChunks(id)?.[0]).toMatchObject({elapsed:500,audioDurationMs:6000,speaker:'Ext',speakerPolicy:'high-confidence'})
 expect(()=>restarted.assertMacCaptureComplete(id,1)).not.toThrow()
 restarted.deleteSession(id)
})

async function selectParakeet() {
 const stt=await import('../lib/stt-settings.js')
 stt.writeSttSettings({...stt.readSttSettings(),preview:'parakeet',hq:'parakeet-ultra',secondOpinion:'off',resolver:false})
}
it('uses selected Parakeet for canonical Mac chunks with the candidate flags disabled and truthful replay provenance',async()=>{
 const oldIos=process.env.COS_IOS_ASR_CANDIDATES,oldCues=process.env.COS_LIVE_CUES
 process.env.COS_IOS_ASR_CANDIDATES='0';process.env.COS_LIVE_CUES='0'
 try {
  await selectParakeet(); await start()
  const path='/mac-recording/'+id+'/chunks?chunkIndex=0&elapsed=6000',wav=wavOf(6,()=>400)
  const done=await call(path,wav)
  expect(done.status).toBe(200)
  expect(done.json).toMatchObject({asrCompleted:true,canonical:true,asrProvider:'server-parakeet',model:'parakeet-ultra',backend:'fluidaudio-coreml',latencyMs:120})
  expect((await call(path,wav)).json).toEqual(done.json)
  const parakeet=await import('../lib/parakeet.js'),whisper=await import('../lib/whisper-local.js')
  expect(parakeet.transcribeParakeet).toHaveBeenCalledTimes(1)
  expect(parakeet.transcribeParakeet).toHaveBeenCalledWith(expect.any(Buffer),{model:'parakeet-ultra',lane:'interactive',timeoutMs:30000})
  expect(whisper.transcribeLocal).not.toHaveBeenCalled()
  expect(stream.getSessionChunks(id)?.[0]).toMatchObject({model:'parakeet-ultra',asrProvider:'server-parakeet',backend:'fluidaudio-coreml'})
  const saved=await call('/meeting/save',{sessionId:id,expectedChunkCount:1,domain:'personal'})
  expect(saved.status).toBe(200);await Promise.allSettled(background.splice(0))
  const sidecar=JSON.parse(readFileSync(join(root,saved.json.filepath.replace(/\.md$/,'.g2-chunks.json')),'utf8'))
  expect(sidecar.chunks[0]).toMatchObject({model:'parakeet-ultra',asrProvider:'server-parakeet',backend:'fluidaudio-coreml'})
 } finally {
  if(oldIos===undefined)delete process.env.COS_IOS_ASR_CANDIDATES;else process.env.COS_IOS_ASR_CANDIDATES=oldIos
  if(oldCues===undefined)delete process.env.COS_LIVE_CUES;else process.env.COS_LIVE_CUES=oldCues
 }
})
it.each(['not_installed','sandbox_unavailable','busy','timeout','cli_failed','bad_output'] as const)('retains raw Mac WAV and rejects canonical save on selected Parakeet %s without a Whisper fallback',async(reason)=>{
 await selectParakeet();await start()
 const parakeet=await import('../lib/parakeet.js'),whisper=await import('../lib/whisper-local.js')
 vi.mocked(parakeet.transcribeParakeet).mockRejectedValueOnce(new parakeet.ParakeetError(reason,'fixture '+reason))
 const path='/mac-recording/'+id+'/chunks?chunkIndex=0&elapsed=6000',wav=wavOf(6,()=>400)
 const failed=await call(path,wav)
 expect(failed.status).toBe(503)
 expect(failed.json).toMatchObject({reason:'mac_parakeet_'+reason,retryable:true,model:'parakeet-ultra'})
 expect(readFileSync(join(root,'session-audio',id,'chunk_0000.wav'))).toEqual(wav)
 expect(stream.getSessionChunks(id)??[]).toHaveLength(0)
 expect((await call('/meeting/save',{sessionId:id,expectedChunkCount:1})).json.reason).toBe('mac_capture_incomplete')
 expect(whisper.transcribeLocal).not.toHaveBeenCalled()
 expect((await call(path,wav)).json).toMatchObject({canonical:true,asrProvider:'server-parakeet'})
 expect(whisper.transcribeLocal).not.toHaveBeenCalled()
})
it('keeps the existing G2 Whisper canonical chunk path when Parakeet HQ is selected',async()=>{
 await selectParakeet()
 const done=await call('/transcribe-stream?sessionId=g2_engine_regression&chunkIndex=0&elapsed=6000',wavOf(6,()=>400))
 expect(done.status).toBe(200)
 const parakeet=await import('../lib/parakeet.js'),whisper=await import('../lib/whisper-local.js')
 expect(parakeet.transcribeParakeet).not.toHaveBeenCalled();expect(whisper.transcribeLocal).toHaveBeenCalledTimes(1)
})
it('records Parakeet silence over detected speech as an empty chunk so later chunks are not blocked behind it',async()=>{
 // 2026-10-15 live meeting: Parakeet returned no words for chunk 51 while Silero heard speech. The server answered
 // 503 retryable on every replay, Control retried 51 forever, and the live transcript froze for every later chunk.
 await selectParakeet();await start()
 const parakeet=await import('../lib/parakeet.js'),whisper=await import('../lib/whisper-local.js')
 vi.mocked(parakeet.transcribeParakeet).mockResolvedValueOnce({model:'parakeet-ultra',text:'',words:[],wallMs:90} as never)
 const first='/mac-recording/'+id+'/chunks?chunkIndex=0&elapsed=6000',wav=wavOf(6,()=>400)
 const empty=await call(first,wav)
 expect(empty.status).toBe(200)
 expect(empty.json).toMatchObject({asrCompleted:true,canonical:false,sessionId:id,chunkIndex:0})
 expect((await call(first,wav)).json).toMatchObject({asrCompleted:true,canonical:false})
 expect(parakeet.transcribeParakeet).toHaveBeenCalledTimes(1)
 const next=await call('/mac-recording/'+id+'/chunks?chunkIndex=1&elapsed=12000',wavOf(6,()=>420))
 expect(next.status).toBe(200)
 expect(next.json).toMatchObject({asrCompleted:true,canonical:true,asrProvider:'server-parakeet'})
 expect(whisper.transcribeLocal).not.toHaveBeenCalled()
})
