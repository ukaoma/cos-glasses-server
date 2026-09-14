import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
let root = ''
let profiles: Array<{name:string;embeddings:number[][];sources:string[]}> = []
let api: typeof import('./held-voice-groups.js')
const vec = (wobble=0) => { const v=new Float32Array(192);v[0]=1;v[1]=wobble;return v }
beforeEach(async () => {
  vi.resetModules();root=mkdtempSync(join(tmpdir(),'held-projection.'));process.env.COS_DATA_DIR=root;profiles=[]
  vi.doMock('./speaker-embeddings.js',async original=>({...await original<any>(),readVoiceProfiles:()=>({profiles}),isEmbeddingAvailable:()=>true}))
  api=await import('./held-voice-groups.js')
})
afterEach(()=>{vi.doUnmock('./speaker-embeddings.js');vi.resetModules();delete process.env.COS_DATA_DIR;rmSync(root,{recursive:true,force:true})})
async function held(index:number, embedding:Float32Array) {
  const dir=join(root,'ext-audio','meeting_projection');mkdirSync(dir,{recursive:true});const wav=join(dir,`ext_chunk${index}_1000.wav`);writeFileSync(wav,Buffer.alloc(48))
  const {appendChunkEmbedding}=await import('./chunk-embedding-store.js');appendChunkEmbedding('meeting_projection',{i:index,speaker:'Ext',similarity:.2,embedding})
  return {sessionId:'meeting_projection',chunkIndex:index}
}
describe('exact held enrollment projection',()=>{
  it('folds duplicate recordings to one anchor without altering held audio or profiles',async()=>{
    const refs=[await held(0,vec()),await held(1,vec())]
    const out=api.projectHeldEnrollment('CB',refs)
    expect(out.plan).toMatchObject({selected:1,distinct:1,coherent:2})
    expect(out.selectedMembers).toEqual([refs[0]])
    expect(out.profiles[0].embeddings).toHaveLength(1)
    expect(api.suggestProfile(vec(),out.profiles)).toMatchObject({name:'CB',agreeing:1,tier:'likely'})
    expect(profiles).toEqual([])
    expect(readFileSync(join(root,'ext-audio','meeting_projection','ext_chunk0_1000.wav'))).toHaveLength(48)
  })
  it('simulates weakest provenance eviction at the shared40 cap and keeps live cached rows unchanged',async()=>{
    profiles=[{name:'CB',embeddings:Array.from({length:40},()=>Array.from(vec(.3))),sources:Array.from({length:40},(_,i)=>i===17?'auto:old':'manual')}]
    const before=JSON.stringify(profiles)
    const ref=await held(0,vec())
    const out=api.projectHeldEnrollment('CB',[ref])
    expect(out.profiles[0].embeddings).toHaveLength(40)
    expect(out.profiles[0].sources).not.toContain('auto:old')
    expect(out.profiles[0].sources?.at(-1)).toBe('ext-group:meeting_projection')
    expect(out.profiles[0].embeddings.at(-1)).toEqual(Array.from(vec()))
    expect(JSON.stringify(profiles)).toBe(before)
  })
  it('uses the exact20 diverse representatives selected for a coherent large request',async()=>{
    const refs=[]
    for(let i=0;i<24;i++){const v=vec();v[i+2]=.2;refs.push(await held(i,v))}
    const out=api.projectHeldEnrollment('CB',refs)
    expect(out.plan.selected).toBe(20);expect(out.selectedMembers).toHaveLength(20);expect(out.profiles[0].embeddings).toHaveLength(20)
    expect(out.plan.coreMembers).toHaveLength(24)
    const {readChunkEmbeddings}=await import('./chunk-embedding-store.js')
    const bank=readChunkEmbeddings('meeting_projection')
    for(const [i,ref] of out.selectedMembers.entries())expect(out.profiles[0].embeddings[i]).toEqual(Array.from(bank.rows.find(row=>row.i===ref.chunkIndex)!.embedding))
  })
})
