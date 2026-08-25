import { describe, expect, it } from 'vitest'
import {
  checkSpeakerName,
  MAX_SPEAKER_NAME_CHARS,
  MAX_SPEAKER_NAME_WORDS,
} from './speaker-name.js'

// Chelsie Hodgkiss, first-time user, 2026-08-25: saying "enroll my voice" and
// continuing to talk wrote the whole ~40s transcript in as the profile name.
const CHELSIE_UTTERANCE =
  'My Voice. Okay So I Am Just Going To Read Something Aloud Here For About '
  + 'Thirty Seconds So The System Can Hear What I Sound Like Naturally'

describe('checkSpeakerName', () => {
  it('accepts ordinary names', () => {
    for (const name of ['Chelsie', 'Miles Ukaoma', 'Maria del Carmen Ruiz', "O'Brien", 'Jean-Luc', 'MU', 'Renée']) {
      expect(checkSpeakerName(name), name).toMatchObject({ ok: true })
    }
  })

  it('REJECTS the reported 40-second transcript', () => {
    const result = checkSpeakerName(CHELSIE_UTTERANCE)
    expect(result.ok).toBe(false)
    // It trips the leading-word rule before the length rule. Either would
    // reject it; assert the rejection, not the order the rules happen to run.
    expect(result.reason).toBe('self_referential')
  })

  it('REJECTS a long transcript that does NOT start with a self word', () => {
    const spoken = 'Okay so I am just going to read something aloud here for thirty seconds'
    expect(checkSpeakerName(spoken)).toMatchObject({ ok: false, reason: 'too_long' })
  })

  it('rejects a short phrase that clears every length and character bound', () => {
    // 3 words, 15 chars, letters only — the LEADING word is the only tell.
    expect(checkSpeakerName('My Voice Please')).toMatchObject({
      ok: false, reason: 'self_referential',
    })
    expect(checkSpeakerName('My name is')).toMatchObject({ ok: false })
    // A real name that merely CONTAINS one of those letters is unaffected.
    expect(checkSpeakerName('Mya Johnson')).toMatchObject({ ok: true })
    expect(checkSpeakerName('Melissa')).toMatchObject({ ok: true })
  })

  it('rejects a sentence that keeps its punctuation', () => {
    expect(checkSpeakerName('Chelsie, can you hear')).toMatchObject({
      ok: false, reason: 'sentence_like',
    })
  })

  it('rejects self-referential words with a message pointing at the right command', () => {
    for (const word of ['my', 'me', 'voice', 'voiceprint', 'my voice']) {
      const result = checkSpeakerName(word)
      expect(result.ok, word).toBe(false)
      expect(result.reason, word).toBe('self_referential')
    }
    expect(checkSpeakerName('my voice').message).toContain('enroll my voice')
  })

  it('ALWAYS accepts the owner label, including the default "Me"', () => {
    // profile.ts:104 defaults owner_speaker_label to 'Me', which is itself in
    // the self-referential list. Rejecting it would break self-enrolment for
    // every default install.
    expect(checkSpeakerName('Me', { ownerLabel: 'Me' })).toMatchObject({ ok: true })
    expect(checkSpeakerName('me', { ownerLabel: 'Me' })).toMatchObject({ ok: true })
    expect(checkSpeakerName('MU', { ownerLabel: 'MU' })).toMatchObject({ ok: true })
    // ...but only when it IS the owner label.
    expect(checkSpeakerName('Me', { ownerLabel: 'MU' })).toMatchObject({ ok: false })
  })

  it('rejects empty and whitespace', () => {
    for (const value of ['', '   ', undefined, null]) {
      expect(checkSpeakerName(value as string).reason).toBe('empty')
    }
  })

  it('enforces the stated bounds exactly', () => {
    expect(checkSpeakerName('a'.repeat(MAX_SPEAKER_NAME_CHARS))).toMatchObject({ ok: true })
    expect(checkSpeakerName('a'.repeat(MAX_SPEAKER_NAME_CHARS + 1))).toMatchObject({
      ok: false, reason: 'too_long',
    })
    const atLimit = Array.from({ length: MAX_SPEAKER_NAME_WORDS }, () => 'Ab').join(' ')
    expect(checkSpeakerName(atLimit)).toMatchObject({ ok: true })
    expect(checkSpeakerName(`${atLimit} Ab`)).toMatchObject({ ok: false, reason: 'too_many_words' })
  })

  it('rejects digits and symbols', () => {
    for (const bad of ['Agent 47', 'user@host', 'Bob<script>', '123']) {
      expect(checkSpeakerName(bad), bad).toMatchObject({ ok: false })
    }
  })
})
