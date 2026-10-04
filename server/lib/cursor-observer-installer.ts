import { readFileSync, existsSync, lstatSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync } from './atomic-fs.js'
import { cosGlassesHome, hookSpoolDir } from './claude-hooks-installer.js'
export const CURSOR_OBSERVER_EVENTS=['subagentStart','subagentStop','preCompact','postToolUse','afterAgentResponse','stop','sessionEnd'] as const
const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'"
export function installCursorObserver(options:{settingsPath?:string;scriptPath?:string;spool?:string;dryRun?:boolean;uninstall?:boolean}={}) {
 const settings=options.settingsPath??join(process.env.CURSOR_CONFIG_DIR??join(homedir(),'.cursor'),'hooks.json')
 const script=options.scriptPath??join(cosGlassesHome(),'bin','cos-cursor-observer.cjs')
 const spool=options.spool??hookSpoolDir()
 try {
  if(existsSync(settings)&&lstatSync(settings).isSymbolicLink())throw new Error('symlinked Cursor settings')
  const old=existsSync(settings)?readFileSync(settings,'utf8'):'{}', config=JSON.parse(old)
  if(!config||typeof config!=='object'||Array.isArray(config)||(config.version!==undefined&&config.version!==1))throw new Error('unsupported Cursor config')
  if(config.hooks!==undefined&&(!config.hooks||typeof config.hooks!=='object'||Array.isArray(config.hooks)))throw new Error('invalid Cursor hooks')
  const hooks={...config.hooks}
  for(const event of CURSOR_OBSERVER_EVENTS){
   if(hooks[event]!==undefined&&!Array.isArray(hooks[event]))throw new Error('invalid Cursor hook list')
   const ours=(h:any)=>typeof h?.command==='string'&&h.command.startsWith(quote(process.execPath)+' '+quote(script)+' ')
   hooks[event]=(hooks[event]??[]).filter((h:any)=>!ours(h))
   if(!options.uninstall)hooks[event].push({command:[process.execPath,script,event,spool].map(quote).join(' '),timeout:5})
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
