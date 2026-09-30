import { afterEach, describe, expect, it } from 'vitest'
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
  expect(result).toEqual({version:1,available:true,activities:[{id:'one',workId:`task:business:${identity}`,domain:'business',status:'queued',provider:'codex',sessionId:'codex:owned',sessionTitle:'Recorded target',
   mode:'continueSession',model:'codex-frontier',createdAt:'1970-01-01T00:00:01.000Z',updatedAt:'1970-01-01T00:00:01.000Z',acknowledged:false,appOpened:false,serverHold:false}]})
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

// ---- 6.59.0: S1 progress projection, S2 open list, S4 saved destination ----
import { readWorkJournal, projectWorkActivity, projectOpenWork, savedDestinationFor, controlSnapshotRevision, cleanEvidence,
  WORK_ACTIVITY_LIMITS, type WorkJournal, type WorkBoardRowLite } from './work-activity.js'
const secrets = ['SECRET detail','SECRET prompt','SECRET result','Private task','SECRET event','SECRET draft prompt']
function journalOf(receipts: unknown[], drafts: unknown[] = []): WorkJournal {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'work-activity-'))); roots.push(root)
 const journalPath=join(root,'handoffs.json');writeFileSync(journalPath,JSON.stringify({version:2,receipts,sessions:[],drafts}),{mode:0o600})
 const read=readWorkJournal({journalPath}); if(!read.available) throw new Error(read.reason); return read
}
const progress = (patch = {}) => ({tag:identity,events:[
 {id:'e1',at:1_790_000_000,kind:'sent',text:'SECRET event sent'},
 {id:'e2',at:1_790_000_060,kind:'received',text:'SECRET event received'},
 {id:'e3',at:1_790_000_120,kind:'moved',text:'SECRET event moved',fromStage:'draft',toStage:'qa',undoneAt:1_790_000_300},
 {id:'e4',at:1_790_000_300,kind:'undone',text:'SECRET event undone'}],
 reported:'done',reportedBy:'session',evidence:'Footer links fixed; checked mobile and desktop.',receivedAt:1_790_000_060,paused:true,
 seenReplies:['a'],notified:[],baseline:[],...patch})
const at = (seconds: number) => new Date(seconds * 1000).toISOString()
const serialized = (value: unknown) => { const json = JSON.stringify(value); for (const secret of secrets) expect(json).not.toContain(secret); return json }

