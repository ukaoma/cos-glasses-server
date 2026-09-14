import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_SAVED_TRAINING_CHUNKS, saveTrainingAudioSample } from './training-audio-save.js'
describe('training audio retention capacity', () => {
  it('uses a slot freed by training or expiration without a server restart', async () => {
    const dir=mkdtempSync(join(tmpdir(),'training-audio-'))
    try {
      for(let i=0;i<MAX_SAVED_TRAINING_CHUNKS;i++) writeFileSync(join(dir,`${i}.wav`),'audio')
      expect(await saveTrainingAudioSample(dir,'new.wav',Buffer.from('new'))).toBe(false)
      unlinkSync(join(dir,'0.wav'))
      expect(await saveTrainingAudioSample(dir,'new.wav',Buffer.from('new'))).toBe(true)
      expect(readdirSync(dir)).toHaveLength(MAX_SAVED_TRAINING_CHUNKS)
    } finally {rmSync(dir,{recursive:true,force:true})}
  })
  it('rejects duplicate samples even below the cap and during a pending write', async () => {
    const dir=mkdtempSync(join(tmpdir(),'training-audio-'))
    try {
      const results=await Promise.all([saveTrainingAudioSample(dir,'same.wav',Buffer.from('a')),saveTrainingAudioSample(dir,'same.wav',Buffer.from('b'))])
      expect(results).toEqual([true,false])
      expect(await saveTrainingAudioSample(dir,'same.wav',Buffer.from('c'))).toBe(false)
    } finally {rmSync(dir,{recursive:true,force:true})}
  })
  it('reserves capacity across concurrent writes and never overwrites a sample', async () => {
    const dir=mkdtempSync(join(tmpdir(),'training-audio-'))
    try {
      const saved=await Promise.all(Array.from({length:MAX_SAVED_TRAINING_CHUNKS+10},(_,i)=>saveTrainingAudioSample(dir,`${i}.wav`,Buffer.from('audio'))))
      expect(saved.filter(Boolean)).toHaveLength(MAX_SAVED_TRAINING_CHUNKS)
      expect(readdirSync(dir)).toHaveLength(MAX_SAVED_TRAINING_CHUNKS)
      expect(await saveTrainingAudioSample(dir,'0.wav',Buffer.from('replacement'))).toBe(false)
    } finally {rmSync(dir,{recursive:true,force:true})}
  })
})
