import { describe, it, expect } from 'vitest'
import { calendarCandidates, confirmOrientation, emptyOrientation } from './meeting-ask-orientation.js'
import { MeetingAskStore } from './meeting-ask-store.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const at = Date.parse('2026-10-11T19:36:00Z')
const calendar = {today_events:[{title:'Pricing review',start_time:'2026-10-11T19:30:00Z',end_time:'2026-10-11T20:00:00Z',domain:'quilt'}, {title:'Later meeting', start_time:'2026-10-11T20:00:00Z',end_time:'2026-10-11T21:00:00Z'}]}
describe('meeting orientation', () => {
  it('matches recording start and offers suggestions without automatic confirmation', () => {
    const candidates=calendarCandidates(calendar,at)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({title:'Pricing review',suggestedDomain:'quilt'})
    expect(emptyOrientation()).toEqual({revision:0,domain:null,calendar:null})
    expect(calendarCandidates(calendar,null)).toEqual([])
    expect(calendarCandidates({...calendar,is_stale:true},at)).toEqual([])
  })
  it('requires valid domain, offered calendar identity and current revision', () => {
    const choices=calendarCandidates(calendar,at)
    const confirmed=confirmOrientation({expectedRevision:0,domain:'quilt',calendarId:choices[0].id},emptyOrientation(),choices,['quilt','personal'])
    expect(confirmed).toMatchObject({revision:1,domain:'quilt',calendar:choices[0]})
    expect(()=>confirmOrientation({expectedRevision:0,domain:'personal',calendarId:null},confirmed,choices,['quilt','personal'])).toThrow('meeting_context_changed')
    expect(()=>confirmOrientation({expectedRevision:1,domain:'fake',calendarId:null},confirmed,choices,['quilt','personal'])).toThrow('invalid_meeting_domain')
    expect(()=>confirmOrientation({expectedRevision:1,domain:null,calendarId:'0'.repeat(24)},confirmed,choices,['quilt','personal'])).toThrow('calendar_match_unavailable')
    expect(confirmOrientation({expectedRevision:1,domain:null,calendarId:null},confirmed,[],['quilt','personal'])).toEqual({revision:2,domain:null,calendar:null})
  })
  it('persists each meeting separately without touching Ask history', () => {
    const dir=mkdtempSync(join(tmpdir(),'ask-orientation-')), store=new MeetingAskStore(dir)
    store.putOrientation('meeting_test',{revision:1,domain:'quilt',calendar:null})
    expect(new MeetingAskStore(dir).orientation('meeting_test').domain).toBe('quilt')
    expect(store.orientation('meeting_other').domain).toBeNull()
    expect(()=>store.orientation('../bad')).toThrow('invalid_session_id')
    expect(store.list()).toEqual([])
  })
})
