import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, cpSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
vi.mock('./python-bridge.js',()=>({pythonBridgeAvailable:vi.fn(()=>false),callPython:vi.fn(async()=>({legacy:true}))}))
import { callTaskBridge, taskBridgeAvailable, portablePythonCandidates, taskBridgeUnavailableMessage } from './task-bridge.js'
import { callPython, pythonBridgeAvailable } from './python-bridge.js'
let root:string, operations:string
beforeEach(()=>{
 root=realpathSync(mkdtempSync(join(tmpdir(),'portable-tasks-')));operations=join(root,'operations');mkdirSync(operations)
 vi.stubEnv('COS_PORTABLE_TASKS','1');vi.stubEnv('COS_SCRIPTS_DIR','');vi.stubEnv('COS_OPERATIONS_DIR',operations);vi.stubEnv('COS_TASK_LOCK_STORE',join(root,'locks.json'));vi.stubEnv('COS_PROFILE_PATH',join(root,'profile.json'));writeFileSync(join(root,'profile.json'),JSON.stringify({domains:['business','personal'],owner_name:'Alex'}))
 vi.mocked(pythonBridgeAvailable).mockReturnValue(false)
})
afterEach(()=>{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true})})
const rows=()=>callTaskBridge(['task-rows','business','--day','2026-09-27']) as Promise<any[]>
it('uses installed full bridge first and never changes generic capability',async()=>{
 vi.mocked(pythonBridgeAvailable).mockReturnValue(true);expect(await callTaskBridge(['task-work-capabilities'])).toEqual({legacy:true});expect(callPython).toHaveBeenCalled()
})
it('fresh runtime captures and supports canonical CRUD, metadata CAS, completion and reopen',async()=>{
 expect(taskBridgeAvailable()).toBe(true)
 expect(await callTaskBridge(['task-work-capabilities'])).toMatchObject({version:1})
 expect(await rows()).toEqual([])
 expect(await callTaskBridge(['task-capture','business','--section','inbox'],12000,'Build draft')).toMatchObject({ok:true})
 let row=(await rows())[0];expect(row.description).toBe('Build draft');const original=row.id
 expect(await callTaskBridge(['task-set-work-stage','business',row.id,'built'],12000,JSON.stringify({expectedText:row.description,expectedRevision:row.work_revision}))).toMatchObject({ok:true})
 const stale=row;row=(await rows())[0];expect(row.work_stage).toBe('built');expect(row.work_identity).toBe(original)
 expect(await callTaskBridge(['task-set-work-stage','business',row.id,'qa'],12000,JSON.stringify({expectedText:stale.description,expectedRevision:stale.work_revision}))).toMatchObject({error:{code:'task_revision_changed'}})
 const meeting={recordId:'record-one',domain:'business',month:'2026-09',filename:'one.md',title:'Canonical meeting'}
 expect(await callTaskBridge(['task-link-meeting','business',row.id],12000,JSON.stringify({expectedText:row.description,expectedRevision:row.work_revision,meeting}))).toMatchObject({ok:true})
 expect(await callTaskBridge(['task-set-text','business',row.id],12000,'Build reviewed draft')).toMatchObject({ok:true})
 row=(await rows())[0];expect(row.id).not.toBe(original);expect(row.work_identity).toBe(original);expect(row.meeting_refs).toEqual([meeting])
 for(const command of [['task-set-done-when','business',row.id],['task-set-run-at','business',row.id,'2026-09-28 09:00'],['task-set-stage','business',row.id,'review'],['task-move','business',row.id,'--section','backlog'],['task-set-marker','business',row.id,'done:1'],['task-check','business',row.id],['task-check','business',row.id,'--uncheck']]) expect(await callTaskBridge(command,12000,command[0]==='task-set-done-when'?'Reviewed artifact exists':undefined)).toMatchObject({ok:true})
 row=(await rows())[0];expect(row.is_checked).toBe(false);expect(row.meeting_refs).toEqual([meeting]);expect(row.work_identity).toBe(original)
})
it('matches canonical ID algorithm and keeps Source while treating configured operator generically',async()=>{
 mkdirSync(join(operations,'business'));writeFileSync(join(operations,'business/tasks.md'),'## INBOX\n- [ ] **Alex**: Draft landing page — **Source:** Meeting A\n- [ ] **Miles**: Different task\n')
 const result=await rows();expect(result).toHaveLength(2);expect(result[0].delegated).toBe(false);expect(result[1].delegated).toBe(true);expect(result[0].source).toBe('Meeting A')
 const {createHash}=await import('node:crypto');expect(result[0].id).toBe(createHash('sha256').update('business/tasks.md|draft landing page|0').digest('hex').slice(0,12))
})
it('rejects symlinked task/domain/root and oversized sources, with protected sentinel unchanged',async()=>{
 const outside=join(root,'outside');mkdirSync(outside);const sentinel=join(outside,'tasks.md');writeFileSync(sentinel,'## INBOX\n- [ ] Protected\n')
 symlinkSync(outside,join(operations,'business'));expect(await rows()).toMatchObject({error:{code:'task_runtime_unavailable'}});unlinkSync(join(operations,'business'));mkdirSync(join(operations,'business'));symlinkSync(sentinel,join(operations,'business/tasks.md'))
 expect(await callTaskBridge(['task-capture','business','--section','inbox'],12000,'Bad')).toMatchObject({error:{code:'task_runtime_unavailable'}});expect(readFileSync(sentinel,'utf8')).toContain('Protected');expect(readFileSync(sentinel,'utf8')).not.toContain('Bad')
 rmSync(join(operations,'business/tasks.md'));writeFileSync(join(operations,'business/tasks.md'),'x'.repeat(8*1024*1024+1));expect(await rows()).toMatchObject({error:{code:'task_runtime_unavailable'}})
})
it('rejects unsupported commands, path traversal and oversized input',async()=>{
 for(const args of [['memory'],['task-rows','../outside','--day','2026-09-27']]) expect(await callTaskBridge(args)).toMatchObject({error:{code:'task_runtime_unavailable'}})
 expect(await callTaskBridge(['task-capture','business','--section','inbox'],12000,'x'.repeat(32769))).toMatchObject({error:{code:'task_runtime_unavailable'}})
})
it('runs copied package in a clean child outside repository, with no site or private imports',()=>{
 const runtime=join(root,'runtime');cpSync(join(process.cwd(),'work-task-runtime'),runtime,{recursive:true})
 const command=['-I','-S','-B',join(runtime,'task_bridge.py'),'--root',operations,'--lock-store',join(root,'separate-lock.json'),'--domains','["business"]','task-capture','business','--section','inbox']
 const output=execFileSync('/opt/homebrew/bin/python3',command,{cwd:root,env:{PATH:'/usr/bin:/bin'},input:'Independent install',encoding:'utf8'})
 expect(JSON.parse(output)).toMatchObject({ok:true});expect(readFileSync(join(operations,'business/tasks.md'),'utf8')).toContain('Independent install')
})

