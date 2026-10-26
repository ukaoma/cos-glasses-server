import express from 'express'
import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { activityOf, wavOf } from '../lib/__fixtures__/nemotron-helpers.js'
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
 vi.doMock('../lib/speaker-embeddings.js',async original=>({...await original<typeof import('../lib/speaker-embeddings.js')>(),AUTO_ENROLL_CANDIDATE_SIMILARITY:0.72,AUTO_ENROLL_THRESHOLD:0.88,identifySpeaker:identify,extractEmbedding:vi.fn((wav:Buffer)=>new Float32Array(wav.readInt16LE(44)>=0?[1,0]:[0,1])),isEmbeddingAvailable:()=>true,autoEnroll:enroll,getEmbeddingCount:()=>3}))
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
/** Run `fn` with the live-voice switches set (undefined = unset), restoring them after. */
async function withLiveVoices<T>(env:{COS_MAC_LIVE_VOICES?:string;COS_MAC_VOICE_LABELS?:string},fn:()=>Promise<T>):Promise<T>{
 const keys=['COS_MAC_LIVE_VOICES','COS_MAC_VOICE_LABELS'] as const,saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]))
 for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k]}
 try{return await fn()}finally{for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k]}}
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
 expect((await call(path,wav)).status).toBe(200); expect(identify).toHaveBeenCalledTimes(1); expect(identify.mock.calls[0]).toHaveLength(3); expect((identify.mock.calls[0] as unknown[])[2]).toMatchObject({minSimilarity:0.88,prioritizeOwner:false,event:'mac-system-audio',shadowEvent:'mac-shadow'})
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

