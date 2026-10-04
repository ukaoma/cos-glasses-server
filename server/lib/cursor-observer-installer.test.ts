import {it,expect,afterEach} from 'vitest'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {installCursorObserver,CURSOR_OBSERVER_EVENTS} from './cursor-observer-installer.js'
const dirs:string[]=[]
afterEach(()=>dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})))
function fixture(){const root=mkdtempSync(join(tmpdir(),'cos-observe-'));dirs.push(root);return{root,settingsPath:join(root,'hooks.json'),scriptPath:join(root,'bin','cos-cursor-observer.cjs'),spool:join(root,'spool')}}
it('merges idempotently, preserves user hooks, and removes only its own observers',()=>{
 const f=fixture();writeFileSync(f.settingsPath,JSON.stringify({version:1,hooks:{subagentStart:[{command:'my-review'}]}}))
 expect(installCursorObserver(f).ok).toBe(true)
 expect(installCursorObserver(f).changed).toBe(false)
 expect(JSON.parse(readFileSync(f.settingsPath,'utf8')).hooks.subagentStart).toHaveLength(2)
 expect(installCursorObserver({...f,uninstall:true}).ok).toBe(true)
 expect(JSON.parse(readFileSync(f.settingsPath,'utf8')).hooks).toEqual({subagentStart:[{command:'my-review'}]})
})
it('rejects malformed configuration without rewriting it; dry run writes nothing',()=>{
 const f=fixture();expect(installCursorObserver({...f,dryRun:true}).ok).toBe(true);expect(readdirSync(f.root)).toEqual([])
 writeFileSync(f.settingsPath,'{broken');expect(installCursorObserver(f).ok).toBe(false);expect(readFileSync(f.settingsPath,'utf8')).toBe('{broken')
})
it('executes the actual observer with native payloads, strips prompts and never requests a followup',()=>{
 const f=fixture();const script=resolve('bin/hooks/cos-cursor-observer.cjs'),sid='00000000-0000-0000-0000-000000000001'
 for(const event of CURSOR_OBSERVER_EVENTS){
  const output=execFileSync(process.execPath,[script,event,f.spool],{input:JSON.stringify({parent_conversation_id:sid,subagent_id:'worker-a',task:'Private task never retained'})}).toString()
  expect(JSON.parse(output)).toEqual(event==='subagentStart'?{permission:'allow'}:{})
 }
 const rows=readdirSync(f.spool).map(n=>JSON.parse(readFileSync(join(f.spool,n),'utf8')))
 expect(rows).toHaveLength(CURSOR_OBSERVER_EVENTS.length)
 expect(rows.every(r=>r.payload.session_id===sid&&r.payload.display_only===true)).toBe(true)
 expect(JSON.stringify(rows)).not.toContain('Private task')
 expect(execFileSync(process.execPath,[script,'subagentStart',f.spool],{input:'bad'}).toString().trim()).toBe('{"permission":"allow"}')
})
