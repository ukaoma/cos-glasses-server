import { describe, it, expect } from 'vitest'
import { connectedEvidence } from './meeting-ask-evidence.js'
import { normalizeAsk } from './live-cos-ask.js'
import { explicitWebRequest, publicSearchGate, prioritizeWebPages } from './meeting-ask-web.js'
import { groundWebLinks } from './meeting-ask-links.js'
import { answerConfidence } from './meeting-ask-confidence.js'
describe('HC field regressions', () => {
  it('ties a displayed URL to its observed linked source and withholds invented URLs',()=>{
    const sources=[{id:'W1',kind:'web' as const,title:'Summary',text:'Whole search summary'}, {id:'W3',kind:'web' as const,title:'Official',text:'Search only',url:'https://www.example.com/apply'}]
    const rows=[{label:'So what',text:'Apply at https://example.com/apply [W1].',sources:['W1']}]
    expect(groundWebLinks(rows,sources).sections[0]).toEqual({label:'So what',text:'Apply at https://www.example.com/apply [W3].',sources:['W3']})
    expect(groundWebLinks([{...rows[0],text:'https://example.evil/apply [W1].'}],sources).withheld).toBe(true)
    expect(groundWebLinks([{...rows[0],text:'(https://example.evil/apply) [W1].'}],sources).withheld).toBe(true)
    expect(groundWebLinks([{...rows[0],text:'https://example.com/apply [W1].'}],sources.slice(0,1)).withheld).toBe(true)
    expect(groundWebLinks([{...rows[0],text:'[Apply](https://www.example.com/apply) [W1].'}],sources).sections[0].text).toBe('[Apply](https://www.example.com/apply) [W3].')
    expect(groundWebLinks([{...rows[0],text:'[Apply](https://example.evil/apply) [W1].'}],sources).withheld).toBe(true)
  })
  it('keeps requested speaker neighborhoods before generic filler without leaking future turns', () => {
    const turns=Array.from({length:120},(_,id)=>({id,elapsedMs:id*6000,speaker:id>=105?'Swaroop Aindala':'Other',text:id>=105?'Override columns and keyword links remain in progress.':'Generic update '.repeat(40)}))
    const input=normalizeAsk({sessionId:'meeting_hc',action:'ask',question:'Summarize Swaroop updates for 1517',elapsedMs:720000,turns})
    const selected=connectedEvidence(input,8000)
    for(const t of turns.slice(105))expect(selected.some(s=>s.id===t.id)).toBe(true)
    expect(selected.reduce((sum,t)=>sum+t.text.length+t.speaker.length+160,0)).toBeLessThanOrEqual(8000)
  })
  it('honors application/link requests while retaining private lookup routing', () => {
    for(const q of ['How much is the claude credit also can you find the application for me.','Can you find the start up program for claude and give me the link here.'])expect(explicitWebRequest(q)).toBe(true)
    for(const q of ['Find our internal application','Find my private document','Find the client application'])expect(explicitWebRequest(q)).toBe(false)
    expect(publicSearchGate({question:'Find the application for Claude',query:'Claude confidential client budget'}).ok).toBe(false)
  })
  it('ranks an observed official product domain before aggregators, not lookalike domains',()=>{
    const sources=['https://example.com','https://anthropic.evil.example/startups','https://www.anthropic.com/startups'].map((url,i)=>({id:`W${i}`,kind:'web' as const,title:'Result',text:'Search only',url}))
    expect(prioritizeWebPages(sources,'Claude startup application')[0].url).toBe('https://www.anthropic.com/startups')
  })
  it('does not turn selected-context coverage into uncertainty about an explicit supported fact',()=>{
    const section={label:'So what',text:'Delivered Friday [T1].',sources:['T1']}
    expect(answerConfidence({level:'supported',reason:'The cited delivery statement is explicit.'},[section],['This answer uses selected passages because the meeting exceeds the context limit.']).text).toMatch(/^Supported/)
    expect(answerConfidence({level:'supported',reason:'The amount is unclear.'},[section],[]).text).toMatch(/^Limited/)
  })
})