// ── 6.83.2: discard a stranded Mac capture that held no sound ──────────────────────
// Miles 2026-10-21: 211 chunks of exact zeros sat stranded with a Save that could never work.
async function silentCapture(chunks=2){
 await start(); const whisper=await import('../lib/whisper-local.js')
 vi.mocked(whisper.transcribeLocal).mockResolvedValue({text:'',backend:'server'} as any)
 for(let i=0;i<chunks;i++) expect((await call('/mac-recording/'+id+'/chunks?chunkIndex='+i+'&elapsed='+(6000*(i+1)),wavOf(6,()=>0))).json).toMatchObject({asrCompleted:true,canonical:false})
}
function goIdle(ms=3*60_000){ const session=stream.__sessionsForTests.get(id)!; session.lastActivityAt-=ms }
const discard=(body:Record<string,unknown>={confirm:true},pin='server-mac')=>call('/meeting/sessions/'+id+'/discard',body,pin)
it('advertises the discard route on Mac recording capabilities',async()=>{
 expect((await call('/mac-recording/capabilities')).json.discard).toBe(true)
})
it('discards a stranded no-sound capture only on confirm: quarantined for 24 h with a terminal receipt, off the stranded list, closed to late chunks',async()=>{
 await silentCapture(2); goIdle()
 const before=(await call('/meeting/orphans')).json.stranded.find((s:any)=>s.sessionId===id)
 expect(before).toMatchObject({transcriptState:'no_speech',canSave:false})
 const preview=await discard({})
 expect(preview.status).toBe(400); expect(preview.json).toMatchObject({reason:'confirmation_required',preview:{sessionId:id,chunkFiles:2,receivedCount:2,retentionHours:24}})
 expect(stream.__sessionsForTests.has(id)).toBe(true); expect(existsSync(join(root,'session-audio',id,'chunk_0000.wav'))).toBe(true)
 const done=await discard()
 expect(done.status).toBe(200); expect(done.json).toMatchObject({sessionId:id,discarded:true,replayed:false,quarantined:id,chunkFiles:2,receivedCount:2})
 expect(stream.__sessionsForTests.has(id)).toBe(false)
 expect((await call('/meeting/orphans')).json.stranded.some((s:any)=>s.sessionId===id)).toBe(false)
 expect(existsSync(join(root,'session-audio',id))).toBe(false)
 expect(existsSync(join(root,'unsaved-audio',id,'chunk_0001.wav'))).toBe(true)
 expect(JSON.parse(readFileSync(join(root,'unsaved-audio',id,'_quarantine.json'),'utf8'))).toMatchObject({reason:'discarded_no_sound',retentionMs:24*3600_000})
 expect(JSON.parse(readFileSync(join(root,'unsaved-audio',id,'_recovered.json'),'utf8'))).toMatchObject({outcome:'no_speech',discarded:true})
 const orphans=(await call('/meeting/orphans')).json
 expect(orphans.items.find((i:any)=>i.sessionId===id)).toMatchObject({recovered:true}); expect(orphans.count).toBe(0)
 expect((await call('/meeting/sessions/'+id+'/status')).json).toMatchObject({outcome:'receipted'})
 expect((await call('/mac-recording/'+id+'/chunks?chunkIndex=2&elapsed=18000',wavOf(6,()=>0))).status).toBe(410)
 expect((await start()).status).toBe(410)
 expect((await discard()).json).toMatchObject({discarded:true,replayed:true})
 // Past the closed-session TTL the in-memory tombstone is gone; the registry's closedAt still refuses a late chunk,
 // so a discarded capture can never come back as a new live session.
 stream.sweepExpiredClosedSessions(Date.now()+400*24*3600_000)
 const late=await call('/mac-recording/'+id+'/chunks?chunkIndex=2&elapsed=18000',wavOf(6,()=>0))
 expect(late.status).toBe(410); expect(late.json.reason).toBe('session_closed'); expect(stream.__sessionsForTests.has(id)).toBe(false)
})
it('never discards a capture with speech, one still transcribing, one still receiving, or a G2 session',async()=>{
 await start(); await call('/mac-recording/'+id+'/chunks?chunkIndex=0&elapsed=6000',wavOf(6,()=>400)); goIdle()
 const speech=await discard()
 expect(speech.status).toBe(409); expect(speech.json.reason).toBe('has_speech')
 expect(stream.getSessionChunks(id)).toHaveLength(1); expect(existsSync(join(root,'session-audio',id,'chunk_0000.wav'))).toBe(true)
 // The route refuses a G2 id itself, before any pin or session check (400, not the guard's 409).
 const g2=await call('/meeting/sessions/g2_1700000000000/discard',{confirm:true},'')
 expect(g2.status).toBe(400); expect(g2.json.reason).toBe('not_mac_capture')
})
it('refuses while a chunk is still being transcribed or audio is still arriving',async()=>{
 await silentCapture(1)
 expect((await discard()).json.reason).toBe('not_idle')
 const whisper=await import('../lib/whisper-local.js')
 vi.mocked(whisper.transcribeLocal).mockRejectedValueOnce(new Error('ASR unavailable'))
 expect((await call('/mac-recording/'+id+'/chunks?chunkIndex=1&elapsed=12000',wavOf(6,()=>0))).status).toBe(503)
 goIdle()
 expect((await discard()).json.reason).toBe('asr_in_progress')
 expect(stream.__sessionsForTests.has(id)).toBe(true)
})
it('requires this server pin and a session it holds',async()=>{
 await silentCapture(1); goIdle()
 expect((await discard({confirm:true},'')).json.reason).toBe('server_identity_pin_required')
 expect((await discard({confirm:true},'wrong')).json.reason).toBe('server_instance_mismatch')
 expect(stream.__sessionsForTests.has(id)).toBe(true)
 const other=await call('/meeting/sessions/mac_00000000-0000-4000-8000-000000000000/discard',{confirm:true})
 expect(other.status).toBe(404); expect(other.json.reason).toBe('session_not_found')
})
it('macDiscardRefusal: every guard by name, idle measured at the empty-session threshold',()=>{
 const ok={sessionId:id,present:true,canonicalCount:0,receivedIndices:[0,1],asrCompletedIndices:[0,1],silentForMs:stream.MAC_DISCARD_IDLE_MS,chunkInProgress:false}
 expect(stream.MAC_DISCARD_IDLE_MS).toBe(2*60_000)
 expect(stream.macDiscardRefusal(ok)).toBeNull()
 expect(stream.macDiscardRefusal({...ok,sessionId:'g2_1700000000000'})).toBe('not_mac_capture')
 expect(stream.macDiscardRefusal({...ok,present:false})).toBe('session_not_found')
 expect(stream.macDiscardRefusal({...ok,canonicalCount:1})).toBe('has_speech')
 expect(stream.macDiscardRefusal({...ok,asrCompletedIndices:[0]})).toBe('asr_in_progress')
 expect(stream.macDiscardRefusal({...ok,chunkInProgress:true})).toBe('chunk_in_progress')
 expect(stream.macDiscardRefusal({...ok,silentForMs:stream.MAC_DISCARD_IDLE_MS-1})).toBe('not_idle')
 expect(stream.macDiscardRefusal({...ok,receivedIndices:[],asrCompletedIndices:[]})).toBeNull()
})

