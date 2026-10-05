import { readFileSync, existsSync, lstatSync, mkdirSync, copyFileSync, chmodSync, accessSync, statSync, constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync } from './atomic-fs.js'
import { cosGlassesHome, hookSpoolDir } from './claude-hooks-installer.js'
// 6.62.0: `afterAgentThought` (the reasoning line, display only) joins the observer's events.
export const CURSOR_OBSERVER_EVENTS=['subagentStart','subagentStop','preCompact','postToolUse','afterAgentResponse','stop','sessionEnd','afterAgentThought'] as const
const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'"
export const cursorHooksPath=()=>join(process.env.CURSOR_CONFIG_DIR??join(homedir(),'.cursor'),'hooks.json')
export const cursorObserverScriptPath=()=>join(cosGlassesHome(),'bin','cos-cursor-observer.cjs')
// 6.62.0 (W18): ours by the SCRIPT path, never by `process.execPath`. A brew upgrade moves node,
// and keying on it made every observer hook foreign, so the next install appended duplicates.
const oursFor=(script:string)=>(h:any)=>typeof h?.command==='string'&&h.command.includes(' '+quote(script)+' ')
export function installCursorObserver(options:{settingsPath?:string;scriptPath?:string;spool?:string;dryRun?:boolean;uninstall?:boolean;nodePath?:string}={}) {
 const settings=options.settingsPath??cursorHooksPath()
 const script=options.scriptPath??cursorObserverScriptPath()
 const spool=options.spool??hookSpoolDir()
 const node=options.nodePath??process.execPath
 try {
  if(existsSync(settings)&&lstatSync(settings).isSymbolicLink())throw new Error('symlinked Cursor settings')
  const old=existsSync(settings)?readFileSync(settings,'utf8'):'{}', config=JSON.parse(old)
  if(!config||typeof config!=='object'||Array.isArray(config)||(config.version!==undefined&&config.version!==1))throw new Error('unsupported Cursor config')
  if(config.hooks!==undefined&&(!config.hooks||typeof config.hooks!=='object'||Array.isArray(config.hooks)))throw new Error('invalid Cursor hooks')
  const hooks={...config.hooks}
  const ours=oursFor(script)
  for(const event of CURSOR_OBSERVER_EVENTS){
   if(hooks[event]!==undefined&&!Array.isArray(hooks[event]))throw new Error('invalid Cursor hook list')
   hooks[event]=(hooks[event]??[]).filter((h:any)=>!ours(h))
   if(!options.uninstall)hooks[event].push({command:[node,script,event,spool].map(quote).join(' '),timeout:5})
   if(!hooks[event].length)delete hooks[event]
  }
  const next=JSON.stringify({...config,version:1,hooks},null,2)+'\n'
  if(!options.dryRun){
   if(!options.uninstall){
    mkdirSync(dirname(script),{recursive:true,mode:0o700})
    const source=resolve(dirname(fileURLToPath(import.meta.url)),'../../bin/hooks/cos-cursor-observer.cjs')
    atomicWriteFileSync(script,readFileSync(source),{mode:0o755});chmodSync(script,0o755)
   }
   mkdirSync(dirname(settings),{recursive:true})
   if(next!==old){if(existsSync(settings))copyFileSync(settings,settings+'.cos-observer-backup');atomicWriteFileSync(settings,next,{mode:0o600})}
  }
  return {ok:true,changed:next!==old,events:[...CURSOR_OBSERVER_EVENTS],dryRun:!!options.dryRun}
 }catch(error){return {ok:false,changed:false,reason:error instanceof Error?error.message:String(error)}}
}
/** The first single-quoted word of an observer command (`quote` above): the node binary it runs. */
export function observerNodeOf(command:string):string|null{
 if(command[0]!=="'")return null
 let out='',i=0
 for(;;){
  const end=command.indexOf("'",i+1);if(end<0)return null
  out+=command.slice(i+1,end);i=end+1
  if(command.startsWith("\\''",i)){out+="'";i+=2}else break
 }
 return out||null
}
/**
 * 6.62.0 health: `installed` when every observer event has exactly one hook of ours, and
 * `nodeOk` when the node binary each of those commands names still exists (a brew upgrade can
 * remove it, and Cursor then runs nothing). Never throws.
 */
export function cursorObserverStatus(options:{settingsPath?:string;scriptPath?:string}={}):{installed:boolean;nodeOk:boolean;events:number;reason:string|null}{
 const settings=options.settingsPath??cursorHooksPath(),ours=oursFor(options.scriptPath??cursorObserverScriptPath())
 try{
  if(!existsSync(settings))return {installed:false,nodeOk:false,events:0,reason:'missing'}
  if(lstatSync(settings).isSymbolicLink())return {installed:false,nodeOk:false,events:0,reason:'symlink'}
  const hooks=JSON.parse(readFileSync(settings,'utf8'))?.hooks??{}
  let events=0,nodeOk=true
  for(const event of CURSOR_OBSERVER_EVENTS){
   const mine=Array.isArray(hooks[event])?hooks[event].filter(ours):[]
   if(mine.length===1)events++
   for(const h of mine){
    const node=observerNodeOf(h.command)
    try{if(!node||!statSync(node).isFile())nodeOk=false;else accessSync(node,constants.X_OK)}catch{nodeOk=false}
   }
  }
  return {installed:events===CURSOR_OBSERVER_EVENTS.length,nodeOk:events>0&&nodeOk,events,reason:null}
 }catch{return {installed:false,nodeOk:false,events:0,reason:'unreadable'}}
}
