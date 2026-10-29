/** Bounded pure worker ownership and opaque, single-use publication authority. */
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { MacSpeakerLiveComputeInput, MacSpeakerLiveComputePrepared, MacSpeakerLiveComputeResult, MacSpeakerLivePreparedPublication } from './mac-speaker-live-worker.js'
import type { MacWindowEmbeddingReceipt } from './mac-speaker-windows.js'
export type { MacSpeakerLiveComputeInput, MacSpeakerLiveComputePrepared, MacSpeakerLiveComputeResult } from './mac-speaker-live-worker.js'
export interface MacSpeakerLivePublicationCapability {readonly kind:'mac-speaker-live-compute'}
interface Binding {captureId:string;generation:string;sourceBindingSHA256:string;fileBindingsSHA256:string;revision:number;voiceHighWater:number;mode:'mac-native-v1'}
const capabilities=new WeakMap<object,{binding:Binding;publication:MacSpeakerLivePreparedPublication}>()
/** A plain object, resealed state or copied capability never confers authority. */
export function takeMacSpeakerLivePublication(capability:unknown,expected:Binding):MacSpeakerLivePreparedPublication|null{
  if(!capability||typeof capability!=='object')return null
  const record=capabilities.get(capability);if(!record)return null
  capabilities.delete(capability)
  if(Object.keys(record.binding).some(key=>record.binding[key as keyof Binding]!==expected[key as keyof Binding]))return null
  return record.publication
}
function createWorker():Worker{
  const url=new URL('./mac-speaker-live-worker'+(import.meta.url.endsWith('.ts')?'.ts':'.js'),import.meta.url)
  const registration=url.pathname.endsWith('.ts')?pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href:null
  return new Worker(`(async()=>{if(${JSON.stringify(registration)}){const tsx=await import(${JSON.stringify(registration)});tsx.register()}await import(${JSON.stringify(url.href)})})().catch(e=>{throw e})`,{eval:true,resourceLimits:{maxOldGenerationSizeMb:192,stackSizeMb:4}})
}
let busy=false
export async function startMacSpeakerLiveCompute(input:MacSpeakerLiveComputeInput,options:{timeoutMs?:number;workerFactory?:()=>Worker}={}){
  if(busy)throw Error('compute_lane_busy')
  if(options.timeoutMs!==undefined&&(!Number.isFinite(options.timeoutMs)||options.timeoutMs<=0||options.timeoutMs>5000))throw Error('compute_deadline_bound')
  if(input.profileJSONBytes.byteLength>32*1024*1024)throw Error('compute_input_bound')
  const binding:Binding=Object.freeze({captureId:input.captureId,generation:input.generation,sourceBindingSHA256:input.sourceBindingSHA256,fileBindingsSHA256:input.fileBindingsSHA256,revision:input.revision,voiceHighWater:input.voiceHighWater,mode:'mac-native-v1'})
  busy=true
  let worker:Worker
  try{worker=(options.workerFactory??createWorker)()}catch(error){busy=false;throw error}
  const job=randomUUID(),budget=options.timeoutMs??5000;let used=0,next=0,closing:Promise<void>|undefined,waiting:{id:number;resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>;deadline:number;started:number}|undefined
  const close=():Promise<void>=>{
    if(!closing){const prior=waiting;waiting=undefined;if(prior){clearTimeout(prior.timer);prior.reject(Error('compute_cancelled'))}
      closing=worker.terminate().then(()=>{}).finally(()=>{busy=false})}
    return closing
  }
  let terminalError:Error|undefined
  const fail=(error:Error)=>{terminalError??=error;const prior=waiting;waiting=undefined;if(prior){clearTimeout(prior.timer);used+=Date.now()-prior.started}void close().then(()=>prior?.reject(error),()=>prior?.reject(error))}
  worker.on('error',error=>fail(error));worker.on('exit',()=>{if(!closing)fail(Error('compute_worker_exited'))})
  worker.on('message',(reply:{id:number;job:string;ok:boolean;value?:unknown;error?:string})=>{
    const pending=waiting;if(!pending)return
    if(reply.id!==pending.id||reply.job!==job)return fail(Error('compute_stale_reply'))
    if(Date.now()>=pending.deadline)return fail(Error('compute_timeout'))
    if(!reply.ok)return fail(Error(reply.error??'compute_failed'))
    clearTimeout(pending.timer);waiting=undefined;used+=Date.now()-pending.started;pending.resolve(reply.value)
  })
  const request=(op:string,payload:Record<string,unknown>,transfer:readonly ArrayBuffer[]=[]):Promise<any>=>new Promise((resolve,reject)=>{
    if(terminalError||closing||waiting){reject(terminalError??Error('compute_not_available'));return}
    const remaining=budget-used;if(remaining<=0){void close().then(()=>reject(Error('compute_timeout')));return}
    const id=++next,started=Date.now(),deadline=started+remaining
    const timer=setTimeout(()=>fail(Error('compute_timeout')),remaining)
    waiting={id,resolve,reject,timer,deadline,started}
    try{worker.postMessage({id,job,op,...payload},transfer)}catch(error){fail(error instanceof Error?error:Error('compute_post_failed'))}
  })
  try{
    const prepared=await request('prepare',{input},[input.profileJSONBytes.buffer as ArrayBuffer])as MacSpeakerLiveComputePrepared
    return{prepared,close,async finish(receipt?:MacWindowEmbeddingReceipt){
      try{
        const result=await request('finish',{receipt})as MacSpeakerLiveComputeResult
        // Keep the authority's payload private; public state/result copies may be
        // inspected or mutated by callers without changing certified bytes.
        const capability=Object.freeze({kind:'mac-speaker-live-compute' as const})
        capabilities.set(capability,{binding,publication:result.publication})
        const {publication,...publicResult}=result
        return{...structuredClone(publicResult),capability}
      }finally{await close()}
    }}
  }catch(error){await close();throw error}
}