it('6.90.0: Mac Nemotron tracks skip the wearer check and are tagged as Mac, while the chunk stays strict Ext',async()=>{
 const live=await import('../lib/nemotron-live.js'); const {activityOf}=await import('../lib/__fixtures__/nemotron-helpers.js')
 vi.mocked(live.nemotronLive.diarize).mockResolvedValue({ok:true,run:{...activityOf(6,[[0,0,2.6],[5,3,6]]),loadSec:0.1,audioSec:6,wallMs:140}} as never)
 await start(); const done=await call('/mac-recording/'+id+'/chunks?chunkIndex=0&elapsed=6000',wavOf(6,t=>(t<2.8?400:-400)))
 expect(done.status).toBe(200)
 const options=identify.mock.calls.map(c=>(c as unknown[])[2] as Record<string,unknown>)
 expect(options[0]).toMatchObject({event:'mac-system-audio',prioritizeOwner:false,shadowEvent:'mac-shadow'})
 const tracks=options.slice(1); expect(tracks.length).toBeGreaterThanOrEqual(2)
 for(const o of tracks){expect(o).toMatchObject({event:'mac-nemotron-track',prioritizeOwner:false,minSimilarity:0.88}); expect(o.shadowEvent).toBeUndefined()}
 // The 0.64 track matches stay below the 0.88 floor: every label is Ext and nothing trains.
 const chunk=stream.getSessionChunks(id)?.[0]; expect(chunk?.speaker).toBe('Ext'); for(const segment of chunk?.segments??[]) expect(segment.speaker).toBe('Ext')
 expect(enroll).not.toHaveBeenCalled(); expect(existsSync(join(root,'chunk-embeddings',id+'.jsonl'))).toBe(false)
})


it('keeps anonymous live voices stable across channel permutations, replay, durable restart and save without training',()=>withLiveVoices({COS_MAC_LIVE_VOICES:'anchors'},async()=>{
 await start()
 const nemotron=await import('../lib/nemotron-live.js')
 const run=(channel:number)=>vi.mocked(nemotron.nemotronLive.diarize).mockResolvedValue({ok:true,run:{...activityOf(6,[[channel,0,6]]),wallMs:20,loadSec:0,audioSec:6}} as any)
 const post=(index:number,value:number)=>call('/mac-recording/'+id+'/chunks?chunkIndex='+index+'&elapsed='+((index+1)*6000),wavOf(6,()=>value))
 run(7); expect((await post(0,400)).json.speaker).toBe('Ext')
 run(2); const named=await post(1,420)
 expect(named.json).toMatchObject({speaker:'Voice 1',segments:[{speaker:'Voice 1',similarity:0}]})
 expect((await post(1,420)).json).toEqual(named.json)
 run(2);expect((await post(2,-400)).json.speaker).toBe('Ext')
 run(7);expect((await post(3,-420)).json.speaker).toBe('Voice 2')
 run(0);expect((await post(4,430)).json.speaker).toBe('Voice 1')
 const privateSession=JSON.parse(readFileSync(join(root,'active-sessions',id+'.json'),'utf8'))
 expect(privateSession.macLiveVoices.anchors).toHaveLength(2)
 vi.resetModules();const recovered=await import('./transcribe-stream.js')
 expect(recovered.getSession(id).macLiveVoices).toEqual(privateSession.macLiveVoices)
 expect(recovered.getSessionChunks(id)?.[4]).toMatchObject({speaker:'Voice 1',speakerPolicy:'high-confidence',similarity:0})
 expect(enroll).not.toHaveBeenCalled()
 expect(existsSync(join(root,'chunk-embeddings',id+'.jsonl'))).toBe(false)
 expect(readdirSync(join(root,'training-audio'),{recursive:true})).toEqual([])
 const saved=await call('/meeting/save',{sessionId:id,expectedChunkCount:5,domain:'personal'})
 expect(saved.status).toBe(200);await Promise.allSettled(background.splice(0))
 expect(existsSync(join(root,'active-sessions',id+'.json'))).toBe(false)
 const sidecar=JSON.parse(readFileSync(join(root,saved.json.filepath.replace(/\.md$/,'.g2-chunks.json')),'utf8'))
 expect(sidecar.chunks[4]).toMatchObject({speaker:'Voice 1',similarity:0,speakerPolicy:'high-confidence'})
 expect(sidecar.macLiveVoices).toBeUndefined() // acoustic anchors are active-capture only
}))

it('withholds anonymous continuity when acoustic extraction fails and preserves strict named identity',()=>withLiveVoices({COS_MAC_LIVE_VOICES:'anchors'},async()=>{
 await start();const nemotron=await import('../lib/nemotron-live.js'),embeddings=await import('../lib/speaker-embeddings.js')
 vi.mocked(nemotron.nemotronLive.diarize).mockResolvedValue({ok:true,run:{...activityOf(6,[[3,0,6]]),wallMs:20,loadSec:0,audioSec:6}} as any)
 vi.mocked(embeddings.extractEmbedding).mockReturnValue(null)
 for(let i=0;i<2;i++)expect((await call('/mac-recording/'+id+'/chunks?chunkIndex='+i+'&elapsed='+((i+1)*6000),wavOf(6,()=>400))).json.speaker).toBe('Ext')
 identify.mockReturnValueOnce({speaker:'Dana',similarity:0.94,embedding:new Float32Array(192).fill(0.1)})
 expect((await call('/mac-recording/'+id+'/chunks?chunkIndex=2&elapsed=18000',wavOf(6,()=>400))).json.speaker).toBe('Dana')
 expect(enroll).not.toHaveBeenCalled()
}))

