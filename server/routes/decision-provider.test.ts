import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'
import { requireApiToken } from '../lib/api-auth.js'
import { createDecisionProviderRouter } from './decision-provider.js'
import { createDecisionClient } from '../lib/decision-provider.js'
import { decisionSettingsRevision, patchDecisionSettings, readDecisionSettings, resolveDecisionSelection, writeDecisionSettings, type DecisionSettings } from '../lib/decision-settings.js'
import { CompletionChecker } from '../lib/work-completion.js'
import { SessionRecommender } from '../lib/session-recommendation.js'
import { WorkSearcher } from '../lib/work-search.js'
const servers: Server[] = [], dirs: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); dirs.splice(0).forEach(p => rmSync(p,{recursive:true,force:true})) })
const empty = (): DecisionSettings => ({ schema: 1, overrides: {} })
async function setup(options: { env?: NodeJS.ProcessEnv; read?: () => DecisionSettings; write?: (settings: DecisionSettings) => void } = {}) {
  let settings = empty()
  const write = vi.fn((next: DecisionSettings) => { settings = next })
  const configured = vi.fn(() => ({ jev: true, subq: false }))
  const app = express(); app.use('/api', requireApiToken('synthetic-token')); app.use(express.json({limit:'1kb'}))
  app.use('/api',createDecisionProviderRouter({read:()=>settings,write,configured,env:{},...options}))
  const server = await new Promise<Server>(r => { const s = app.listen(0,'127.0.0.1',()=>r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/decision-provider`
  const call = (method = 'GET',body?: unknown,token = 'synthetic-token') => fetch(base,{method,headers:{'X-COS-Token':token,'Content-Type':'application/json'},body: body === undefined ? undefined : JSON.stringify(body)})
  return {base,call,write,configured}
}
it('authenticates GET and PATCH, defaults to Jev, and never returns credentials', async () => {
  const s = await setup()
  expect((await fetch(s.base)).status).toBe(401)
  expect((await s.call('PATCH',{provider:'subq'},'wrong')).status).toBe(401)
  const response = await s.call();expect(response.headers.get('cache-control')).toBe('private, no-store')
  const status = await response.json()
  expect(status).toMatchObject({schema:1,provider:'jev',effective:{session:'jev',completion:'jev',search:'jev'},configured:{jev:true,subq:false},saved:{provider:null,overrides:{}},capabilities:{fallback:false,hotReload:true}})
  expect(status.revision).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(status)).not.toContain('synthetic-token')
  expect(s.write).not.toHaveBeenCalled()
})
it('patches only explicit fields, persists overrides, clears choices with null and rejects stale revisions', async () => {
  const s = await setup();const first = await (await s.call()).json()
  const next = await (await s.call('PATCH',{expectedRevision:first.revision,provider:'subq',overrides:{completion:'jev'}})).json()
  expect(next).toMatchObject({provider:'subq',effective:{session:'subq',completion:'jev',search:'subq'},configured:{subq:false},sources:{session:'config',completion:'config',search:'config'}})
  expect(next.revision).not.toBe(first.revision)
  const stale = await s.call('PATCH',{expectedRevision:first.revision,provider:'jev'})
  expect(stale.status).toBe(409);expect((await stale.json()).error.code).toBe('decision_settings_conflict');expect(s.write).toHaveBeenCalledTimes(1)
  const cleared = await (await s.call('PATCH',{expectedRevision:next.revision,provider:null,overrides:{completion:null}})).json()
  expect(cleared).toMatchObject({provider:'jev',overrides:{},effective:{session:'jev',completion:'jev',search:'jev'},saved:{provider:null,overrides:{}}})
})
it('uses a strict request allowlist and never treats a key or auto mode as settings', async () => {
  const s=await setup();const {revision}=await (await s.call()).json()
  for (const patch of [{},{provider:'subq'},{expectedRevision:revision},{expectedRevision:revision,provider:'auto'},
    {expectedRevision:revision,provider:'subq',key:'secret'}, {expectedRevision:revision,overrides:{unknown:'subq'}}, {expectedRevision:revision,overrides:[]}, {expectedRevision:revision,overrides:{}},
    {expectedRevision:'invalid',provider:'subq'}, {expectedRevision:revision,overrides:{search:1}}]) {
    const r=await s.call('PATCH',patch);expect(r.status).toBe(400);expect((await r.json()).error.code).toBe('invalid_decision_settings')
  }
  expect(s.write).not.toHaveBeenCalled()
})
it('reports read/write failures without exposing private paths or raw configuration', async () => {
  const bad=await setup({read:()=>{throw new Error('private-key-value')}})
  const get=await bad.call();expect(get.status).toBe(503);expect(await get.text()).not.toContain('private-key-value')
  const failed=await setup({write:()=>{throw new Error('private-key-value')}});const {revision}=await (await failed.call()).json()
  const patch=await failed.call('PATCH',{expectedRevision:revision,provider:'subq'});expect(patch.status).toBe(503);expect(await patch.text()).not.toContain('private-key-value')
})
it('stores atomic private settings, refuses symlinks/corruption and preserves the target', () => {
  const dir=mkdtempSync(join(tmpdir(),'decision-settings-'));dirs.push(dir);const file=join(dir,'settings.json')
  expect(readDecisionSettings(file)).toEqual(empty())
  const next=patchDecisionSettings(empty(),{expectedRevision:decisionSettingsRevision(empty()),provider:'subq'})
  writeDecisionSettings(next,file);expect(readDecisionSettings(file)).toEqual(next);expect(statSync(file).mode&0o777).toBe(0o600)
  writeFileSync(file,'broken');expect(()=>readDecisionSettings(file)).toThrow('decision_settings_unavailable')
  const target=join(dir,'target');writeFileSync(target,'keep');const link=join(dir,'link');symlinkSync(target,link)
  expect(()=>writeDecisionSettings(next,link)).toThrow();expect(()=>readDecisionSettings(link)).toThrow('decision_settings_unavailable');expect(readFileSync(target,'utf8')).toBe('keep')
})
it('defaults only for genuinely missing settings and fails closed for a dangling symlink over HTTP', async () => {
  const dir=mkdtempSync(join(tmpdir(),'decision-settings-missing-'));dirs.push(dir);const file=join(dir,'settings.json')
  expect(resolveDecisionSelection('session',{},readDecisionSettings(file))).toEqual({provider:'jev',source:'default'})
  const target=join(dir,'missing-target');symlinkSync(target,file)
  expect(()=>readDecisionSettings(file)).toThrow('decision_settings_unavailable')
  const s=await setup({read:()=>readDecisionSettings(file)})
  for (const [method,body] of [['GET',undefined],['PATCH',{expectedRevision:decisionSettingsRevision(empty()),provider:'subq'}]] as const) {
    const response=await s.call(method,body)
    expect(response.status).toBe(503);expect(await response.json()).toMatchObject({error:{code:'decision_settings_unavailable'}})
  }
  expect(s.write).not.toHaveBeenCalled()
})
it('resolves saved per-workflow, workflow environment, saved global, global environment, then default', () => {
  const saved:DecisionSettings={schema:1,provider:'subq',overrides:{completion:'jev'}}
  expect(resolveDecisionSelection('completion',{COS_DECISION_PROVIDER_COMPLETION:'subq'},saved)).toEqual({provider:'jev',source:'config'})
  expect(resolveDecisionSelection('search',{COS_DECISION_PROVIDER_SEARCH:'jev'},saved)).toEqual({provider:'jev',source:'env'})
  expect(resolveDecisionSelection('search',{COS_DECISION_PROVIDER:'jev'},saved)).toEqual({provider:'subq',source:'config'})
  expect(resolveDecisionSelection('search',{COS_DECISION_PROVIDER:'subq'},empty())).toEqual({provider:'subq',source:'env'})
  expect(()=>resolveDecisionSelection('search',{COS_DECISION_PROVIDER:'auto'},empty())).toThrow('decision_invalid_provider')
})
it('snapshots each request and isolates all workflow caches when provider selection changes', async () => {
  const dir=mkdtempSync(join(tmpdir(),'decision-switch-'));dirs.push(dir)
  vi.stubEnv('SUBQ_API_KEY','synthetic-subq-key')
  const env:NodeJS.ProcessEnv={COS_DECISION_PROVIDER:'jev'}
  const answers={finished:{type:'choice' as const,choice:'unclear',confidence:.9,probabilities:{done:.05,not_done:.05,unclear:.9}},best:{type:'choice' as const,choice:'none',confidence:.95,probabilities:{s0:.05,none:.95}},exact:{type:'choice' as const,choice:'none',confidence:.95,probabilities:{s0:.05,none:.95}},c:{type:'choice' as const,choice:'none',confidence:.95,probabilities:{t0:.05,none:.95}}}
  const jevAsk=vi.fn(async (_state:unknown,questions:Record<string,unknown>)=>({answers:Object.fromEntries(Object.keys(questions).map(k=>[k,answers[k as keyof typeof answers]])),model:'jev-1.13.0',inputTokens:10}))
  const transport=vi.fn(async (_url:unknown,init:RequestInit)=>{const body=JSON.parse(String(init.body));return Response.json({model:'subq-snap-preview',answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,answers[k as keyof typeof answers]])),usage:{input_tokens:10}})})
  vi.stubGlobal('fetch',transport)
  const checker=new CompletionChecker(createDecisionClient('completion',{ask:jevAsk},env));const rec=new SessionRecommender(createDecisionClient('session',{ask:jevAsk},env));const search=new WorkSearcher(createDecisionClient('search',{ask:jevAsk},env))
  const run=()=>Promise.all([checker.check({task:{text:'synthetic cache check',doneWhen:''},reply:'unknown'}),rec.recommend({task:{text:'synthetic cache check',domain:'personal',meetings:[]},sessions:[{id:'synthetic',provider:'codex',title:'a separate task'}]}),search.search('synthetic cache check',[{id:'synthetic',text:'a separate task',domain:'personal',checked:false}])])
  expect((await run()).map(r=>'provider' in r?r.provider:undefined)).toEqual(['jev','jev','jev']);expect(jevAsk).toHaveBeenCalledTimes(3)
  env.COS_DECISION_PROVIDER='subq'
  expect((await run()).map(r=>'provider' in r?r.provider:undefined)).toEqual(['subq','subq','subq']);expect(transport).toHaveBeenCalledTimes(3)
  expect((await run()).map(r=>'cached' in r?r.cached:undefined)).toEqual([true,true,true]);expect(transport).toHaveBeenCalledTimes(3)
  env.COS_DECISION_PROVIDER='jev'
  expect((await run()).map(r=>'provider' in r?r.provider:undefined)).toEqual(['jev','jev','jev']);expect(jevAsk).toHaveBeenCalledTimes(3)
})
