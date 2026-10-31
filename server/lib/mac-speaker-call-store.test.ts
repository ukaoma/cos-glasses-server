import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { prepareMacSpeakerCallPublication, executeMacSpeakerCallPublication, hashMacSpeakerCallFileInventory, type MacSpeakerCallPublicationInput, type MacSpeakerCallQualification, type MacSpeakerCallFileRole } from './mac-speaker-call-store.js'
import { bindMacSpeakerShadowRepair } from './mac-speaker-shadow-repair.js'
import { reconcileMacSpeaker256Snapshot } from './mac-speaker-live-memory.js'
import { prepareMacSpeakerCallPacket } from './mac-speaker-call-view.js'
import { pcm16WavFile } from './speaker-shadow-timeline.js'

const roots:string[]=[],sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex'),digest=(v:unknown)=>sha(JSON.stringify(v))
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
/** Synthetic, empty acoustic result with an explicitly FICTIONAL QA decision.
 * No test fixture receipt represents native execution or real qualification. */
function fixture(intervalMembership?:'accepted-only'|'native-exclusive-members'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'call-store-')));roots.push(root)
  const txRoot=join(root,'transactions');mkdirSync(txRoot)
  const captureId='mac_synthetic_store',pcm=Buffer.alloc(32000),wav=pcm16WavFile(pcm),wavPath=join(root,'raw.wav'),modelPath=join(root,'model.bin'),cliPath=join(root,'cli.bin')
  writeFileSync(wavPath,wav);writeFileSync(modelPath,'fictional model');writeFileSync(cliPath,'fictional CLI')
  const chunk={text:'fictional words',speaker:'Voice 1',elapsed:0,audioSha256:sha(wav),audioDurationMs:1000,segments:[{speaker:'Voice 1',startSec:0,endSec:1}]}
  const doc={sessionId:captureId,sourceType:'mac_system_audio',finalizationState:'complete',chunks:[chunk],chunkEntries:[{chunkIndex:0,chunk}]}
  const original=JSON.stringify(doc),native=JSON.stringify({segments:[{speakerId:'S1',startTimeSeconds:0,endTimeSeconds:1}]}),embeddings='[]',modelSHA256=sha('synthetic model-space manifest'),cliSHA256=sha('fictional CLI')
  const rawManifest={version:1,captureId,rows:[{rawChunkIndex:0,path:wavPath,wavSHA256:sha(wav),pcmSHA256:sha(pcm),sampleCount:16000}]}
  const modelManifest={version:1,modelSHA256,files:[{path:modelPath,sha256:sha('fictional model')}]}
  const source={originalJSON:original,currentJSON:original,ledgerJSONL:'',rawAudio:[{rawChunkIndex:0,wavSHA256:sha(wav),pcmSHA256:sha(pcm),sampleCount:16000}],timeline:{rows:[{rawChunkIndex:0,startSample:0,sampleCount:16000,usedSampleCount:16000}],total:16000,pcmSHA256:sha(pcm)},cohort:{nativeJSON:native,embeddingsJSON:embeddings,modelSHA256,cliSHA256}}
  const snapshot={...source,sourceBindingSHA256:bindMacSpeakerShadowRepair(source),generation:'synthetic-generation'},state=reconcileMacSpeaker256Snapshot(null,snapshot)
  const packet:any=prepareMacSpeakerCallPacket(snapshot,state,{admission:'qualified',...(intervalMembership?{projectionPolicy:'source-bound-intervals' as const,intervalMembership}:{})})
  // Explicit synthetic policy annotation also works while the peer's additive
  // projectionPolicy field is being implemented; no semantic gate is bypassed.
  if(!intervalMembership)packet.projectionPolicy='strict';const{packetSHA256:_,...body}=packet;packet.packetSHA256=digest(body)
  const values:Array<[MacSpeakerCallFileRole,string,string|Buffer|null]>=[['original','original.json',original],['current','meeting.g2-chunks.json',original],['ledger','ledger.jsonl',null],['raw-pcm-manifest','raw-manifest.json',JSON.stringify(rawManifest)],['cli','cli.bin','fictional CLI'],['model-manifest','model-manifest.json',JSON.stringify(modelManifest)],['native-export','native.json',native],['embedding-export','embeddings.json',embeddings],['raw-audio','raw.wav',wav],['model-file','model.bin','fictional model']]
  const sources=values.map(([role,name,bytes])=>{const path=join(root,name);if(bytes!==null)writeFileSync(path,bytes);return{role,path,sha256:bytes===null?null:sha(bytes)}})
  const packetJSON=JSON.stringify(packet),stateJSON=JSON.stringify(state)
  const qualification:MacSpeakerCallQualification={...(intervalMembership?{version:2 as const,policy:'fluid256-call-interval-view-v1' as const,admissionPolicy:'source-bound-intervals' as const,intervalMembership,intervalSupportSHA256:packet.intervalSupport.supportSHA256,timelinePCMSHA256:packet.intervalSupport.timelinePCMSHA256}:{version:1 as const,policy:'fluid256-call-view-v1' as const,admissionPolicy:'strict' as const}),kind:'mac-speaker-call-qualified',captureId,qualification:{status:'qualified',reviewer:'SYNTHETIC UNIT TEST ONLY',reviewReceiptSHA256:sha('fictional independent review')},sourceFilesSHA256:hashMacSpeakerCallFileInventory(sources),bindings:{originalSHA256:sha(original),currentSHA256:sha(original),ledgerSHA256:sha(''),rawPCMManifestSHA256:sha(JSON.stringify(rawManifest)),cliSHA256,modelSHA256,nativeExportSHA256:sha(native),embeddingExportSHA256:sha(embeddings),sourceBindingSHA256:snapshot.sourceBindingSHA256,stateSHA256:state.stateSHA256,packetSHA256:packet.packetSHA256,stateFileSHA256:sha(stateJSON),packetFileSHA256:sha(packetJSON)}}
  const qualificationPath=join(root,'qualification.json');writeFileSync(qualificationPath,JSON.stringify(qualification))
  const input:MacSpeakerCallPublicationInput={captureId,transactionRoot:txRoot,packetPath:join(root,'meeting.speaker-call.json'),statePath:join(root,'meeting.speaker-call-state.json'),packetJSON,stateJSON,expectedPacketSHA256:null,expectedStateFileSHA256:null,sources,qualificationReceipt:{path:qualificationPath,expectedSHA256:sha(JSON.stringify(qualification))}}
  return{root,input,qualification,currentPath:sources.find(x=>x.role==='current')!.path,ledgerPath:sources.find(x=>x.role==='ledger')!.path,qualificationPath,wavPath,modelPath,rawManifest,packet,state,original}
}
function qEdit(f:ReturnType<typeof fixture>,change:(q:MacSpeakerCallQualification)=>void){change(f.qualification);const bytes=JSON.stringify(f.qualification);writeFileSync(f.qualificationPath,bytes);f.input.qualificationReceipt.expectedSHA256=sha(bytes)}
const journal=(dir:string)=>JSON.parse(readFileSync(join(dir,'transaction.json'),'utf8'))
const overwrite=(p:string,text:string|Buffer)=>{chmodSync(p,0o600);writeFileSync(p,text)}

