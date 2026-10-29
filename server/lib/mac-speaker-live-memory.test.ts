import{describe,it,expect}from'vitest'
import{planMacSpeakerWindows}from'./mac-speaker-windows.js'
import{createMacSpeakerLiveState,appendMacSpeakerLiveEvidence,validateMacSpeakerLiveState,withholdMacSpeakerLiveState,replayMacSpeakerLiveEvidence,hashMacSpeakerLive,type MacSpeakerLiveEvidence}from'./mac-speaker-live-memory.js'
const h=(s:string)=>hashMacSpeakerLive(s),captureId='mac_11111111-1111-4111-8111-111111111111',modelSHA256=h('model'),profileSHA256=h('profiles')
const vector=(angle=0)=>[Math.cos(angle),Math.sin(angle),...Array(190).fill(0)]
function evidence(n:number,angle=0,halves=[angle,angle],hint='Voice 1'):MacSpeakerLiveEvidence{
 const raw=Array.from({length:5},(_,i)=>({chunkIndex:n*5+i,audioSHA256:h(`wav${n}-${i}`),pcmSHA256:h(`pcm${n}-${i}`),sampleRate:16000 as const,channels:1 as const,format:'pcm_s16le' as const,sampleCount:96000,verified:true as const}))
 const chunkEntries=raw.map(r=>({chunkIndex:r.chunkIndex,chunk:{speaker:hint,text:'Example',elapsed:r.chunkIndex*6000,audioSha256:r.audioSHA256,speakerPolicy:'high-confidence' as const,similarity:0,segments:[{speaker:hint,text:'Example',startSec:0,endSec:6,similarity:0}]}}))
 const window=planMacSpeakerWindows({sidecar:{sessionId:captureId,chunkEntries},rawChunks:raw,correctionHistory:'verified-clear'}).windows[0]
 const receipt={windowId:window.id,windowBindingSHA256:window.bindingSHA256,modelSHA256,audioSHA256:h(`aggregate-wav${n}`),pcmSHA256:h(`aggregate-pcm${n}`),sampleCount:480000,embedding:vector(angle),halfEmbeddings:[vector(halves[0]),vector(halves[1])]as const}
 return{window,receipt,nativeReceiptSHA256:hashMacSpeakerLive({window,receipt})}
}
const initial=()=>createMacSpeakerLiveState(captureId,'generation-test',modelSHA256,profileSHA256)
const profiles=[{name:'Avery Sample',embeddings:[vector()],profileSHA256},{name:'Blake Sample',embeddings:[vector(Math.PI/2)],profileSHA256}]
describe('capture-long source-bound Mac speaker identity memory',()=>{
 it('requires two independent windows, retains returning voices across a long gap and restart',()=>{
  const first=appendMacSpeakerLiveEvidence(initial(),evidence(0),profiles);expect(first.projections).toEqual([])
  const second=appendMacSpeakerLiveEvidence(first,evidence(100),profiles)
  expect(second.projections).toHaveLength(10);expect(second.projections.every(p=>p.displayLabel==='Avery Sample')).toBe(true)
  const third=appendMacSpeakerLiveEvidence(JSON.parse(JSON.stringify(second)),evidence(300),profiles)
  expect(third.projections).toHaveLength(15);expect(new Set(third.projections.map(p=>p.identityId)).size).toBe(1)
  expect(first.projections).toEqual([]);validateMacSpeakerLiveState(third)
 })
 it('keeps two different voices separate without names or attendee-count hints',()=>{
  const state=replayMacSpeakerLiveEvidence({captureId,generation:'x',modelSHA256,profileSHA256,evidence:[evidence(0),evidence(1),evidence(2,Math.PI/2),evidence(3,Math.PI/2)],profiles:[]})
  expect(new Set(state.projections.map(p=>p.identityId)).size).toBe(2);expect(new Set(state.projections.map(p=>p.displayLabel))).toEqual(new Set(['Voice 1','Voice 2']))
 })
 it('preserves strict full-cohort profile ambiguity without enrollment',()=>{
  const p=[profiles[0],{...profiles[0],name:'Casey Sample'}],before=JSON.stringify(p)
  let state=appendMacSpeakerLiveEvidence(initial(),evidence(0),p);state=appendMacSpeakerLiveEvidence(state,evidence(1),p)
  expect(state.projections.every(p=>p.profileName===undefined)).toBe(true);expect(JSON.stringify(p)).toBe(before)
 })
 it('retains MU as a full-cohort competitor without displaying it',()=>{
  const mu={name:'MU',embeddings:[vector()],profileSHA256}
  const winner=replayMacSpeakerLiveEvidence({captureId,generation:'x',modelSHA256,profileSHA256,evidence:[evidence(0),evidence(1)],profiles:[mu,profiles[1]]})
  expect(winner.projections).toHaveLength(10);expect(winner.projections.every(p=>p.profileName===undefined&&p.displayLabel==='Voice 1')).toBe(true)
  const tie=replayMacSpeakerLiveEvidence({captureId,generation:'x',modelSHA256,profileSHA256,evidence:[evidence(0),evidence(1)],profiles:[mu,profiles[0]]})
  expect(tie.projections.every(p=>p.profileName===undefined)).toBe(true)
 })
 it('rejects rehashed threshold and projection-reference corruption',()=>{
  let state=appendMacSpeakerLiveEvidence(initial(),evidence(0),[]);state=appendMacSpeakerLiveEvidence(state,evidence(1),[])
  const reseal=(s:typeof state)=>{const{stateSHA256,...body}=s;s.stateSHA256=hashMacSpeakerLive(body);return s}
  const changed=structuredClone(state);changed.memory.thresholds.anonymousCosine=.1
  expect(()=>validateMacSpeakerLiveState(reseal(changed))).toThrow()
  const forged=structuredClone(state);forged.projections[0].evidenceIds[0]=h('missing')
  expect(()=>validateMacSpeakerLiveState(reseal(forged))).toThrow('live_projection_support')
  const crossed=structuredClone(state);crossed.projections[0].endSample++
  expect(()=>validateMacSpeakerLiveState(reseal(crossed))).toThrow('live_projection_source')
 })
 it('refuses same original crops, duplicate PCM, crossed source intervals and modified receipts',()=>{
  const first=appendMacSpeakerLiveEvidence(initial(),evidence(0),[])
  expect(appendMacSpeakerLiveEvidence(first,evidence(0),[]).revision).toBe(first.revision)
  const repeated=evidence(1);repeated.window.sources[0].pcmSHA256=first.evidence[0].window.sources[0].pcmSHA256
  expect(()=>appendMacSpeakerLiveEvidence(first,repeated,[])).toThrow()
  const changed=evidence(1);changed.receipt.embedding=vector(.2)
  expect(()=>appendMacSpeakerLiveEvidence(first,changed,[])).toThrow('live_receipt_hash')
 })
 it('withholds against a failed-half full confuser rather than dropping it',()=>{
  let state=appendMacSpeakerLiveEvidence(initial(),evidence(0),[]);state=appendMacSpeakerLiveEvidence(state,evidence(1),[])
  expect(state.projections).toHaveLength(10)
  state=appendMacSpeakerLiveEvidence(state,evidence(2,0,[0,Math.PI/2]),[])
  expect(state.evidence).toHaveLength(3);expect(state.projections).toEqual([])
 })
 it('allows only compatible failed-half non-support and revokes on a late coherent singleton',()=>{
  let state=appendMacSpeakerLiveEvidence(initial(),evidence(0,0),[]);state=appendMacSpeakerLiveEvidence(state,evidence(1,.3),[])
  state=appendMacSpeakerLiveEvidence(state,evidence(2,.15,[-.1,.355]),[])
  expect(state.projections).toHaveLength(10);expect(state.projections.some(p=>p.rawChunkIndex>=10)).toBe(false)
  state=appendMacSpeakerLiveEvidence(state,evidence(3,-.45),[])
  expect(state.projections).toEqual([])
 })
 it('keeps the namespace monotonic and never resurrects retired labels',()=>{
  let state=createMacSpeakerLiveState(captureId,'x',modelSHA256,profileSHA256,8)
  state=appendMacSpeakerLiveEvidence(state,evidence(0),[]);state=appendMacSpeakerLiveEvidence(state,evidence(1),[])
  expect(state.projections[0].displayLabel).toBe('Voice 9')
  state=withholdMacSpeakerLiveState(state,'human_history');const high=state.voiceHighWater
  state=appendMacSpeakerLiveEvidence(state,evidence(2),[])
  expect(state.projections).toEqual([]);expect(state.voiceHighWater).toBe(high)
 })
 it('withholds at namespace exhaustion instead of reusing old numbers',()=>{
  let state=createMacSpeakerLiveState(captureId,'x',modelSHA256,profileSHA256,99)
  state=appendMacSpeakerLiveEvidence(state,evidence(0),[]);state=appendMacSpeakerLiveEvidence(state,evidence(1),[])
  expect(state.withheldReason).toBe('voice_namespace_exhausted');expect(state.projections).toEqual([])
 })
 it('refuses corrupt recovery, model/profile drift and garbage vectors',()=>{
  const state=initial();const changed=structuredClone(state);changed.revision++
  expect(()=>validateMacSpeakerLiveState(changed)).toThrow('live_state_hash')
  expect(()=>appendMacSpeakerLiveEvidence(state,evidence(0),[{...profiles[0],profileSHA256:h('other')}])).toThrow('live_profile_drift')
  const bad=evidence(0);bad.receipt.embedding=Array(192).fill(0)
  expect(()=>appendMacSpeakerLiveEvidence(state,bad,[])).toThrow('live_evidence_binding')
 })
 it('treats a supplied receipt set as a bounded replay, never a whole-call completeness proof',()=>{
  const state=replayMacSpeakerLiveEvidence({captureId,generation:'x',modelSHA256,profileSHA256,evidence:Array(257).fill(evidence(0)),profiles:[]})
  expect(state.withheldReason).toBe('evidence_budget_exhausted');expect(state.projections).toEqual([])
 })
})
