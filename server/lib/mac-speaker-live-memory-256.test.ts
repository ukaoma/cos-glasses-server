import { describe, expect, it } from 'vitest'
import { bindMacSpeakerShadowRepair, type MacShadowRepairSource } from './mac-speaker-shadow-repair.js'
import { hashMacSpeakerLive, reconcileMacSpeaker256Snapshot, validateMacSpeaker256State, type MacSpeaker256SnapshotInput, type MacSpeaker256State } from './mac-speaker-live-memory.js'
import { SYNTHETIC_SPANS, SYNTHETIC_SECONDS, syntheticEmbeddings, syntheticNative } from './__fixtures__/speaker-shadow/synthetic-meeting.js'

const H='a'.repeat(64), B='b'.repeat(64)
/** Fictional vectors/labels only. This fixture does not authenticate native inference. */
function fixture():MacShadowRepairSource {
  const entries:any[]=[]
  for(const span of SYNTHETIC_SPANS)for(let start=span.start;start<span.end;start+=6){
    const duration=Math.min(6,span.end-start),raw=entries.length
    const chunk={text:`synthetic words ${raw}`,speaker:span.label,elapsed:start*1000,audioDurationMs:duration*1000,audioSha256:hashMacSpeakerLive(['wav',raw]),similarity:0,
      segments:[{speaker:span.label,startSec:0,endSec:duration}],finalSegments:[{speaker:span.label,startSec:0,endSec:duration}],words:[{word:`word${raw}`,start:0,end:duration}]}
    entries.push({chunkIndex:raw,chunk})
  }
  const doc={sessionId:'mac_synthetic_memory256',sourceType:'mac_system_audio',finalizationState:'complete',chunks:entries.map(e=>structuredClone(e.chunk)),chunkEntries:entries,
    batchSegments:[{startChunkIdx:0,endChunkIdx:entries.length-1,speakerWords:entries.map(e=>({word:e.chunk.text,speaker:e.chunk.speaker,start:e.chunk.elapsed/1000,end:e.chunk.elapsed/1000+e.chunk.audioDurationMs/1000}))}]}
  const rawAudio=entries.map(e=>({rawChunkIndex:e.chunkIndex,wavSHA256:e.chunk.audioSha256,pcmSHA256:hashMacSpeakerLive(['pcm',e.chunkIndex]),sampleCount:e.chunk.audioDurationMs*16}))
  return{originalJSON:JSON.stringify(doc),currentJSON:JSON.stringify(doc),ledgerJSONL:'',rawAudio,
    timeline:{rows:rawAudio.map((r,i)=>({rawChunkIndex:i,startSample:entries[i].chunk.elapsed*16,sampleCount:r.sampleCount,usedSampleCount:r.sampleCount})),total:SYNTHETIC_SECONDS*16000,pcmSHA256:H},
    cohort:{nativeJSON:JSON.stringify(syntheticNative()),embeddingsJSON:JSON.stringify(syntheticEmbeddings()),modelSHA256:H,cliSHA256:B}}
}
function input(source=fixture(),previous?:MacSpeaker256State):MacSpeaker256SnapshotInput {
  return{...source,sourceBindingSHA256:bindMacSpeakerShadowRepair(source),generation:'synthetic-generation',...(previous?{expectedStateSHA256:previous.stateSHA256}:{})}
}
function edit(source:MacShadowRepairSource,which:'originalJSON'|'currentJSON',change:(doc:any)=>void){const d=JSON.parse(source[which]);change(d);source[which]=JSON.stringify(d)}
function reseal(state:MacSpeaker256State){const{stateSHA256:_,...body}=state;state.stateSHA256=hashMacSpeakerLive(body);return state}
const sourceOf=(s:MacSpeaker256SnapshotInput):MacShadowRepairSource=>{const{generation:_,expectedStateSHA256:__,sourceBindingSHA256:___,...source}=s;return source}
function quartet(split=false):MacShadowRepairSource {
  const source=fixture(),native=JSON.parse(source.cohort.nativeJSON),embeddings=JSON.parse(source.cohort.embeddingsJSON)
  const templates=embeddings.filter((e:any)=>e.startTime<40).map((e:any)=>e.embedding256)
  let n=0
  for(const e of embeddings)if(e.cluster===0){e.embedding256=templates[n++%templates.length];if(split&&(e.startTime>=110&&e.endTime<=130||e.startTime>=325))e.cluster=4}
  if(split)for(const row of native.segments)if(row.startTimeSeconds===110||row.startTimeSeconds===325)row.speakerId='S5'
  source.cohort.embeddingsJSON=JSON.stringify(embeddings);source.cohort.nativeJSON=JSON.stringify(native);return source
}

