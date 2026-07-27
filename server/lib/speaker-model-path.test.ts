import { afterEach, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { SPEAKER_MODEL_FILENAME, speakerModelCandidates } from './speaker-embeddings.js'

// The voiceprint model is ~26 MB and deliberately outside the npm tarball, so a
// managed install has NO bundled copy. These cases pin the bolt-on contract:
// the model must be loadable from a location that survives a generation swap.
describe('speaker model resolution', () => {
  const original = process.env.COS_SPEAKER_MODEL_PATH
  afterEach(() => {
    if (original === undefined) delete process.env.COS_SPEAKER_MODEL_PATH
    else process.env.COS_SPEAKER_MODEL_PATH = original
  })

  it('prefers an explicit COS_SPEAKER_MODEL_PATH override', () => {
    process.env.COS_SPEAKER_MODEL_PATH = '/tmp/custom-voiceprint.onnx'
    expect(speakerModelCandidates()[0]).toBe('/tmp/custom-voiceprint.onnx')
  })

  it('resolves a relative override against cwd rather than passing it through raw', () => {
    process.env.COS_SPEAKER_MODEL_PATH = 'models/v.onnx'
    expect(speakerModelCandidates()[0]).toBe(resolve('models/v.onnx'))
  })

  it('ignores a blank override instead of searching an empty path', () => {
    process.env.COS_SPEAKER_MODEL_PATH = '   '
    const candidates = speakerModelCandidates()
    expect(candidates).toHaveLength(2)
    expect(candidates.every(Boolean)).toBe(true)
  })

  it('falls back to the data home, which survives generation swaps', () => {
    delete process.env.COS_SPEAKER_MODEL_PATH
    const candidates = speakerModelCandidates()
    // Second-to-last is the bolt-on location; last is the source-checkout bundle.
    expect(candidates[candidates.length - 2]).toBe(
      resolve(homedir(), '.cos-glasses', 'models', SPEAKER_MODEL_FILENAME),
    )
  })

  it('never resolves the bolt-on path inside the installed package', () => {
    delete process.env.COS_SPEAKER_MODEL_PATH
    // A model under node_modules/ is destroyed by the next Update Server, so the
    // durable candidate must not live there.
    const boltOn = speakerModelCandidates().slice(0, -1)
    expect(boltOn.some(p => p.includes('node_modules'))).toBe(false)
  })
})
