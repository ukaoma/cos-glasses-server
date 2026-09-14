import { describe, it, expect } from 'vitest'
import { buildHeldVoiceGroups, suggestProfile } from './held-voice-groups.js'
import { coherentClusterContaining } from './voice-enrolment-selection.js'
import { mergeProfilesInStore, type VoiceProfile } from './voice-profile-store.js'
const v = (...xs: number[]) => new Float32Array(xs)
const profile = (name: string, rows: number[][], source = 'manual'): VoiceProfile => ({name, embeddings: rows, sources: rows.map(() => source)})
describe('single held sample suggestions', () => {
  it('scores a loose sample with the same scorer and preserves raw playback index', () => {
    const profiles = [profile('Brigitta Pólya', [[1,0,0],[1,.1,0]])]
    const out = buildHeldVoiceGroups([{sessionId:'meeting_x',chunkIndex:7,embedding:v(1,0,.1)}],profiles)
    expect(out.groups).toEqual([])
    expect(out.loose[0]).toMatchObject({chunkIndex:7,suggestion:{name:'Brigitta Pólya',agreeing:2,anchor:'manual'}})
  })
  it('requires a clear margin against a different competing voice', () => {
    const profiles = [profile('A',[[.8,.6,0],[.8,.6,0]]),profile('B',[[.79,-.6,0],[.79,-.6,0]])]
    expect(suggestProfile(v(1,0,0), profiles)).toBeNull()
  })
  it('excludes near-duplicate profile pairs from runner-up margin without changing names', () => {
    const profiles = [profile('A',[[1,.05,0],[1,.05,0]]),profile('Alias',[[1,.1,0],[1,.1,0]])]
    expect(suggestProfile(v(1,0,0),profiles)).toMatchObject({name:'A',runnerUpSimilarity:0})
    expect(profiles).toHaveLength(2)
  })
  it('never suggests an owner case alias and flags owner proximity', () => {
    const profiles=[profile('mu',[[1,0,0],[1,.01,0]]),profile('Guest',[[1,.5,0],[1,.51,0]])]
    expect(suggestProfile(v(1,0,0),profiles,{ownerLabel:'MU'})).toMatchObject({name:'Guest',ownerCaution:true})
  })
  it('cautions on one very close owner sample even without two owner anchors', () => {
    const profiles=[profile('MU',[[1,0,0],[0,1,0]]),profile('Guest',[[.8,.6,0],[.8,.6,0]])]
    expect(suggestProfile(v(1,0,0),profiles,{ownerLabel:'MU'})).toMatchObject({name:'Guest',ownerSimilarity:1,ownerCaution:true})
  })
  it('rejects empty and invalid profiles and unvouched winners', () => {
    expect(suggestProfile(v(1,0),[])).toBeNull()
    expect(suggestProfile(v(1,0),[profile('A',[[NaN,0],[Infinity,0]])])).toBeNull()
    expect(suggestProfile(v(1,0),[profile('A',[[1,0],[1,0]],'ext-retroactive:x')])).toBeNull()
    expect(suggestProfile(v(1,0),[profile('A',[[1,0],[0,1]])])).toBeNull()
    expect(suggestProfile(v(1,0),[profile('A',[[1,0],[.5,Math.sqrt(.75)]])])).toBeNull()
  })
  it('a one-sample voice remains likely even at perfect similarity', () => {
    expect(suggestProfile(v(1,0),[profile('A',[[1,0]])])).toMatchObject({tier:'likely',agreeing:1})
  })
})
describe('seed-containing wider cluster', () => {
  it('keeps the named seed even when another voice dominates the room', () => {
    expect(coherentClusterContaining([v(1,0,0)],[v(1,.1,0),v(0,1,0),v(0,1,.1),v(0,1,.2)]).members).toEqual([0,1])
  })
  it('fails closed for mutually inconsistent named seeds', () => {
    expect(coherentClusterContaining([v(1,0),v(0,1)],[v(0,1)])).toEqual({members:[],seed:-1})
  })
  it('does not bridge mutually incompatible candidates through a seed', () => {
    const c=coherentClusterContaining([v(1,1)],[v(1,0),v(0,1)])
    expect(c.members).toEqual([0,1])
  })
  it('handles no seeds, invalid seeds and invalid candidates without admitting them', () => {
    expect(coherentClusterContaining([],[v(1,0)]).members).toEqual([])
    expect(coherentClusterContaining([v(0,0)],[v(1,0)]).members).toEqual([])
    expect(coherentClusterContaining([v(NaN,0)],[v(1,0)]).members).toEqual([])
    expect(coherentClusterContaining([v(1,0)],[v(NaN,0),v(0,0),v(1)])).toEqual({members:[0],seed:0})
  })
})
describe('merge source strength', () => {
  it('keeps human samples even when automatic samples would add more diversity', () => {
    const store={profiles:[profile('A',Array.from({length:40},()=>[1,0]),'correction:x'),profile('B',Array.from({length:40},()=>[0,1]),'auto:y')]}
    expect(mergeProfilesInStore(store,'A',['B']).samplesAfter).toBe(40)
    expect(store.profiles[0].sources?.every(x=>x==='correction:x')).toBe(true)
    expect(store.profiles[0].embeddings.every(x=>x[0]===1)).toBe(true)
  })
})
