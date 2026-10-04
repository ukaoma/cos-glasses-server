import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { childStateFromTail, readCodexSubagents, SUBAGENT_FRESH_MS } from './codex-subagent-activity.js'
const now = Date.parse('2026-10-04T21:00:00Z')
const event = (type:string, offset=0) => JSON.stringify({timestamp:new Date(now+offset).toISOString(),type:'event_msg',payload:{type}})
const roots:string[]=[]
afterEach(()=> { for(const p of roots.splice(0)) rmSync(p,{recursive:true,force:true}) })
describe('child lifecycle is not spawn-edge liveness',()=>{
 it('holds work while a task is open and clears on completion, stop or failure',()=>{
  expect(childStateFromTail(event('task_started'),now)).toBe('active')
  for(const terminal of ['task_complete','turn_aborted','task_failed','turn_cancelled']) expect(childStateFromTail(event('task_started',-1000)+'\n'+event(terminal),now)).toBe('completed')
 })
 it('supports follow-up turns, stale/missing events and future timestamps',()=>{
  expect(childStateFromTail(event('task_complete',-1000)+'\n'+event('task_started'),now)).toBe('active')
  expect(childStateFromTail(event('task_started',-SUBAGENT_FRESH_MS-1),now)).toBe('unknown')
  expect(childStateFromTail(event('task_started',60_000),now)).toBe('unknown')
  expect(childStateFromTail('{bad}\n'+event('token_count'),now)).toBe('unknown')
  expect(childStateFromTail(event('task_started'),now,true)).toBe('unknown')
 })
 it('recent child tool progress keeps a long open turn active',()=>{
  const tool=JSON.stringify({type:'response_item',timestamp:new Date(now).toISOString(),payload:{type:'function_call'}})
  expect(childStateFromTail(event('task_started',-10*60_000)+'\n'+tool,now)).toBe('active')
 })
})
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'cos-child-test-'));roots.push(home);const sessions=join(home,'sessions');mkdirSync(sessions)
 const db=join(home,'state_5.sqlite');execFileSync('/usr/bin/sqlite3',[db,'CREATE TABLE threads(id TEXT,rollout_path TEXT,archived INT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);'])
 const parent='00000000-0000-0000-0000-000000000001'
 const add=(n:number,body:string,p=parent,status='open',outside=false)=>{
  const id='00000000-0000-0000-0000-'+String(n).padStart(12,'0'),file=join(outside?home:sessions,id+'.jsonl');writeFileSync(file,body)
  execFileSync('/usr/bin/sqlite3',[db,`INSERT INTO threads VALUES('${id}','${file}',0); INSERT INTO thread_spawn_edges VALUES('${p}','${id}','${status}');`]);return{id,file}
 };return{home,db,sessions,parent,add}
}
it('counts linked descendants, excludes unrelated and closed edges, then clears completed children',async()=>{
 const f=fixture(),a=f.add(2,event('task_started')),b=f.add(3,event('task_complete')),c=f.add(4,event('task_started'),a.id)
 f.add(5,event('task_started'),'00000000-0000-0000-0000-000000000099');f.add(6,event('task_started'),f.parent,'closed')
 const first=(await readCodexSubagents([f.parent],f.sessions,now)).get(f.parent)!
 expect(first).toEqual({active:2,completed:1,unknown:0,total:3,checked_at:now,partial:false})
 writeFileSync(a.file,event('task_started',-1000)+'\n'+event('task_complete'));writeFileSync(c.file,event('turn_aborted'))
 expect((await readCodexSubagents([f.parent],f.sessions,now)).get(f.parent)).toMatchObject({active:0,completed:3,unknown:0,total:3})
})
it('deduplicates shared descendants and terminates cycles',async()=>{
 const f=fixture(),a=f.add(2,event('task_started'));f.add(3,event('task_complete'),a.id)
 execFileSync('/usr/bin/sqlite3',[f.db,`INSERT INTO thread_spawn_edges VALUES('${a.id}','${f.parent}','open'); INSERT INTO thread_spawn_edges VALUES('${f.parent}','${a.id}','open');`])
 expect((await readCodexSubagents([f.parent],f.sessions,now)).get(f.parent)).toMatchObject({active:1,completed:1,total:2})
})
it('does not read outside the session store, and ages cached active evidence',async()=>{
 const f=fixture();f.add(2,event('task_started'),f.parent,'open',true);f.add(3,event('task_started'))
 expect((await readCodexSubagents([f.parent],f.sessions,now)).get(f.parent)).toMatchObject({active:1,unknown:1})
 expect((await readCodexSubagents([f.parent],f.sessions,now+SUBAGENT_FRESH_MS+1)).get(f.parent)).toMatchObject({active:0,unknown:2})
})
it('missing/schema-incompatible stores cannot claim zero active children',async()=>{
 const f=fixture();execFileSync('/usr/bin/sqlite3',[f.db,'DROP TABLE thread_spawn_edges;'])
 expect((await readCodexSubagents([f.parent],f.sessions,now)).get(f.parent)?.partial).toBe(true)
 expect((await readCodexSubagents(["' OR 1=1"],f.sessions,now)).size).toBe(0)
})
