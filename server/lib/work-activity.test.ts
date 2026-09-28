import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkActivity } from './work-activity.js'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const identity = 'a'.repeat(12)
const receipt = (patch = {}) => ({id:'one',workID:`task:business:${identity}`,workTitle:'Private task',sourceRevision:'r',mode:'continueSession',provider:'codex',modelID:'codex-frontier',sessionID:'codex:owned',sessionTitle:'Recorded target',status:'queued',detail:'SECRET detail',prompt:'SECRET prompt',result:'SECRET result',createdAt:1,...patch})
function fixture(receipts = [receipt()], version = 2) {
 const root = realpathSync(mkdtempSync(join(tmpdir(),'work-activity-'))); roots.push(root)
 const journalPath=join(root,'handoffs.json');writeFileSync(journalPath,JSON.stringify({version,receipts,sessions:[],drafts:[]}),{mode:0o600})
 return {journalPath,root}
}
it('reads v1/v2 exact source identity; never infers title ownership or returns private fields',()=>{
 for (const version of [1,2]) {
  const f=fixture([receipt(),receipt({id:'other',workID:`task:personal:${identity}`}),receipt({id:'title',workID:'task:business:bbbbbbbbbbbb',workTitle:'Same title'})],version)
  const result=readWorkActivity('business',identity,f)
  expect(result).toEqual({version:1,available:true,activities:[{id:'one',workId:`task:business:${identity}`,domain:'business',status:'queued',provider:'codex',sessionId:'codex:owned',sessionTitle:'Recorded target'}]})
  expect(JSON.stringify(result)).not.toContain('SECRET');expect(JSON.stringify(result)).not.toContain('Private task')
 }
})
it('does not treat queued/delivered as task completion; interrupted intent is unknown',()=>{
 const f=fixture([receipt({status:'sending'})]);const activity=readWorkActivity('business',identity,f).activities[0]
 expect(activity.status).toBe('unknown');expect(activity.error).toContain('unresolved')
})
it('does not assign a cross-provider target',()=>{
 const f=fixture([receipt({sessionID:'claude:wrong'})]);expect(readWorkActivity('business',identity,f).activities[0].sessionId).toBeUndefined()
})
it('missing/corrupt/unknown-version/duplicate journals are unavailable, not empty success',()=>{
 const f=fixture();rmSync(f.journalPath);expect(readWorkActivity('business',identity,f).available).toBe(false)
 for (const raw of ['{',JSON.stringify({version:9,receipts:[],sessions:[]}),JSON.stringify({version:2,receipts:[receipt(),receipt()],sessions:[]})]) {
  writeFileSync(f.journalPath,raw);expect(readWorkActivity('business',identity,f)).toMatchObject({available:false,activities:[]})
 }
})
it('rejects leaf/ancestor symlinks and oversized files',()=>{
 const f=fixture();const alias=join(f.root,'alias.json');symlinkSync(f.journalPath,alias)
 expect(readWorkActivity('business',identity,{journalPath:alias}).available).toBe(false)
 const link=join(f.root,'linked');symlinkSync(f.root,link);expect(readWorkActivity('business',identity,{journalPath:join(link,'handoffs.json')}).available).toBe(false)
 writeFileSync(f.journalPath,' '.repeat(10_000_000));expect(readWorkActivity('business',identity,f).available).toBe(false)
})
it('isolated runtimes never silently consult the real native history',()=>{
 const f=fixture();const native=join(f.root,'Library/Application Support/COS Control/work-handoffs');mkdirSync(native,{recursive:true});writeFileSync(join(native,'handoffs.json'),JSON.stringify({version:2,receipts:[receipt()],sessions:[]}))
 for (const env of [{NODE_ENV:'test'},{COS_CONTROL_TEST_HOME:f.root},{COS_DATA_DIR:join(f.root,'scratch')},{COS_WORK_CONNECTED_TEST:'1'}]) expect(readWorkActivity('business',identity,{home:f.root,platform:'darwin',env}).available).toBe(false)
 expect(readWorkActivity('business',identity,{home:f.root,platform:'linux',env:{}}).available).toBe(false)
 expect(readWorkActivity('business',identity,{home:f.root,platform:'darwin',env:{}}).available).toBe(true)
})
it('matches native rejection of malformed sessions/drafts and duplicate draft identity without changing journal',()=>{
 const f=fixture();const draft={sourceID:'task:business:'+identity,sourceRevision:'r',mode:'continueSession',sessionID:'',provider:'',modelID:'',prompt:'private',editVersion:0}
 for(const patch of [{sessions:[null]},{sessions:[{id:'codex:one'}]},{drafts:[null]},{drafts:[{...draft,editVersion:'0'}]},{drafts:[draft,draft]},{drafts:[{...draft,sourceRevision:''}]}]) {
  const bytes=JSON.stringify({version:2,receipts:[receipt()],sessions:[],drafts:[],...patch});writeFileSync(f.journalPath,bytes)
  expect(readWorkActivity('business',identity,f)).toMatchObject({available:false,activities:[]})
  expect(readFileSync(f.journalPath,'utf8')).toBe(bytes)
 }
})
