import { afterEach, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { SPEAKER_MODEL_FILENAME, speakerModelCandidates } from './speaker-embeddings.js'

// The voiceprint model is ~26 MB and deliberately outside the npm tarball, so a
// managed install has NO bundled copy. These cases pin the bolt-on contract: the
// model must be loadable from a location that survives a generation swap.
describe('speaker model resolution', () => {
  const originalOverride = process.env.COS_SPEAKER_MODEL_PATH
  const originalDataDir = process.env.COS_DATA_DIR
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  afterEach(() => {
    restore('COS_SPEAKER_MODEL_PATH', originalOverride)
    restore('COS_DATA_DIR', originalDataDir)
  })

  const durableDir = resolve(homedir(), '.cos-glasses', 'models')

  it('prefers an explicit COS_SPEAKER_MODEL_PATH override', () => {
    process.env.COS_SPEAKER_MODEL_PATH = '/tmp/custom-voiceprint.onnx'
    expect(speakerModelCandidates()[0]).toBe('/tmp/custom-voiceprint.onnx')
  })

  it('ignores a blank override instead of searching an empty path', () => {
    process.env.COS_SPEAKER_MODEL_PATH = '   '
    const candidates = speakerModelCandidates()
    expect(candidates).toHaveLength(2)
    expect(candidates.every(Boolean)).toBe(true)
  })

  it('offers the durable data-home directory as the first non-override candidate', () => {
    delete process.env.COS_SPEAKER_MODEL_PATH
    expect(speakerModelCandidates()[0]).toBe(resolve(durableDir, SPEAKER_MODEL_FILENAME))
  })

  // Regression: the durable candidate was derived as resolve(DATA_DIR,'..'),
  // which is purely lexical. A relocated COS_DATA_DIR moved the "durable"
  // location out of the cos home — and a COS_DATA_DIR inside the package
  // collapsed it back onto the directory an update deletes.
  it('keeps the durable candidate anchored to the home dir when COS_DATA_DIR moves', () => {
    delete process.env.COS_SPEAKER_MODEL_PATH
    for (const dataDir of ['/Users/someone/mycos', '/data', '/tmp/pkg/server/data']) {
      process.env.COS_DATA_DIR = dataDir
      expect(speakerModelCandidates()[0]).toBe(resolve(durableDir, SPEAKER_MODEL_FILENAME))
    }
  })

  it('never offers a non-override candidate inside the installed package', () => {
    delete process.env.COS_SPEAKER_MODEL_PATH
    // Only the bundled source-checkout copy may sit next to the code, and it is
    // the LAST resort. Everything ahead of it must be update-durable.
    const beforeBundled = speakerModelCandidates().slice(0, -1)
    expect(beforeBundled.length).toBeGreaterThan(0)
    expect(beforeBundled.some(p => p.includes('node_modules'))).toBe(false)
  })
})
