import{describe,it,expect}from'vitest'
import{createMacSpeakerLiveState,hashMacSpeakerLive}from'./mac-speaker-live-memory.js'
import{macSpeakerLiveVoiceHighWater,prepareMacSpeakerLivePublication}from'./mac-speaker-live-store.js'
const captureId='mac_11111111-1111-4111-8111-111111111111',generation='test',h=(s:unknown)=>hashMacSpeakerLive(s)
const original={i:0,c:{speaker:'Voice 7',text:'Untouched words',elapsed:0,audioDurationMs:6000,audioSha256:h('raw'),segments:[{speaker:'Voice 9',text:'Untouched words',startSec:0,endSec:6}]}}
describe('atomic speaker publication preparation',()=>{
 it('reserves every root/nested legacy Voice including original diagnostics',()=>{expect(macSpeakerLiveVoiceHighWater([original.c,{speaker:'Ext',words:[{speaker:'Voice 48'}],originalSpeaker:'Voice 49'}],4)).toBe(49)})
 it('returns a valid original-only replacement for corrupted recovery and never resets namespace',()=>{
  const broken={...createMacSpeakerLiveState(captureId,generation,h('model'),h('profiles')),projections:[{garbage:true}]}as any
  const result=prepareMacSpeakerLivePublication({captureId,generation,chunksIndexed:[original],state:broken,validated:false,revision:17,previousDigest:h('old')})
  expect(result.speakerRevision).toBe(18);expect(result.macSpeakerLive!.revision).toBe(18);expect(result.macSpeakerLive!.voiceHighWater).toBe(99)
  expect(result.macSpeakerLive!.projections).toEqual([]);expect(result.macSpeakerLiveQuarantineSHA256).toBe(h(broken));expect(result.speakerProjectedChunksIndexed).toEqual([original])
 })
 it('advances a missing-state withdrawal and retires its untrusted namespace',()=>{
  const result=prepareMacSpeakerLivePublication({captureId,generation,chunksIndexed:[original],validated:false,revision:17,previousDigest:h('previous claims')})
  expect(result.speakerRevision).toBe(18);expect(result.macSpeakerLive!.projections).toEqual([]);expect(result.macSpeakerLive!.voiceHighWater).toBe(99);expect(result.macSpeakerLive!.withheldReason).toBe('recovered_state_missing')
 })
 it('uses the reserved terminal counter only for original-only irreversible withdrawal',()=>{
  for(const revision of [9999998,10000000,Number.MAX_SAFE_INTEGER,Number.NaN]){
   const result=prepareMacSpeakerLivePublication({captureId,generation,chunksIndexed:[original],validated:false,revision,previousDigest:h('claimed')})
   expect(result.speakerRevision).toBe(9999999);expect(result.macSpeakerLive!.revision).toBe(9999999);expect(result.macSpeakerLive!.voiceHighWater).toBe(99);expect(result.macSpeakerLive!.projections).toEqual([]);expect(result.macSpeakerLive!.withheldReason).toBe('revision_counter_exhausted');expect(result.speakerProjectedChunksIndexed).toEqual([original])
   const again=prepareMacSpeakerLivePublication({captureId,generation,chunksIndexed:[original],state:result.macSpeakerLive,validated:true,revision:result.speakerRevision,previousDigest:result.speakerProjectionSHA256})
   expect(again.speakerRevision).toBe(9999999);expect(again.macSpeakerLive!.projections).toEqual([])
  }
 })
 it('refuses a prior terminal claim when no strictly newer clear is representable',()=>{
  expect(()=>prepareMacSpeakerLivePublication({captureId,generation,chunksIndexed:[original],validated:false,revision:9999999,previousDigest:h('prior terminal claim')})).toThrow('live_revision_exhausted')
 })
 it('retains valid private evidence while recovery publishes no claims',()=>{
  const state=createMacSpeakerLiveState(captureId,generation,h('model'),h('profiles'),9)
  const result=prepareMacSpeakerLivePublication({captureId,generation,chunksIndexed:[original],state,validated:false,revision:8,previousDigest:h('old')})
  expect(result.speakerProjectedChunksIndexed).toEqual([original]);expect(result.macSpeakerLive!.voiceHighWater).toBe(9);expect(result.macSpeakerLive!.withheldReason).toBeNull();expect(result.speakerRevision).toBe(9)
  const again=prepareMacSpeakerLivePublication({captureId,generation,chunksIndexed:[original],state:result.macSpeakerLive,validated:false,revision:result.speakerRevision,previousDigest:result.speakerProjectionSHA256})
  expect(again.speakerRevision).toBe(9)
 })
})