it('repeated audio at a different raw index is not independent voice evidence; flag-off leaves no anchors',()=>withLiveVoices({COS_MAC_LIVE_VOICES:'anchors'},async()=>{
 await start();const nemotron=await import('../lib/nemotron-live.js')
 vi.mocked(nemotron.nemotronLive.diarize).mockResolvedValue({ok:true,run:{...activityOf(6,[[3,0,6]]),wallMs:20,loadSec:0,audioSec:6}} as any)
 const post=(i:number,value:number)=>call('/mac-recording/'+id+'/chunks?chunkIndex='+i+'&elapsed='+((i+1)*6000),wavOf(6,()=>value))
 expect((await post(0,400)).json.speaker).toBe('Ext')
 expect((await post(1,400)).json.speaker).toBe('Ext')
 expect((await post(2,420)).json.speaker).toBe('Voice 1')
 const old=process.env.COS_MAC_VOICE_LABELS;process.env.COS_MAC_VOICE_LABELS='0'
 try{expect((await post(3,440)).json.speaker).toBe('Ext')}finally{if(old===undefined)delete process.env.COS_MAC_VOICE_LABELS;else process.env.COS_MAC_VOICE_LABELS=old}
}))

it('corrupt recovered continuity stays unknown instead of reusing an existing voice number',()=>withLiveVoices({COS_MAC_LIVE_VOICES:'anchors'},async()=>{
 await start();stream.getSession(id).macLiveVoices={version:2,anchors:[]} as any
 const nemotron=await import('../lib/nemotron-live.js')
 vi.mocked(nemotron.nemotronLive.diarize).mockResolvedValue({ok:true,run:{...activityOf(6,[[3,0,6]]),wallMs:20,loadSec:0,audioSec:6}} as any)
 for(let i=0;i<2;i++)expect((await call('/mac-recording/'+id+'/chunks?chunkIndex='+i+'&elapsed='+((i+1)*6000),wavOf(6,()=>400+i))).json.speaker).toBe('Ext')
 expect(stream.getSession(id).macLiveVoices).toEqual({version:2,anchors:[]})
}))

it('does not acknowledge a non-durable voice promotion and replays the same canonical label without another model pass',()=>withLiveVoices({COS_MAC_LIVE_VOICES:'anchors'},async()=>{
 await start();const nemotron=await import('../lib/nemotron-live.js')
 vi.mocked(nemotron.nemotronLive.diarize).mockResolvedValue({ok:true,run:{...activityOf(6,[[3,0,6]]),wallMs:20,loadSec:0,audioSec:6}} as any)
 const post=(i:number,value:number)=>call('/mac-recording/'+id+'/chunks?chunkIndex='+i+'&elapsed='+((i+1)*6000),wavOf(6,()=>value))
 await post(0,400)
 const atomic=await import('../lib/atomic-fs.js'),write=atomic.durableAtomicWriteFileSync
 let failed=false
 const spy=vi.spyOn(atomic,'durableAtomicWriteFileSync').mockImplementation((path,data,options)=>{
   if(!failed && String(path).endsWith('/active-sessions/'+id+'.json') && String(data).includes('"speaker":"Voice 1"')) {failed=true;throw new Error('injected durable voice promotion failure')}
   return write(path,data,options)
 })
 try{
  expect((await post(1,420)).status).toBe(503)
  const before=JSON.parse(readFileSync(join(root,'active-sessions',id+'.json'),'utf8'))
  expect(before.chunks).toHaveLength(1)
  expect(before.macLiveVoices.anchors[0].confirmed).toBe(false)
  expect((await post(1,420)).json.speaker).toBe('Voice 1')
  expect(vi.mocked(nemotron.nemotronLive.diarize)).toHaveBeenCalledTimes(2)
  const after=JSON.parse(readFileSync(join(root,'active-sessions',id+'.json'),'utf8'))
  expect(after.chunks[1].speaker).toBe('Voice 1')
  expect(after.macLiveVoices.anchors[0].confirmed).toBe(true)
 }finally{spy.mockRestore()}
}))