it('S1 projects progress, times, mode and model from Control\'s WorkProgress, never its text', () => {
 const j=journalOf([receipt({createdAt:1_790_000_000,progress:progress()})])
 const [activity]=projectWorkActivity(j,'business',identity)
 expect(activity).toMatchObject({mode:'continueSession',model:'codex-frontier',createdAt:at(1_790_000_000),updatedAt:at(1_790_000_300),
  acknowledged:false,appOpened:false,serverHold:false})
 expect(activity.progress).toEqual({reported:'done',reportedBy:'session',evidence:'Footer links fixed; checked mobile and desktop.',
  receivedAt:at(1_790_000_060),lastMove:{from:'draft',to:'qa',at:at(1_790_000_120),undone:true},paused:true})
 expect(activity).not.toHaveProperty('requestedFrom')
 serialized(activity)
})
it('S1 lastMove is the newest move, and a move still standing is not undone; a move naming no known stage is left out', () => {
 const events=[{id:'m1',at:10,kind:'moved',text:'x',fromStage:'planned',toStage:'draft'},{id:'m2',at:20,kind:'moved',text:'x',fromStage:'draft',toStage:'qa'}]
 const [one]=projectWorkActivity(journalOf([receipt({createdAt:5,progress:progress({events,paused:false})})]),'business',identity)
 expect(one.progress!.lastMove).toEqual({from:'draft',to:'qa',at:at(20),undone:false}); expect(one.progress!.paused).toBe(false)
 const [two]=projectWorkActivity(journalOf([receipt({createdAt:5,progress:progress({events:[{...events[1],toStage:'published'}]})})]),'business',identity)
 expect(two.progress).not.toHaveProperty('lastMove'); expect(two.progress!.reported).toBe('done')
})
it('S1 a malformed progress block drops only that block, never the receipt or the journal', () => {
 const bad = ['x',7,[],{reported:5},{reportedBy:false},{evidence:9},{receivedAt:'yesterday'},{paused:'yes'},{events:'x'},{events:[null]},
  {events:[{at:'soon',kind:'sent'}]},{events:[{at:1,kind:3}]},{events:[{at:1,kind:'moved',fromStage:4}]},{events:[{at:1,kind:'moved',undoneAt:'x'}]},
  {events:Array.from({length:WORK_ACTIVITY_LIMITS.progressEvents+1},(_,i)=>({id:String(i),at:1,kind:'note',text:''}))}]
 for (const block of bad) {
  const j=journalOf([receipt({createdAt:100,progress:block}),receipt({id:'two',createdAt:100,progress:progress()})])
  const [first,second]=projectWorkActivity(j,'business',identity)
  expect(first).not.toHaveProperty('progress'); expect(first.updatedAt).toBe(at(100)); expect(first.status).toBe('queued')
  expect(second.progress!.reported).toBe('done')
 }
})
it('S1 a report kind Control does not know reads as no report, and evidence and reportedBy go with a report only', () => {
 const [a]=projectWorkActivity(journalOf([receipt({progress:progress({reported:'celebrating'})})]),'business',identity)
 expect(a.progress).toMatchObject({reported:null}); expect(a.progress).not.toHaveProperty('evidence'); expect(a.progress).not.toHaveProperty('reportedBy')
 const [b]=projectWorkActivity(journalOf([receipt({progress:progress({reported:'needsInput',reportedBy:'jev'})})]),'business',identity)
 expect(b.progress).toMatchObject({reported:'needsInput',reportedBy:'jev'})
 const [c]=projectWorkActivity(journalOf([receipt({progress:progress({reported:'blocked',reportedBy:'someone'})})]),'business',identity)
 expect(c.progress!.reported).toBe('blocked'); expect(c.progress).not.toHaveProperty('reportedBy')
})
it('S1 evidence is at most 280 whole characters with control characters as spaces', () => {
 expect(cleanEvidence('line one\nline two\ttab\u0007bell\u0085next')).toBe('line one line two tab bell next')
 expect(cleanEvidence('x'.repeat(280))).toBe('x'.repeat(280))
 const long=cleanEvidence('y'.repeat(300))!; expect(Array.from(long)).toHaveLength(280); expect(long.endsWith('…')).toBe(true)
 const family='\u{1F468}‍\u{1F469}‍\u{1F467}', joined=cleanEvidence('z'.repeat(278)+family+family+'tail')!
 expect(joined).toBe('z'.repeat(278)+family+'…')
 expect(cleanEvidence(' \n ')).toBeUndefined(); expect(cleanEvidence(5)).toBeUndefined()
 const [activity]=projectWorkActivity(journalOf([receipt({progress:progress({evidence:'q'.repeat(400)+'\n'})})]),'business',identity)
 expect(Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(activity.progress!.evidence!))).toHaveLength(280)
})
it('S1 acknowledged, appOpened, serverHold and requestedFrom mirror Control and read malformed values as absent', () => {
 const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
  [{acknowledgedAt:1_790_000_000,status:'completed'},{acknowledged:true}],
  [{status:'reviewed'},{acknowledged:true}],
  [{acknowledgedAt:'yesterday',status:'completed'},{acknowledged:false}],
  [{appOpen:{runEndedAt:5,openedAt:6}},{appOpened:true}],
  [{appOpen:{runEndedAt:5}},{appOpened:false}],
  [{appOpen:'open'},{appOpened:false}],
  [{channel:'tab',sessionID:'codex:owned'},{appOpened:true}],
  [{channel:'job',mode:'newSession',sessionID:'codex:owned',status:'running'},{serverHold:true}],
  [{channel:'job',mode:'newSession',sessionID:'codex:owned',status:'sending'},{serverHold:true}],
  [{channel:'job',mode:'newSession',sessionID:'codex:owned',status:'completed'},{serverHold:false}],
  [{channel:'job',mode:'newSession',status:'running',sessionID:null},{serverHold:false}],
  [{channel:'job',mode:'continueSession',sessionID:'codex:owned',status:'running'},{serverHold:false}],
  [{channel:'app',mode:'newSession',sessionID:'codex:owned',status:'running'},{serverHold:false}],
  [{requestedFrom:'glasses'},{requestedFrom:'glasses'}],
 ]
 for (const [patch, expected] of cases) expect(projectWorkActivity(journalOf([receipt(patch)]),'business',identity)[0]).toMatchObject(expected)
 expect(projectWorkActivity(journalOf([receipt({requestedFrom:'phone'})]),'business',identity)[0]).not.toHaveProperty('requestedFrom')
})
it('S1 a 0.5.248 tab that never reached a session reads as canceled, as Control reads it; a linked tab keeps its status', () => {
 const [unsent]=projectWorkActivity(journalOf([receipt({channel:'tab',status:'queued',sessionID:null})]),'business',identity)
 expect(unsent).toMatchObject({status:'canceled',appOpened:true}); expect(unsent.error).toContain('did not complete')
 expect(projectWorkActivity(journalOf([receipt({channel:'tab',status:'queued'})]),'business',identity)[0].status).toBe('queued')
})
it('S1 a time no Date can hold is left out instead of failing the journal, and a model id is optional', () => {
 const [far]=projectWorkActivity(journalOf([receipt({createdAt:1e20,modelID:''})]),'business',identity)
 expect(far).not.toHaveProperty('createdAt'); expect(far).not.toHaveProperty('updatedAt'); expect(far).not.toHaveProperty('model')
 const [ok]=projectWorkActivity(journalOf([receipt({createdAt:100,progress:progress({events:[{id:'a',at:50,kind:'sent',text:''}]})})]),'business',identity)
 expect(ok.updatedAt).toBe(at(100))
})
it('S1 keeps every strict check on the fields it already validated', () => {
 for (const patch of [{status:'published'},{mode:'teleport'},{createdAt:'now'},{channel:5},{prompt:7},{epoch:1.5}]) {
  const f=fixture([receipt(patch)]); expect(readWorkActivity('business',identity,f)).toMatchObject({available:false,activities:[]})
 }
})

