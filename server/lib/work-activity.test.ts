import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWorkJournal, projectWorkActivity, projectOpenWork, savedDestinationFor, controlSnapshotRevision, cleanEvidence,
  parseWorkSessionId, sameSession, reportOf, WORK_ACTIVITY_LIMITS, type WorkJournal, type WorkBoardRowLite, type WorkActivityOptions } from './work-activity.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const identity = 'a'.repeat(12)
const receipt = (patch = {}) => ({id:'one',workID:`task:business:${identity}`,workTitle:'Private task',sourceRevision:'r',mode:'continueSession',provider:'codex',modelID:'codex-frontier',sessionID:'codex:owned',sessionTitle:'Recorded target',status:'queued',detail:'SECRET detail',prompt:'SECRET prompt',result:'SECRET result',createdAt:1,...patch})
function fixture(receipts: unknown[] = [receipt()], version = 2) {
 const root = realpathSync(mkdtempSync(join(tmpdir(),'work-activity-'))); roots.push(root)
 const journalPath=join(root,'handoffs.json');writeFileSync(journalPath,JSON.stringify({version,receipts,sessions:[],drafts:[]}),{mode:0o600})
 return {journalPath,root}
}
/** The route's own path: read the journal, then project one item. */
function activityOf(domain: string, workIdentity: string, options: WorkActivityOptions) {
 const journal = readWorkJournal(options)
 return journal.available ? { available: true, activities: projectWorkActivity(journal, domain, workIdentity) } : { available: false, reason: journal.reason, activities: [] }
}
const C1 = 'claude:11111111-2222-4333-8444-555555555555', X1 = 'codex:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const R1 = 'cursor:99999999-8888-4777-8666-555555555555', O1 = 'ollama:12345678-1234-4123-8123-123456789abc'

it('reads v1/v2 exact source identity; never infers title ownership or returns private fields',()=>{
 for (const version of [1,2]) {
  const f=fixture([receipt(),receipt({id:'other',workID:`task:personal:${identity}`}),receipt({id:'title',workID:'task:business:bbbbbbbbbbbb',workTitle:'Same title'})],version)
  const result=activityOf('business',identity,f)
  expect(result).toEqual({available:true,activities:[{id:'one',workId:`task:business:${identity}`,domain:'business',status:'queued',provider:'codex',sessionId:'codex:owned',sessionTitle:'Recorded target',
   mode:'continueSession',model:'codex-frontier',createdAt:'1970-01-01T00:00:01.000Z',updatedAt:'1970-01-01T00:00:01.000Z',acknowledged:false,appOpened:false,serverHold:false,waitingInApp:false}]})
  expect(JSON.stringify(result)).not.toContain('SECRET');expect(JSON.stringify(result)).not.toContain('Private task')
 }
})
it('does not treat queued/delivered as task completion; interrupted intent is unknown',()=>{
 const activity=activityOf('business',identity,fixture([receipt({status:'sending'})])).activities[0]
 expect(activity.status).toBe('unknown');expect(activity.error).toContain('unresolved')
})
it('does not assign a cross-provider target',()=>{
 expect(activityOf('business',identity,fixture([receipt({sessionID:'claude:wrong'})])).activities[0].sessionId).toBeUndefined()
})
it('missing/corrupt/unknown-version/duplicate journals are unavailable, not empty success',()=>{
 const f=fixture();rmSync(f.journalPath);expect(readWorkJournal(f).available).toBe(false)
 for (const raw of ['{',JSON.stringify({version:9,receipts:[],sessions:[]}),JSON.stringify({version:2,receipts:[receipt(),receipt()],sessions:[]})]) {
  writeFileSync(f.journalPath,raw);expect(readWorkJournal(f).available).toBe(false)
 }
})
it('rejects leaf/ancestor symlinks and oversized files',()=>{
 const f=fixture();const alias=join(f.root,'alias.json');symlinkSync(f.journalPath,alias)
 expect(readWorkJournal({journalPath:alias}).available).toBe(false)
 const link=join(f.root,'linked');symlinkSync(f.root,link);expect(readWorkJournal({journalPath:join(link,'handoffs.json')}).available).toBe(false)
 writeFileSync(f.journalPath,' '.repeat(10_000_000));expect(readWorkJournal(f).available).toBe(false)
})
it('isolated runtimes never silently consult the real native history',()=>{
 const f=fixture();const native=join(f.root,'Library/Application Support/COS Control/work-handoffs');mkdirSync(native,{recursive:true});writeFileSync(join(native,'handoffs.json'),JSON.stringify({version:2,receipts:[receipt()],sessions:[]}))
 for (const env of [{NODE_ENV:'test'},{COS_CONTROL_TEST_HOME:f.root},{COS_DATA_DIR:join(f.root,'scratch')},{COS_WORK_CONNECTED_TEST:'1'}]) expect(readWorkJournal({home:f.root,platform:'darwin',env}).available).toBe(false)
 expect(readWorkJournal({home:f.root,platform:'linux',env:{}}).available).toBe(false)
 expect(readWorkJournal({home:f.root,platform:'darwin',env:{}}).available).toBe(true)
})
it('matches native rejection of malformed sessions/drafts and duplicate draft identity without changing journal',()=>{
 const f=fixture();const draft={sourceID:'task:business:'+identity,sourceRevision:'r',mode:'continueSession',sessionID:'',provider:'',modelID:'',prompt:'private',editVersion:0}
 for(const patch of [{sessions:[null]},{sessions:[{id:'codex:one'}]},{drafts:[null]},{drafts:[{...draft,editVersion:'0'}]},{drafts:[draft,draft]},{drafts:[{...draft,sourceRevision:''}]}]) {
  const bytes=JSON.stringify({version:2,receipts:[receipt()],sessions:[],drafts:[],...patch});writeFileSync(f.journalPath,bytes)
  expect(readWorkJournal(f).available).toBe(false)
  expect(readFileSync(f.journalPath,'utf8')).toBe(bytes)
 }
})
it('S1 keeps every strict check on the fields it already validated', () => {
 for (const patch of [{status:'published'},{mode:'teleport'},{createdAt:'now'},{channel:5},{prompt:7},{epoch:1.5}]) expect(readWorkJournal(fixture([receipt(patch)])).available).toBe(false)
})

