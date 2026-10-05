#!/usr/bin/env node
// Read-only native Cursor lifecycle observer. No network, credentials, commands or prompts; agent thoughts are capped, display-only and never persisted.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const event=process.argv[2],spool=process.argv[3];
const names={subagentStart:'SubagentStart',subagentStop:'SubagentStop',preCompact:'PreCompact',postToolUse:'PostToolUse',afterAgentResponse:'PostCompact',stop:'PostCompact',sessionEnd:'PostCompact',afterAgentThought:'AgentThought'};
let input='',oversize=false;
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{if(input.length+chunk.length>1048576){oversize=true;input=''}else if(!oversize)input+=chunk});
process.stdin.on('error',()=>{});
process.stdin.on('end',()=>{
 try {
  if(!oversize && names[event] && spool){
   const p=JSON.parse(input),id=p.parent_conversation_id||p.conversation_id||p.session_id;
   if(typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)){
    fs.mkdirSync(spool,{recursive:true,mode:0o700});
    if(fs.readdirSync(spool).length<2000){
     const ts=Date.now(),payload={session_id:id.toLowerCase(),display_only:true};
     const agent=p.subagent_id||p.agent_id;
     if(typeof agent==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(agent))payload.agent_id=agent;
     // 6.62.0: the thought itself, at most 280 characters. The server keeps it in memory only.
     if(names[event]==='AgentThought'){if(typeof p.text!=='string'||!p.text.trim())throw 0;payload.text=p.text.slice(0,280)}
     const name=ts+'-'+process.pid+'-'+crypto.randomBytes(6).toString('hex')+'-'+names[event]+'.json';
     const temp=path.join(spool,'.'+name);
     fs.writeFileSync(temp,JSON.stringify({ts,ppid:null,event:names[event],provider:'cursor',payload}),{mode:0o600,flag:'wx'});
     fs.renameSync(temp,path.join(spool,name));
    }
   }
  }
 } catch {} // An observational failure never blocks a user action.
 process.stdout.write(event==='subagentStart'?'{"permission":"allow"}\n':'{}\n');
});