it('6.93.0 window replay: numbers survive chunk boundaries and slot permutations, state is private, bounded and never trains',async()=>{
 const old=process.env.COS_MAC_LIVE_VOICES;process.env.COS_MAC_LIVE_VOICES='window'
 try{
  await start();const nemotron=await import('../lib/nemotron-live.js')
  const paths:string[]=[];let calls=0
  // A fake window run: each frame's slot comes from the sign of that frame's samples; the
  // positive voice's slot moves every call, so a number can only come from the crosswalk.
  vi.mocked(nemotron.nemotronLive.diarize).mockImplementation(async(path:string)=>{
   paths.push(path);const wav=readFileSync(path);const samples=(wav.length-44)/2;const frames=1+Math.floor((samples+112)/160)
   const probs=new Float32Array(frames*8).fill(0.02);const pos=calls++%3
   for(let f=0;f<frames-1;f++){const v=wav.readInt16LE(44+f*320);probs[f*8+(v>=0?pos:5)]=0.9}
   return {ok:true,run:{frames,probs,wallMs:20,loadSec:0,audioSec:samples/16000}} as any
  })
  const post=(index:number,value:number)=>call('/mac-recording/'+id+'/chunks?chunkIndex='+index+'&elapsed='+((index+1)*6000),wavOf(6,()=>value))
  const spoken=[]
  for(const [i,v] of [[0,400],[1,420],[2,-400],[3,-420],[4,430],[5,-430]] as const) spoken.push((await post(i,v)).json.speaker)
  expect(spoken).toEqual(['Ext','Voice 1','Ext','Voice 2','Voice 1','Voice 2'])
  // One window run per chunk, plus the chunk diarized alone (the agreement view) once a slot is carried: chunks 1 to 5.
  const windows=paths.filter(p=>p.endsWith('/window.wav')),singles=paths.filter(p=>!p.endsWith('/window.wav'))
  expect(windows).toHaveLength(6)
  expect(singles).toHaveLength(5)
  expect(singles.every(p=>/\/chunk_000[1-5]\.wav$/.test(p))).toBe(true)
  expect(paths.some(p=>existsSync(p)&&p.endsWith('/window.wav'))).toBe(false) // window WAVs are removed after each run
  expect(readFileSync(join(root,'session-audio',id,'chunk_0005.wav')).length).toBe(192044)
  const privateSession=JSON.parse(readFileSync(join(root,'active-sessions',id+'.json'),'utf8'))
  expect(privateSession.macWindowVoices).toMatchObject({version:1,kind:'window',voices:2,nextTrack:2})
  expect(privateSession.macWindowVoices.recent).toHaveLength(4)
  expect(privateSession.macLiveVoices).toBeUndefined() // the per-chunk anchors do not also run
  vi.resetModules();const recovered=await import('./transcribe-stream.js')
  expect(recovered.getSession(id).macWindowVoices).toEqual(privateSession.macWindowVoices)
  expect(enroll).not.toHaveBeenCalled();expect(existsSync(join(root,'chunk-embeddings',id+'.jsonl'))).toBe(false)
  const saved=await call('/meeting/save',{sessionId:id,expectedChunkCount:6,domain:'personal'})
  expect(saved.status).toBe(200);await Promise.allSettled(background.splice(0))
  const sidecar=JSON.parse(readFileSync(join(root,saved.json.filepath.replace(/\.md$/,'.g2-chunks.json')),'utf8'))
  expect(sidecar.chunks[4]).toMatchObject({speaker:'Voice 1',similarity:0,speakerPolicy:'high-confidence'})
  expect(sidecar.macWindowVoices).toBeUndefined()
 }finally{if(old===undefined)delete process.env.COS_MAC_LIVE_VOICES;else process.env.COS_MAC_LIVE_VOICES=old}
})
it('6.93.0 window replay withholds numbers on corrupt state, after earlier Voice labels, and when COS_MAC_VOICE_LABELS is off',async()=>{
 const old=process.env.COS_MAC_LIVE_VOICES,oldLabels=process.env.COS_MAC_VOICE_LABELS;process.env.COS_MAC_LIVE_VOICES='window'
 try{
  await start();const nemotron=await import('../lib/nemotron-live.js')
  vi.mocked(nemotron.nemotronLive.diarize).mockImplementation(async(path:string)=>{
   const samples=(readFileSync(path).length-44)/2;const frames=1+Math.floor((samples+112)/160);const probs=new Float32Array(frames*8).fill(0.02)
   for(let f=0;f<frames-1;f++)probs[f*8+3]=0.9
   return {ok:true,run:{frames,probs,wallMs:20,loadSec:0,audioSec:samples/16000}} as any
  })
  const post=(i:number,v:number)=>call('/mac-recording/'+id+'/chunks?chunkIndex='+i+'&elapsed='+((i+1)*6000),wavOf(6,()=>v))
  stream.getSession(id).macWindowVoices={version:1,kind:'window',nextTrack:0,voices:7,tracks:[],recent:[{chunk:9,frames:'AA=='}]} as any
  for(let i=0;i<3;i++)expect((await post(i,400+i)).json.speaker).toBe('Ext')
  expect(stream.getSession(id).macWindowVoices?.voices).toBe(7) // corrupt state is left as it is, never restarted
  delete stream.getSession(id).macWindowVoices;stream.getSession(id).chunks[0].speaker='Voice 4'
  expect((await post(3,410)).json.speaker).toBe('Ext');expect((await post(4,411)).json.speaker).toBe('Ext')
  expect(stream.getSession(id).macWindowVoices).toBeUndefined()
  stream.getSession(id).chunks[0].speaker='Ext';process.env.COS_MAC_VOICE_LABELS='0'
  expect((await post(5,412)).json.speaker).toBe('Ext');expect((await post(6,413)).json.speaker).toBe('Ext')
  expect(stream.getSession(id).macWindowVoices).toBeUndefined()
  // A strict name (0.88 floor) still wins over a confirmed anonymous number.
  delete process.env.COS_MAC_VOICE_LABELS
  expect((await post(7,414)).json.speaker).toBe('Ext');expect((await post(8,415)).json.speaker).toBe('Voice 1')
  identify.mockReturnValueOnce({speaker:'Dana',similarity:0.94,embedding:new Float32Array(192).fill(0.1)})
  expect((await post(9,416)).json.speaker).toBe('Dana');expect((await post(10,417)).json.speaker).toBe('Voice 1')
  expect(enroll).not.toHaveBeenCalled()
 }finally{
  if(old===undefined)delete process.env.COS_MAC_LIVE_VOICES;else process.env.COS_MAC_LIVE_VOICES=old
  if(oldLabels===undefined)delete process.env.COS_MAC_VOICE_LABELS;else process.env.COS_MAC_VOICE_LABELS=oldLabels
 }
})


