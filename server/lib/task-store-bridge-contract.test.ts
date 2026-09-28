import { expect, it, vi } from 'vitest'
const call = vi.hoisted(()=>vi.fn())
vi.mock('./task-bridge.js',()=>({callTaskBridge:call,taskBridgeAvailable:()=>true,taskOperationsRoot:()=>null,taskBridgeUnavailableMessage:()=>''}))
import { loadDomainRows, listBoard } from './task-store.js'
const valid = {id:'a'.repeat(12),ref:'business-1',domain:'business',description:'Task',priority:'inbox',section:'inbox',is_checked:false,archived:false,delegated:false,needs_review:false,line_number:2}
it('never converts malformed bridge inventory to complete empty success',async()=>{
 for (const payload of [{},null,'[]',{tasks:[]},[null],[{...valid,description:42}],[{...valid,domain:'personal'}],[{...valid,is_checked:'false'}],[valid,valid],[{...valid,meeting_refs:[null]}]]) {
  call.mockResolvedValue(payload)
  await expect(loadDomainRows('business','2026-09-27')).rejects.toMatchObject({code:'invalid_task_inventory'})
 }
 call.mockResolvedValue({});await expect(listBoard()).rejects.toMatchObject({code:'invalid_task_inventory'})
})
it('accepts genuine empty and legacy rows without additive Work fields',async()=>{
 call.mockResolvedValue([]);expect(await loadDomainRows('business','2026-09-27')).toEqual([])
 call.mockResolvedValue([valid]);expect(await loadDomainRows('business','2026-09-27')).toEqual([valid])
})
