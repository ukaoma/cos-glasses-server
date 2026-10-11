import { describe, expect, it } from 'vitest'
import { answerConfidence } from './meeting-ask-confidence.js'
const rows = [{label:'So what',text:'The corrected quantity is 12 [T1].',sources:['T1']}]
describe('evidence confidence', () => {
  it('keeps a specific limitation without converting it to an ASR score', () => {
    const row = answerConfidence({level:'limited',reason:'Quantity is explicitly corrected; the owner name is uncertain.'}, rows, [])
    expect(row.text).toContain('Limited — Quantity is explicitly corrected')
    expect(row.text).toContain('owner name is uncertain')
  })
  it('backstops missing, malformed, empty and invented numerical confidence', () => {
    for (const raw of [undefined,{}, {level:'supported',reason:''},{level:'supported',reason:'99% accurate'}, {level:'supported',reason:'95 percent accurate'}]) {
      expect(answerConfidence(raw, rows, []).text).toMatch(/^Limited — Based on/)
    }
  })
  it('does not let supported override missing sources or partial coverage', () => {
    expect(answerConfidence({level:'supported',reason:'Clear facts.'}, [], []).text).toMatch(/^Low — No cited/)
    expect(answerConfidence({level:'supported',reason:'Clear facts.'}, rows, ['selected passages']).text).toContain('Context coverage is incomplete')
  })
})