// ── 6.93.0 QA B1: every new switch off is 6.92.0 for a Mac recording ──────────────
// The same eight clean one-voice chunks would be `Voice 1` / `Voice 2` live under either opt-in.
const TWO_VOICE_SIGNS=[1,1,-1,-1,1,-1,-1,-1] as const
for(const labels of [undefined,'1'] as const) it('6.93.0 B1: with COS_MAC_LIVE_VOICES unset'+(labels?' and COS_MAC_VOICE_LABELS=1':'')+' live and saved labels are 6.92.0: Ext live, no anchors, no window, every voice numbered at save',async()=>withLiveVoices({COS_MAC_LIVE_VOICES:undefined,COS_MAC_VOICE_LABELS:labels},async()=>{
 await start();const nemotron=await import('../lib/nemotron-live.js'),embeddings=await import('../lib/speaker-embeddings.js')
 const diarize=vi.mocked(nemotron.nemotronLive.diarize)
 diarize.mockImplementation(async()=>({ok:true,run:{...activityOf(6,[[3,0,6]]),wallMs:20,loadSec:0,audioSec:6}} as any))
 for(let i=0;i<TWO_VOICE_SIGNS.length;i++){
  const done=await call('/mac-recording/'+id+'/chunks?chunkIndex='+i+'&elapsed='+((i+1)*6000),wavOf(6,()=>TWO_VOICE_SIGNS[i]*(400+i)))
  expect(done.status).toBe(200);expect(done.json.speaker).toBe('Ext');expect(done.json.segments?.every((x:any)=>x.speaker==='Ext')??true).toBe(true)
 }
 // The 6.92.0 per-chunk run: one argument (the chunk's own WAV), no window, no anchors, no embedding work.
 expect(diarize).toHaveBeenCalledTimes(8)
 for(const call of diarize.mock.calls){expect(call).toHaveLength(1);expect(String(call[0])).toMatch(/\/chunk_000\d\.wav$/)}
 expect(vi.mocked(embeddings.extractEmbedding)).not.toHaveBeenCalled()
 const privateSession=JSON.parse(readFileSync(join(root,'active-sessions',id+'.json'),'utf8'))
 expect(privateSession.macLiveVoices).toBeUndefined();expect(privateSession.macWindowVoices).toBeUndefined()
 expect(privateSession.chunks.every((c:any)=>c.speaker==='Ext'&&c.similarity===0&&(c.segments??[]).every((x:any)=>x.speaker==='Ext'))).toBe(true)
 // Saved: the whole-meeting pass sees only Ext chunks and numbers EVERY voice it is confident of, as 6.92.0 did.
 const audioCopy=mkdtempSync(join(tmpdir(),'cos-b1-audio-'));cpSync(join(root,'session-audio',id),audioCopy,{recursive:true})
 try{
  const saved=await call('/meeting/save',{sessionId:id,expectedChunkCount:8,domain:'personal'});expect(saved.status).toBe(200);await Promise.allSettled(background.splice(0))
  const meetingPath=join(root,saved.json.filepath),sidecarPath=meetingPath.replace(/\.md$/,'.g2-chunks.json')
  const sidecar=JSON.parse(readFileSync(sidecarPath,'utf8'));expect(sidecar.chunks.every((c:any)=>c.speaker==='Ext')).toBe(true)
  const {runNemotronFinalPass}=await import('../lib/nemotron-final.js'),{fakeNemotronHome}=await import('../lib/__fixtures__/nemotron-helpers.js')
  const outcome=await runNemotronFinalPass({meetingPath,sidecarPath,audioDir:audioCopy,env:{COS_DIARIZER:'nemotron'},home:fakeNemotronHome(),log:()=>{},
   run:async()=>activityOf(49,[[0,0,12],[1,12,24],[0,24,32.5],[1,32.5,48]])})
  expect(outcome).toMatchObject({status:'applied',unnamed:true,voices:2,mapped:{0:'Voice 1',1:'Voice 2'}})
 }finally{rmSync(audioCopy,{recursive:true,force:true})}
}))
it('6.93.0 B1: with the live switch off a profile that happens to be called Voice 1 is a name at its real similarity, exactly as 6.92.0',async()=>withLiveVoices({COS_MAC_LIVE_VOICES:undefined,COS_MAC_VOICE_LABELS:undefined},async()=>{
 await start();const nemotron=await import('../lib/nemotron-live.js')
 vi.mocked(nemotron.nemotronLive.diarize).mockResolvedValue({ok:true,run:{...activityOf(6,[[3,0,6]]),wallMs:20,loadSec:0,audioSec:6}} as any)
 identify.mockReturnValueOnce({speaker:'Voice 1',similarity:0.94,embedding:new Float32Array(192).fill(0.1)})
 expect((await call('/mac-recording/'+id+'/chunks?chunkIndex=0&elapsed=6000',wavOf(6,()=>400))).json).toMatchObject({speaker:'Voice 1',segments:[{speaker:'Voice 1',similarity:0.94}]})
}))
it('6.93.0 B1: COS_MAC_LIVE_VOICES is the only live switch: anchors and window are each opt-in, an unknown value is off, COS_MAC_VOICE_LABELS=0 turns both off',async()=>{
 await start();const nemotron=await import('../lib/nemotron-live.js')
 vi.mocked(nemotron.nemotronLive.diarize).mockResolvedValue({ok:true,run:{...activityOf(6,[[3,0,6]]),wallMs:20,loadSec:0,audioSec:6}} as any)
 const spoken:string[]=[];let i=0
 for(const [live,labels] of [['anchors',undefined],['yes',undefined],['anchors','0'],['',undefined]] as const) await withLiveVoices({COS_MAC_LIVE_VOICES:live,COS_MAC_VOICE_LABELS:labels},async()=>{
  for(let n=0;n<2;n++,i++) spoken.push((await call('/mac-recording/'+id+'/chunks?chunkIndex='+i+'&elapsed='+((i+1)*6000),wavOf(6,()=>400+i))).json.speaker)
 })
 // Only the first pair (anchors) can name a voice; "yes", COS_MAC_VOICE_LABELS=0 and an empty value stay Ext.
 expect(spoken.slice(2)).toEqual(Array(6).fill('Ext'))
 expect(spoken[1]).toBe('Voice 1')
})

