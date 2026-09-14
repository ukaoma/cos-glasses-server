import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
import {chmodSync,cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
let root='',data='',ops=''
let profiles:Array<{name:string;embeddings:number[][];sources:string[]}> = []
let enrollments=0
let onEnroll:(()=>void)|undefined
const v=(axis=0,wobble=3)=>{const a=new Float32Array(192);a[axis]=1;a[wobble]=.1;return a}
let api:typeof import('./held-naming-batches.js')
let saved:{sidecarPath:string;filepath:string}
let opSide='',opMd=''
let originalDoc:any
let originalMd=''
const refs=[{sessionId:'meeting_sample',chunkIndex:3}]
beforeEach(async()=>{
  vi.resetModules();root=mkdtempSync(join(tmpdir(),'cos-naming.'));data=join(root,'data');ops=join(root,'operations');mkdirSync(data)
  process.env.COS_DATA_DIR=data;delete process.env.COS_OPERATIONS_DIR;delete process.env.COS_MEETINGS_ROOT;delete process.env.COS_SCRIPTS_DIR
  profiles=[];enrollments=0;onEnroll=undefined
  vi.doMock('./profile.js',()=>({getOwnerSpeakerLabel:()=> 'MU'}))
  vi.doMock('./speaker-embeddings.js',async original=>({...await original<any>(),readVoiceProfiles:()=>({profiles}),isEmbeddingAvailable:()=>true,enrollEmbedding:(name:string,emb:Float32Array,source:string)=>{let p=profiles.find(p=>p.name===name);if(!p){p={name,embeddings:[],sources:[]};profiles.push(p)}p.embeddings.push(Array.from(emb));p.sources.push(source);enrollments++;onEnroll?.();return{success:true,dim:192}}}))
  const {MeetingStore}=await import('./meeting-store.js')
  const chunks=[{speaker:'Ext',text:'one same room',elapsed:1000,similarity:.2},{speaker:'Ext',text:'two distinct words',elapsed:4000,similarity:.3},{speaker:'Other',text:'three unchanged words',elapsed:7000,similarity:.4}]
  const entry=[{chunkIndex:0,chunk:chunks[0]},{chunkIndex:1},{chunkIndex:2},{chunkIndex:3,chunk:chunks[1]},{chunkIndex:7,chunk:chunks[2]}]
  saved=new MeetingStore().save({sessionId:'meeting_sample',startTime:new Date('2026-09-13T12:00:00Z').getTime(),durationMs:9000,transcript:'[Ext]: one same room\n\n[Ext]: two distinct words\n\n[Other]: three unchanged words',chunks:chunks as any,chunkEntries:entry as any})
  originalDoc=JSON.parse(readFileSync(saved.sidecarPath,'utf8'));originalDoc.batchApplied=true;originalDoc.batchSegments=[{startChunkIdx:0,endChunkIdx:7,startElapsed:0,speakerWords:[{word:'one',start:1,end:1.4,speaker:'Ext',similarity:.2},{word:'two',start:4,end:4.4,speaker:'Ext',similarity:.3},{word:'three',start:7,end:7.5,speaker:'Other',similarity:.4}]}]
  writeFileSync(saved.sidecarPath,JSON.stringify(originalDoc));originalMd=readFileSync(saved.filepath,'utf8')
  const {appendChunkEmbedding}=await import('./chunk-embedding-store.js')
  for(const [i,axis] of [[0,1],[3,0],[7,1],[2,0]])appendChunkEmbedding('meeting_sample',{i,speaker:'Ext',similarity:.3,embedding:v(axis,i+10)})
  mkdirSync(join(data,'ext-audio','meeting_sample'),{recursive:true});writeFileSync(join(data,'ext-audio','meeting_sample','ext_chunk3_1000.wav'),Buffer.alloc(48))
  api=await import('./held-naming-batches.js')
})
afterEach(()=>{vi.doUnmock('./speaker-embeddings.js');vi.doUnmock('./profile.js');delete process.env.COS_DATA_DIR;delete process.env.COS_OPERATIONS_DIR;delete process.env.COS_SCRIPTS_DIR;rmSync(root,{recursive:true,force:true});vi.resetModules()})
function read(){return JSON.parse(readFileSync(saved.sidecarPath,'utf8'))}
function twoCopies(){
  const dir=join(ops,'quilt','meetings','2026-09');mkdirSync(dir,{recursive:true})
  opSide=join(dir,'2026-09-13_ops.g2-chunks.json');opMd=join(dir,'2026-09-13_ops.md');cpSync(saved.sidecarPath,opSide);cpSync(saved.filepath,opMd)
  const scripts=join(ops,'scripts');mkdirSync(scripts);const python=join(scripts,'cos_python');writeFileSync(python,'#!/bin/sh\nexec /usr/bin/python3 "$@"\n');chmodSync(python,0o700)
  process.env.COS_OPERATIONS_DIR=ops;process.env.COS_SCRIPTS_DIR=scripts
}
describe('held naming execution',()=>{
  it('preview mutates no labels/profiles/audio, maps raw3 to position1, never raw7',()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs)
    expect(p.kind).toBe('preview');expect(p.previewHash).toHaveLength(64)
    expect(p.meetings[0]).toMatchObject({status:'ready',namedChunks:[1],widerChunks:[],labelled:1,playback:[{sessionId:'meeting_sample',chunkIndex:3,position:1}]})
    expect(enrollments).toBe(0);expect(read()).toEqual(originalDoc);expect(readFileSync(saved.filepath,'utf8')).toBe(originalMd)
  })
  it('applies exact chunks, raw entries, HQ word speaker and speaking-time, keeping text/similarity',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs);const result=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})
    expect(result).toMatchObject({kind:'applied',status:'applied',enrolled:1,deleted:1,lockMode:'standalone'})
    const doc=read();expect(doc.chunks.map((c:any)=>c.speaker)).toEqual(['Ext','Brigitta Pólya','Other']);expect(doc.chunkEntries[3].chunk.speaker).toBe('Brigitta Pólya');expect(doc.chunkEntries[4].chunk.speaker).toBe('Other')
    expect(doc.batchSegments[0].speakerWords[1]).toMatchObject({speaker:'Brigitta Pólya',similarity:.3,word:'two',speakerCorrectionBatchId:result.batchId})
    expect(doc.chunks.map((c:any)=>c.text)).toEqual(originalDoc.chunks.map((c:any)=>c.text));expect(doc.correctionRevision).toBe(1);expect(doc.labelsNewerThanGraph).toBe(true)
    const {speakerWordMs}=await import('./meeting-speaker-review.js');expect(speakerWordMs(doc.batchSegments).get('Brigitta Pólya')).toBe(400)
    expect(readFileSync(saved.filepath,'utf8')).toContain('[Brigitta Pólya]: two distinct words')
  })
  it('undo works after audio deletion, restores words/labels, retains enrolled samples and never resurrects audio',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs);const result=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})
    const undo=await api.undoHeldNaming(result.batchId,true)
    expect(undo).toMatchObject({status:'reverted',samplesKept:true,audioRestored:false});expect(read().chunks).toEqual(originalDoc.chunks);expect(read().batchSegments).toEqual(originalDoc.batchSegments);expect(readFileSync(saved.filepath,'utf8')).toContain('<!-- speaker-labels-newer-than-graph -->');expect(readFileSync(saved.filepath,'utf8')).toContain('[Ext]: two distinct words');expect(enrollments).toBe(1);expect(readdirSync(join(data,'ext-audio','meeting_sample')).filter(p=>p.endsWith('.wav'))).toHaveLength(0)
  })
  it('replay is idempotent after audio deletion and changed voice version',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs);const a=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true});const b=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true});expect(b.batchId).toBe(a.batchId);expect(enrollments).toBe(1)
  })
  it('refuses expired preview and voice-version drift before enrolment',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs);profiles.push({name:'Changed',embeddings:[],sources:[]});await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'voice_version_changed'});expect(enrollments).toBe(0)
    profiles=[];vi.spyOn(Date,'now').mockReturnValue(Date.now()+16*60*1000);await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'preview_expired'});vi.restoreAllMocks()
  })
  it.each(['correctionRevision','lifecycleRevision','batchApplied'])('detects %s drift, including HQ acceptance between preview/apply',async key=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs);const doc=read();doc[key]=key==='batchApplied'?false:9;writeFileSync(saved.sidecarPath,JSON.stringify(doc));await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'meetings_changed'});expect(enrollments).toBe(0)
  })
  it('two copies update and undo coherently under the real Python flock holder',async()=>{
    twoCopies();const p=api.previewHeldNaming('Brigitta Pólya',refs);expect(p.meetings[0].copies).toHaveLength(2);const a=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true});expect(a.lockMode).toBe('sync');expect(JSON.parse(readFileSync(opSide,'utf8')).chunks[1].speaker).toBe('Brigitta Pólya');const undo=await api.undoHeldNaming(a.batchId,true);expect(undo.status).toBe('reverted');expect(JSON.parse(readFileSync(opSide,'utf8')).chunks).toEqual(originalDoc.chunks)
  })
  it('missing or read-only operations copy fails meeting closed, force cannot bypass it',async()=>{
    twoCopies();chmodSync(opSide,0o400);const p=api.previewHeldNaming('Brigitta Pólya',refs);expect(p.meetings[0].status).toBe('blocked');await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true,...({force:true}as any)})).rejects.toMatchObject({reason:'meetings_changed'});expect(enrollments).toBe(0);expect(read()).toEqual(originalDoc)
  })
  it('counts textless members as enrolled, no transcript position',async()=>{
    writeFileSync(join(data,'ext-audio','meeting_sample','ext_chunk2_1000.wav'),Buffer.alloc(48));const input=[{sessionId:'meeting_sample',chunkIndex:2}];const p=api.previewHeldNaming('Brigitta Pólya',input);expect(p.members[0].status).toBe('no_transcript_position');const a=await api.applyHeldNaming('Brigitta Pólya',input,p.previewHash,{confirm:true});expect(a.enrolled).toBe(1);expect(a.meetings[0].namedChunks).toEqual([])
    expect(a.members).toEqual([{...input[0],previewStatus:'no_transcript_position',status:'no_transcript_position',enrollmentStatus:'enrolled',labelStatus:'no_transcript_position',audioStatus:'deleted',position:null}])
    vi.resetModules();api=await import('./held-naming-batches.js')
    expect(api.namingBatchList().batches[0].members).toEqual(a.members)
    const undo=await api.undoHeldNaming(a.batchId,true)
    expect(undo.members[0]).toMatchObject({status:'reverted',enrollmentStatus:'enrolled',labelStatus:'no_transcript_position',audioStatus:'deleted'})
  })
  it('member receipts distinguish duplicate representation from the exact enrolled vector',async()=>{
    const {appendChunkEmbedding}=await import('./chunk-embedding-store.js')
    appendChunkEmbedding('meeting_sample',{i:2,speaker:'Ext',similarity:.3,embedding:v(0,13)})
    writeFileSync(join(data,'ext-audio','meeting_sample','ext_chunk2_1000.wav'),Buffer.alloc(48))
    const input=[...refs,{sessionId:'meeting_sample',chunkIndex:2}],p=api.previewHeldNaming('Brigitta Pólya',input)
    const a=await api.applyHeldNaming('Brigitta Pólya',input,p.previewHash,{confirm:true})
    expect(a).toMatchObject({enrolled:1,deleted:2})
    expect(a.members[0]).toMatchObject({chunkIndex:3,position:1,status:'applied',labelStatus:'labelled',enrollmentStatus:'enrolled',audioStatus:'deleted'})
    expect(a.members[1]).toMatchObject({chunkIndex:2,position:null,status:'no_transcript_position',enrollmentStatus:'represented',audioStatus:'deleted'})
    expect(JSON.parse(readFileSync(join(data,'meeting-corrections',`batch-${a.batchId}.json`),'utf8')).memberOutcomes).toEqual(JSON.parse(JSON.stringify(a.members)))
  })
  it('history retains every requested member and explicit skipped reasons',async()=>{
    const doc=read();doc.chunks[0].speaker='Known Person';doc.chunkEntries[0].chunk.speaker='Known Person';writeFileSync(saved.sidecarPath,JSON.stringify(doc))
    const {appendChunkEmbedding}=await import('./chunk-embedding-store.js')
    appendChunkEmbedding('meeting_sample',{i:0,speaker:'Known Person',similarity:.3,embedding:v(0,18)})
    appendChunkEmbedding('meeting_sample',{i:2,speaker:'Ext',similarity:.3,embedding:v(1,19)})
    for(const i of [0,2])writeFileSync(join(data,'ext-audio','meeting_sample',`ext_chunk${i}_1000.wav`),Buffer.alloc(48))
    const input=[3,0,2,99].map(chunkIndex=>({sessionId:'meeting_sample',chunkIndex})),p=api.previewHeldNaming('Brigitta Pólya',input)
    const a=await api.applyHeldNaming('Brigitta Pólya',input,p.previewHash,{confirm:true})
    expect(a.members.map(m=>m.chunkIndex)).toEqual([3,0,2,99])
    expect(a.members.slice(1)).toMatchObject([
      {status:'skipped',enrollmentStatus:'not_enrolled',labelStatus:'unchanged',audioStatus:'retained',reason:'no_longer_Ext'},
      {status:'skipped',enrollmentStatus:'not_enrolled',labelStatus:'unchanged',audioStatus:'retained',reason:'left_held'},
      {status:'skipped',enrollmentStatus:'not_enrolled',labelStatus:'unchanged',audioStatus:'missing',reason:'missing'},
    ])
    vi.resetModules();api=await import('./held-naming-batches.js');expect(api.namingBatchList().batches[0].members).toEqual(a.members)
  })
  it('legacy batch history never invents individual enrollment from aggregate counts',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs),a=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})
    const path=join(data,'meeting-corrections',`batch-${a.batchId}.json`),legacy=JSON.parse(readFileSync(path,'utf8'))
    delete legacy.memberOutcomes;delete legacy.requestedMembers;writeFileSync(path,JSON.stringify(legacy))
    expect(api.namingBatchList().batches[0].members).toEqual([{...refs[0],status:'unknown',enrollmentStatus:'unknown',labelStatus:'unknown',audioStatus:'unknown',position:null,reason:'legacy_receipt_has_no_member_outcome'}])
  })
  it('reports a selected vector refusal independently of successful labels and another accepted vector',async()=>{
    writeFileSync(join(data,'ext-audio','meeting_sample','ext_chunk2_1000.wav'),Buffer.alloc(48))
    const input=[...refs,{sessionId:'meeting_sample',chunkIndex:2}],p=api.previewHeldNaming('Brigitta Pólya',input)
    const embeddings=await import('./speaker-embeddings.js'),spy=vi.spyOn(embeddings,'enrollEmbedding').mockImplementationOnce(()=>({success:false} as any))
    const a=await api.applyHeldNaming('Brigitta Pólya',input,p.previewHash,{confirm:true});spy.mockRestore()
    expect(a.enrolled).toBe(1);expect(a.members.filter(m=>m.enrollmentStatus==='enrolled')).toHaveLength(1);expect(a.members.filter(m=>m.enrollmentStatus==='not_enrolled')).toHaveLength(1)
    expect(a.members.filter(m=>m.enrollmentStatus==='represented')).toHaveLength(0)
    expect(a.members.every(m=>['applied','no_transcript_position'].includes(m.status))).toBe(true)
    expect(api.namingBatchList().batches[0].members).toEqual(a.members)
  })
  it('known total enrollment refusal persists failed members without claiming samples enrolled',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs),embeddings=await import('./speaker-embeddings.js')
    const spy=vi.spyOn(embeddings,'enrollEmbedding').mockReturnValue({success:false} as any)
    await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'nothing_enrolled'});spy.mockRestore()
    const batch=api.namingBatchList().batches[0]
    expect(batch.enrolled).toBe(0);expect(batch.members[0]).toMatchObject({status:'failed',labelStatus:'failed',enrollmentStatus:'not_enrolled',audioStatus:'retained'})
  })
  it('chunk counts disagreement fails closed, not shifted to another speaker',()=>{
    const doc=read();doc.chunkEntries.pop();writeFileSync(saved.sidecarPath,JSON.stringify(doc));const p=api.previewHeldNaming('Brigitta Pólya',refs);expect(p.meetings[0]).toMatchObject({status:'blocked',labelled:0});expect(p.meetings[0].error).toContain('counts disagree')
  })
  it('resolves unicode case to stored voice and rejects ambiguous duplicates',()=>{
    profiles=[{name:'Brigitta Pólya',embeddings:[],sources:[]}];expect(api.resolveStoredName('brigitta pólya').name).toBe('Brigitta Pólya');profiles.push({name:'BRIGITTA PÓLYA',embeddings:[],sources:[]});expect(()=>api.resolveStoredName('Brigitta Pólya')).toThrow(/Multiple stored/)
  })
  it('requires owner acknowledgement and 0.65 evidence',async()=>{
    profiles=[{name:'MU',embeddings:[Array.from(v(1))],sources:['manual']}];expect(()=>api.previewHeldNaming('mu',refs)).toThrow(/verification floor/)
    profiles[0].embeddings=[Array.from(v())];const p=api.previewHeldNaming('mu',refs);expect(p.owner).toBe(true);await expect(api.applyHeldNaming('mu',refs,p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'owner_confirmation_required'});expect(enrollments).toBe(0)
  })
  it('confirms only named positions and undo revokes only its batch',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs);const a=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true});const {confirmedLabels,confirmedChunks}=await import('./meeting-corrections.js');expect(confirmedLabels('meeting_sample').size).toBe(0);expect([...confirmedChunks('meeting_sample')]).toEqual([[1,'Brigitta Pólya']]);await api.undoHeldNaming(a.batchId,true);expect(confirmedChunks('meeting_sample').size).toBe(0)
  })
  it('boot closes open intents without applying any labels',async()=>{
    const {appendCorrection,pendingCorrections,readCorrections}=await import('./meeting-corrections.js');appendCorrection('meeting_sample',{id:'interrupted',phase:'intent',at:new Date().toISOString(),from:'Ext',to:'Brigitta Pólya',chunks:[1],scope:'meeting'});expect(api.recoverInterruptedNaming()).toBe(1);expect(pendingCorrections('meeting_sample')).toHaveLength(0);expect(readCorrections('meeting_sample').rows.at(-1)?.phase).toBe('failed');expect(read()).toEqual(originalDoc)
  })
  it.each(['finalizationState','enrichmentState','syncState'])('rejects non-finalized %s state at preview',key=>{
    const doc=read();doc[key]=key==='syncState'?'claimed':'pending';writeFileSync(saved.sidecarPath,JSON.stringify(doc))
    expect(api.previewHeldNaming('Brigitta Pólya',refs).meetings[0].status).toBe('blocked')
  })
  it('active sessions refuse even when durable copy looks finalized',()=>{
    api.setNamingSessionLiveness(()=>true);expect(api.previewHeldNaming('Brigitta Pólya',refs).meetings[0].status).toBe('blocked');api.setNamingSessionLiveness(()=>false)
  })
  it('will not overwrite an already named held position',async()=>{
    const doc=read();doc.chunks[1].speaker='Other Person';doc.chunkEntries[3].chunk.speaker='Other Person';writeFileSync(saved.sidecarPath,JSON.stringify(doc))
    const p=api.previewHeldNaming('Brigitta Pólya',refs);expect(p.members[0].status).toBe('no_longer_Ext');expect(p.meetings[0].namedChunks).toEqual([])
    await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'meetings_changed'});expect(enrollments).toBe(0)
  })
  it('wider matches exclude named speakers, use updated scorer, flag room-only evidence',async()=>{
    const {appendChunkEmbedding}=await import('./chunk-embedding-store.js')
    appendChunkEmbedding('meeting_sample',{i:0,speaker:'Ext',similarity:.3,embedding:v(0,50)})
    appendChunkEmbedding('meeting_sample',{i:7,speaker:'Other',similarity:.3,embedding:v(0,51)})
    const p=api.previewHeldNaming('Brigitta Pólya',refs)
    expect(p.meetings[0]).toMatchObject({widerChunks:[0],roomRisk:true});expect(p.meetings[0].widerScores?.[0].similarity).toBeGreaterThan(.55)
    profiles=[{name:'Brigitta Pólya',embeddings:[Array.from(v(0,52)),Array.from(v(0,53))],sources:['manual','fireflies:other_meeting']}]
    expect(api.previewHeldNaming('Brigitta Pólya',refs).meetings[0].roomRisk).toBe(false)
  })
  it('wider candidates already in the target profile are excluded',async()=>{
    const {appendChunkEmbedding}=await import('./chunk-embedding-store.js');const sample=v(0,50)
    appendChunkEmbedding('meeting_sample',{i:0,speaker:'Ext',similarity:.3,embedding:sample})
    profiles=[{name:'Brigitta Pólya',embeddings:[Array.from(sample)],sources:['manual']}]
    expect(api.previewHeldNaming('Brigitta Pólya',refs).meetings[0].widerChunks).toEqual([])
  })
  it('embedding bank changes invalidate preview even when revision numbers stay equal',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs);const {appendChunkEmbedding}=await import('./chunk-embedding-store.js');appendChunkEmbedding('meeting_sample',{i:0,speaker:'Ext',similarity:.3,embedding:v(0,50)})
    await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'evidence_changed'});expect(enrollments).toBe(0)
  })
  it('replay rejects a different name or member set before looking up applied receipt',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs);await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})
    await expect(api.applyHeldNaming('Wrong Person',refs,p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'preview_mismatch'})
    await expect(api.applyHeldNaming('Brigitta Pólya',[{sessionId:'meeting_sample',chunkIndex:7}],p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'preview_mismatch'})
  })
  it('records two-copy partial failure then restores each copy through explicit Undo',async()=>{
    twoCopies();const atomic=await import('./atomic-fs.js'),real=atomic.durableAtomicWriteFileSync
    const p=api.previewHeldNaming('Brigitta Pólya',refs)
    const spy=vi.spyOn(atomic,'durableAtomicWriteFileSync').mockImplementation((path,...args)=>{if(String(path).endsWith('/2026-09-13_ops.md'))throw new Error('simulated copy crash');return real(path,...args)})
    const a=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true});spy.mockRestore()
    expect(a.status).toBe('partial');expect(a.deleted).toBe(0);expect(a.meetings[0].receipts.map(r=>r.status)).toEqual(['applied','sidecar_written'])
    expect(a.members[0]).toMatchObject({status:'failed',labelStatus:'failed',enrollmentStatus:'enrolled',audioStatus:'retained',reason:'simulated copy crash'})
    vi.resetModules();api=await import('./held-naming-batches.js');expect(api.namingBatchList().batches[0].members).toEqual(a.members)
    const undo=await api.undoHeldNaming(a.batchId,true);expect(undo.status).toBe('reverted');expect(read().chunks).toEqual(originalDoc.chunks);expect(JSON.parse(readFileSync(opSide,'utf8')).chunks).toEqual(originalDoc.chunks)
    expect(undo.members[0]).toMatchObject({status:'reverted',labelStatus:'reverted',enrollmentStatus:'enrolled',audioStatus:'retained'});expect(undo.members[0].reason).toBeUndefined()
  })
  it('crash after sidecar write before receipt can still be explicitly reverted',async()=>{
    const atomic=await import('./atomic-fs.js'),real=atomic.durableAtomicWriteFileSync
    const p=api.previewHeldNaming('Brigitta Pólya',refs)
    const spy=vi.spyOn(atomic,'durableAtomicWriteFileSync').mockImplementation((path,...args)=>{const result=real(path,...args);if(path===saved.sidecarPath)throw new Error('crash after write');return result})
    const a=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true});spy.mockRestore();expect(a.status).toBe('partial');expect(a.meetings[0].receipts[0].status).toBe('pending')
    expect((await api.undoHeldNaming(a.batchId,true)).status).toBe('reverted');expect(read().chunks).toEqual(originalDoc.chunks)
  })
  it('crash after audio deletion replays without reenrolling or restoring audio',async()=>{
    const atomic=await import('./atomic-fs.js'),real=atomic.durableAtomicWriteFileSync
    const p=api.previewHeldNaming('Brigitta Pólya',refs)
    const spy=vi.spyOn(atomic,'durableAtomicWriteFileSync').mockImplementation((path,data,...args)=>{if(String(path).includes('/batch-')&&String(data).includes('"deleted": 1'))throw new Error('crash after delete');return real(path,data,...args)})
    await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})).rejects.toThrow('crash after delete');spy.mockRestore()
    const replay=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true});expect(replay.deleted).toBe(1);expect(enrollments).toBe(1);expect((await api.undoHeldNaming(replay.batchId,true)).audioRestored).toBe(false)
  })
  it('a layered later batch refuses Undo of an earlier touched position',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs);const a=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})
    const b=await api.renameMeetingSpeaker('meeting_sample','Brigitta Pólya','Updated Name',{apply:true})
    const undo=await api.undoHeldNaming(a.batchId,true);expect(undo.status).toBe('partial');expect(undo.meetings[0].error).toContain('later batch');expect(read().chunks[1].speaker).toBe('Updated Name')
    expect((await api.undoHeldNaming(b.batchId!,true)).status).toBe('reverted')
    expect((await api.undoHeldNaming(a.batchId,true)).status).toBe('reverted')
    expect(read().chunks[1].speaker).toBe('Ext')
  })
  it('legacy confirmation remains whole-label while chunk confirmation never vouches sibling7',async()=>{
    const {appendCorrection,confirmedLabels,confirmedChunks}=await import('./meeting-corrections.js')
    const {reviewMeetingSpeakers}=await import('./meeting-speaker-review.js')
    appendCorrection('meeting_sample',{id:'legacy',phase:'confirmed',at:'2026',from:'Legacy Name',to:'Legacy Name',chunks:[],scope:'meeting'})
    appendCorrection('meeting_sample',{id:'scoped',phase:'confirmed-chunks',at:'2026',from:'Ext',to:'Brigitta Pólya',chunks:[0],scope:'meeting',batchId:'batch1'})
    expect(confirmedLabels('meeting_sample').has('Legacy Name')).toBe(true)
    const review=reviewMeetingSpeakers([{speaker:'Brigitta Pólya',text:'a',similarity:.1},{speaker:'Brigitta Pólya',text:'b',similarity:.1}],{confirmed:confirmedLabels('meeting_sample'),confirmedChunks:confirmedChunks('meeting_sample')})
    expect(review.voices[0].nameAsserted).toBe(false)
  })

  it('operations ops_pending mirror is finalized when canonical local is complete and operations sync finalized',()=>{
    twoCopies();const local=read();local.finalizationState='complete';writeFileSync(saved.sidecarPath,JSON.stringify(local))
    const op=JSON.parse(readFileSync(opSide,'utf8'));op.finalizationState='ops_pending';op.syncState='finalized';op.hqState='accepted';writeFileSync(opSide,JSON.stringify(op))
    expect(api.previewHeldNaming('Brigitta Pólya',refs).meetings[0].status).toBe('ready')
    local.finalizationState='ops_pending';writeFileSync(saved.sidecarPath,JSON.stringify(local));expect(api.previewHeldNaming('Brigitta Pólya',refs).meetings[0].status).toBe('blocked')
  })

  it('a named label in either copy prevents held relabel on every copy',async()=>{
    twoCopies();const op=JSON.parse(readFileSync(opSide,'utf8'));op.chunks[1].speaker='Queen';op.chunkEntries[3].chunk.speaker='Queen';writeFileSync(opSide,JSON.stringify(op))
    const p=api.previewHeldNaming('Brigitta Pólya',refs);expect(p.meetings[0].status).toBe('blocked');expect(p.meetings[0].error).toContain('disagree on speaker labels')
    await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'meetings_changed'});expect(enrollments).toBe(0);expect(JSON.parse(readFileSync(opSide,'utf8')).chunks[1].speaker).toBe('Queen')
  })

  it('disjoint undo survives later attendee insertions and restores only its own prefixes',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs);const a=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})
    const b=await api.renameMeetingSpeaker('meeting_sample','Other','Separate Name',{apply:true})
    const undo=await api.undoHeldNaming(a.batchId,true);expect(undo.status).toBe('reverted');expect(read().chunks.map((c:any)=>c.speaker)).toEqual(['Ext','Ext','Separate Name'])
    const md=readFileSync(saved.filepath,'utf8');expect(md).toContain('[Ext]: two distinct words');expect(md).toContain('[Separate Name]: three unchanged words');expect(md).toContain('- Separate Name');expect(md).not.toContain('- Brigitta Pólya');expect(md).toContain('<!-- speaker-labels-newer-than-graph -->')
    expect((await api.undoHeldNaming(b.batchId!,true)).status).toBe('reverted')
  })

  it('Undo retries safely after crash between restored sidecar and markdown',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs);const a=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})
    const atomic=await import('./atomic-fs.js'),real=atomic.durableAtomicWriteFileSync
    const spy=vi.spyOn(atomic,'durableAtomicWriteFileSync').mockImplementation((path,...args)=>{const result=real(path,...args);if(path===saved.sidecarPath)throw new Error('crash in undo after sidecar');return result})
    expect((await api.undoHeldNaming(a.batchId,true)).status).toBe('partial');spy.mockRestore()
    expect((await api.undoHeldNaming(a.batchId,true)).status).toBe('reverted');expect(read().chunks).toEqual(originalDoc.chunks);expect(readFileSync(saved.filepath,'utf8')).toContain('[Ext]: two distinct words')
  })
  it('sync-lock contention fails before enrolment against another live Python holder',async()=>{
    twoCopies();const {spawn}=await import('node:child_process')
    const holder=spawn('/usr/bin/python3',['-c',"import fcntl,sys; f=open(sys.argv[1],'a+'); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); sys.stdin.read()",join(ops,'scripts','.sync_meetings.lock')],{stdio:['pipe','pipe','pipe']})
    await new Promise<void>(resolve=>holder.stdout.once('data',()=>resolve()))
    try{const p=api.previewHeldNaming('Brigitta Pólya',refs);await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'sync_running'});expect(enrollments).toBe(0)}finally{holder.stdin.end();await new Promise<void>(resolve=>holder.once('exit',()=>resolve()))}
  })
  it('high count wider matches require listening before any enrolment',async()=>{
    const doc=read(),{appendChunkEmbedding}=await import('./chunk-embedding-store.js')
    doc.chunks=Array.from({length:31},(_,i)=>({speaker:'Ext',text:`unique text ${i}`,elapsed:(i+1)*1000,similarity:.2}));doc.chunkEntries=doc.chunks.map((chunk:any,chunkIndex:number)=>({chunkIndex,chunk}));delete doc.batchSegments
    writeFileSync(saved.sidecarPath,JSON.stringify(doc));writeFileSync(saved.filepath,'## Transcript\n\n'+doc.chunks.map((c:any)=>`[Ext]: ${c.text}`).join('\n\n')+'\n')
    for(let i=0;i<31;i++)appendChunkEmbedding('meeting_sample',{i,speaker:'Ext',similarity:.2,embedding:v(0,i+100)})
    const p=api.previewHeldNaming('Brigitta Pólya',refs);expect(p.requiresListening).toBe(true);expect(p.meetings[0].widerChunks.length).toBe(30)
    await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})).rejects.toMatchObject({reason:'listening_required'});expect(enrollments).toBe(0)
  })
  it('write-site word guard catches a poisoned edit before markdown or audio changes',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs),labels=await import('./meeting-speaker-labels.js'),real=labels.relabelSpeakerPositions
    const spy=vi.spyOn(labels,'relabelSpeakerPositions').mockImplementation((...args)=>{const out=real(...args);out.markdown=out.markdown.replace('two distinct words','silently rewritten words');return out})
    const result=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true});spy.mockRestore()
    expect(result.status).toBe('partial');expect(result.deleted).toBe(0);expect(readFileSync(saved.filepath,'utf8')).toBe(originalMd)
  })

  it('HQ acceptance after enrolment but before copy write fails the meeting closed',async()=>{
    const p=api.previewHeldNaming('Brigitta Pólya',refs)
    onEnroll=()=>{const doc=read();doc.lifecycleRevision=1;doc.batchApplied=true;writeFileSync(saved.sidecarPath,JSON.stringify(doc));onEnroll=undefined}
    const result=await api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true})
    expect(result.status).toBe('partial');expect(result.deleted).toBe(0);expect(result.meetings[0].error).toContain('changed at write-time');expect(read().chunks[1].speaker).toBe('Ext')
  })
  it('deliberate owner wider match uses scorer and 0.65 gate with owner acknowledgement',async()=>{
    profiles=[{name:'MU',embeddings:[Array.from(v(0,60))],sources:['manual']}]
    const {appendChunkEmbedding}=await import('./chunk-embedding-store.js');appendChunkEmbedding('meeting_sample',{i:0,speaker:'Ext',similarity:.3,embedding:v(0,61)})
    let p=api.previewHeldNaming('mu',refs);expect(p.owner).toBe(true);expect(p.meetings[0].widerChunks).toEqual([0])
    const weak=new Float32Array(192);weak[0]=.6;weak[1]=.8;appendChunkEmbedding('meeting_sample',{i:0,speaker:'Ext',similarity:.3,embedding:weak})
    p=api.previewHeldNaming('mu',refs);expect(p.meetings[0].widerChunks).toEqual([])
  })
  it('ineligible already named held samples cannot inflate wider matching support',async()=>{
    const doc=read();doc.chunks[0].speaker='Known Person';doc.chunkEntries[0].chunk.speaker='Known Person';doc.chunks[2].speaker='Ext';doc.chunkEntries[4].chunk.speaker='Ext';writeFileSync(saved.sidecarPath,JSON.stringify(doc))
    const {appendChunkEmbedding}=await import('./chunk-embedding-store.js');appendChunkEmbedding('meeting_sample',{i:0,speaker:'Known Person',similarity:.3,embedding:v(0,61)});appendChunkEmbedding('meeting_sample',{i:7,speaker:'Ext',similarity:.3,embedding:v(0,62)})
    writeFileSync(join(data,'ext-audio','meeting_sample','ext_chunk0_1000.wav'),Buffer.alloc(48))
    const p=api.previewHeldNaming('Brigitta Pólya',[{sessionId:'meeting_sample',chunkIndex:0},...refs]);expect(p.members[0].status).toBe('no_longer_Ext');expect(p.meetings[0].widerChunks).toEqual([2]);expect(p.meetings[0].widerScores?.[0].agreeing).toBe(1)
  })
  it('competing voice wins even when candidate is coherent with named seed',async()=>{
    const {appendChunkEmbedding}=await import('./chunk-embedding-store.js');const candidate=new Float32Array(192);candidate[0]=.6;candidate[1]=.8
    appendChunkEmbedding('meeting_sample',{i:0,speaker:'Ext',similarity:.3,embedding:candidate});profiles=[{name:'Competing Person',embeddings:[Array.from(candidate),Array.from(candidate)],sources:['manual','manual']}]
    const p=api.previewHeldNaming('Brigitta Pólya',refs);expect(p.meetings[0].status).toBe('ready');expect(p.meetings[0].widerChunks).toEqual([])
  })

  it('pending correction intent blocks a meeting even with force true',async()=>{
    const {appendCorrection}=await import('./meeting-corrections.js');appendCorrection('meeting_sample',{id:'still-pending',phase:'intent',at:new Date().toISOString(),from:'Ext',to:'Other Name',chunks:[1],scope:'meeting'})
    const p=api.previewHeldNaming('Brigitta Pólya',refs);expect(p.meetings[0].status).toBe('blocked');expect(p.meetings[0].error).toContain('interrupted correction')
    await expect(api.applyHeldNaming('Brigitta Pólya',refs,p.previewHash,{confirm:true,...({force:true}as any)})).rejects.toMatchObject({reason:'meetings_changed'})
  })

})