// ---- 6.59.0: S1 progress projection, S2 open list, S4 saved destination ----
const secrets = ['SECRET detail','SECRET prompt','SECRET result','Private task','SECRET event','SECRET draft prompt']
function journalOf(receipts: unknown[], drafts: unknown[] = []): WorkJournal {
 const f=fixture(receipts); writeFileSync(f.journalPath,JSON.stringify({version:2,receipts,sessions:[],drafts}),{mode:0o600})
 const read=readWorkJournal(f); if(!read.available) throw new Error(read.reason); return read
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
const one = (patch: Record<string, unknown>, others: unknown[] = []) => projectWorkActivity(journalOf([receipt(patch), ...others]),'business',identity)[0]

it('S1 projects progress, times, mode and model from Control\'s WorkProgress, never its text', () => {
 const activity=one({createdAt:1_790_000_000,progress:progress()})
 expect(activity).toMatchObject({mode:'continueSession',model:'codex-frontier',createdAt:at(1_790_000_000),updatedAt:at(1_790_000_300),
  acknowledged:false,appOpened:false,serverHold:false,waitingInApp:false})
 expect(activity.progress).toEqual({reported:'done',reportedBy:'session',evidence:'Footer links fixed; checked mobile and desktop.',
  receivedAt:at(1_790_000_060),lastMove:{from:'draft',to:'qa',at:at(1_790_000_120),undone:true},paused:true})
 expect(activity).not.toHaveProperty('requestedFrom'); expect(activity).not.toHaveProperty('requestId')
 serialized(activity)
})
it('S1 lastMove is the newest move, and a move still standing is not undone; a move naming no known stage is left out', () => {
 const events=[{id:'m1',at:10,kind:'moved',text:'x',fromStage:'planned',toStage:'draft'},{id:'m2',at:20,kind:'moved',text:'x',fromStage:'draft',toStage:'qa'}]
 const first=one({createdAt:5,progress:progress({events,paused:false})})
 expect(first.progress).toMatchObject({lastMove:{from:'draft',to:'qa',at:at(20),undone:false},paused:false})
 const second=one({createdAt:5,progress:progress({events:[{...events[1],toStage:'published'}]})})
 expect(second.progress).not.toHaveProperty('lastMove'); expect(reportOf(second.progress)).toBe('done')
})
it('S1 a malformed progress block reads unreadable on its own, never silence, never the receipt or the journal', () => {
 const bad = ['x',7,[],{reported:5},{reportedBy:false},{evidence:9},{receivedAt:'yesterday'},{paused:'yes'},{events:'x'},{events:[null]},
  {events:[{at:'soon',kind:'sent'}]},{events:[{at:1,kind:3}]},{events:[{at:1,kind:'moved',fromStage:4}]},{events:[{at:1,kind:'moved',undoneAt:'x'}]},
  {events:Array.from({length:WORK_ACTIVITY_LIMITS.progressEvents+1},(_,i)=>({id:String(i),at:1,kind:'note',text:''}))}]
 for (const block of bad) {
  const [first,second]=projectWorkActivity(journalOf([receipt({createdAt:100,progress:block}),receipt({id:'two',createdAt:100,progress:progress()})]),'business',identity)
  expect(first.progress).toEqual({unreadable:true}); expect(first.updatedAt).toBe(at(100)); expect(first.status).toBe('queued')
  expect(reportOf(first.progress)).toBeNull(); expect(reportOf(second.progress)).toBe('done')
 }
 expect(one({progress:null})).not.toHaveProperty('progress')
})
it('S1 a report kind Control does not know reads as no report, and evidence and reportedBy go with a report only', () => {
 const a=one({progress:progress({reported:'celebrating'})})
 expect(a.progress).toMatchObject({reported:null}); expect(a.progress).not.toHaveProperty('evidence'); expect(a.progress).not.toHaveProperty('reportedBy')
 expect(one({progress:progress({reported:'needsInput',reportedBy:'jev'})}).progress).toMatchObject({reported:'needsInput',reportedBy:'jev'})
 const c=one({progress:progress({reported:'blocked',reportedBy:'someone'})})
 expect(reportOf(c.progress)).toBe('blocked'); expect(c.progress).not.toHaveProperty('reportedBy')
})
it('S1 evidence is cleaned as a session name is, at most 280 characters and 1,200 UTF-16 units', () => {
 expect(cleanEvidence('line one\nline two\ttab\u0007bell\u0085next')).toBe('line one line two tab bell next')
 expect(cleanEvidence('a‮b⁦c​d‎e﻿f g h   i')).toBe('a b c d e f g h i')
 expect(cleanEvidence('joined \u{1F468}‍\u{1F469}‍\u{1F467} and क्‍ष')).toBe('joined \u{1F468}‍\u{1F469}‍\u{1F467} and क्‍ष')
 expect(cleanEvidence('x'.repeat(280))).toBe('x'.repeat(280))
 const long=cleanEvidence('y'.repeat(300))!; expect(Array.from(long)).toHaveLength(280); expect(long.endsWith('…')).toBe(true)
 const family='\u{1F468}‍\u{1F469}‍\u{1F467}', joined=cleanEvidence('z'.repeat(278)+family+family+'tail')!
 expect(joined).toBe('z'.repeat(278)+family+'…')
 // 200 characters of 8 units each: under 280 characters, over 1,200 units.
 const heavy='\u{1F468}‍\u{1F469}‍\u{1F467}'.repeat(200), cut=cleanEvidence(heavy)!
 expect(cut.length).toBeLessThanOrEqual(1_200); expect(cut.endsWith('…')).toBe(true); expect(cut.startsWith(family)).toBe(true)
 expect(cleanEvidence('e'+'́'.repeat(5_000))).toBe('…')
 expect(cleanEvidence(' \n ')).toBeUndefined(); expect(cleanEvidence(5)).toBeUndefined()
 const activity=one({progress:progress({evidence:'q'.repeat(400)+'\n'})}) as { progress: { evidence: string } }
 expect(Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(activity.progress.evidence))).toHaveLength(280)
})
it('S1 acknowledged and requestedFrom mirror Control and read malformed values as absent; requestId and channel project', () => {
 expect(one({acknowledgedAt:1_790_000_000,status:'completed'}).acknowledged).toBe(true)
 expect(one({status:'reviewed'}).acknowledged).toBe(true)
 expect(one({acknowledgedAt:'yesterday',status:'completed'}).acknowledged).toBe(false)
 expect(one({requestedFrom:'glasses'}).requestedFrom).toBe('glasses')
 expect(one({requestedFrom:'phone'})).not.toHaveProperty('requestedFrom')
 expect(one({requestId:'0000000a-0000-4000-8000-000000000000'}).requestId).toBe('0000000a-0000-4000-8000-000000000000')
 expect(one({requestId:'not-a-request'})).not.toHaveProperty('requestId')
 expect(one({channel:'turn'}).channel).toBe('turn'); expect(one({channel:'carrier-pigeon'})).not.toHaveProperty('channel')
})
it('S1 app, server and queued-in-app ownership belong to the SESSION, across every receipt that names it', () => {
 const other = (patch: Record<string, unknown>) => receipt({ id:'other', workID:'task:personal:'+'c'.repeat(12), createdAt:2, ...patch })
 // This handoff never opened an app itself; another receipt on the same session did (Control's appOwner).
 expect(one({sessionID:X1,channel:'turn',status:'delivered'},[other({sessionID:X1,appOpen:{runEndedAt:5,openedAt:6}})]).appOpened).toBe(true)
 expect(one({sessionID:X1,channel:'turn'},[other({sessionID:X1,channel:'tab'})]).appOpened).toBe(true)
 expect(one({sessionID:X1,channel:'turn'},[other({sessionID:X1,channel:'app',status:'queued'})])).toMatchObject({appOpened:true,waitingInApp:true})
 expect(one({sessionID:X1,channel:'turn'},[other({sessionID:X1,channel:'app',status:'delivered'})])).toMatchObject({appOpened:true,waitingInApp:false})
 // A short id of the same session counts (Control's sameSession); another session or provider does not.
 expect(one({sessionID:X1},[other({sessionID:'codex:aaaaaaaa',appOpen:{openedAt:6}})]).appOpened).toBe(true)
 expect(one({sessionID:X1},[other({sessionID:'codex:aaaaaaa',appOpen:{openedAt:6}})]).appOpened).toBe(false)
 expect(one({sessionID:X1},[other({sessionID:'claude:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',appOpen:{openedAt:6}})]).appOpened).toBe(false)
 expect(one({sessionID:X1,appOpen:{runEndedAt:5}}).appOpened).toBe(false)
 expect(one({sessionID:X1,appOpen:'open'}).appOpened).toBe(false)
 // Server hold: a Work New session the server still runs, on this session, from any receipt.
 expect(one({sessionID:X1,channel:'turn'},[other({sessionID:X1,channel:'job',mode:'newSession',status:'running'})]).serverHold).toBe(true)
 expect(one({sessionID:X1,channel:'job',mode:'newSession',status:'sending'}).serverHold).toBe(true)
 expect(one({sessionID:X1,channel:'job',mode:'newSession',status:'completed'}).serverHold).toBe(false)
 expect(one({sessionID:X1,channel:'job',mode:'continueSession',status:'running'}).serverHold).toBe(false)
 expect(one({sessionID:X1,channel:'app',mode:'newSession',status:'running'}).serverHold).toBe(false)
 // With no session there is nothing to own: a 0.5.248 tab that never reached one.
 expect(one({channel:'tab',status:'queued',sessionID:null})).toMatchObject({status:'canceled',appOpened:false,serverHold:false,waitingInApp:false})
 expect(one({channel:'tab',status:'queued',sessionID:null}).error).toContain('did not complete')
 expect(one({channel:'tab',status:'queued'}).status).toBe('queued')
})
it('S1 a time no Date can hold is left out instead of failing the journal, and a model id is optional', () => {
 const far=one({createdAt:1e20,modelID:''})
 expect(far).not.toHaveProperty('createdAt'); expect(far).not.toHaveProperty('updatedAt'); expect(far).not.toHaveProperty('model')
 expect(one({createdAt:100,progress:progress({events:[{id:'a',at:50,kind:'sent',text:''}]})}).updatedAt).toBe(at(100))
})
it('sameSession and parseWorkSessionId follow Control and the native thread id rule', () => {
 expect(sameSession('claude:ABCDEF12-0000','claude:abcdef12')).toBe(true)
 expect(sameSession('claude:abcdef1','claude:abcdef12')).toBe(false)
 expect(sameSession('claude:abcdef12','codex:abcdef12')).toBe(false)
 expect(sameSession(':abcdef12',':abcdef12')).toBe(false)
 expect(sameSession('claude:','claude:')).toBe(false)
 expect(parseWorkSessionId(C1)).toEqual({provider:'claude',native:C1.slice(7)})
 for (const bad of [O1,'claude:11111111','claude:claude:11111111-2222-4333-8444-555555555555','claude:../11111111-2222-4333-8444-555555555555',
  'CLAUDE:11111111-2222-4333-8444-555555555555','claude:11111111-2222-4333-8444-55555555555G',5]) expect(parseWorkSessionId(bad)).toBeNull()
})

