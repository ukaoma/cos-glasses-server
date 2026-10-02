import { afterAll, describe, expect, it } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeDiarizer,
  modelsDirComplete,
  nemotronModelSource,
  prepareNemotronModelsDir,
  requestedDiarizer,
} from './diarizer-backend.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function home(options: { cli?: boolean; cache?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'diarizer-home-'))
  roots.push(dir)
  if (options.cli) {
    mkdirSync(join(dir, '.cos-glasses', 'bin'), { recursive: true })
    writeFileSync(join(dir, '.cos-glasses', 'bin', 'fluidaudiocli'), '')
  }
  if (options.cache) {
    const cache = join(dir, 'Library', 'Application Support', 'FluidAudio', 'Models', 'nemotron-3-diarization')
    mkdirSync(join(cache, 'monolithic', 'v2', 'Nemotron3Diarizer_fast32.mlmodelc'), { recursive: true })
    writeFileSync(join(cache, 'monolithic', 'v2', 'Nemotron3Diarizer_fast32.mlmodelc', 'coremldata.bin'), 'x')
    writeFileSync(join(cache, 'learnable_sil_emb.bin'), 'x')
  }
  return dir
}

describe('requestedDiarizer', () => {
  it('defaults to nemotron', () => {
    expect(requestedDiarizer({})).toBe('nemotron')
  })

  it('accepts the voiceprint aliases', () => {
    expect(requestedDiarizer({ COS_DIARIZER: 'embedding' })).toBe('embedding')
    expect(requestedDiarizer({ COS_DIARIZER: 'eres2net' })).toBe('embedding')
    expect(requestedDiarizer({ COS_DIARIZER: 'voiceprint' })).toBe('embedding')
  })

  it('treats an unknown value as nemotron', () => {
    expect(requestedDiarizer({ COS_DIARIZER: 'sortformer' })).toBe('nemotron')
  })
})

describe('activeDiarizer', () => {
  it('stays on the voiceprint when that is requested', () => {
    expect(activeDiarizer({ COS_DIARIZER: 'embedding' }, home({ cli: true, cache: true }))).toEqual({
      requested: 'embedding',
      active: 'embedding',
      fallback: null,
    })
  })

  it('falls back when Nemotron is requested and the CLI is missing', () => {
    expect(activeDiarizer({ COS_DIARIZER: 'nemotron', COS_NEMOTRON_CLI: '/no/such/fluidaudiocli' }, home({ cache: true }))).toEqual({
      requested: 'nemotron',
      active: 'embedding',
      fallback: 'cli_missing',
    })
  })

  it('falls back when the CLI exists but no local models do (it would download them)', () => {
    expect(activeDiarizer({ COS_DIARIZER: 'nemotron' }, home({ cli: true }))).toEqual({
      requested: 'nemotron',
      active: 'embedding',
      fallback: 'models_missing',
    })
  })

  it('uses Nemotron when the CLI and the local models exist', () => {
    expect(activeDiarizer({ COS_DIARIZER: 'nemotron' }, home({ cli: true, cache: true }))).toEqual({
      requested: 'nemotron',
      active: 'nemotron',
      fallback: null,
    })
  })
})

describe('the --models directory (offline by construction)', () => {
  it('links the FluidAudio cache into one directory the CLI can load without downloading', () => {
    const dir = home({ cli: true, cache: true })
    expect(nemotronModelSource({}, dir)).toMatchObject({ source: 'fluidaudio-cache' })
    const models = prepareNemotronModelsDir({}, dir)!
    expect(models).toBe(join(dir, '.cos-glasses', 'models', 'nemotron-3-diarization'))
    expect(modelsDirComplete(models)).toBe(true)
    expect(lstatSync(join(models, 'learnable_sil_emb.bin')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(models, 'Nemotron3Diarizer_fast32.mlmodelc'))).toContain(join('monolithic', 'v2'))
    expect(nemotronModelSource({}, dir)).toMatchObject({ source: 'cos' })
    // Idempotent.
    expect(prepareNemotronModelsDir({}, dir)).toBe(models)
  })

  it('an explicit COS_NEMOTRON_MODELS that is incomplete is not replaced by another copy', () => {
    const dir = home({ cli: true, cache: true })
    const env = { COS_NEMOTRON_MODELS: join(dir, 'elsewhere') }
    expect(nemotronModelSource(env, dir)).toBeNull()
    expect(prepareNemotronModelsDir(env, dir)).toBeNull()
    expect(activeDiarizer({ ...env, COS_DIARIZER: 'nemotron' }, dir).fallback).toBe('models_missing')
  })
})

describe('the managed runtime contract', () => {
  it('lists the diarizer settings so a managed install can carry them', async () => {
    const { readFileSync } = await import('node:fs')
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    for (const key of ['COS_DIARIZER', 'COS_NEMOTRON_CLI', 'COS_NEMOTRON_MODELS']) expect(contract.optionalEnvironment, key).toContain(key)
  })
})
