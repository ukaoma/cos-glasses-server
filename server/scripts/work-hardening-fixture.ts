/** Disposable review candidate. Actual Work routes and bundled task writer; no provider routes. */
import express from 'express'
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
let root=resolve(process.argv[2] ?? '')
if (!root.startsWith('/tmp/cos-hardening-') && !root.startsWith('/private/tmp/cos-hardening-')) throw new Error('Use a dedicated disposable /tmp/cos-hardening- home')
mkdirSync(root,{recursive:true,mode:0o700})
root=realpathSync(root)
if (!root.startsWith('/private/tmp/cos-hardening-')) throw new Error('Fixture root may not redirect elsewhere')
const operations=join(root,'operations');mkdirSync(join(operations,'business'),{recursive:true})
const tasks=join(operations,'business/tasks.md')
if (!existsSync(tasks)) writeFileSync(tasks,'# Disposable QA tasks\n\n## INBOX\n- [ ] Review homepage headline — **Done when:** Approved copy is saved — **Source:** Disposable fixture\n- [ ] A deliberately long task name to test wrapping, selection, editing and persistence after restarting the review candidate — **Source:** Disposable fixture\n')
process.env.COS_PORTABLE_TASKS='1';process.env.COS_SCRIPTS_DIR='';process.env.COS_OPERATIONS_DIR=operations
process.env.COS_PROFILE_PATH=join(root,'profile.json');process.env.COS_TASK_LOCK_STORE=join(root,'locks.json');process.env.COS_DATA_DIR=join(root,'data')
writeFileSync(process.env.COS_PROFILE_PATH,JSON.stringify({domains:['business'],owner_name:'QA Operator'}))
const {createWorkBoardRouter}=await import('../routes/work-board.js')
const {listBoard}=await import('../lib/task-store.js')
const {requireApiToken}=await import('../lib/api-auth.js')
const token='disposable-candidate-token';mkdirSync(join(root,'.cos-glasses'),{recursive:true,mode:0o700})
writeFileSync(join(root,'.cos-glasses/.env'),'COS_API_TOKEN='+token+'\n',{mode:0o600})
const app=express();app.use(express.json({limit:'16kb'}));app.use('/api',requireApiToken(token))
app.use('/api',createWorkBoardRouter({journal:()=>({available:false,reason:'Disposable fixture has no native session history.'})}))
app.get('/api/tasks',async(_req,res)=>res.json({tasks:await listBoard()}))
app.get('/api/domains',(_req,res)=>res.json({domains:[{name:'business',title:'Business fixture'}],gate:'ready'}))
app.get('/api/work-reviews',(_req,res)=>res.json({schemaVersion:1,capabilities:{manualReview:false},reviews:[]}))
app.get('/api/work-models',(_req,res)=>res.json({models:[]}))
app.use((_req,res)=>res.status(403).json({error:'Provider dispatch and non-fixture routes are disabled'}))
const server=app.listen(0,'127.0.0.1',()=>{
 const port=(server.address() as {port:number}).port
 writeFileSync(join(root,'fixture-port'),String(port),{mode:0o600});console.log(JSON.stringify({root,port}))
})
process.on('SIGTERM',()=>server.close(()=>process.exit(0)))
