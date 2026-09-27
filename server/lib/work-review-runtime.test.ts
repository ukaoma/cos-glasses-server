import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkReviewRuntime, proposeReviewTaskLinks, createOptionalWorkReviewRuntime } from './work-review-runtime.js'
import { WorkReviewStore, parseMeetingDescriptor } from './work-review-store.js'
import type { MeetingDetail } from './meeting-store.js'
import type { QueryJobSnapshot } from './query-job-types.js'
const roots: string[] = []; const runtimes: WorkReviewRuntime[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(r => r.close())); roots.splice(0).forEach(r => rmSync(r,{recursive:true,force:true})) })
const descriptor = { domain: 'quilt', month: '2026-09', filename: '2026-09-27_Review Café.md', recordId: 'ops:quilt:meeting-one' }
function setup() {
  const root = mkdtempSync(join(tmpdir(),'work-review-')); roots.push(root)
  let detail = { ...descriptor, title: 'Website review', recordId: descriptor.recordId, sourceContent: 'Review the website launch. Gina owns copy.', sourceTruncated:false,
    transcript:'Review the website launch.', attendees:['Gina'], actionItems:[], decisions:[], topics:[], summary:'Website review', date:'2026-09-27', source:'meeting', duration:'1m', domainAbbr:'Q' } as MeetingDetail
  const jobs = new Map<string, QueryJobSnapshot>(); const submissions: any[] = []
  const models = vi.fn(async () => [{ id:'ollama', provider:'ollama', title:'Local', available:true }, { id:'sonnet', provider:'claude',title:'Claude',available:true }, {id:'cursor-grok',provider:'cursor',title:'Cursor',available:false}])
  const deps = { store:new WorkReviewStore(root), resolveMeeting:vi.fn(async () => structuredClone(detail)), models,
    listTasks:vi.fn(async () => [{id:'existing',domain:'quilt',text:'Review copy',source:descriptor.filename}]), currentMessageEra:()=> 'era-current',
    jobs: { getByClientGeneration:vi.fn(async (id:string) => jobs.get(id)), submit:vi.fn(async (r:any) => {
      submissions.push(r)
      const job = {jobId:'job-'+r.clientJobId,clientJobId:r.clientJobId,generation:1,sessionId:'allocated',status:'running',provider:r.model==='sonnet'?'claude':'ollama'} as QueryJobSnapshot
      jobs.set(r.clientJobId,job);return {job}
    }) },intervalMs:1000 }
  const runtime = new WorkReviewRuntime(deps);runtimes.push(runtime)
  return {root,runtime,deps,jobs,submissions,setDetail:(change:Partial<MeetingDetail>)=>{detail={...detail,...change}}}
}
it('accepts real saved filenames but refuses path traversal and invalid domains', () => {
  expect(parseMeetingDescriptor(descriptor)).toEqual(descriptor)
  for (const filename of ['../secret.md','sub/file.md','sub\\file.md','file\0.md']) expect(()=>parseMeetingDescriptor({...descriptor,filename})).toThrow('invalid_meeting_descriptor')
  expect(()=>parseMeetingDescriptor({...descriptor,domain:'../quilt'})).toThrow()
})
it('persists intent before submit; concurrent/repeated revision is one job and one review',async()=>{
  const s=setup();s.deps.jobs.submit.mockImplementationOnce(async(r:any)=>{
    const journal=JSON.parse(readFileSync(join(s.root,'reviews.json'),'utf8'))
    expect(journal.reviews[0].clientJobId).toBe(r.clientJobId)
    expect(journal.reviews[0].admissionAttempted).toBe(true)
    s.submissions.push(r);const job={jobId:'one',clientJobId:r.clientJobId,generation:1,sessionId:'allocated',status:'running',provider:'ollama'} as QueryJobSnapshot
    s.jobs.set(r.clientJobId,job);return{job}
  })
  const [a,b]=await Promise.all([s.runtime.request({meeting:descriptor,model:'ollama'}),s.runtime.request({meeting:descriptor,model:'ollama'})])
  expect(a.review.id).toBe(b.review.id);expect(b.replayed).toBe(true);expect(s.deps.jobs.submit).toHaveBeenCalledTimes(1)
  expect(s.submissions[0]).toMatchObject({messageEra:'era-current',generation:1,model:'ollama'})
  expect(s.submissions[0]).not.toHaveProperty('sessionId');expect(s.submissions[0]).not.toHaveProperty('origin')
  expect(a.review.taskLinks[0]).toMatchObject({taskId:'existing',decision:'proposed'})
  expect(a.review).not.toHaveProperty('prompt')
})
it('rejects unavailable provider, identity mismatch and stale expected revision before any intent',async()=>{
  const s=setup()
  await expect(s.runtime.request({meeting:descriptor,model:'cursor-grok'})).rejects.toThrow('review_model_unavailable')
  await expect(s.runtime.request({meeting:{...descriptor,recordId:'wrong'},model:'ollama'})).rejects.toThrow('meeting_identity_changed')
  await expect(s.runtime.request({meeting:descriptor,model:'ollama',expectedRevision:'a'.repeat(64)})).rejects.toThrow('meeting_revision_changed')
  expect(s.deps.store.list()).toEqual([]);expect(s.deps.jobs.submit).not.toHaveBeenCalled()
})
it('enforces Claude read-only policy in trusted admission and never falls back model',async()=>{
  const s=setup();await s.runtime.request({meeting:descriptor,model:'sonnet'})
  expect(s.submissions[0]).toMatchObject({model:'sonnet',dispatch:{restricted:true,tools:['Read','Grep','Glob']}})
  await expect(s.runtime.request({meeting:descriptor,model:'ollama'})).rejects.toThrow('review_model_conflict_use_existing')
  expect(s.submissions).toHaveLength(1)
})
it('source correction supersedes old review and admits exactly one new revision',async()=>{
  const s=setup();const first=await s.runtime.request({meeting:descriptor,model:'ollama'})
  s.setDetail({sourceContent:'Corrected: Ryan owns copy.'})
  expect((await s.runtime.get(first.review.id)).status).toBe('superseded')
  const next=await s.runtime.request({meeting:descriptor,model:'ollama'})
  expect(next.review.id).not.toBe(first.review.id);expect(s.submissions).toHaveLength(2)
  expect((await s.runtime.get(first.review.id)).status).toBe('superseded')
})
it('terminal output requires same source revision and exact job identity',async()=>{
  const s=setup();const first=await s.runtime.request({meeting:descriptor,model:'ollama'})
  const job=s.jobs.get(first.review.clientJobId)!
  s.jobs.set(job.clientJobId,{...job,status:'completed',response:'Review ready',providerOwnershipConfirmedAt:'now',ollamaRunId:'local'})
  const ready=await s.runtime.get(first.review.id)
  expect(ready.status).toBe('ready');expect(ready.markdown).toBe('Review ready');expect(ready.providerNativeSessionId).toBeUndefined()
  s.setDetail({sourceContent:'Changed after completion'})
  expect((await s.runtime.get(first.review.id)).status).toBe('superseded')
})
it('correction between result read and final commit cannot create ready output',async()=>{
  const s=setup();const first=await s.runtime.request({meeting:descriptor,model:'ollama'})
  const job=s.jobs.get(first.review.clientJobId)!
  s.deps.jobs.getByClientGeneration.mockImplementationOnce(async()=>{s.setDetail({sourceContent:'Concurrent correction'});return{...job,status:'completed',response:'Stale output'}})
  const result=await s.runtime.get(first.review.id)
  expect(result.status).toBe('superseded');expect(result.markdown).toBeUndefined()
})
it('lost submit response adopts durable job after restart without a second provider submit',async()=>{
  const s=setup();s.deps.jobs.submit.mockImplementationOnce(async(r:any)=>{
    s.jobs.set(r.clientJobId,{jobId:'accepted',clientJobId:r.clientJobId,generation:1,sessionId:'allocated',status:'completed',provider:'ollama',response:'Recovered'} as QueryJobSnapshot)
    throw new Error('lost202')
  })
  const first=await s.runtime.request({meeting:descriptor,model:'ollama'});await s.runtime.close()
  const second=new WorkReviewRuntime({...s.deps,store:new WorkReviewStore(s.root)});runtimes.push(second)
  await second.start();expect((await second.get(first.review.id)).markdown).toBe('Recovered');expect(s.deps.jobs.submit).toHaveBeenCalledTimes(1)
})
it('unknown submission without job stays fenced across restart; GET never launches',async()=>{
  const s=setup();s.deps.jobs.submit.mockRejectedValue(new Error('unknown'))
  const first=await s.runtime.request({meeting:descriptor,model:'ollama'})
  await s.runtime.list();await s.runtime.start();await s.runtime.request({meeting:descriptor,model:'ollama'})
  expect(s.deps.jobs.submit).toHaveBeenCalledTimes(1);expect((await s.runtime.get(first.review.id)).error?.code).toBe('review_admission_unconfirmed')
})
it('server timer advances completed job without any UI read',async()=>{
  const s=setup();const first=await s.runtime.request({meeting:descriptor,model:'ollama'});await s.runtime.start()
  const job=s.jobs.get(first.review.clientJobId)!
  s.jobs.set(job.clientJobId,{...job,status:'completed',response:'Prepared review'})
  await vi.waitFor(()=>expect(s.deps.store.get(first.review.id)?.status).toBe('ready'),{timeout:1800,interval:50})
})
it('unavailable/truncated source and stale task references never become task mutations',async()=>{
  const s=setup();s.setDetail({sourceTruncated:true})
  await expect(s.runtime.request({meeting:descriptor,model:'ollama'})).rejects.toThrow('meeting_source_truncated')
  expect(s.deps.jobs.submit).not.toHaveBeenCalled()
  const detail=await s.deps.resolveMeeting()
  expect(proposeReviewTaskLinks(detail,[{id:'wrong',domain:'personal',text:'copy',source:descriptor.filename},{id:'generic',domain:'quilt',text:'copy',source:'website meeting'}])).toEqual([])
})
it('store refuses second writer and corrupt history instead of losing accepted intent',()=>{
  const s=setup();expect(()=>new WorkReviewStore(s.root)).toThrow('review_store_locked')
  s.deps.store.close();writeFileSync(join(s.root,'reviews.json'),'{broken',{mode:0o600})
  expect(()=>new WorkReviewStore(s.root)).toThrow('review_store_recovery_required')
})