it('configured broken full bridge does not silently switch task storage',async()=>{
 vi.stubEnv('COS_SCRIPTS_DIR',join(root,'missing-full-bridge'))
 expect(taskBridgeAvailable()).toBe(false)
 expect(await callTaskBridge(['task-work-capabilities'])).toMatchObject({error:{code:'task_runtime_unavailable'}})
})
it('explicit symlink root and lock file fail closed',async()=>{
 const alias=join(root,'alias');symlinkSync(operations,alias);vi.stubEnv('COS_OPERATIONS_DIR',alias)
 expect(await rows()).toMatchObject({error:{code:'task_runtime_unavailable'}})
 vi.stubEnv('COS_OPERATIONS_DIR',operations)
 const sentinel=join(root,'sentinel');writeFileSync(sentinel,'protected');symlinkSync(sentinel,join(root,'locks.json'))
 expect(await callTaskBridge(['task-capture','business','--section','inbox'],12000,'bad')).toMatchObject({error:{code:'task_runtime_unavailable'}})
 expect(readFileSync(sentinel,'utf8')).toBe('protected')
})

it('respects existing canonical file lock and leaves the task unchanged',async()=>{
 await callTaskBridge(['task-capture','business','--section','inbox'],12000,'Before lock')
 const source=join(operations,'business/tasks.md'), before=readFileSync(source,'utf8')
 writeFileSync(join(root,'locks.json'),JSON.stringify({'file:business':{task_id:'file:business',user:'another-process',locked_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString()}}))
 expect(await callTaskBridge(['task-capture','business','--section','inbox'],12000,'Blocked')).toMatchObject({error:{code:'task_file_locked'}})
 expect(readFileSync(source,'utf8')).toBe(before)
})
it('real production-environment subprocess defaults to portable Work without test opt-in',()=>{
 const modulePath=join(process.cwd(),'server/lib/task-bridge.ts')
 const script=`const {callTaskBridge,taskBridgeAvailable}=await import(${JSON.stringify('file://'+modulePath)}); if(!taskBridgeAvailable()) throw Error('unavailable'); const cap=await callTaskBridge(['task-work-capabilities']); const result=await callTaskBridge(['task-capture','business','--section','inbox'],12000,'Production-shaped fresh install'); const rows=await callTaskBridge(['task-rows','business','--day','2026-09-27']); console.log(JSON.stringify({cap,result,rows}));`
 const output=execFileSync(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),'--input-type=module','-e',script],{cwd:root,env:{PATH:process.env.PATH!,HOME:root,NODE_ENV:'production',COS_DATA_DIR:join(root,'data'),COS_OPERATIONS_DIR:operations,COS_TASK_LOCK_STORE:join(root,'production-locks.json'),COS_PROFILE_PATH:join(root,'profile.json')},encoding:'utf8'})
 const result=JSON.parse(output.trim().split('\n').at(-1)!);expect(result.cap.version).toBe(1);expect(result.result.ok).toBe(true);expect(result.rows[0].description).toBe('Production-shaped fresh install')
})

