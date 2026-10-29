/** Pure durable publication preparation. The caller writes this replacement and
 * originals atomically before committing in-memory state or emitting an event. */
import { createMacSpeakerLiveState, MAC_SPEAKER_LIVE_TERMINAL_REVISION, hashMacSpeakerLive, validateMacSpeakerLiveState, withholdMacSpeakerLiveState, type MacSpeakerLiveState } from './mac-speaker-live-memory.js'
import { projectMacSpeakerLiveChunks, type MacSpeakerLiveSourceChunk } from './mac-speaker-live-projection.js'
const ZERO='0'.repeat(64)
export function macSpeakerLiveVoiceHighWater(chunks:readonly unknown[],minimum=0):number{
 let maximum=minimum
 const visit=(v:unknown):void=>{if(!v||typeof v!=='object')return
  const row=v as Record<string,unknown>
  for(const key of ['speaker','originalSpeaker'])if(typeof row[key]==='string'){
   const match=/^Voice\s*([1-9]\d?)$/i.exec(row[key] as string);if(match)maximum=Math.max(maximum,Number(match[1]))
  }
  for(const key of ['segments','finalSegments','words'])if(Array.isArray(row[key]))for(const child of row[key] as unknown[])visit(child)
 }
 for(const c of chunks)visit(c)
 return maximum
}
function reseal(state:MacSpeakerLiveState):MacSpeakerLiveState {const{stateSHA256,...body}=state;return{...body,stateSHA256:hashMacSpeakerLive(body)}}
export function prepareMacSpeakerLivePublication(input:{captureId:string;generation:string;chunksIndexed:readonly {i:number;c:MacSpeakerLiveSourceChunk & Record<string,unknown>}[];state?:MacSpeakerLiveState;validated:boolean;revision:number;previousDigest?:string}){
 let state=input.state,invalid=false
 const unsafeCounter=!Number.isSafeInteger(input.revision)||input.revision<0||input.revision>=MAC_SPEAKER_LIVE_TERMINAL_REVISION-1
 const revision=unsafeCounter?MAC_SPEAKER_LIVE_TERMINAL_REVISION-1:input.revision
 if(state){try{validateMacSpeakerLiveState(state);if(state.captureId!==input.captureId||state.generation!==input.generation)throw Error('capture_generation_drift')}
 catch{invalid=true;state=withholdMacSpeakerLiveState(createMacSpeakerLiveState(input.captureId,input.generation,ZERO,ZERO,99),'recovered_state_invalid')}}
 if(unsafeCounter||state&&state.revision>=MAC_SPEAKER_LIVE_TERMINAL_REVISION-1){
  state=withholdMacSpeakerLiveState(createMacSpeakerLiveState(input.captureId,input.generation,ZERO,ZERO,99),'revision_counter_exhausted')
  state.revision=MAC_SPEAKER_LIVE_TERMINAL_REVISION;state=reseal(state)
 }
 if(state){state=structuredClone(state);if(!input.validated||invalid)state.projections=[];state=reseal(state)}
 let overlay:ReturnType<typeof projectMacSpeakerLiveChunks>
 try{overlay=projectMacSpeakerLiveChunks({captureId:input.captureId,generation:input.generation,chunksIndexed:input.chunksIndexed,projections:state?.projections??[]})}
 catch(error){
  // Projection conflicts (including a newly arrived legacy Voice collision)
  // revoke the complete overlay. Never leave the prior durable claim visible.
  if(!state?.projections.length)throw error
  state.projections=[];state=reseal(state)
  overlay=projectMacSpeakerLiveChunks({captureId:input.captureId,generation:input.generation,chunksIndexed:input.chunksIndexed,projections:[]})
 }
 // A valid state must never advertise proof for rows the source projector refused.
 if(state&&overlay.withheld.length&&state.projections.length){state.projections=[];state=reseal(state);overlay=projectMacSpeakerLiveChunks({captureId:input.captureId,generation:input.generation,chunksIndexed:input.chunksIndexed,projections:[]})}
 const changed=input.previousDigest!==overlay.effectiveOverlaySHA256
 // A prior claim already at the terminal cursor has no representable newer
 // withdrawal. Refuse adoption; recovery preserves it outside active claims.
 if(input.revision===MAC_SPEAKER_LIVE_TERMINAL_REVISION&&changed&&input.previousDigest!==undefined)throw Error('live_revision_exhausted')
 if(!state&&input.previousDigest!==undefined&&changed&&revision>0){
  invalid=true;state=withholdMacSpeakerLiveState(createMacSpeakerLiveState(input.captureId,input.generation,ZERO,ZERO,99),'recovered_state_missing')
 }
 const nextRevision=Math.max(state?.revision??0,revision+(changed||invalid?1:0))
 if(nextRevision>MAC_SPEAKER_LIVE_TERMINAL_REVISION)throw Error('live_revision_exhausted')
 if(state){state.revision=nextRevision;state=reseal(state);validateMacSpeakerLiveState(state)}
 return{speakerIdentityPolicy:'mac-native-v1' as const,sourceType:'mac_system_audio' as const,speakerGeneration:input.generation,speakerRevision:nextRevision,
  speakerProjectionSHA256:overlay.effectiveOverlaySHA256,speakerProjectedChunksIndexed:overlay.speakerProjectedChunksIndexed,
  ...(state?{macSpeakerLive:state}:{}),...(invalid?{macSpeakerLiveQuarantineSHA256:hashMacSpeakerLive(input.state??null)}:{}),invalid,
  sourceBindingSHA256:overlay.sourceBindingSHA256}
}

/** Main-thread withdrawal path. Never validates, clones or hashes retained
 * acoustic state. That state is private/untrusted until the worker certifies it. */
export function macSpeakerLiveOriginalOnly(input:{captureId:string;generation:string;chunksIndexed:readonly {i:number;c:Record<string,unknown>}[];state?:MacSpeakerLiveState;revision:number;previousDigest?:string}){
 const digest=hashMacSpeakerLive({captureId:input.captureId,generation:input.generation,changes:[]}),changed=input.previousDigest!==digest
 if(input.revision===MAC_SPEAKER_LIVE_TERMINAL_REVISION&&changed&&input.previousDigest!==undefined)throw Error('live_revision_exhausted')
 const unsafe=!Number.isSafeInteger(input.revision)||input.revision<0||input.revision>=MAC_SPEAKER_LIVE_TERMINAL_REVISION-1
 const missing=!input.state&&input.previousDigest!==undefined&&changed&&input.revision>0
 let terminal:MacSpeakerLiveState|undefined
 if(unsafe||missing){terminal=withholdMacSpeakerLiveState(createMacSpeakerLiveState(input.captureId,input.generation,ZERO,ZERO,99),unsafe?'revision_counter_exhausted':'recovered_state_missing')
  terminal.revision=unsafe?MAC_SPEAKER_LIVE_TERMINAL_REVISION:input.revision+1;terminal=reseal(terminal)}
 const revision=terminal?.revision??input.revision+(changed?1:0)
 return{speakerIdentityPolicy:'mac-native-v1' as const,sourceType:'mac_system_audio' as const,speakerGeneration:input.generation,speakerRevision:revision,speakerProjectionSHA256:digest,
  speakerProjectedChunksIndexed:input.chunksIndexed,...(terminal?{macSpeakerLive:terminal}:{}),...(!terminal&&input.state?{macSpeakerLiveRetainedState:input.state}:{}),invalid:false,
  sourceBindingSHA256:hashMacSpeakerLive({captureId:input.captureId,generation:input.generation,originals:input.chunksIndexed})}
}