describe('separately qualified source-bound interval publication',()=>{
  for(const membership of ['accepted-only','native-exclusive-members'] as const)it(`publishes and undoes explicitly reviewed ${membership} without changing original evidence`,()=>{
    const f=fixture(membership),before=readFileSync(f.currentPath),dir=prepareMacSpeakerCallPublication(f.input)
    expect(executeMacSpeakerCallPublication(dir,'apply').phase).toBe('applied')
    expect(JSON.parse(readFileSync(f.input.packetPath,'utf8')).intervalSupport.membership).toBe(membership)
    expect(readFileSync(f.currentPath)).toEqual(before);expect(existsSync(f.ledgerPath)).toBe(false)
    expect(executeMacSpeakerCallPublication(dir,'undo').phase).toBe('reverted')
    expect(existsSync(f.input.packetPath)).toBe(false);expect(existsSync(f.input.statePath)).toBe(false)
  })
  it('does not let a legacy qualification authorize an interval packet',()=>{
    const f=fixture('accepted-only')
    qEdit(f,q=>{Object.assign(q,{version:1,policy:'fluid256-call-view-v1',admissionPolicy:'strict'});delete(q as any).intervalMembership;delete(q as any).intervalSupportSHA256;delete(q as any).timelinePCMSHA256})
    expect(()=>prepareMacSpeakerCallPublication(f.input)).toThrow('qualified packet/state policy')
    expect(existsSync(f.input.packetPath)).toBe(false)
  })
  for(const field of ['intervalMembership','intervalSupportSHA256','timelinePCMSHA256'] as const)it(`requires the independent receipt to bind ${field}`,()=>{
    const f=fixture('accepted-only');qEdit(f,q=>{(q as any)[field]=field==='intervalMembership'?'native-exclusive-members':sha('a different independently reviewed source')})
    expect(()=>prepareMacSpeakerCallPublication(f.input)).toThrow('qualified interval evidence binding')
    expect(existsSync(f.input.packetPath)).toBe(false)
  })
  it('rejects an arbitrary native interval even after the packet, support, and receipt are rehashed',()=>{
    const f=fixture('native-exclusive-members'),support=f.packet.intervalSupport
    support.nativeIntervals[0].nativeCluster='S2'
    const{supportSHA256:_,...supportBody}=support;support.supportSHA256=digest(supportBody)
    const{packetSHA256:__,...packetBody}=f.packet;f.packet.packetSHA256=digest(packetBody);f.input.packetJSON=JSON.stringify(f.packet)
    qEdit(f,q=>{q.bindings.packetSHA256=f.packet.packetSHA256;q.bindings.packetFileSHA256=sha(f.input.packetJSON);(q as any).intervalSupportSHA256=support.supportSHA256})
    expect(()=>prepareMacSpeakerCallPublication(f.input)).toThrow('native source geometry drift')
    expect(existsSync(f.input.packetPath)).toBe(false);expect(readFileSync(f.currentPath,'utf8')).toBe(f.original)
  })
})

