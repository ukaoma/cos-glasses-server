import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let root = ''

async function loadProfile(profile: Record<string, unknown>) {
  root = mkdtempSync(join(tmpdir(), 'cos-profile-transcription-'))
  const path = join(root, '.cos-profile.json')
  writeFileSync(path, JSON.stringify(profile))
  process.env.COS_PROFILE_PATH = path
  vi.resetModules()
  return import('./profile.js')
}

describe('transcription profile safeguards', () => {
  afterEach(() => {
    delete process.env.COS_PROFILE_PATH
    vi.resetModules()
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  it('ignores every shipped placeholder instead of decoder-biasing toward it', async () => {
    const profile = await loadProfile({
      owner_name: 'Your Name',
      vocabulary: ['NameOne', 'NameTwo', 'YourCompany', 'ProductName'],
      whisper_corrections: '{"Soundalike":"YourName"}',
    })
    expect(profile.getOwnerName()).toBe('User')
    expect(profile.getVocabulary()).toEqual([])
    expect(profile.getWhisperCorrections()).toEqual({})
    expect(profile.getTranscriptionProfileStatus()).toEqual({
      configured: false,
      ownerConfigured: false,
      vocabularyTerms: 0,
      ignoredPlaceholderTerms: 4,
      ignoredPlaceholderCorrection: true,
    })
  })

  it('reports the safe starter profile as unconfigured until the user adds identity or vocabulary', async () => {
    const profile = await loadProfile({
      owner_name: 'User',
      vocabulary: [],
      whisper_corrections: '{}',
    })
    expect(profile.getOwnerName()).toBe('User')
    expect(profile.getTranscriptionProfileStatus()).toMatchObject({
      configured: false,
      ownerConfigured: false,
      vocabularyTerms: 0,
    })
  })

  it('trims, deduplicates, and keeps real names and corrections', async () => {
    const profile = await loadProfile({
      owner_name: ' Queen ',
      vocabulary: [' tacrolimus ', 'Tacrolimus', 'Ascension Seton', 42],
      whisper_corrections: { Takrelimus: 'tacrolimus' },
    })
    expect(profile.getOwnerName()).toBe('Queen')
    expect(profile.getVocabulary()).toEqual(['tacrolimus', 'Ascension Seton'])
    expect(profile.getWhisperCorrections()).toEqual({ Takrelimus: 'tacrolimus' })
    expect(profile.getTranscriptionProfileStatus()).toMatchObject({
      configured: true,
      ownerConfigured: true,
      vocabularyTerms: 2,
      ignoredPlaceholderTerms: 0,
    })
  })
})
