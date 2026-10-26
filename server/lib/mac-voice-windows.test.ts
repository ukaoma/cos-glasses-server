import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { planMacVoiceWindow as plan, assembleMacVoiceWindow as assemble, independentMacVoiceWindows as independent,
  MAC_VOICE_WINDOW_MAX_SOURCES, MAC_VOICE_WINDOW_MAX_SAMPLES, type MacVoiceSource, type MacVoiceWindow, type MacVoiceWindowState } from './mac-voice-windows.js'
const id='mac_00000000-0000-4000-8000-000000000001'
const ref=(index:number, seconds=6):MacVoiceSource=>({chunkIndex:index,startSample:index*6*16000,samples:seconds*16000,audioSha256:index.toString(16).padStart(64,'0')})
function next(state:MacVoiceWindowState|undefined, source:MacVoiceSource){const p=plan(id,state,source);if(p.status!=='ready'&&p.status!=='collecting')throw Error(p.status);return p}
const window=(index:number):MacVoiceWindow=>({captureId:id,sources:[ref(index),ref(index+1)]})
function wav(index:number){
 const source=ref(index),audio=Buffer.alloc(44+source.samples*2);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(source.samples*2,40);audio.fill(index,44);source.audioSha256=createHash('sha256').update(audio).digest('hex');return {source,audio}
}
describe('candidate Mac temporal windows (no quality claim or live wiring)',()=>{
 it('stages disjoint12s windows and retries a failed durable commit without consuming either source',()=>{
  const first=next(undefined,ref(77)),before=structuredClone(first.next)
  const ready=next(first.next,ref(78));expect(ready.status).toBe('ready');expect(ready.window?.sources.map(s=>s.chunkIndex)).toEqual([77,78])
  expect(first.next).toEqual(before);expect(next(first.next,ref(78))).toEqual(ready)
  expect(plan(id,ready.next,ref(78))).toEqual({status:'duplicate'})
  const third=next(ready.next,ref(79)),fourth=next(third.next,ref(80));expect(fourth.window?.sources.map(s=>s.chunkIndex)).toEqual([79,80]);expect(independent(ready.window!,fourth.window!)).toBe(true)
  ready.window!.sources[0].chunkIndex=999;expect(ready.next.previous[0].chunkIndex).toBe(77)
 })
 it('cannot bridge missing indices or clock gaps and refuses overlap, older completions and conflicting retries',()=>{
  const first=next(undefined,ref(0))
  const gap=next(first.next,ref(2));expect(gap.reset).toBe('gap');expect(gap.status).toBe('collecting');expect(gap.next.pending.map(s=>s.chunkIndex)).toEqual([2])
  const clock=next(first.next,{...ref(1),startSample:ref(1).startSample+1});expect(clock.reset).toBe('gap');expect(clock.status).toBe('collecting')
  expect(plan(id,first.next,{...ref(1),startSample:1})).toEqual({status:'rejected',reason:'out_of_order'})
  const ready=next(first.next,ref(1));expect(plan(id,ready.next,ref(0))).toEqual({status:'rejected',reason:'out_of_order'})
  expect(plan(id,first.next,{...ref(0),audioSha256:ref(8).audioSha256})).toEqual({status:'rejected',reason:'index_conflict'})
 })
 it('rejects reused audio under new indices and cannot call overlapping windows independent',()=>{
  const first=next(undefined,ref(0));const duplicate=next(first.next,{...ref(1),audioSha256:ref(0).audioSha256});expect(duplicate.reset).toBe('duplicate_audio');expect(duplicate.next.pending).toEqual([])
  const again=next(duplicate.next,{...ref(2),audioSha256:ref(0).audioSha256});expect(again.reset).toBe('duplicate_audio');expect(again.next.pending).toEqual([])
  const ready=next(first.next,ref(1));const reuse=next(ready.next,{...ref(2),audioSha256:ref(0).audioSha256});expect(reuse.reset).toBe('duplicate_audio');expect(reuse.next.pending).toEqual([])
  expect(independent(window(0),window(1))).toBe(false)
  expect(independent(window(0),{...window(2),sources:[{...ref(2),audioSha256:ref(0).audioSha256},ref(3)]})).toBe(false)
  expect(independent(window(0),{...window(2),sources:[{...ref(2),startSample:0},{...ref(3),startSample:96000}]})).toBe(false)
  expect(independent(window(0),{...window(2),captureId:id.replace(/1$/,'2')})).toBe(false)
 })
 it('rejects sparse pending, previous, window and materialization arrays without throwing',()=>{
  const first=next(undefined,ref(0)),ready=next(first.next,ref(1))
  for(const sparse of [new Array(1),[ref(0),,ref(2)]]){
   expect(plan(id,{...first.next,pending:sparse} as any,ref(1))).toEqual({status:'rejected',reason:'invalid_state'})
   expect(plan(id,{...ready.next,previous:sparse} as any,ref(2))).toEqual({status:'rejected',reason:'invalid_state'})
   expect(independent({captureId:id,sources:sparse} as any,window(2))).toBe(false)
   expect(assemble({captureId:id,sources:sparse} as any,[])).toBeNull()
  }
  const a=wav(0),b=wav(1),w={captureId:id,sources:[a.source,b.source]}
  expect(assemble(w,new Array(2))).toBeNull()
 })
 it('cannot confirm replayed audio by replacing an anchor original with intervening window provenance',()=>{
  const first=next(next(undefined,ref(0)).next,ref(1))
  const original=structuredClone(first.window!)
  const intervening=next(next(first.next,ref(2)).next,ref(3))
  expect(independent(original,intervening.window!)).toBe(true)
  const replayFirst={...ref(4),audioSha256:ref(0).audioSha256},replaySecond={...ref(5),audioSha256:ref(1).audioSha256}
  const replay=next(next(intervening.next,replayFirst).next,replaySecond)
  // A bounded planner can materialize this older replay. Only the anchor's
  // retained original evidence, rather than the latest window, rejects it.
  expect(replay.status).toBe('ready')
  expect(independent(intervening.window!,replay.window!)).toBe(true)
  expect(independent(original,replay.window!)).toBe(false)
  expect(original).toEqual(first.window)
 })
 it('fails closed on corrupt reloads and keeps a fixed descriptor/PCM budget over long captures',()=>{
  const first=next(undefined,ref(0));expect(plan(id,undefined,{...ref(0),audio:Buffer.alloc(8)} as any)).toEqual({status:'rejected',reason:'invalid_source'});for(const corrupt of [{...first.next,extra:'not metadata'},{...first.next,version:2},{...first.next,pending:[ref(0),ref(1)]},{...first.next,last:{...ref(0),samples:NaN}},{...first.next,captureId:'another'}])expect(plan(id,corrupt as any,ref(1))).toEqual({status:'rejected',reason:'invalid_state'})
  let state:MacVoiceWindowState|undefined
  for(let i=0;i<500;i++){const p=next(state,ref(i));state=p.next;expect(state.pending.length).toBeLessThan(MAC_VOICE_WINDOW_MAX_SOURCES);expect(state.previous.length).toBeLessThanOrEqual(MAC_VOICE_WINDOW_MAX_SOURCES);expect(Object.values(state).some(v=>Buffer.isBuffer(v))).toBe(false)}
  const full=next(undefined,{...ref(0),samples:MAC_VOICE_WINDOW_MAX_SAMPLES});expect(full.status).toBe('ready');expect(full.next.pending).toEqual([])
  expect(plan(id,undefined,{...ref(0),samples:MAC_VOICE_WINDOW_MAX_SAMPLES+1})).toEqual({status:'rejected',reason:'invalid_source'})
  state=undefined
  for(let i=0;i<20;i++){const p=next(state,{...ref(i),startSample:i*16000,samples:16000});state=p.next;expect(p.status).toBe('collecting');expect(state.pending.length).toBeLessThan(MAC_VOICE_WINDOW_MAX_SOURCES)}
 })
 it('materializes unchanged original PCM only after hash, header, order and provenance verification',()=>{
  const a=wav(0),b=wav(1),w={captureId:id,sources:[a.source,b.source]},before=[Buffer.from(a.audio),Buffer.from(b.audio)]
  const output=assemble(w,[a,b])!;expect(output.length).toBe(384044);expect(output.readUInt32LE(40)).toBe(384000);expect(output.subarray(44)).toEqual(Buffer.concat([a.audio.subarray(44),b.audio.subarray(44)]));expect(a.audio).toEqual(before[0]);expect(b.audio).toEqual(before[1])
  expect(assemble(w,[b,a])).toBeNull();expect(assemble(w,[a])).toBeNull()
  const changed=Buffer.from(b.audio);changed[50]^=1;expect(assemble(w,[a,{...b,audio:changed}])).toBeNull()
  for(const [offset,value] of [[22,2],[24,8000],[34,8],[40,2]]){const broken=Buffer.from(b.audio);broken.writeUInt16LE(value,offset);const source={...b.source,audioSha256:createHash('sha256').update(broken).digest('hex')};expect(assemble({captureId:id,sources:[a.source,source]},[a,{source,audio:broken}])).toBeNull()}
  expect(assemble({...w,sources:[{...a.source,samples:1},b.source]},[a,b])).toBeNull()
 })
})