// Control 0.5.250 WorkSource.taskSnapshot, run in Swift 6.0.2 (CryptoKit) on 2026-09-30 for these two rows.
const goldenRowA: WorkBoardRowLite = { id:'a'.repeat(12), domain:'DNP study Café', title:'Fix the café',
 text:'Fix the café menu \u{1F377} and the éclair line', doneWhen:'Menu live on mobile', source:'Meeting 2026-09-28',
 meetingRefs:[{recordId:'ops:quilt:2026-09:2026-09-24_Bottle_QA.md',domain:'quilt',month:'2026-09',filename:'2026-09-24_Bottle_QA.md',title:'Bottle QA'},
  {recordId:'unreadable',domain:'../quilt',month:'2026-09',filename:'x.md',title:'Control leaves this one out'},
  {recordId:'ops:quilt:2026-09:b.md',domain:'quilt',month:'2026-09',filename:'b.md',title:'Second \u{1F468}‍\u{1F469}‍\u{1F467}'}] }
const goldenRowB: WorkBoardRowLite = { id:'b'.repeat(12), domain:'personal', title:'Title only', text:'' }
it('S4 computes the task revision exactly as Control does (Swift golden)', () => {
 expect(controlSnapshotRevision(goldenRowA)).toBe('099225a7cea987a93e37729e54d92c105028b928315d764df9e52d86bcf618dc')
 expect(controlSnapshotRevision(goldenRowB)).toBe('4815ab92cb3485b1a1d5f808e126ebbac2c415cbf1e8498c15b172c58df6a5db')
 expect(controlSnapshotRevision({...goldenRowB,text:undefined})).toBe('4815ab92cb3485b1a1d5f808e126ebbac2c415cbf1e8498c15b172c58df6a5db')
 expect(controlSnapshotRevision({...goldenRowB,doneWhen:'Now'})).not.toBe('4815ab92cb3485b1a1d5f808e126ebbac2c415cbf1e8498c15b172c58df6a5db')
})
it('S4 agrees with Control\'s Swift on every row of the committed harness (__fixtures__/control-task-snapshot)', () => {
 const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'control-task-snapshot')
 const rows = JSON.parse(readFileSync(join(dir, 'rows.json'), 'utf8')) as WorkBoardRowLite[]
 const expected = readFileSync(join(dir, 'expected.txt'), 'utf8').trim().split('\n')
 expect(rows.length).toBe(12); expect(expected).toHaveLength(12)
 rows.forEach((row, i) => expect(`task:${row.domain}:${row.workIdentity || row.id} ${controlSnapshotRevision(row)}`).toBe(expected[i]))
})

