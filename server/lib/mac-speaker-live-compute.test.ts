import{describe,it,expect}from'vitest'
import{Worker}from'node:worker_threads'
import{createHash}from'node:crypto'
import{startMacSpeakerLiveCompute,takeMacSpeakerLivePublication,type MacSpeakerLiveComputeInput}from'./mac-speaker-live-compute.js'
import{prepareMacSpeakerLiveCompute}from'./mac-speaker-live-worker.js'
import{hashMacSpeakerLive as h,createMacSpeakerLiveState}from'./mac-speaker-live-memory.js'
const v=[1,...Array(191).fill(0)]
function fixture():MacSpeakerLiveComputeInput{
 const captureId='mac_11111111-1111-4111-8111-111111111111',generation='compute-test',profileJSONBytes=Uint8Array.from(Buffer.from(JSON.stringify({profiles:[{name:'Avery Example',embeddings:[v]}]})))
 const rawChunks=Array.from({length:5},(_,chunkIndex)=>({chunkIndex,audioSHA256:h(['wav',chunkIndex]),pcmSHA256:h(['pcm',chunkIndex]),sampleRate:16000 as const,channels:1 as const,format:'pcm_s16le' as const,sampleCount:96000,verified:true as const}))
 const chunksIndexed=rawChunks.map(r=>({i:r.chunkIndex,c:{speaker:'Voice 1',text:'Exact unchanged text',elapsed:r.chunkIndex*6000,audioDurationMs:6000,audioSha256:r.audioSHA256,speakerPolicy:'high-confidence',segments:[{speaker:'Voice 1',text:'Exact unchanged text',startSec:0,endSec:6}]}}))
 return{captureId,generation,modelSHA256:h('model'),profileSHA256:createHash('sha256').update(profileJSONBytes).digest('hex'),profileJSONBytes,chunksIndexed,rawChunks,sourceBindingSHA256:h(chunksIndexed),fileBindingsSHA256:h('file stamps'),revision:0,voiceHighWater:1,humanHistory:false}
}
const expected=(i:MacSpeakerLiveComputeInput)=>({captureId:i.captureId,generation:i.generation,sourceBindingSHA256:i.sourceBindingSHA256,fileBindingsSHA256:i.fileBindingsSHA256,revision:i.revision,voiceHighWater:i.voiceHighWater,mode:'mac-native-v1' as const})
describe('real off-thread Mac pure transition parity and lifecycle',()=>{
 it('matches direct pure preparation/receipt/projection exactly',async()=>{
  const input=fixture(),direct=prepareMacSpeakerLiveCompute(structuredClone(input)),window=direct.prepared.window!
  const receipt={windowId:window.id,windowBindingSHA256:window.bindingSHA256,modelSHA256:input.modelSHA256,audioSHA256:h('aggregate-wav'),pcmSHA256:h('aggregate-pcm'),sampleCount:window.sampleCount,embedding:v,halfEmbeddings:[v,v]as const}
  const wanted=direct.finish(receipt),job=await startMacSpeakerLiveCompute(input)
  expect(job.prepared).toEqual(direct.prepared)
  const result=await job.finish(receipt),publication=takeMacSpeakerLivePublication(result.capability,expected(input))
  expect(result.state).toEqual(wanted.state);expect(publication).toEqual(wanted.publication)
 })
 it('certifies corrupt retained state only as irreversible original-only withholding',async()=>{
  const input=fixture();input.state={...createMacSpeakerLiveState(input.captureId,input.generation,input.modelSHA256,input.profileSHA256),projections:[{bad:true}]}as any
  const job=await startMacSpeakerLiveCompute(input),result=await job.finish(),publication=takeMacSpeakerLivePublication(result.capability,expected(input))!
  expect(result.state.withheldReason).toBe('recovered_state_invalid');expect(result.state.voiceHighWater).toBe(99);expect(publication.speakerProjectedChunksIndexed).toEqual(input.chunksIndexed);expect(publication.macSpeakerLive!.projections).toEqual([])
 })
 it('rejects real worker early exit, then releases its lane',async()=>{
  const child=new Worker('process.exit(0)',{eval:true});let exited=false;child.on('exit',()=>{exited=true})
  await expect(startMacSpeakerLiveCompute(fixture(),{workerFactory:()=>child})).rejects.toThrow('compute_worker_exited');expect(exited).toBe(true)
  const next=await startMacSpeakerLiveCompute(fixture());await next.close()
 })
 it('rejects a real worker stale reply and confirms closure before re-admission',async()=>{
  const child=new Worker("require('node:worker_threads').parentPort.on('message',m=>require('node:worker_threads').parentPort.postMessage({id:m.id,job:'stale',ok:true,value:{}}))",{eval:true});let exited=false;child.on('exit',()=>{exited=true})
  await expect(startMacSpeakerLiveCompute(fixture(),{workerFactory:()=>child})).rejects.toThrow('compute_stale_reply');expect(exited).toBe(true)
  const next=await startMacSpeakerLiveCompute(fixture());await next.close()
 })
})