describe('source-bound256d call-wide recurrence memory',()=>{
  it('retains a long-gap recurrence with exact support and separate unknown tails',()=>{
    const i=input(),before=JSON.stringify(i),s=reconcileMacSpeaker256Snapshot(null,i)
    expect(s.groups).toHaveLength(2)
    const a=s.groups.find(g=>g.memberVoices.includes('Voice 13'))!
    expect(a.memberVoices).toEqual(['Voice 1','Voice 13','Voice 2'])
    expect(a.intervals.some(x=>x.startSample>=325*16000)).toBe(true)
    expect(a.witnesses).toHaveLength(2)
    expect(a.witnesses[0].originalVoice).not.toBe(a.witnesses[1].originalVoice)
    expect(a.witnesses[0].rawChunkIndices.some(r=>a.witnesses[1].rawChunkIndices.includes(r))).toBe(false)
    expect(s.withheld.some(x=>JSON.parse(i.originalJSON).chunkEntries[x.rawChunkIndex].chunk.speaker==='Voice 9')).toBe(true)
    expect(s.provenance).toMatchObject({nativeAuthenticated:false,productionQualified:false})
    expect(a.intervals.every(x=>x.timingBasis==='native-exclusive-intersect-machine-production')).toBe(true)
    validateMacSpeaker256State(s,i)
    expect(JSON.stringify(i)).toBe(before)
  })
  it('keeps different native/acoustic groups distinct without guessing names',()=>{
    const s=reconcileMacSpeaker256Snapshot(null,input())
    expect(new Set(s.groups.map(g=>g.identityId)).size).toBe(2)
    expect(s.groups.flatMap(g=>g.intervals).some(x=>x.originalVoice==='Voice 5')).toBe(false)
    expect(JSON.stringify(s)).not.toContain('Dana Fictional')
  })
  it('restarts idempotently and requires exact optimistic prior-state CAS',()=>{
    const i=input(),s=reconcileMacSpeaker256Snapshot(null,i),next={...i,expectedStateSHA256:s.stateSHA256}
    expect(reconcileMacSpeaker256Snapshot(JSON.parse(JSON.stringify(s)),next)).toEqual(s)
    expect(()=>reconcileMacSpeaker256Snapshot(s,i)).toThrow('state_cas')
    expect(()=>reconcileMacSpeaker256Snapshot(s,{...next,expectedStateSHA256:H})).toThrow('state_cas')
    expect(()=>reconcileMacSpeaker256Snapshot(null,next)).toThrow('unexpected_state_cas')
  })
  it('reuses opaque identities under a native cluster renumbering using reciprocal exact-source overlap',()=>{
    const i=input(),s=reconcileMacSpeaker256Snapshot(null,i),source=sourceOf(i)
    const native=JSON.parse(source.cohort.nativeJSON);for(const row of native.segments)if(row.speakerId==='S1')row.speakerId='S10'
    const embeddings=JSON.parse(source.cohort.embeddingsJSON);for(const e of embeddings)if(e.cluster===0)e.cluster=9
    source.cohort.nativeJSON=JSON.stringify(native);source.cohort.embeddingsJSON=JSON.stringify(embeddings)
    const n=reconcileMacSpeaker256Snapshot(s,input(source,s))
    expect(n.revision).toBe(s.revision+1)
    expect(n.groups.map(g=>g.identityId).sort()).toEqual(s.groups.map(g=>g.identityId).sort())
    validateMacSpeaker256State(n,input(source,s))
  })
  it('withdraws absent recurrence and never resurrects its retired namespace',()=>{
    const i=input(),s=reconcileMacSpeaker256Snapshot(null,i),source=sourceOf(i),originalNative=source.cohort.nativeJSON
    const native=JSON.parse(originalNative);native.segments=native.segments.filter((r:any)=>r.speakerId!=='S1');source.cohort.nativeJSON=JSON.stringify(native)
    const n=reconcileMacSpeaker256Snapshot(s,input(source,s)),retired=s.groups.find(g=>g.nativeCluster==='S1')!.identityId
    expect(n.withdrawn.map(x=>x.identityId)).toContain(retired)
    expect(n.identities.find(x=>x.identityId===retired)?.retired).toBe(true)
    source.cohort.nativeJSON=originalNative
    const returned=reconcileMacSpeaker256Snapshot(n,input(source,n))
    expect(returned.groups.some(g=>g.identityId===retired)).toBe(false)
    expect(returned.withheld.some(x=>x.reason==='split-merge-or-retired-lineage')).toBe(true)
    expect(returned.identityHighWater).toBe(n.identityHighWater)
    validateMacSpeaker256State(returned,input(source,n))
  })
  it('explicitly withdraws a split instead of giving either descendant the old identity',()=>{
    const s=reconcileMacSpeaker256Snapshot(null,input(quartet())),old=s.groups.find(g=>g.nativeCluster==='S1')!
    expect(old.memberVoices).toHaveLength(4)
    const n=reconcileMacSpeaker256Snapshot(s,input(quartet(true),s))
    expect(n.coverage.independentQualifiedGroups).toBe(3)
    expect(n.groups.some(g=>g.nativeCluster==='S1'||g.nativeCluster==='S5')).toBe(false)
    expect(n.withdrawn.map(x=>x.identityId)).toContain(old.identityId)
    expect(n.withheld.some(x=>x.reason==='split-merge-or-retired-lineage')).toBe(true)
    validateMacSpeaker256State(n,input(quartet(true),s))
  })
  it('explicitly withdraws both predecessors when independent groups merge',()=>{
    const s=reconcileMacSpeaker256Snapshot(null,input(quartet(true))),old=s.groups.filter(g=>g.nativeCluster==='S1'||g.nativeCluster==='S5')
    expect(old).toHaveLength(2)
    const n=reconcileMacSpeaker256Snapshot(s,input(quartet(),s))
    expect(n.coverage.independentQualifiedGroups).toBe(2)
    expect(n.groups.some(g=>g.nativeCluster==='S1')).toBe(false)
    expect(n.withdrawn.map(x=>x.identityId)).toEqual(expect.arrayContaining(old.map(g=>g.identityId)))
    validateMacSpeaker256State(n,input(quartet(),s))
  })
  it('never treats copied PCM or overlapping export crops as independent witnesses',()=>{
    const source=fixture();for(const raw of source.rawAudio)raw.pcmSHA256=H
    const s=reconcileMacSpeaker256Snapshot(null,input(source))
    expect(s.coverage.acceptedRecurrenceGroups).toBe(2)
    expect(s.groups).toEqual([])
    expect(s.coverage.supportedSamples).toBe(0)
  })
  it('does not fill native gaps or overlaps with the old whole-chunk label',()=>{
    const source=fixture(),native=JSON.parse(source.cohort.nativeJSON)
    const first=native.segments[0];first.endTimeSeconds=3
    native.segments.push({...first,startTimeSeconds:4,endTimeSeconds:40})
    native.segments.push({speakerId:'S99',startTimeSeconds:7,endTimeSeconds:8,qualityScore:1})
    source.cohort.nativeJSON=JSON.stringify(native)
    const s=reconcileMacSpeaker256Snapshot(null,input(source)),spans=s.groups.flatMap(g=>g.intervals)
    for(const[lo,hi]of [[3,4],[7,8]])expect(spans.some(x=>x.startSample<hi*16000&&x.endSample>lo*16000)).toBe(false)
    expect(spans.some(x=>x.startSample===0&&x.endSample===3*16000)).toBe(true)
    expect(s.withheld.some(x=>x.startSample===3*16000&&x.endSample===4*16000)).toBe(true)
  })
  for(const marker of ['speakerOrigin','manuallyCorrected'] as const)for(const surface of ['root','segments','finalSegments','batchWords'] as const)it(`protects ${marker} on ${surface} from support and projection`,()=>{
    const source=fixture();edit(source,'currentJSON',d=>{
      const row=surface==='batchWords'?d.batchSegments[0].speakerWords[0]:surface==='root'?d.chunks[0]:d.chunks[0][surface][0]
      row[marker]=marker==='speakerOrigin'?'manual':true
    })
    const i=input(source),s=reconcileMacSpeaker256Snapshot(null,i)
    expect(s.groups.flatMap(g=>g.intervals).some(x=>x.rawChunkIndex===0)).toBe(false)
    expect(s.groups.flatMap(g=>g.witnesses).some(w=>w.rawChunkIndices.includes(0))).toBe(false)
    expect(s.withheld.some(x=>x.rawChunkIndex===0&&x.reason==='protected-source')).toBe(true)
    validateMacSpeaker256State(s,i)
  })
  it('preserves a named current original and does not borrow its name for a group',()=>{
    const source=fixture();edit(source,'currentJSON',d=>{d.chunks[0].speaker='Human Example'})
    const s=reconcileMacSpeaker256Snapshot(null,input(source))
    expect(s.groups.flatMap(g=>g.intervals).some(x=>x.rawChunkIndex===0)).toBe(false)
    expect(JSON.stringify(s)).not.toContain('Human Example')
  })
  it('honors an empty human confirmation as protect-all, without discarding its denominator',()=>{
    const source=fixture();source.ledgerJSONL=JSON.stringify({id:'confirm',phase:'confirmed',chunks:[],to:'Human Example'})
    const s=reconcileMacSpeaker256Snapshot(null,input(source))
    expect(s.groups).toEqual([]);expect(s.coverage.protectedOriginals).toBe(source.rawAudio.length)
    expect(s.coverage.machineSpeechSamples).toBe(SYNTHETIC_SECONDS*16000)
  })
  it('rejects source/model/generation drift and partial raw manifests',()=>{
    const i=input(),s=reconcileMacSpeaker256Snapshot(null,i)
    expect(()=>reconcileMacSpeaker256Snapshot(s,{...i,generation:'other',expectedStateSHA256:s.stateSHA256})).toThrow('model_or_capture_drift')
    const source=sourceOf(i);source.cohort.modelSHA256=B
    expect(()=>reconcileMacSpeaker256Snapshot(s,input(source,s))).toThrow('model_or_capture_drift')
    source.cohort.modelSHA256=H;source.rawAudio.pop()
    expect(()=>reconcileMacSpeaker256Snapshot(null,input(source))).toThrow()
  })
  it('rejects substituted original raw bytes even with a newly sealed current input',()=>{
    const i=input(),s=reconcileMacSpeaker256Snapshot(null,i),source=sourceOf(i),changed='c'.repeat(64)
    source.rawAudio[0].wavSHA256=changed
    for(const which of ['originalJSON','currentJSON'] as const)edit(source,which,d=>{d.chunks[0].audioSha256=changed;d.chunkEntries[0].chunk.audioSha256=changed})
    expect(()=>reconcileMacSpeaker256Snapshot(s,input(source,s))).toThrow('original_source_drift')
  })
  it('rejects a192-dimensional vector instead of comparing spaces',()=>{
    const source=fixture(),e=JSON.parse(source.cohort.embeddingsJSON);e[0].embedding256=e[0].embedding256.slice(0,192);source.cohort.embeddingsJSON=JSON.stringify(e)
    expect(()=>reconcileMacSpeaker256Snapshot(null,input(source))).toThrow(/256d/)
  })
  it('records complete terminal-window quarantine without reusing a clipped vector',()=>{
    const source=fixture(),e=JSON.parse(source.cohort.embeddingsJSON);e.push({...e.at(-1),startTime:SYNTHETIC_SECONDS-2,endTime:SYNTHETIC_SECONDS+.25});source.cohort.embeddingsJSON=JSON.stringify(e)
    const i=input(source),s=reconcileMacSpeaker256Snapshot(null,i)
    expect(s.excludedEmbeddingWindows).toEqual([expect.objectContaining({originalIndex:e.length-1,reason:'window-crosses-capture-end'})])
    validateMacSpeaker256State(s,i)
  })
  it('replays semantics rather than trusting a resealed interval, coverage or provenance',()=>{
    const i=input(),s=reconcileMacSpeaker256Snapshot(null,i)
    for(const mutation of [(x:MacSpeaker256State)=>x.coverage.supportedSamples++, (x:MacSpeaker256State)=>{x.provenance.nativeAuthenticated=true as false}, (x:MacSpeaker256State)=>{x.rawBindings[0].audioSHA256=B},(x:MacSpeaker256State)=>{x.withheld.pop()}]){
      const corrupt=structuredClone(s);mutation(corrupt);reseal(corrupt);expect(()=>validateMacSpeaker256State(corrupt,i)).toThrow()
    }
    const corrupt=structuredClone(s),g=corrupt.groups[0];g.intervals[0].endSample--
    corrupt.identities.find(x=>x.identityId===g.identityId)!.lastIntervals=structuredClone(g.intervals)
    const{identityId:_,groupSHA256:__,...body}=g
    g.groupSHA256=hashMacSpeakerLive({...body,intervals:g.intervals.map(({identityId:___,...x})=>x)})
    reseal(corrupt);expect(()=>validateMacSpeaker256State(corrupt,i)).toThrow()
  })
  it('rejects namespace/counter corruption without recycling an identifier',()=>{
    const i=input(),s=reconcileMacSpeaker256Snapshot(null,i)
    for(const mutate of [(x:MacSpeaker256State)=>{x.identityHighWater=1025},(x:MacSpeaker256State)=>{x.revision=9999999},(x:MacSpeaker256State)=>{x.identities[0].identityId=x.identities[1].identityId},(x:MacSpeaker256State)=>{x.identities[0].retired=true}]){
      const corrupt=structuredClone(s);mutate(corrupt);reseal(corrupt);expect(()=>validateMacSpeaker256State(corrupt,i)).toThrow()
    }
  })
})