// ── 6.93.0 QA N9: G2 and phone are untouched by the Mac window ────────────────────
it('6.93.0: a G2 chunk never takes the Mac window path, even with COS_MAC_LIVE_VOICES=window',async()=>withLiveVoices({COS_MAC_LIVE_VOICES:'window',COS_MAC_VOICE_LABELS:undefined},async()=>{
 const nemotron=await import('../lib/nemotron-live.js'),diarize=vi.mocked(nemotron.nemotronLive.diarize)
 diarize.mockImplementation(async()=>({ok:true,run:{...activityOf(6,[[3,0,6]]),wallMs:20,loadSec:0,audioSec:6}} as any))
 const g2='g2_test_session'
 for(let i=0;i<3;i++) expect((await call('/transcribe-stream?sessionId='+g2+'&chunkIndex='+i+'&elapsed='+((i+1)*6000)+'&speaker=Ext',wavOf(6,()=>400+i))).status).toBe(200)
 expect(diarize).toHaveBeenCalledTimes(3)
 for(const c of diarize.mock.calls){expect(c).toHaveLength(1);expect(String(c[0])).toMatch(new RegExp('/'+g2+'/chunk_000\\d\\.wav$'))}
 expect(stream.getSession(g2).macWindowVoices).toBeUndefined();expect(stream.getSession(g2).macLiveVoices).toBeUndefined()
 expect(stream.getSessionChunks(g2)?.every(c=>!/^Voice \d/.test(c.speaker))).toBe(true)
}))