const row: WorkBoardRowLite = { id:identity, domain:'business', title:'Board title', text:'Board text', workIdentity:identity, meetingRefs:[] }
const draft = (patch = {}) => ({sourceID:`task:business:${identity}`,sourceRevision:controlSnapshotRevision(row),mode:'continueSession',sessionID:C1,provider:'',modelID:'',prompt:'SECRET draft prompt',editVersion:1,...patch})
it('S4 names the destination only when Control\'s sendPlan would send exactly that and a request would pass, never the prompt', () => {
 const cases: Array<[string, Record<string, unknown>, unknown]> = [
  ['continue on claude', {}, {mode:'continueSession',provider:'claude',sessionId:C1}],
  ['continue on cursor', {sessionID:R1}, {mode:'continueSession',provider:'cursor',sessionId:R1}],
  ['continue on ollama', {sessionID:O1}, undefined],
  ['continue on a short id', {sessionID:'claude:11111111'}, undefined],
  ['a new Codex session', {mode:'newSession',sessionID:'',provider:'codex',modelID:'codex-frontier'}, {mode:'newSession',provider:'codex',model:'codex-frontier'}],
  ['a legacy model slot is normalized', {mode:'newSession',sessionID:'',provider:'codex',modelID:'codex-high'}, {mode:'newSession',provider:'codex',model:'codex-frontier'}],
  ['a new session whose model is another provider\'s', {mode:'newSession',sessionID:'',provider:'claude',modelID:'codex-frontier'}, undefined],
  ['a new session with an unknown slot', {mode:'newSession',sessionID:'',provider:'claude',modelID:'gpt-9'}, undefined],
  ['a new session with no model', {mode:'newSession',sessionID:'',provider:'codex',modelID:''}, undefined],
  ['native fork of codex', {mode:'fork',sessionID:X1}, {mode:'fork',provider:'codex',sessionId:X1}],
  ['native fork of cursor', {mode:'fork',sessionID:R1}, undefined],
  ['fork from ollama to claude', {mode:'fork',sessionID:O1,provider:'claude',modelID:'opus'}, undefined],
  ['fork from codex to claude', {mode:'fork',sessionID:X1,provider:'claude',modelID:'opus'}, {mode:'fork',provider:'claude',model:'opus',sessionId:X1}],
  ['fork from codex to claude without a model', {mode:'fork',sessionID:X1,provider:'claude',modelID:''}, undefined],
  ['fork from codex to claude with a codex model', {mode:'fork',sessionID:X1,provider:'claude',modelID:'codex-balanced'}, undefined],
  ['fork from cursor to claude (Control exports it; a request refuses a cursor Fork)', {mode:'fork',sessionID:R1,provider:'claude',modelID:'opus'}, undefined],
  ['claude fork with a leftover cursor provider is a native fork', {mode:'fork',sessionID:C1,provider:'cursor',modelID:'cursor-grok'}, {mode:'fork',provider:'claude',sessionId:C1}],
  ['claude fork naming claude is a native fork', {mode:'fork',sessionID:C1,provider:'claude',modelID:'opus'}, {mode:'fork',provider:'claude',sessionId:C1}],
  ['an empty prompt', {prompt:'  \n '}, undefined],
  ['a prompt over Control\'s draft limit', {prompt:'p'.repeat(31_521)}, undefined],
  ['a stale revision', {sourceRevision:'f'.repeat(64)}, undefined],
  ['another item', {sourceID:'task:business:'+'c'.repeat(12)}, undefined],
 ]
 for (const [name, patch, expected] of cases) {
  const destination=savedDestinationFor(journalOf([receipt()],[draft(patch)]),row)
  expect({ name, destination }).toEqual({ name, destination: expected }); serialized(destination ?? null)
 }
 expect(savedDestinationFor(journalOf([receipt()],[draft({prompt:'p'.repeat(31_520)})]),row)).toBeDefined()
})

