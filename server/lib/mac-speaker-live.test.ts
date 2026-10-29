import{afterEach,describe,it,expect,vi}from'vitest'
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync}from'node:fs'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{createHash}from'node:crypto'
import{pcm16ToWav}from'./nemotron-segments.js'
import{createMacSpeakerLiveScheduler,runMacSpeakerLivePass,macSpeakerLiveEnabled,type MacSpeakerLiveInput}from'./mac-speaker-live.js'
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const v=[1,...Array(191).fill(0)]
function fixture(count=10){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mac-live-runtime-')));roots.push(root);mkdirSync(join(root,'audio'))
 const modelPath=join(root,'model.onnx'),profilesPath=join(root,'profiles.json');writeFileSync(modelPath,'fake-model-no-native');writeFileSync(profilesPath,JSON.stringify({profiles:[{name:'Avery Example',embeddings:[v]}]}))
 const chunksIndexed=Array.from({length:count},(_,i)=>{
  const pcm=Buffer.alloc(192000);for(let at=0;at<pcm.length;at+=2)pcm.writeInt16LE((i+1)*3,at)
  const wav=pcm16ToWav(pcm,16000);writeFileSync(join(root,'audio',`chunk_${String(i).padStart(4,'0')}.wav`),wav)
  return{i,c:{speaker:'Voice 1',text:`Exact words ${i}`,elapsed:i*6000,audioDurationMs:6000,audioSha256:sha(wav),similarity:0,speakerPolicy:'high-confidence',segments:[{speaker:'Voice 1',text:`Exact words ${i}`,startSec:0,endSec:6,similarity:0}]}}
 })
 const input:MacSpeakerLiveInput={captureId:'mac_11111111-1111-4111-8111-111111111111',generation:'test',audioDir:join(root,'audio'),ledgerPath:join(root,'ledger.jsonl'),chunksIndexed,voiceHighWater:1}
 const extract=vi.fn(async()=>[v,v,v]),deps={admit:()=>true,runtime:async()=>({modelPath,profilesPath}),extract}
 return{root,input,deps,extract,modelPath,profilesPath}
}
describe('background Mac live extraction adapter without native inference',()=>{
 it('defaults off without changing transcription or cue flags',()=>{expect(macSpeakerLiveEnabled({})).toBe(false);expect(macSpeakerLiveEnabled({COS_MAC_SPEAKER_LIVE:'1'})).toBe(true)})
 it('enumerates the complete plan beyond12 windows and processes one per invocation',async()=>{
  const f=fixture(70),before=JSON.stringify(f.input.chunksIndexed),start=performance.now();let input=f.input
  for(let n=0;n<14;n++){
   const result=await runMacSpeakerLivePass(input,f.deps);expect(result.plannedWindows).toBe(14);expect(result.attemptedWindows).toBe(1);expect(result.pendingWindows).toBe(13-n);expect(result.completeEligibleSnapshot).toBe(n===13)
   expect(result.state).toBeDefined();input={...input,state:result.state,voiceHighWater:result.state!.voiceHighWater}
  }
  expect(f.extract).toHaveBeenCalledTimes(14);expect(input.state!.projections).toHaveLength(70)
  expect(JSON.stringify(f.input.chunksIndexed)).toBe(before)
  // Synthetic local I/O upper bound, not a native latency claim.
  expect(performance.now()-start).toBeLessThan(10000)
 })
 it('does not let unhashed placeholders skip otherwise verified speech',async()=>{
  const f=fixture();f.input.chunksIndexed=[{i:999,c:{text:'',speaker:'Ext',elapsed:0}},...f.input.chunksIndexed]
  const result=await runMacSpeakerLivePass(f.input,f.deps);expect(result.plannedWindows).toBe(2);expect(f.extract).toHaveBeenCalledOnce()
 })
 it('refuses history or nested manual rows before extraction',async()=>{
  const f=fixture();writeFileSync(f.input.ledgerPath,'{"speaker":"Human"}\n')
  expect((await runMacSpeakerLivePass(f.input,f.deps)).reason).toBe('human_history');expect(f.extract).not.toHaveBeenCalled()
  rmSync(f.input.ledgerPath);(f.input.chunksIndexed[0].c as any).segments[0].manuallyCorrected=true
  expect((await runMacSpeakerLivePass(f.input,f.deps)).reason).toBe('human_history');expect(f.extract).not.toHaveBeenCalled()
 })
 it('checks model drift after owned child completion before publishing',async()=>{
  const f=fixture();f.extract.mockImplementation(async()=>{writeFileSync(f.modelPath,'changed');return[v,v,v]})
  const result=await runMacSpeakerLivePass(f.input,f.deps);expect(result.reason).toBe('model_profile_or_history_changed');expect(result.completeEligibleSnapshot).toBe(false);expect(result.state!.projections).toEqual([])
 })
 it('refuses model ABA even when original bytes are restored before return',async()=>{
  const f=fixture(),bytes=readFileSync(f.modelPath)
  f.extract.mockImplementation(async()=>{writeFileSync(f.modelPath,'temporary other model');writeFileSync(f.modelPath,bytes);return[v,v,v]})
  const result=await runMacSpeakerLivePass(f.input,f.deps);expect(result.reason).toBe('live_publication_source_changed');expect(result.completeEligibleSnapshot).toBe(false);expect(result.state!.projections).toEqual([])
 })
 it('invalidates historical raw pins on metadata drift',async()=>{
  const f=fixture(),first=await runMacSpeakerLivePass(f.input,f.deps)
  const path=join(f.input.audioDir,'chunk_0000.wav'),bytes=readFileSync(path);bytes[44]^=1;writeFileSync(path,bytes)
  const result=await runMacSpeakerLivePass({...f.input,state:first.state,voiceHighWater:first.state!.voiceHighWater},f.deps)
  expect(result.reason).toBe('raw_audio_drift');expect(result.state!.projections).toEqual([]);expect(f.extract).toHaveBeenCalledTimes(1)
 })
 it('coalesces work, drains all eligible evidence, and never overlaps extractors',async()=>{
  const f=fixture(),outcomes:any[]=[];let state=f.input.state,active=0,peak=0
  f.extract.mockImplementation(async()=>{peak=Math.max(peak,++active);await new Promise(r=>setImmediate(r));active--;return[v,v,v]})
  const scheduler=createMacSpeakerLiveScheduler({snapshot:()=>({...f.input,state,voiceHighWater:state?.voiceHighWater??1}),commit:(_id,out)=>{state=out.state;outcomes.push(out);return true},runtime:f.deps})
  scheduler.schedule(f.input.captureId);scheduler.schedule(f.input.captureId);await scheduler.drain()
  expect(peak).toBe(1);expect(f.extract).toHaveBeenCalledTimes(2);expect(outcomes.at(-1).completeEligibleSnapshot).toBe(true)
 })
 it('holds maintenance ownership through extraction and synchronous publication',async()=>{
  const f=fixture(),events:string[]=[];let release:()=>void=()=>{}
  f.extract.mockImplementation(async()=>{events.push('extract');await new Promise<void>(r=>{release=r});return[v,v,v]})
  const scheduler=createMacSpeakerLiveScheduler({snapshot:()=>f.input,lease:()=>{events.push('lease');return{release(){events.push('release')}}},commit:()=>{events.push('commit');return false},runtime:f.deps})
  scheduler.schedule(f.input.captureId);const done=scheduler.drain()
  while(!events.includes('extract'))await new Promise(r=>setImmediate(r))
  expect(events).toEqual(['lease','extract']);release();await done;expect(events).toEqual(['lease','extract','commit','release'])
 })
 it('rechecks admission after awaited setup before starting a new child',async()=>{
  const f=fixture();let admitted=true
  const result=await runMacSpeakerLivePass(f.input,{...f.deps,admit:()=>admitted,runtime:async()=>{admitted=false;return{modelPath:f.modelPath,profilesPath:f.profilesPath}}})
  expect(result.reason).toBe('live_admission_closed');expect(f.extract).not.toHaveBeenCalled()
 })
 it('does not spin or report completeness when extraction is unavailable',async()=>{
  const f=fixture(),extract=vi.fn(async()=>null),outcomes:any[]=[]
  const scheduler=createMacSpeakerLiveScheduler({snapshot:()=>f.input,commit:(_id,o)=>{outcomes.push(o);return true},runtime:{...f.deps,extract}})
  scheduler.schedule(f.input.captureId);await scheduler.drain();expect(extract).toHaveBeenCalledTimes(1);expect(outcomes[0].completeEligibleSnapshot).toBe(false)
 })
})