it('exact action links remain same-domain proposals and preserve checked-state evidence',async()=>{
  const s=setup();s.setDetail({actionItems:[{task:'Draft the homepage call to action',owner:'Gina'},{task:'Follow up',owner:'Gina'}]})
  const detail=await s.deps.resolveMeeting()
  const links=proposeReviewTaskLinks(detail,[
    {id:'match',domain:'quilt',text:'Draft the homepage call-to-action!',checked:true},
    {id:'wrong-domain',domain:'personal',text:'Draft the homepage call to action'},
    {id:'generic',domain:'quilt',text:'Follow up'},
    {id:'substring',domain:'quilt',text:'Draft the homepage call to action and launch it'},
  ])
  expect(links).toHaveLength(1);expect(links[0]).toMatchObject({taskId:'match',confidence:'possible',decision:'proposed'})
  expect(links[0].evidence).toContain('checked');expect(links[0].evidence).toContain('not a confirmed association')
  const result=await s.runtime.request({meeting:descriptor,model:'ollama'})
  expect(result.review.contextWarnings.join(' ')).toContain('not semantic deduplication')
  expect(s.submissions[0].query).toContain('CONTEXT LIMITS')
})
it('source references do not treat one meeting ID as a prefix of another',async()=>{
  const s=setup();const detail=await s.deps.resolveMeeting()
  const links=proposeReviewTaskLinks(detail,[
    {id:'prefix',domain:'quilt',text:'Other meeting',source:descriptor.recordId+'-different'},
    {id:'file-prefix',domain:'quilt',text:'Other file',source:descriptor.filename+'.backup'},
    {id:'exact',domain:'quilt',text:'Same meeting',source:'['+descriptor.recordId+']'},
  ])
  expect(links.map(x=>x.taskId)).toEqual(['exact'])
})
it('shutdown during startup never re-arms the reconciliation timer',async()=>{
  const s=setup();const timer=vi.spyOn(globalThis,'setInterval')
  try { await Promise.all([s.runtime.start(),s.runtime.close()]);expect(timer).not.toHaveBeenCalled() }
  finally {timer.mockRestore()}
})
it('parseable journal damage cannot become fresh provider admission after restart',async()=>{
  const s=setup();await s.runtime.request({meeting:descriptor,model:'ollama'});await s.runtime.close()
  const path=join(s.root,'reviews.json');const original=JSON.parse(readFileSync(path,'utf8'))
  for(const patch of [{admissionAttempted:undefined},{provider:'cursor'},{generation:2},{clientJobId:'not-uuid'},{messageEra:null},{canonicalMeetingId:'different'}]) {
    const journal=structuredClone(original);Object.assign(journal.reviews[0],patch);writeFileSync(path,JSON.stringify(journal))
    expect(()=>new WorkReviewStore(s.root)).toThrow('review_store_recovery_required')
  }
  expect(s.deps.jobs.submit).toHaveBeenCalledTimes(1)
})