// Control 0.5.250 WorkSource.taskSnapshot, run in Swift 6.0.2 (CryptoKit) on 2026-09-30 for these two rows.
const goldenRowA: WorkBoardRowLite = { id:'a'.repeat(12), domain:'DNP study Café', title:'Fix the café',
 text:'Fix the café menu \u{1F377} and the éclair line', doneWhen:'Menu live on mobile', source:'Meeting 2026-09-28',
 meetingRefs:[{recordId:'ops:quilt:2026-09:2026-09-24_Bottle_QA.md',domain:'quilt',month:'2026-09',filename:'2026-09-24_Bottle_QA.md',title:'Bottle QA'},
  {recordId:'unreadable',domain:'../quilt',month:'2026-09',filename:'x.md',title:'Control leaves this one out'},
  {recordId:'ops:quilt:2026-09:b.md',domain:'quilt',month:'2026-09',filename:'b.md',title:'Second \u{1F468}‍\u{1F469}‍\u{1F467}'}] }
const goldenRowB: WorkBoardRowLite = { id:'b'.repeat(12), domain:'personal', title:'Title only', text:'' }
it('S4 computes the draft revision exactly as Control does (Swift golden)', () => {
 expect(controlSnapshotRevision(goldenRowA)).toBe('099225a7cea987a93e37729e54d92c105028b928315d764df9e52d86bcf618dc')
 expect(controlSnapshotRevision(goldenRowB)).toBe('4815ab92cb3485b1a1d5f808e126ebbac2c415cbf1e8498c15b172c58df6a5db')
 expect(controlSnapshotRevision({...goldenRowB,text:undefined})).toBe('4815ab92cb3485b1a1d5f808e126ebbac2c415cbf1e8498c15b172c58df6a5db')
 expect(controlSnapshotRevision({...goldenRowB,doneWhen:'Now'})).not.toBe('4815ab92cb3485b1a1d5f808e126ebbac2c415cbf1e8498c15b172c58df6a5db')
})
const row: WorkBoardRowLite = { id:identity, domain:'business', title:'Board title', text:'Board text', workIdentity:identity, meetingRefs:[] }
const draft = (patch = {}) => ({sourceID:`task:business:${identity}`,sourceRevision:controlSnapshotRevision(row),mode:'continueSession',sessionID:'claude:abc-1',provider:'',modelID:'',prompt:'SECRET draft prompt',editVersion:1,...patch})
it('S4 names the destination of the draft for the current revision, never its prompt', () => {
 const cases: Array<[Record<string, unknown>, unknown]> = [
  [{}, {mode:'continueSession',provider:'claude',sessionId:'claude:abc-1'}],
  [{mode:'newSession',sessionID:'',provider:'codex',modelID:'codex-frontier'}, {mode:'newSession',provider:'codex',model:'codex-frontier'}],
  [{mode:'fork',sessionID:'codex:t-9'}, {mode:'fork',provider:'codex',sessionId:'codex:t-9'}],
  [{mode:'fork',sessionID:'codex:t-9',provider:'claude',modelID:'opus'}, {mode:'fork',provider:'claude',model:'opus',sessionId:'codex:t-9'}],
  [{mode:'fork',sessionID:'codex:t-9',provider:'claude',modelID:''}, undefined],
  [{sessionID:''}, undefined],
  [{sessionID:'claude'}, undefined],
  [{mode:'newSession',sessionID:'',provider:'codex',modelID:''}, undefined],
  [{mode:'newSession',sessionID:'',provider:'',modelID:'opus'}, undefined],
  [{sourceRevision:'f'.repeat(64)}, undefined],
  [{sourceID:'task:business:'+'c'.repeat(12)}, undefined],
 ]
 for (const [patch, expected] of cases) {
  const destination=savedDestinationFor(journalOf([receipt()],[draft(patch)]),row)
  expect(destination).toEqual(expected); serialized(destination ?? null)
 }
})

