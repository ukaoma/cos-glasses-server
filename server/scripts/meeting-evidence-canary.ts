/** Explicit tools-off, bounded semantic canary. Run only by a release operator, never in the background. */
import { writeFileSync } from 'node:fs'
import { createLiveAsk, LIVE_ASK_SYSTEM, normalizeAsk } from '../lib/live-cos-ask.js'
import { runMeetingAskModel } from '../lib/meeting-ask-runner.js'
const path=process.argv[2]
if (!path) throw Error('receipt path required')
const examples=[
 {id:'clear-correction',words:'This is a rehearsal for testing the meeting assistant. Norr owns the pilot. Approved budget is $2,400. Deadline is Friday, October 16. Order ten headsets. Correction: order twelve headsets, replacing ten. Do not order twenty.',question:'For this test pilot, who owns it, what budget and deadline were stated, and how many headsets should be ordered?',kind:'correction'},
 {id:'unresolved-change',words:'We may order ten headsets. Someone else suggested twelve headsets. We have not decided the quantity or assigned an owner.',question:'How many headsets are final, and who owns the order?',kind:'unresolved'},
 {id:'negation',words:'The budget is not approved. Nora will review the quote Friday, but has not agreed to place an order.',question:'Is the budget approved and has Nora committed to ordering?',kind:'negation'},
]
const results=[]
for (const model of ['haiku','sonnet']) {
 for (const ex of examples) {
  const start=Date.now()
  const input=normalizeAsk({sessionId:'meeting_semantic_canary',action:'ask',question:ex.question,elapsedMs:30000,turns:[{id:1,speaker:'You',elapsedMs:1000,text:ex.words}]})
  const result=await createLiveAsk({requireHaiku:false,run:(prompt,signal)=>runMeetingAskModel({engine:'claude',model},prompt,LIVE_ASK_SYSTEM,signal),search:async()=>{throw Error('Canary must not search')},wearer:()=>null})(input)
  const content=result.sections.filter(s=>s.label!=='Confidence').map(s=>s.text).join(' ')
  const flags={confidence:result.sections.at(-1)?.label==='Confidence',cited:result.sources.some(s=>s.id==='T1'),noInventedNora:ex.kind!=='correction'||!/(?:\bNora\s+(?:owns|is the owner)|\bowner\s*(?:is|:)\s*["']?Nora\b)/i.test(content),quantity:ex.kind!=='correction'||/\b(?:12|twelve)\b/i.test(content),noFalseConflict:ex.kind!=='correction'||!/(?:count|quantity|headset).{0,55}(?:contradictory|ambiguous|unresolved|not final|confirm before)/i.test(content),unresolved:ex.kind!=='unresolved'||/(?:not (?:final|decided|assigned)|undecided|unresolved|no[^.]{0,30}(?:final|owns|owner)|has not been (?:decided|assigned)|unassigned|unknown)/i.test(content),negation:ex.kind!=='negation'||/(?:not approved|unapproved|has not|hasn.t|not committed|no.*commitment)/i.test(content)}
  results.push({model,id:ex.id,elapsedMs:Date.now()-start,flags,result})
  writeFileSync(path,JSON.stringify({results,passed:results.every(r=>Object.values(r.flags).every(Boolean))},null,2))
 }
}
if(results.some(r=>Object.values(r.flags).some(v=>!v)))process.exitCode=1