// ── 6.93.0 QA W4/W8 ───────────────────────────────────────────────────────────────
it('6.93.0 W4: a window timeout falls back to the per-chunk run for that chunk, commits no window state and leaves the breaker alone',async()=>withLiveVoices({COS_MAC_LIVE_VOICES:'window',COS_MAC_VOICE_LABELS:undefined},async()=>{
 await start();const nemotron=await import('../lib/nemotron-live.js'),diarize=vi.mocked(nemotron.nemotronLive.diarize)
 const seen:Array<{path:string;opts:any}>=[]
 diarize.mockImplementation((async(path:string,opts?:any)=>{
  seen.push({path,opts})
  if(path.endsWith('/window.wav'))return {ok:false,reason:'timeout',ms:opts?.timeoutMs,detail:'budget'}
  return {ok:true,run:{...activityOf(6,[[3,0,6]]),wallMs:20,loadSec:0,audioSec:6}}
 }) as any)
 const lines:string[]=[];const log=vi.spyOn(console,'log').mockImplementation((...a:unknown[])=>{lines.push(a.join(' '))})
 try{
  for(let i=0;i<2;i++) expect((await call('/mac-recording/'+id+'/chunks?chunkIndex='+i+'&elapsed='+((i+1)*6000),wavOf(6,()=>400+i))).json.speaker).toBe('Ext')
 }finally{log.mockRestore()}
 const windowCalls=seen.filter(c=>c.path.endsWith('/window.wav'))
 expect(windowCalls).toHaveLength(2);expect(windowCalls[0].opts).toEqual({timeoutMs:1500,timeoutTripsBreaker:false});expect(windowCalls[1].opts).toEqual({timeoutMs:3000,timeoutTripsBreaker:false})
 expect(seen.filter(c=>!c.path.endsWith('/window.wav')).map(c=>c.opts)).toEqual([undefined,undefined]) // the fallbacks are ordinary per-chunk runs
 expect(stream.getSession(id).macWindowVoices).toBeUndefined()
 expect(lines.filter(l=>l.includes('[mac-window] chunk #')&&l.includes('fallback=timeout'))).toHaveLength(2)
 expect(lines.join('\n')).not.toContain('bad_output')
}))
it('6.93.0 W8: a capture whose window labels are withheld says so once, and /api/health-side state reports the switch and counts',async()=>withLiveVoices({COS_MAC_LIVE_VOICES:'window',COS_MAC_VOICE_LABELS:undefined},async()=>{
 await start();const nemotron=await import('../lib/nemotron-live.js'),replay=await import('../lib/mac-window-replay.js')
 replay.__resetMacWindowCountersForTests()
 vi.mocked(nemotron.nemotronLive.diarize).mockImplementation((async(path:string)=>{
  const samples=(readFileSync(path).length-44)/2,frames=1+Math.floor((samples+112)/160),probs=new Float32Array(frames*8).fill(0.02)
  for(let f=0;f<frames-1;f++)probs[f*8+3]=0.9
  return {ok:true,run:{frames,probs,wallMs:20,loadSec:0,audioSec:samples/16000}}
 }) as any)
 stream.getSession(id).macWindowVoices={version:1,kind:'window',nextTrack:0,voices:7,tracks:[],recent:[{chunk:9,frames:'AA=='}]} as any
 const lines:string[]=[];const log=vi.spyOn(console,'log').mockImplementation((...a:unknown[])=>{lines.push(a.join(' '))})
 try{for(let i=0;i<3;i++)expect((await call('/mac-recording/'+id+'/chunks?chunkIndex='+i+'&elapsed='+((i+1)*6000),wavOf(6,()=>400+i))).json.speaker).toBe('Ext')}finally{log.mockRestore()}
 expect(lines.filter(l=>l.includes('window labels withheld (corrupt_state)'))).toHaveLength(1)
 expect(replay.macLiveVoicesSnapshot().window).toMatchObject({stateWithheld:{corrupt_state:1,earlier_voice_labels:0},runs:0})
}))

it('6.93.0 R3: after two window timeouts in a row the capture stops using the window and runs per-chunk only',async()=>withLiveVoices({COS_MAC_LIVE_VOICES:'window',COS_MAC_VOICE_LABELS:undefined},async()=>{
 await start();const nemotron=await import('../lib/nemotron-live.js'),replay=await import('../lib/mac-window-replay.js'),diarize=vi.mocked(nemotron.nemotronLive.diarize)
 replay.__resetMacWindowCountersForTests()
 const seen:string[]=[]
 diarize.mockImplementation((async(path:string,opts?:any)=>{
  seen.push(path)
  if(path.endsWith('/window.wav'))return {ok:false,reason:'timeout',ms:opts?.timeoutMs}
  return {ok:true,run:{...activityOf(6,[[3,0,6]]),wallMs:20,loadSec:0,audioSec:6}}
 }) as any)
 const lines:string[]=[];const log=vi.spyOn(console,'log').mockImplementation((...a:unknown[])=>{lines.push(a.join(' '))})
 try{for(let i=0;i<5;i++) expect((await call('/mac-recording/'+id+'/chunks?chunkIndex='+i+'&elapsed='+((i+1)*6000),wavOf(6,()=>400+i))).json.speaker).toBe('Ext')}finally{log.mockRestore()}
 expect(seen.filter(p=>p.endsWith('/window.wav'))).toHaveLength(2) // chunks 0 and 1 only; 2 to 4 never start a window
 expect(seen.filter(p=>!p.endsWith('/window.wav'))).toHaveLength(5) // every chunk still gets its per-chunk run
 expect(lines.filter(l=>l.includes('window disabled after 2 window timeouts in a row'))).toHaveLength(1)
 expect(replay.macWindowDisabledFor(id)).toBe(true)
 expect(replay.macLiveVoicesSnapshot().window).toMatchObject({disabledCaptures:1,fallbacks:{timeout:2,geometry:0}})
}))
