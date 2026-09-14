import {describe,it,expect} from 'vitest'
import {relabelSpeakerPositions,strippedTranscript,validatedRawMap} from './meeting-speaker-labels.js'
function fixture(){
 const chunks=[{speaker:'Ext',text:'one sentence',elapsed:1000,similarity:.2},{speaker:'Ext',text:'another sentence',elapsed:4000,similarity:.3},{speaker:'Other',text:'closing words',elapsed:7000,similarity:.4}]
 return{chunks,chunkEntries:[{chunkIndex:0,chunk:chunks[0]},{chunkIndex:1},{chunkIndex:2},{chunkIndex:3,chunk:chunks[1]},{chunkIndex:7,chunk:chunks[2]}],speakers:['Ext','Other'],batchSegments:[{startChunkIdx:3,endChunkIdx:7,startElapsed:0,speakerWords:[{word:'near',start:4,end:4.5,speaker:'Ext',similarity:.3},{word:'far',start:11,end:11.5,speaker:'Ext',similarity:0}]}]}
}
describe('position-scoped relabel',()=>{
 it('leaves a partially covered concatenated turn untouched',()=>{
  const md='## Transcript\n\n[Ext]: one sentence another sentence\n\n[Other]: closing words\n'
  const result=relabelSpeakerPositions(fixture(),md,[1],'Brigitta Pólya')
  expect(result.transcript).toBe(0);expect(result.unresolvedTurns).toBe(1);expect(result.markdown).toContain('[Ext]: one sentence another sentence')
 })
 it('rewrites a uniquely aligned whole turn and preserves every spoken byte',()=>{
  const md='## Transcript\n\n[Ext]: one sentence another sentence\n\n[Other]: closing words\n'
  const result=relabelSpeakerPositions(fixture(),md,[0,1],'Brigitta Pólya')
  expect(result.transcript).toBe(1);expect(result.markdown).toContain('[Brigitta Pólya]: one sentence another sentence');expect(strippedTranscript(md)).toBe(strippedTranscript(result.markdown.replace(/\n<!-- speaker-labels-newer-than-graph -->\n$/,'')))
 })
 it('refuses ambiguous duplicate text alignment',()=>{
  const doc=fixture();doc.chunks[1].text=doc.chunks[0].text
  const result=relabelSpeakerPositions(doc,'## Transcript\n\n[Ext]: one sentence\n',[0],'Brigitta Pólya')
  expect(result.transcript).toBe(0);expect(result.unresolvedTurns).toBe(1)
 })
 it('handles bracket newline and bold timestamp labels with zero word changes',()=>{
  const md='## Transcript\n\n[Ext]:\none sentence\n\n**Ext** _[00:04]_: another sentence\n\n[Other]: closing words\n'
  const result=relabelSpeakerPositions(fixture(),md,[0,1],'Brigitta Pólya')
  expect(result.transcript).toBe(2);expect(result.markdown).toContain('[Brigitta Pólya]:\none sentence');expect(result.markdown).toContain('**Brigitta Pólya** _[00:04]_: another sentence')
 })
 it('uses raw segment bounds and nearest 3.5 seconds for HQ words, preserving original similarity',()=>{
  const result=relabelSpeakerPositions(fixture(),'',[1],'Brigitta Pólya')
  expect(result.doc.batchSegments[0].speakerWords).toEqual([{word:'near',start:4,end:4.5,speaker:'Brigitta Pólya',similarity:.3},{word:'far',start:11,end:11.5,speaker:'Ext',similarity:0}])
 })
 it('adds attendee in chunk first appearance order and drops no existing attendee',()=>{
  const md='## Attendees\n\n- Earlier Person\n- Other\n\n## Transcript\n\n[Ext]: one sentence\n\n[Ext]: another sentence\n\n[Other]: closing words\n'
  const result=relabelSpeakerPositions(fixture(),md,[1],'Brigitta Pólya')
  expect(result.markdown.indexOf('- Earlier Person')).toBeLessThan(result.markdown.indexOf('- Brigitta Pólya'));expect(result.markdown.indexOf('- Brigitta Pólya')).toBeLessThan(result.markdown.indexOf('- Other'));expect(result.markdown).not.toContain('- Ext')
 })
 it('refuses same-count wrong text ordering and duplicate raw IDs',()=>{
  const doc=fixture();doc.chunkEntries=[doc.chunkEntries[3],doc.chunkEntries[1],doc.chunkEntries[2],doc.chunkEntries[0],doc.chunkEntries[4]]
  expect(()=>validatedRawMap(doc)).toThrow(/text and raw index map disagree/)
  const duplicate=fixture();duplicate.chunkEntries[3].chunkIndex=0;expect(()=>validatedRawMap(duplicate)).toThrow(/ambiguous/)
 })
})