describe('S2 open list', () => {
 const now = 1_790_100_000_000, nowS = now / 1000
 const id = (n: number) => n.toString(16).padStart(12, '0')
 const boardRow = (n: number, patch: Partial<WorkBoardRowLite> = {}): WorkBoardRowLite => ({ id:id(n), domain:'business', title:`Board ${n}`, text:`Board text ${n}`, workIdentity:id(n), meetingRefs:[], ...patch })
 const r = (n: number, patch: Record<string, unknown> = {}) => receipt({ id:`r${n}-${String(patch.createdAt ?? '')}`, workID:`task:business:${id(n)}`, createdAt:nowS - n * 60, ...patch })
 const ids = (list: { items: Array<{ workIdentity: string }> }) => list.items.map(item => item.workIdentity)
 it('groups needs input, attention, running, done awaiting review, in that order', () => {
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
   r(21,{status:'failed',progress:progress({reported:'needsInput'})}),
   r(22,{status:'failed',acknowledgedAt:nowS}),
   r(23,{status:'canceled',progress:progress({reported:'done'})}),
   r(24,{status:'completed',progress:progress({reported:'done'})}),
   r(25,{status:'completed',progress:'garbled'}),
   receipt({id:'not-on-board',workID:`task:business:${id(99)}`,createdAt:nowS,status:'running'}),
   receipt({id:'review',workID:'meeting-review:wr_1',createdAt:nowS,status:'running'}),
  ]
  const rows = Array.from({length:25},(_,i)=>boardRow(i+1, i+1===18 || i+1===19 ? {checked:true,workStage:'complete'} : i+1===24 ? {workStage:'complete'} : {}))
  const list = projectOpenWork(journalOf(receipts), rows, now)
  expect(ids(list)).toEqual([id(6),id(7), id(4),id(5),id(10),id(11),id(13),id(21),id(25), id(1),id(2),id(3),id(19),id(17), id(8),id(9),id(24)])
  expect(list.items.map(item => item.group)).toEqual(['needsInput','needsInput','attention','attention','attention','attention','attention','attention','attention','running','running','running','running','running','done','done','done'])
  expect(list.items[0]).toMatchObject({workIdentity:id(6),domain:'business',title:'Board 6',status:'completed',taskRevision:controlSnapshotRevision(rows[5])})
  expect(list).toMatchObject({total:17,truncated:false})
  serialized(list)
 })
 it('reads only the newest receipt of an item, by time then id', () => {
  const receipts=[r(1,{id:'old',status:'completed',createdAt:nowS-600,progress:progress({reported:'needsInput'})}), r(1,{id:'new',status:'completed',createdAt:nowS-60,progress:progress({reported:null})})]
  expect(projectOpenWork(journalOf(receipts),[boardRow(1)],now).items.map(item => item.id)).toEqual(['new'])
  const acked=[r(1,{id:'old',status:'running',createdAt:nowS-600}), r(1,{id:'new',status:'completed',createdAt:nowS-60,acknowledgedAt:nowS})]
  expect(projectOpenWork(journalOf(acked),[boardRow(1)],now).items).toEqual([])
  const tie=[r(2,{id:'b',status:'running',createdAt:nowS-60}), r(2,{id:'a',status:'completed',createdAt:nowS-60,acknowledgedAt:nowS})]
  expect(projectOpenWork(journalOf(tie),[boardRow(2)],now).items.map(item => item.id)).toEqual(['b'])
 })
 it('orders by the newest progress, not the send time, before cutting to 50, and says how many there were', () => {
  const receipts=Array.from({length:60},(_,i)=>r(i+1,{status:'running'}))
  // The oldest send has the newest progress event: it leads.
  receipts[59]=r(60,{status:'running',progress:progress({reported:null,events:[{id:'late',at:nowS-1,kind:'working',text:''}]})})
  const list=projectOpenWork(journalOf(receipts),Array.from({length:60},(_,i)=>boardRow(i+1)),now)
  expect(list.items).toHaveLength(50); expect(list.total).toBe(60); expect(list.truncated).toBe(true)
  expect(list.items[0].workIdentity).toBe(id(60)); expect(list.items[1].workIdentity).toBe(id(1)); expect(list.items[49].workIdentity).toBe(id(49))
 })
 it('carries the task revision and the saved destination of each item', () => {
  const b=boardRow(3), d={sourceID:`task:business:${id(3)}`,sourceRevision:controlSnapshotRevision(b),mode:'newSession',sessionID:'',provider:'claude',modelID:'opus',prompt:'SECRET draft prompt',editVersion:0}
  const [item]=projectOpenWork(journalOf([r(3,{status:'running'})],[d]),[b],now).items
  expect(item).toMatchObject({savedDestination:{mode:'newSession',provider:'claude',model:'opus'},taskRevision:controlSnapshotRevision(b)}); serialized(item)
 })
})