it.each(['ready','failed'] as const)('restores durable %s receipt after source outage and query-job expiry without admission',async(status)=>{
  const s=setup();const first=await s.runtime.request({meeting:descriptor,model:'ollama'})
  const job=s.jobs.get(first.review.clientJobId)!
  s.jobs.set(job.clientJobId,{...job,status:status==='ready'?'completed':'failed',response:status==='ready'?'Durable review output':undefined,
    ...(status==='failed'?{error:{code:'provider_failure',message:'Saved provider failure',retryable:false}}:{})})
  const terminal=await s.runtime.get(first.review.id);expect(terminal.status).toBe(status)
  s.deps.resolveMeeting.mockRejectedValueOnce(new Error('temporary source outage'))
  expect((await s.runtime.get(first.review.id)).status).toBe('source_unavailable')
  await s.runtime.close();s.jobs.clear();s.deps.jobs.getByClientGeneration.mockClear()
  const restarted=new WorkReviewRuntime({...s.deps,store:new WorkReviewStore(s.root)});runtimes.push(restarted)
  await restarted.start();const restored=await restarted.get(first.review.id)
  expect(restored.status).toBe(status);expect(restored.markdown).toBe(terminal.markdown);expect(restored.error).toEqual(terminal.error)
  expect(restored.clientJobId).toBe(first.review.clientJobId);expect(restored).not.toHaveProperty('suspendedTerminal')
  expect(s.deps.jobs.getByClientGeneration).not.toHaveBeenCalled();expect(s.deps.jobs.submit).toHaveBeenCalledTimes(1)
})
it('a suspended terminal receipt cannot recover readiness when its saved source changed',async()=>{
  const s=setup();const first=await s.runtime.request({meeting:descriptor,model:'ollama'});const job=s.jobs.get(first.review.clientJobId)!
  s.jobs.set(job.clientJobId,{...job,status:'completed',response:'Old result'});await s.runtime.get(first.review.id)
  s.deps.resolveMeeting.mockRejectedValueOnce(new Error('outage'));await s.runtime.get(first.review.id)
  s.setDetail({sourceContent:'Corrected source'});s.jobs.clear()
  expect((await s.runtime.get(first.review.id)).status).toBe('superseded');expect(s.deps.jobs.submit).toHaveBeenCalledTimes(1)
})
it('corrupt optional review journal degrades to disabled backend without admission or leaked details',()=>{
  const s=setup();s.deps.store.close();writeFileSync(join(s.root,'reviews.json'),'{broken',{mode:0o600})
  const create=vi.fn(()=>new WorkReviewRuntime({...s.deps,store:new WorkReviewStore(s.root)}))
  const log=vi.spyOn(console,'error').mockImplementation(()=>{})
  try {
    expect(createOptionalWorkReviewRuntime(false,create)).toBeNull();expect(create).not.toHaveBeenCalled()
    let result: WorkReviewRuntime | null | undefined
    expect(()=>{result=createOptionalWorkReviewRuntime(true,create)}).not.toThrow();expect(result).toBeNull();expect(create).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[work-reviews] optional backend unavailable; base API remains available')
    expect(s.deps.jobs.submit).not.toHaveBeenCalled()
  } finally {log.mockRestore()}
})
