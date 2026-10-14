import { runMeetingAskModel } from '../lib/meeting-ask-runner.js'
import { parseWorkChatInput,parseWorkChatAnswer,WORK_CHAT_SYSTEM } from '../lib/work-chat.js'
const input=parseWorkChatInput({workID:'task:quilt:aaaaaaaaaaaa',revision:'a'.repeat(64),question:'Have the copy reviewer check the launch headline and the implementation reviewer check navigation. Report their findings here. Do not publish.',context:'Sample website launch task. Finish line: copy and navigation reviewed. Sample only.',sessions:[{id:'claude:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',title:'Website copy review',summary:'Owns headline copy only.',status:'idle',automatic:true},{id:'codex:bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',title:'Website implementation review',summary:'Owns navigation verification only.',status:'idle',automatic:true},{id:'cursor:cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',title:'Mobile layout review',summary:'Mobile layout',status:'idle',automatic:false}],history:[],updates:[],mode:'plan'})
const started=Date.now()
const response=await runMeetingAskModel({engine:'claude',model:'sonnet'},JSON.stringify(input),WORK_CHAT_SYSTEM,undefined,undefined,{caller:'work_chat_canary'})
const parsed=parseWorkChatAnswer(response.text,input)
if (parsed.assignments.length!==2 || !parsed.assignments.some(a=>a.sessionID===input.sessions[0].id) || !parsed.assignments.some(a=>a.sessionID===input.sessions[1].id)) throw new Error('Expected two distinct qualified sample assignments')
console.log(JSON.stringify({passed:true,durationMs:Date.now()-started,model:response.model,answer:parsed.answer,assignments:parsed.assignments,actualDispatches:0}))

const summaryInput=parseWorkChatInput({...input,mode:'summary',question:'Summarize observed changes and blockers; do not dispatch.',updates:[{sessionID:input.sessions[0].id,status:'completed',detail:'Copy review finished',result:'Headline copy approved; implementation is outside my scope.'},{sessionID:input.sessions[1].id,status:'running',detail:'Implementation review continues',result:'Navigation has a failing mobile check. Launch is not approved.'}]})
const summaryResponse=await runMeetingAskModel({engine:'claude',model:'sonnet'},JSON.stringify(summaryInput),WORK_CHAT_SYSTEM,undefined,undefined,{caller:'work_chat_summary_canary'})
const summary=parseWorkChatAnswer(summaryResponse.text,summaryInput)
if(summary.assignments.length!==0 || !/mobile|navigation/i.test(summary.answer)) throw new Error('Summary omitted the observed blocker')
console.log(JSON.stringify({summaryPassed:true,model:summaryResponse.model,answer:summary.answer,actualDispatches:0}))
const readOnlyInput=parseWorkChatInput({...input,question:'What is this task’s finish line and which reviewers are connected? Answer here only; do not send any messages.'})
const readOnlyResponse=await runMeetingAskModel({engine:'claude',model:'sonnet'},JSON.stringify(readOnlyInput),WORK_CHAT_SYSTEM,undefined,undefined,{caller:'work_chat_read_only_canary'})
const readOnly=parseWorkChatAnswer(readOnlyResponse.text,readOnlyInput)
if(readOnly.assignments.length!==0) throw new Error('Read-only question unexpectedly assigned work')
console.log(JSON.stringify({readOnlyPassed:true,model:readOnlyResponse.model,answer:readOnly.answer,actualDispatches:0}))
