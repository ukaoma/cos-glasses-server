import { randomUUID } from 'node:crypto'
import { fetchPublicArticle } from './meeting-web-page.js'
import type { MeetingAskSource } from '../../shared/meeting-ask.js'
/** Fixed public authorities for a single reviewed rules family. Never accepts a model/meeting URL. */
export const RETIREMENT_AUTHORITIES = [
  'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-termination-of-employment',
  'https://www.dol.gov/agencies/ebsa/workers-and-families/changing-jobs-and-job-loss',
] as const
export async function readRetirementRules(publicAddress:(address:string)=>boolean,signal?:AbortSignal){
 const retrievalId=randomUUID(),retrievedAt=new Date().toISOString()
 const pages=await Promise.all(RETIREMENT_AUTHORITIES.map(url=>fetchPublicArticle(url,publicAddress,signal)))
 const sources:MeetingAskSource[]=pages.flatMap((page,i)=>page?[{id:`W${i+1}`,kind:'web' as const,title:page.title||new URL(page.url).hostname,url:page.url,text:'Retrieved page excerpt (may be partial): '+page.text,retrievalId,retrievedAt}]:[])
 return {sources,notices:[sources.length?`Public rules: ${sources.length} official page(s) read. General rules do not establish this account's terms or fees.`:'Official public rules could not be read; the claim is unverified.']}
}
