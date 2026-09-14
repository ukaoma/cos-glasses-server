import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  earlyMeetingSyncEnabled,
  g2Revision,
  mergeG2OperationsSidecar,
  patchRecordingForG2Pipeline,
} from './g2-ops-handoff.js'

describe('patchRecordingForG2Pipeline', () => {
  it('stays default-off and requires an explicit 1', () => {
    const prior = process.env.COS_MEETING_EARLY_SYNC
    try {
      delete process.env.COS_MEETING_EARLY_SYNC
      expect(earlyMeetingSyncEnabled()).toBe(false)
      process.env.COS_MEETING_EARLY_SYNC = '0'
      expect(earlyMeetingSyncEnabled()).toBe(false)
      process.env.COS_MEETING_EARLY_SYNC = '1'
      expect(earlyMeetingSyncEnabled()).toBe(true)
    } finally {
      if (prior == null) delete process.env.COS_MEETING_EARLY_SYNC
      else process.env.COS_MEETING_EARLY_SYNC = prior
    }
  })
  it('rewrites standalone summaries into pipeline markers sync_meetings accepts', () => {
    const input = [
      '# G2 Recording',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| **Source** | G2 Glasses |',
      '',
      '## Summary',
      '',
      '*Standalone recording — canonical transcript shown in meeting detail.*',
      '',
      '## Transcript',
      '',
      '[MU]: hello',
      '',
    ].join('\n')

    const patched = patchRecordingForG2Pipeline(input)
    expect(patched).toContain('summary pending pipeline processing')
    expect(patched).toContain('g2-needs-domain-review')
    expect(patched).not.toContain('Standalone recording')
  })

  it('marks claim markdown as HQ-pending and removes the marker on final staging', () => {
    const input = '# Meeting\n\n## Summary\n\n*Standalone recording — canonical transcript shown in meeting detail.*\n'
    expect(patchRecordingForG2Pipeline(input, { phase: 'claim' })).toContain('g2-hq-state: pending')
    expect(patchRecordingForG2Pipeline(input, { phase: 'final' })).not.toContain('g2-hq-state: pending')
  })

  it('preserves operations-owned blend evidence across a final server merge', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-g2-merge-'))
    const source = join(root, 'source.json')
    const destination = join(root, 'destination.json')
    try {
      writeFileSync(source, JSON.stringify({
        sessionId: 'session_001',
        lifecycleRevision: 2,
        batchApplied: true,
        chunks: [{ text: 'final' }],
      }))
      writeFileSync(destination, JSON.stringify({
        sessionId: 'session_001',
        lifecycleRevision: 1,
        blended_into: ['quilt/meetings/2026-08/cloud.md'],
        enrichmentState: 'matched',
        chunks: [{ text: 'live' }],
      }))

      mergeG2OperationsSidecar(source, destination, { phase: 'final', revision: 2 })
      const merged = JSON.parse(readFileSync(destination, 'utf8'))
      expect(merged).toMatchObject({
        sessionId: 'session_001',
        lifecycleRevision: 2,
        hqState: 'accepted',
        syncState: 'finalized',
        blended_into: ['quilt/meetings/2026-08/cloud.md'],
        enrichmentState: 'matched',
        chunks: [{ text: 'final' }],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed on a conflicting session identity or regressing revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-g2-merge-'))
    const source = join(root, 'source.json')
    const destination = join(root, 'destination.json')
    try {
      writeFileSync(source, JSON.stringify({ sessionId: 'session_new', lifecycleRevision: 1 }))
      writeFileSync(destination, JSON.stringify({ sessionId: 'session_old', lifecycleRevision: 2 }))
      expect(() => mergeG2OperationsSidecar(source, destination, { phase: 'final', revision: 1 }))
        .toThrow(/across sessions/)

      writeFileSync(source, JSON.stringify({ sessionId: 'session_old', lifecycleRevision: 1 }))
      expect(() => mergeG2OperationsSidecar(source, destination, { phase: 'final', revision: 1 }))
        .toThrow(/regressing/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('correction revision precedence',()=>{
  it.each([true,false,-1,1.5,'2',NaN,Infinity])('rejects invalid revision %s',value=>{expect(()=>g2Revision(value)).toThrow(/revision/)})
  it.each([['source',2,1],['destination',1,2]])('higher %s correction wins speaker fields in either direction',(_where,sourceRevision,destinationRevision)=>{
    const root=mkdtempSync(join(tmpdir(),'correction-revision.')),source=join(root,'source.json'),destination=join(root,'destination.json')
    try{
      writeFileSync(source,JSON.stringify({sessionId:'session_001',lifecycleRevision:2,correctionRevision:sourceRevision,chunks:[{speaker:'Source'}],chunkEntries:[{chunk:{speaker:'Source'}}],speakers:['Source'],batchApplied:true,batchSegments:[{speakerWords:[{speaker:'Source'}]}]}))
      writeFileSync(destination,JSON.stringify({sessionId:'session_001',lifecycleRevision:1,correctionRevision:destinationRevision,chunks:[{speaker:'Destination'}],chunkEntries:[{chunk:{speaker:'Destination'}}],speakers:['Destination'],batchApplied:true,batchSegments:[{speakerWords:[{speaker:'Destination'}]}],labelsNewerThanGraph:true,claimed_parent:'quilt/parent.md'}))
      mergeG2OperationsSidecar(source,destination)
      const result=JSON.parse(readFileSync(destination,'utf8')),winner=Number(sourceRevision)>Number(destinationRevision)?'Source':'Destination'
      expect(result.chunks[0].speaker).toBe(winner);expect(result.batchSegments[0].speakerWords[0].speaker).toBe(winner);expect(result.chunkEntries[0].chunk.speaker).toBe(winner);expect(result.correctionRevision).toBe(2);expect(result.labelsNewerThanGraph).toBe(true);expect(result.claimed_parent).toBe('quilt/parent.md');expect(result.hqState).toBe('accepted')
    }finally{rmSync(root,{recursive:true,force:true})}
  })
})