describe('explicitly qualified derived speaker-call transaction',()=>{
  it('journals before publication, applies/idempotently resumes, and restores exact absence without touching base/ledger',()=>{
    const f=fixture(),before=readFileSync(f.currentPath),dir=prepareMacSpeakerCallPublication(f.input)
    expect(journal(dir).phase).toBe('prepared');expect(existsSync(f.input.packetPath)).toBe(false)
    expect(executeMacSpeakerCallPublication(dir,'apply').phase).toBe('applied')
    expect(readFileSync(f.input.packetPath,'utf8')).toBe(f.input.packetJSON);expect(readFileSync(f.input.statePath,'utf8')).toBe(f.input.stateJSON)
    expect(executeMacSpeakerCallPublication(dir,'apply').phase).toBe('applied')
    expect(executeMacSpeakerCallPublication(dir,'undo').phase).toBe('reverted')
    expect(existsSync(f.input.packetPath)).toBe(false);expect(existsSync(f.input.statePath)).toBe(false)
    expect(executeMacSpeakerCallPublication(dir,'undo').phase).toBe('reverted')
    expect(()=>executeMacSpeakerCallPublication(dir,'apply')).toThrow('cannot be reapplied')
    expect(readFileSync(f.currentPath)).toEqual(before);expect(existsSync(f.ledgerPath)).toBe(false)
  })
  it('restores exact preexisting artifact bytes and refuses stale initial target expectations',()=>{
    const f=fixture();writeFileSync(f.input.packetPath,'old packet\n');writeFileSync(f.input.statePath,'old state\n')
    expect(()=>prepareMacSpeakerCallPublication(f.input)).toThrow('initial target CAS')
    f.input.expectedPacketSHA256=sha('old packet\n');f.input.expectedStateFileSHA256=sha('old state\n')
    const dir=prepareMacSpeakerCallPublication(f.input);executeMacSpeakerCallPublication(dir,'apply');executeMacSpeakerCallPublication(dir,'undo')
    expect(readFileSync(f.input.packetPath,'utf8')).toBe('old packet\n');expect(readFileSync(f.input.statePath,'utf8')).toBe('old state\n')
  })
  it('does not adopt another prepared transaction\'s later identical publication',()=>{
    const f=fixture(),first=prepareMacSpeakerCallPublication(f.input),second=prepareMacSpeakerCallPublication(f.input)
    executeMacSpeakerCallPublication(first,'apply')
    expect(()=>executeMacSpeakerCallPublication(second,'apply')).toThrow('ownership CAS')
    expect(()=>executeMacSpeakerCallPublication(second,'undo')).toThrow('ownership CAS')
    expect(readFileSync(f.input.packetPath,'utf8')).toBe(f.input.packetJSON)
    executeMacSpeakerCallPublication(first,'undo')
  })
  it('rechecks source bytes before intent exists and refuses late preparation target changes',()=>{
    const f=fixture();expect(()=>prepareMacSpeakerCallPublication(f.input,{beforeWrite:()=>writeFileSync(f.currentPath,f.original+'\n')})).toThrow('source drift')
    expect(existsSync(f.input.packetPath)).toBe(false)
    const g=fixture();expect(()=>prepareMacSpeakerCallPublication(g.input,{beforeWrite:()=>writeFileSync(g.input.packetPath,g.input.packetJSON)})).toThrow('preparation target CAS')
    expect(readFileSync(g.input.packetPath,'utf8')).toBe(g.input.packetJSON)
  })
  for(const after of [0,1])it(`recovers a torn publication after artifact${after} without redoing acoustic inference`,()=>{
    const f=fixture(),dir=prepareMacSpeakerCallPublication(f.input)
    expect(()=>executeMacSpeakerCallPublication(dir,'apply',{afterWrite:index=>{if(index===after)throw Error('synthetic crash')}})).toThrow('synthetic crash')
    expect(journal(dir).phase).toBe('partial');expect(existsSync(f.input.packetPath)).toBe(true);expect(existsSync(f.input.statePath)).toBe(after===1)
    expect(()=>executeMacSpeakerCallPublication(dir,'apply')).toThrow('explicit resume')
    executeMacSpeakerCallPublication(dir,'apply',{resume:true});expect(journal(dir).phase).toBe('applied')
    executeMacSpeakerCallPublication(dir,'undo');expect(existsSync(f.input.packetPath)).toBe(false)
  })
  for(const role of ['current','ledger','cli','model-file','native-export','embedding-export','raw-audio'] as const)it(`rechecks ${role} immediately before publication and preserves partial intent on conflict`,()=>{
    const f=fixture(),pin=f.input.sources.find(x=>x.role===role)!,old=existsSync(pin.path)?readFileSync(pin.path):null,dir=prepareMacSpeakerCallPublication(f.input)
    expect(()=>executeMacSpeakerCallPublication(dir,'apply',{beforeWrite:i=>{if(i===0)writeFileSync(pin.path,'drift')}})).toThrow()
    expect(existsSync(f.input.packetPath)).toBe(false);expect(journal(dir).phase).toBe('partial')
    if(old)writeFileSync(pin.path,old);else rmSync(pin.path)
    executeMacSpeakerCallPublication(dir,'apply',{resume:true});executeMacSpeakerCallPublication(dir,'undo')
  })
  it('refuses later human/base edits during undo without modifying either derived artifact',()=>{
    const f=fixture(),dir=prepareMacSpeakerCallPublication(f.input);executeMacSpeakerCallPublication(dir,'apply')
    writeFileSync(f.currentPath,f.original+'\n')
    expect(()=>executeMacSpeakerCallPublication(dir,'undo')).toThrow('source drift')
    expect(readFileSync(f.input.packetPath,'utf8')).toBe(f.input.packetJSON);expect(readFileSync(f.currentPath,'utf8')).toBe(f.original+'\n')
  })
  it('refuses later artifact edits on undo and idempotent apply',()=>{
    const f=fixture(),dir=prepareMacSpeakerCallPublication(f.input);executeMacSpeakerCallPublication(dir,'apply');writeFileSync(f.input.packetPath,'later external edit')
    expect(()=>executeMacSpeakerCallPublication(dir,'undo')).toThrow('target CAS');expect(()=>executeMacSpeakerCallPublication(dir,'apply')).toThrow('target CAS')
    expect(readFileSync(f.input.packetPath,'utf8')).toBe('later external edit')
  })
  for(const when of ['before','after'] as const)it(`rechecks owned qualification proof ${when} target publication`,()=>{
    const f=fixture(),dir=prepareMacSpeakerCallPublication(f.input),proof=join(dir,'qualification.json'),old=readFileSync(proof)
    const mutate=(i:number)=>{if(i===(when==='before'?0:1))overwrite(proof,'changed owned proof')}
    expect(()=>executeMacSpeakerCallPublication(dir,'apply',when==='before'?{beforeWrite:mutate}:{afterWrite:mutate})).toThrow('owned proof/image drift')
    expect(existsSync(f.input.packetPath)).toBe(when==='after');expect(journal(dir).phase).not.toBe('applied')
    overwrite(proof,old);executeMacSpeakerCallPublication(dir,'apply',{resume:true});executeMacSpeakerCallPublication(dir,'undo')
  })
  it('preserves externally changed journal bytes and refuses recovery from them',()=>{
    const f=fixture(),dir=prepareMacSpeakerCallPublication(f.input),path=join(dir,'transaction.json')
    expect(()=>executeMacSpeakerCallPublication(dir,'apply',{beforeWrite:i=>{if(i===0)writeFileSync(path,'external journal')}})).toThrow('journal drift')
    expect(readFileSync(path,'utf8')).toBe('external journal');expect(existsSync(f.input.packetPath)).toBe(false)
    expect(()=>executeMacSpeakerCallPublication(dir,'apply',{resume:true})).toThrow()
  })
  for(const mode of ['apply','undo'] as const)for(const saveNumber of [1,2,4])it(`preserves a journal replaced after ${mode} rename ${saveNumber} and never reports completion`,()=>{
    const f=fixture(),dir=prepareMacSpeakerCallPublication(f.input),path=join(dir,'transaction.json')
    if(mode==='undo')executeMacSpeakerCallPublication(dir,'apply')
    const fs=createRequire(import.meta.url)('node:fs') as typeof import('node:fs'),realRename=fs.renameSync
    const external='EXTERNAL JOURNAL OWNER\n';let seen=0,intercepted=false
    fs.renameSync=(from,to)=>{
      realRename(from,to)
      if(to===path&&++seen===saveNumber){intercepted=true;writeFileSync(path,external)}
    }
    syncBuiltinESMExports()
    try{expect(()=>executeMacSpeakerCallPublication(dir,mode)).toThrow('journal publication readback drift')}
    finally{fs.renameSync=realRename;syncBuiltinESMExports()}
    expect(intercepted).toBe(true);expect(readFileSync(path,'utf8')).toBe(external)
    const published=saveNumber===1?0:saveNumber===2?1:2
    expect(existsSync(f.input.packetPath)).toBe(mode==='apply'?published>=1:published<1)
    expect(existsSync(f.input.statePath)).toBe(mode==='apply'?published>=2:published<2)
    expect(()=>executeMacSpeakerCallPublication(dir,mode,{resume:true})).toThrow()
    expect(readFileSync(path,'utf8')).toBe(external)
  })
  it('rejects a changed external qualification receipt even if its copied proof remains intact',()=>{
    const f=fixture(),dir=prepareMacSpeakerCallPublication(f.input)
    expect(()=>executeMacSpeakerCallPublication(dir,'apply',{beforeWrite:i=>{if(i===0)writeFileSync(f.qualificationPath,'changed receipt')}})).toThrow('qualification receipt drift')
    expect(existsSync(f.input.packetPath)).toBe(false)
  })
  it('does not autoqualify an off packet, absent receipt, unknown policy or unsigned caller assertion',()=>{
    for(const kind of ['off','missing','policy','unqualified'] as const){
      const f=fixture()
      if(kind==='off'){f.packet.admission='off';const{packetSHA256:_,...b}=f.packet;f.packet.packetSHA256=digest(b);f.input.packetJSON=JSON.stringify(f.packet);qEdit(f,q=>{q.bindings.packetSHA256=f.packet.packetSHA256;q.bindings.packetFileSHA256=sha(f.input.packetJSON)})}
      if(kind==='missing')rmSync(f.qualificationPath)
      if(kind==='policy')qEdit(f,q=>{q.admissionPolicy='guessed-policy' as any})
      if(kind==='unqualified')qEdit(f,q=>{q.qualification.status='proposed' as any})
      expect(()=>prepareMacSpeakerCallPublication(f.input)).toThrow();expect(existsSync(f.input.packetPath)).toBe(false)
    }
  })
  it('binds independent receipt to exact projection policy',()=>{
    const f=fixture();qEdit(f,q=>{q.admissionPolicy='anonymous-estimate'})
    expect(()=>prepareMacSpeakerCallPublication(f.input)).toThrow('packet/state policy')
  })
  it('physically verifies PCM rather than trusting a rehashed manifest claim',()=>{
    const f=fixture();f.rawManifest.rows[0].pcmSHA256='b'.repeat(64)
    const pin=f.input.sources.find(x=>x.role==='raw-pcm-manifest')!,bytes=JSON.stringify(f.rawManifest);writeFileSync(pin.path,bytes);pin.sha256=sha(bytes)
    qEdit(f,q=>{q.sourceFilesSHA256=hashMacSpeakerCallFileInventory(f.input.sources);q.bindings.rawPCMManifestSHA256=pin.sha256!})
    expect(()=>prepareMacSpeakerCallPublication(f.input)).toThrow('raw PCM drift')
  })
  it('requires complete raw and model file inventories',()=>{
    for(const role of ['raw-audio','model-file'] as const){const f=fixture();f.input.sources=f.input.sources.filter(x=>x.role!==role);qEdit(f,q=>{q.sourceFilesSHA256=hashMacSpeakerCallFileInventory(f.input.sources)})
      expect(()=>prepareMacSpeakerCallPublication(f.input)).toThrow('complete manifest inventory')}
  })
  it('refuses symlink sources/targets and never permits a BASE target',()=>{
    const f=fixture(),pin=f.input.sources.find(x=>x.role==='cli')!,link=join(f.root,'cli-link');symlinkSync(pin.path,link);pin.path=link
    expect(()=>prepareMacSpeakerCallPublication(f.input)).toThrow()
    const g=fixture();g.input.packetPath=g.currentPath;g.input.expectedPacketSHA256=sha(g.original);expect(()=>prepareMacSpeakerCallPublication(g.input)).toThrow('target scope');expect(readFileSync(g.currentPath,'utf8')).toBe(g.original)
    const h=fixture();symlinkSync(h.currentPath,h.input.packetPath);expect(()=>prepareMacSpeakerCallPublication(h.input)).toThrow();expect(readFileSync(h.currentPath,'utf8')).toBe(h.original)
  })
  it('requires explicit stale-lock recovery and never reclaims a live owner',()=>{
    const f=fixture(),path=join(f.root,`.${f.input.captureId}.speaker-call.lock`),abandoned=join(f.input.transactionRoot,'abandoned');mkdirSync(abandoned);writeFileSync(join(abandoned,'leave-me'),'immutable abandoned preparation')
    writeFileSync(path,JSON.stringify({pid:process.pid,token:'live'}));expect(()=>prepareMacSpeakerCallPublication(f.input,{resume:true})).toThrow('owner alive')
    writeFileSync(path,JSON.stringify({pid:2147483647,token:'dead'}));expect(()=>prepareMacSpeakerCallPublication(f.input)).toThrow('explicit resume')
    const dir=prepareMacSpeakerCallPublication(f.input,{resume:true});executeMacSpeakerCallPublication(dir,'apply');executeMacSpeakerCallPublication(dir,'undo')
    expect(readFileSync(join(abandoned,'leave-me'),'utf8')).toBe('immutable abandoned preparation')
  })
  it('serializes separate representations of one capture under the common transaction root',()=>{
    const f=fixture(),other=fixture();other.input.transactionRoot=f.input.transactionRoot
    const dir=prepareMacSpeakerCallPublication(f.input)
    executeMacSpeakerCallPublication(dir,'apply',{beforeWrite:i=>{if(i===0)expect(()=>prepareMacSpeakerCallPublication(other.input,{resume:true})).toThrow('owner alive')}})
    expect(existsSync(other.input.packetPath)).toBe(false)
    const second=prepareMacSpeakerCallPublication(other.input);executeMacSpeakerCallPublication(second,'apply');executeMacSpeakerCallPublication(second,'undo');executeMacSpeakerCallPublication(dir,'undo')
  })
})