it('discovers versioned Homebrew interpreters and keeps explicit override exclusive',()=>{
 const candidates=portablePythonCandidates({})
 for (const prefix of ['/opt/homebrew','/usr/local']) for (const version of ['3.12','3.11']) {
  const path=`${prefix}/opt/python@${version}/bin/python${version}`
  expect(candidates).toContain(path);expect(candidates.indexOf(path)).toBeLessThan(candidates.indexOf('/usr/bin/python3'))
 }
 expect(portablePythonCandidates({COS_TASK_PYTHON:'/custom/python'})).toEqual(['/custom/python'])
})
it('missing Python and broken configured bridge give distinct actionable errors',async()=>{
 vi.stubEnv('COS_TASK_PYTHON',join(root,'missing-python'))
 expect(taskBridgeAvailable()).toBe(false)
 const absent=await callTaskBridge(['task-work-capabilities']) as any
 expect(absent.error.message).toContain('Python 3.10 or later');expect(absent.error.message).toContain('brew install python@3.12');expect(absent.error.message).toContain('restart the server')
 vi.stubEnv('COS_SCRIPTS_DIR',join(root,'broken-bridge'))
 expect(taskBridgeUnavailableMessage()).toContain('cos_api_bridge.py');expect(taskBridgeUnavailableMessage()).toContain('will not switch task storage')
 const broken=await callTaskBridge(['task-work-capabilities']) as any
 expect(broken.error.message).toContain('Repair COS_SCRIPTS_DIR');expect(broken.error.message).not.toContain('brew install')
})

it('malformed canonical lock ownership never authorizes capture or changes source/lock bytes',async()=>{
 await callTaskBridge(['task-capture','business','--section','inbox'],12000,'Protected source')
 const source=join(operations,'business/tasks.md'), before=readFileSync(source,'utf8')
 const lock={task_id:'file:business',user:'active-other-owner',locked_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString()}
 for(const patch of [{expires_at:'corrupt-timestamp'},{expires_at:null},{user:2},{task_id:'file:wrong'},{locked_at:'no'},{extra:true}]) {
  const bytes=JSON.stringify({'file:business':{...lock,...patch}});writeFileSync(join(root,'locks.json'),bytes)
  for(let attempt=0;attempt<2;attempt++) {
   expect(await callTaskBridge(['task-capture','business','--section','inbox'],12000,'MUST NOT WRITE')).toMatchObject({error:{code:'task_runtime_unavailable'}})
   expect(readFileSync(source,'utf8')).toBe(before);expect(readFileSync(join(root,'locks.json'),'utf8')).toBe(bytes)
  }
 }
})

it('bundled guarded edit saves both fields, preserves linked identity, and refuses stale repeat',async()=>{
 expect(await callTaskBridge(['task-work-capabilities'])).toMatchObject({version:1,editTasks:1})
 await callTaskBridge(['task-capture','business','--section','inbox'],12000,'Original task')
 const row=(await rows())[0], original=row.id
 const input={expectedText:row.description,expectedRevision:row.work_revision,text:'Changed name',doneWhen:'Reviewed result'}
 const out=await callTaskBridge(['task-edit-work','business',row.id],12000,JSON.stringify(input))
 expect(out).toMatchObject({ok:true,workIdentity:original,text:'Changed name',doneWhen:'Reviewed result'})
 const fresh=(await rows())[0]
 expect(fresh.work_identity).toBe(original);expect(fresh.done_when).toBe('Reviewed result');expect(fresh.description).toBe('Changed name')
 expect(await callTaskBridge(['task-edit-work','business',row.id],12000,JSON.stringify(input))).toHaveProperty('error')
 expect((await rows())[0]).toEqual(fresh)
})
