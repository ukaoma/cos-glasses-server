import { describe, expect, it } from 'vitest'
import { matchMacLiveVoice as match, validMacLiveVoices, macAnonymousProjection, MAC_LIVE_MAX_VOICES, MAC_LIVE_MATCH_SIMILARITY, type MacLiveVoiceState } from './mac-live-voices.js'
const digest = (index: number) => index.toString(16).padStart(64,'0')
const matchMacLiveVoice = (state:MacLiveVoiceState,e:Float32Array|null,index:number) => match(state,e,index,digest(index))
const fresh = (): MacLiveVoiceState => ({ version: 1, anchors: [] })
const vec = (...x: number[]) => new Float32Array(x)
describe('capture-local anonymous continuity', () => {
  it('requires matching evidence from distinct chunks, independent of channel number and identity', () => {
    const state = fresh()
    expect(matchMacLiveVoice(state, vec(1,0), 0)).toBeNull()
    expect(matchMacLiveVoice(state, vec(1,0), 0)).toBeNull()
    expect(match(state,vec(1,0),9,digest(0))).toBeNull() // same recording window, different index
    expect(matchMacLiveVoice(state, vec(1,0), 1)).toBe('Voice 1')
    expect(matchMacLiveVoice(state, vec(0,1), 2)).toBeNull()
    expect(matchMacLiveVoice(state, vec(0,1), 3)).toBe('Voice 2')
    expect(matchMacLiveVoice(state, vec(1,0), 4)).toBe('Voice 1')
    expect(matchMacLiveVoice(fresh(), vec(1,0), 4)).toBeNull()
  })
  it('keeps weak and ambiguous evidence unknown without allocating another voice or drifting an anchor', () => {
    const state = fresh(); matchMacLiveVoice(state,vec(1,0),0)
    const before = structuredClone(state)
    expect(matchMacLiveVoice(state,vec(0.7,Math.sqrt(1-0.49)),1)).toBeNull()
    expect(state).toEqual(before)
    state.anchors.push({ embedding:[0.95,Math.sqrt(1-0.95**2)],firstChunk:0,firstAudioSha256:digest(0),confirmed:true })
    expect(matchMacLiveVoice(state,vec(1,0),2)).toBeNull()
    expect(state.anchors[0].confirmed).toBe(false)
  })
  it('survives private session serialization with the same labels and never accepts corrupt continuity', () => {
    const state=fresh();matchMacLiveVoice(state,vec(1,0),0);matchMacLiveVoice(state,vec(1,0),1)
    const restored=JSON.parse(JSON.stringify(state))
    expect(validMacLiveVoices(restored)).toBe(true)
    expect(matchMacLiveVoice(restored,vec(1,0),10)).toBe('Voice 1')
    for(const bad of [{version:2,anchors:[]},{version:1,anchors:[{embedding:[1,NaN],firstChunk:0,firstAudioSha256:digest(0),confirmed:true}]},{version:1,anchors:[{embedding:[0,0],firstChunk:0,firstAudioSha256:digest(0),confirmed:true}]}]) {
      expect(validMacLiveVoices(bad)).toBe(false)
      expect(matchMacLiveVoice(bad as any,vec(1,0),11)).toBeNull()
    }
  })
  it('uses its own continuity threshold and handles extreme finite vector scales without overflow', () => {
    const state=fresh();matchMacLiveVoice(state,vec(1,0),0)
    const below=MAC_LIVE_MATCH_SIMILARITY-0.001
    expect(matchMacLiveVoice(state,vec(below,Math.sqrt(1-below**2)),1)).toBeNull()
    const above=MAC_LIVE_MATCH_SIMILARITY+0.001
    expect(matchMacLiveVoice(state,vec(above,Math.sqrt(1-above**2)),2)).toBe('Voice 1')
    state.anchors[0].embedding=[1e200,0]
    expect(matchMacLiveVoice(state,vec(1e30,0),3)).toBe('Voice 1')
    state.anchors[0].embedding=[1e-200,0]
    expect(matchMacLiveVoice(state,vec(1e-30,0),4)).toBe('Voice 1')
  })
  it('bounds anchor count and rejects missing, invalid and different model dimensions', () => {
    const state=fresh()
    for(let i=0;i<MAC_LIVE_MAX_VOICES;i++) {const e=new Float32Array(8);e[i]=1;matchMacLiveVoice(state,e,i)}
    const extra=new Float32Array(8);extra[7]=1
    expect(matchMacLiveVoice(state,extra,7)).toBeNull()
    expect(state.anchors).toHaveLength(MAC_LIVE_MAX_VOICES)
    for(const e of [null,vec(0,0),vec(NaN,1),vec(Infinity,1),vec(1,0)]) expect(matchMacLiveVoice(state,e,8)).toBeNull()
  })
  it('retains only anonymous labels at zero identity confidence; names retain strict projection', () => {
    expect(macAnonymousProjection({speaker:'Voice 2',similarity:0.94},{speaker:'Ext',similarity:0})).toEqual({speaker:'Voice 2',similarity:0})
    expect(macAnonymousProjection({speaker:'Dana',similarity:0.7},{speaker:'Ext',similarity:0})).toEqual({speaker:'Ext',similarity:0})
  })
})