describe('S2 open list', () => {
 const now = 1_790_100_000_000, nowS = now / 1000
 const id = (n: number) => n.toString(16).padStart(12, '0')
 const boardRow = (n: number, patch: Partial<WorkBoardRowLite> = {}): WorkBoardRowLite => ({ id:id(n), domain:'business', title:`Board ${n}`, text:`Board text ${n}`, workIdentity:id(n), meetingRefs:[], ...patch })
 const r = (n: number, patch: Record<string, unknown> = {}) => receipt({ id:`r${n}-${String(patch.createdAt ?? '')}`, workID:`task:business:${id(n)}`, createdAt:nowS - n * 60, ...patch })
 it('includes open handoffs, needs input first, then running, then done awaiting review, newest first in each', () => {
  const receipts = [
   r(1,{status:'running'}), r(2,{status:'queued'}), r(3,{status:'delivered'}), r(4,{status:'unknown'}), r(5,{status:'sending'}),
   r(6,{status:'completed',progress:progress({reported:'needsInput'})}), r(7,{status:'delivered',progress:progress({reported:'blocked'})}),
   r(8,{status:'completed',progress:progress({reported:'done'})}), r(9,{status:'delivered',progress:progress({reported:'done'})}),
   r(10,{status:'completed'}), r(11,{status:'failed'}), r(12,{status:'canceled'}), r(13,{status:'refused'}),
   r(14,{status:'completed',acknowledgedAt:nowS,progress:progress({reported:'done'})}),
   r(15,{status:'reviewed',progress:progress({reported:'needsInput'})}),
   r(16,{status:'running',createdAt:nowS - 14 * 86_400}),
   r(17,{status:'running',createdAt:nowS - 14 * 86_400 + 1}),
   r(18,{status:'completed',progress:progress({reported:'done'})}),
   r(19,{status:'running'}),
   r(20,{channel:'tab',status:'queued',sessionID:null}),
   receipt({id:'not-on-board',workID:`task:business:${id(99)}`,createdAt:nowS,status:'running'}),
   receipt({id:'review',workID:'meeting-review:wr_1',createdAt:nowS,status:'running'}),
  ]
  const rows = Array.from({length:20},(_,i)=>boardRow(i+1, i+1===18 ? {checked:true,workStage:'complete'} : i+1===19 ? {checked:true,workStage:'complete'} : {}))
  const items = projectOpenWork(journalOf(receipts), rows, now)
  expect(items.map(item => item.workIdentity)).toEqual([id(6),id(7), id(1),id(2),id(3),id(4),id(5),id(19),id(17), id(8),id(9)])
  expect(items[0]).toMatchObject({workIdentity:id(6),domain:'business',title:'Board 6',status:'completed',progress:{reported:'needsInput'}})
  serialized(items)
 })
 it('reads only the newest receipt of an item, by time then id', () => {
  const receipts=[r(1,{id:'old',status:'completed',createdAt:nowS-600,progress:progress({reported:'needsInput'})}), r(1,{id:'new',status:'completed',createdAt:nowS-60})]
  expect(projectOpenWork(journalOf(receipts),[boardRow(1)],now)).toEqual([])
  const tie=[r(2,{id:'b',status:'running',createdAt:nowS-60}), r(2,{id:'a',status:'completed',createdAt:nowS-60})]
  expect(projectOpenWork(journalOf(tie),[boardRow(2)],now).map(item => item.id)).toEqual(['b'])
 })
 it('answers at most 50, the newest', () => {
  const receipts=Array.from({length:60},(_,i)=>r(i+1,{status:'running'})), rows=Array.from({length:60},(_,i)=>boardRow(i+1))
  const items=projectOpenWork(journalOf(receipts),rows,now)
  expect(items).toHaveLength(50); expect(items[0].workIdentity).toBe(id(1)); expect(items[49].workIdentity).toBe(id(50))
 })
 it('carries the saved destination of each item', () => {
  const b=boardRow(3), d={sourceID:`task:business:${id(3)}`,sourceRevision:controlSnapshotRevision(b),mode:'newSession',sessionID:'',provider:'claude',modelID:'opus',prompt:'SECRET draft prompt',editVersion:0}
  const [item]=projectOpenWork(journalOf([r(3,{status:'running'})],[d]),[b],now)
  expect(item.savedDestination).toEqual({mode:'newSession',provider:'claude',model:'opus'}); serialized(item)
 })
})
