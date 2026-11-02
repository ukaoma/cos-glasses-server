// The real profile source of the general cues' name gate: the owner's profile through thunks, and every enrolled voice profile
// read from the speaker store (the store behind GET /api/voice/profiles), loaded on first use. This file has its own data home
// with a voice store in it; nothing here touches the user's.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'cues-general-names-'))
const prior = { data: process.env.COS_DATA_DIR, profile: process.env.COS_PROFILE_PATH }
process.env.COS_DATA_DIR = home
process.env.COS_PROFILE_PATH = join(home, 'profile.json')
writeFileSync(process.env.COS_PROFILE_PATH, JSON.stringify({ owner_name: 'Zephyrine Quillon', owner_speaker_label: 'ZQX', vocabulary: ['Frobnitz Works'], domain_keywords: { quillco: ['Quillco'] } }))
writeFileSync(join(home, 'voice-profiles.json'), JSON.stringify({ profiles: [
  { name: 'Prunella Voss', embeddings: [[0.1, 0.2, 0.3]], sources: ['manual'] },
  { name: 'Thaddeus Orme', embeddings: [[0.3, 0.2, 0.1]], sources: ['manual'] },
] }))
const { realProfileNames, blockedNameWords, ownerTermPhrases } = await import('./live-cues-general-topic.js')

afterAll(() => {
  for (const [key, value] of [['COS_DATA_DIR', prior.data], ['COS_PROFILE_PATH', prior.profile]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  rmSync(home, { recursive: true, force: true })
})

describe('the real profile source', () => {
  it('reads the owner\'s profile through thunks, not at import', () => {
    expect(realProfileNames.ownerName()).toBe('Zephyrine Quillon')
    expect(realProfileNames.speakerLabel()).toBe('ZQX')
    expect(realProfileNames.vocabulary()).toEqual(['Frobnitz Works'])
    expect(realProfileNames.domainKeywords()).toEqual({ quillco: ['Quillco'] })
    expect(ownerTermPhrases()).toEqual([['frobnitz', 'work'], ['quillco']])
  })
  it('reads every enrolled voice profile name from the speaker store', async () => {
    expect(await realProfileNames.voiceProfileNames!()).toEqual(['Prunella Voss', 'Thaddeus Orme'])
  })
  it('blocks every word of those names, the owner and the label with the real source', async () => {
    const names = await blockedNameWords('', [], realProfileNames)
    for (const w of ['prunella', 'voss', 'thaddeus', 'orme', 'zephyrine', 'quillon', 'zqx']) expect(names, w).toContain(w)
  })
})
