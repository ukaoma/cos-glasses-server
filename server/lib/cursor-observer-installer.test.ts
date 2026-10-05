import {it,expect,afterEach} from 'vitest'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,chmodSync,existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {installCursorObserver,CURSOR_OBSERVER_EVENTS,cursorObserverStatus,observerNodeOf} from './cursor-observer-installer.js'
import {AGENT_THOUGHT_MAX} from './session-hook-events.js'
const dirs:string[]=[]
afterEach(()=>dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})))
// 6.62.0: a space and a dot directory in every path, as the real ones have.
function fixture(){const root=mkdtempSync(join(tmpdir(),'cos-observe-'));dirs.push(root);const home=join(root,'Ukaoma Chief Of Staff');return{root:home,settingsPath:join(home,'.cursor','hooks.json'),scriptPath:join(home,'.cos-glasses','bin','cos-cursor-observer.cjs'),spool:join(home,'.cos-glasses','data','hook-spool')}}
it('merges idempotently, preserves user hooks, and removes only its own observers',()=>{
 const f=fixture();mkdirSync(join(f.root,'.cursor'),{recursive:true});writeFileSync(f.settingsPath,JSON.stringify({version:1,hooks:{subagentStart:[{command:'my-review'}]}}))
 expect(installCursorObserver(f).ok).toBe(true)
 expect(installCursorObserver(f).changed).toBe(false)
 expect(JSON.parse(readFileSync(f.settingsPath,'utf8')).hooks.subagentStart).toHaveLength(2)
 expect(installCursorObserver({...f,uninstall:true}).ok).toBe(true)
 expect(JSON.parse(readFileSync(f.settingsPath,'utf8')).hooks).toEqual({subagentStart:[{command:'my-review'}]})
})
it('rejects malformed configuration without rewriting it; dry run writes nothing',()=>{
 const f=fixture();mkdirSync(f.root,{recursive:true});expect(installCursorObserver({...f,dryRun:true}).ok).toBe(true);expect(readdirSync(f.root)).toEqual([])
 mkdirSync(join(f.root,'.cursor'));writeFileSync(f.settingsPath,'{broken');expect(installCursorObserver(f).ok).toBe(false);expect(readFileSync(f.settingsPath,'utf8')).toBe('{broken')
})
it('executes the actual observer with native payloads, strips prompts and never requests a followup',()=>{
 const f=fixture();const script=resolve('bin/hooks/cos-cursor-observer.cjs'),sid='00000000-0000-0000-0000-000000000001'
 for(const event of CURSOR_OBSERVER_EVENTS){
  const output=execFileSync(process.execPath,[script,event,f.spool],{input:JSON.stringify({parent_conversation_id:sid,subagent_id:'worker-a',task:'Private task never retained'})}).toString()
  expect(JSON.parse(output)).toEqual(event==='subagentStart'?{permission:'allow'}:{})
 }
 const rows=readdirSync(f.spool).map(n=>JSON.parse(readFileSync(join(f.spool,n),'utf8')))
 // 6.62.0: afterAgentThought writes only when it carries a thought (this payload has none).
 expect(rows).toHaveLength(CURSOR_OBSERVER_EVENTS.length-1)
 expect(rows.every(r=>r.payload.session_id===sid&&r.payload.display_only===true&&r.provider==='cursor')).toBe(true)
 expect(JSON.stringify(rows)).not.toContain('Private task')
 expect(execFileSync(process.execPath,[script,'subagentStart',f.spool],{input:'bad'}).toString().trim()).toBe('{"permission":"allow"}')
 // A thought is spooled capped at AGENT_THOUGHT_MAX (the server's cap, QA W19), display only, and nothing else rides along.
 execFileSync(process.execPath,[script,'afterAgentThought',f.spool],{input:JSON.stringify({conversation_id:sid,text:'x'.repeat(600),user_email:'me@example.com',workspace_roots:['/secret']})})
 const thought=readdirSync(f.spool).map(n=>JSON.parse(readFileSync(join(f.spool,n),'utf8'))).find(r=>r.event==='AgentThought')
 expect(thought.payload).toEqual({session_id:sid,display_only:true,text:'x'.repeat(AGENT_THOUGHT_MAX)})
})
it('6.62.0 (W18): ours by the script path, so a node upgrade replaces the hook instead of adding a second',()=>{
 const f=fixture()
 expect(installCursorObserver({...f,nodePath:'/opt/homebrew/Cellar/node/24.1.0/bin/node'}).ok).toBe(true)
 expect(installCursorObserver({...f,nodePath:'/opt/homebrew/Cellar/node/25.0.0/bin/node'}).changed).toBe(true)
 const hooks=JSON.parse(readFileSync(f.settingsPath,'utf8')).hooks
 for(const event of CURSOR_OBSERVER_EVENTS){expect(hooks[event]).toHaveLength(1);expect(hooks[event][0].command).toContain('/node/25.0.0/')}
})
it('6.62.0 status: installed with a node that exists; nodeOk false when the node in the commands is gone',()=>{
 const f=fixture()
 expect(cursorObserverStatus(f)).toEqual({installed:false,nodeOk:false,events:0,reason:'missing'})
 expect(installCursorObserver(f).ok).toBe(true)
 expect(cursorObserverStatus(f)).toEqual({installed:true,nodeOk:true,events:CURSOR_OBSERVER_EVENTS.length,reason:null})
 // A node binary at a path with a space and a quote, then removed.
 const node=join(f.root,"node's dir",'node');mkdirSync(join(f.root,"node's dir"));writeFileSync(node,'#!/bin/sh\n');chmodSync(node,0o755)
 installCursorObserver({...f,nodePath:node})
 const command=JSON.parse(readFileSync(f.settingsPath,'utf8')).hooks.stop[0].command
 expect(observerNodeOf(command)).toBe(node)
 expect(cursorObserverStatus(f).nodeOk).toBe(true)
 rmSync(node);expect(existsSync(node)).toBe(false)
 expect(cursorObserverStatus(f)).toMatchObject({installed:true,nodeOk:false})
 // One event missing: not installed.
 const cfg=JSON.parse(readFileSync(f.settingsPath,'utf8'));delete cfg.hooks.afterAgentThought;writeFileSync(f.settingsPath,JSON.stringify(cfg))
 expect(cursorObserverStatus(f)).toMatchObject({installed:false,events:CURSOR_OBSERVER_EVENTS.length-1})
})
