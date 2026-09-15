import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DERIVED_DOMAIN,
  DERIVED_SIDECAR_VERSION,
  MERGED_SOURCE_LABEL,
  SPLIT_SOURCE_LABEL,
  fingerprintKey,
  renderMergedRecord,
  renderSplitPiece,
} from './render.js'
import { firefliesMeeting, g2Capture, phrase } from './__fixtures__/synthetic.js'

const START = Date.UTC(2026, 7, 20, 15, 0, 0)

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function scene() {
  const phrases = Array.from({ length: 10 }, (_, i) => ({ ...phrase(`p${i}`, 6, 100 + i * 10, 10), speaker: 'Speaker 1' }))
  const primary = firefliesMeeting({
    id: 'ff-primary',
    startMs: START,
    durationS: 1800,
    phrases,
    title: 'Quarterly review',
    participants: ['nadia@example.test'],
    summary: 'A synthetic summary.',
    actionItems: ['Send the synthetic follow-up'],
    sha256: 'ff-primary-sha',
  })
  const alternate = firefliesMeeting({
    id: 'ff-alternate',
    startMs: START + 60_000,
    durationS: 1800,
    phrases: [{ ...phrase('alt', 6, 120, 10), speaker: 'Marcus Bell' }],
    title: 'Quarterly review',
    sha256: 'ff-alternate-sha',
  })
  const capture = g2Capture({
    sessionId: 'g2-session',
    startMs: START,
    durationMs: 1_800_000,
    phrases,
    offsetMs: 0,
    labels: [{ speaker: 'Nadia Okonkwo', startS: 0, similarity: 0.72 }, { speaker: 'Closing Speaker', startS: 1000 }],
    sha256: 'g2-sha',
    correctionRevision: 4,
    batchApplied: true,
  })
  return { primary, alternate, capture }
}

function render(limits?: { markdownMaxBytes?: number; sidecarMaxBytes?: number }) {
  const { primary, alternate, capture } = scene()
  return renderMergedRecord({
    actionId: 'a_0123456789abcdef',
    tier: 'auto',
    primary,
    alternates: [alternate],
    captures: [capture],
    evidence: { k1: 120, k2: 4 },
    limits,
  })
}

describe('the merged record is additive', () => {
  it('holds every input\'s content', () => {
    const { primary, alternate, capture } = scene()
    const result = render()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const markdown = result.record.markdown
    for (const sentence of primary.sentences) expect(markdown).toContain(String(sentence.text))
    for (const sentence of alternate.sentences) expect(markdown).toContain(String(sentence.text))
    for (const chunk of capture.chunks ?? []) expect(markdown).toContain(String(chunk.text))
    expect(markdown).toContain('## G2 Capture')
    expect(markdown).toContain('## Alternate Transcript')
    expect(markdown).toContain(primary.summary!)
    expect(markdown).toContain(primary.actionItems![0])
  })

  it('names every source and its role, and ends with the transcript', () => {
    const result = render()
    if (!result.ok) throw new Error('expected a record')
    const markdown = result.record.markdown
    // Literals: these two strings are a contract with the meeting parsers and the list's
    // domain filter, so a test that echoes the constant pins nothing.
    expect(markdown).toContain('| **Source** | G2 Glasses + Fireflies |')
    expect(markdown).toContain('| **Domain** | imported |')
    expect(MERGED_SOURCE_LABEL).toBe('G2 Glasses + Fireflies')
    expect(DERIVED_DOMAIN).toBe('imported')
    expect(markdown).toContain('| Primary transcript | Fireflies | ff-primary |')
    expect(markdown).toContain('| Alternate transcript | Fireflies | ff-alternate |')
    expect(markdown).toContain('| Capture | G2 | g2-session |')
    expect(markdown.indexOf('## Transcript')).toBeGreaterThan(markdown.indexOf('## G2 Capture'))
    expect(markdown.trimEnd().lastIndexOf('## ')).toBe(markdown.indexOf('## Transcript'))
  })

  it('reports each name with its voice match and sentence count', () => {
    const result = render()
    if (!result.ok) throw new Error('expected a record')
    expect(result.record.markdown).toContain('| **Speaker Verification** | Nadia Okonkwo (voice match 0.72, 10 sentences) |')
    expect(result.record.verification[0]).toMatchObject({ name: 'Nadia Okonkwo', sentences: 10 })
  })

  it('applies the G2 name to the Fireflies transcript when it may', () => {
    const result = render()
    if (!result.ok) throw new Error('expected a record')
    const transcript = result.record.markdown.slice(result.record.markdown.indexOf('## Transcript'))
    expect(transcript).toContain('Nadia Okonkwo:')
    expect(transcript).not.toContain('Speaker 1:')
  })
})

describe('the sidecar', () => {
  it('carries the evidence, the fingerprints and every sentence decision', () => {
    const result = render()
    if (!result.ok) throw new Error('expected a record')
    const sidecar = result.record.sidecar
    expect(sidecar.version).toBe(1)
    expect(DERIVED_SIDECAR_VERSION).toBe(1)
    expect(sidecar.kind).toBe('merge')
    expect(sidecar.evidence).toEqual({ K1: 120, K2: 4 })
    expect(sidecar.attribution).toBe('aligned')
    expect(sidecar.labels).toHaveLength(10)
    expect(sidecar.labels[0]).toMatchObject({ index: 0, ffLabel: 'Speaker 1', g2Label: 'Nadia Okonkwo', outcome: 'replaced_generic' })
    expect(sidecar.inputs).toEqual([
      { kind: 'fireflies', id: 'ff-primary', sha256: 'ff-primary-sha' },
      { kind: 'fireflies', id: 'ff-alternate', sha256: 'ff-alternate-sha' },
      { kind: 'g2', id: 'g2-session', sha256: 'g2-sha', correctionRevision: 4, batchApplied: true },
    ])
  })

  it('changes its fingerprint key when a source changes, and not otherwise', () => {
    const result = render()
    if (!result.ok) throw new Error('expected a record')
    const inputs = result.record.sidecar.inputs
    const reordered = [inputs[2], inputs[0], inputs[1]]
    expect(fingerprintKey(reordered)).toBe(fingerprintKey(inputs))
    const relabelled = inputs.map(input => input.kind === 'g2' ? { ...input, correctionRevision: 5 } : input)
    expect(fingerprintKey(relabelled)).not.toBe(fingerprintKey(inputs))
  })
})

describe('re-derive', () => {
  it('produces the same bytes from the same inputs', () => {
    const first = render()
    const second = render()
    if (!first.ok || !second.ok) throw new Error('expected records')
    expect(second.record.markdown).toBe(first.record.markdown)
    expect(JSON.stringify(second.record.sidecar)).toBe(JSON.stringify(first.record.sidecar))
  })

  it('leaves its sources untouched', () => {
    const { primary, alternate, capture } = scene()
    const before = [sha(primary), sha(alternate), sha(capture)]
    renderMergedRecord({ actionId: 'a_1', tier: 'auto', primary, alternates: [alternate], captures: [capture], evidence: { k1: 1, k2: 0 } })
    expect([sha(primary), sha(alternate), sha(capture)]).toEqual(before)
  })
})

describe('size', () => {
  it('moves the attached transcripts into the sidecar rather than lose them', () => {
    const full = render()
    if (!full.ok) throw new Error('expected a record')
    const result = render({ markdownMaxBytes: Buffer.byteLength(full.record.markdown, 'utf8') - 100 })
    if (!result.ok) throw new Error('expected a record')
    expect(result.record.markdown).not.toContain('## G2 Capture')
    expect(result.record.markdown).toContain('## Attached Transcripts')
    expect(result.record.sidecar.overflow?.sections.join('')).toContain('## G2 Capture')
    expect(result.record.markdown).toContain('## Transcript')
  })

  it('fails loudly when even the transcript alone is too large', () => {
    const result = render({ markdownMaxBytes: 200 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('derived_too_large')
    expect(result.markdownBytes).toBeGreaterThan(200)
  })

  it('fails when the sidecar itself would be too large', () => {
    const result = render({ sidecarMaxBytes: 500 })
    expect(result.ok).toBe(false)
  })
})

describe('a split piece', () => {
  it('holds only its own stretch of the recording, plus its capture', () => {
    const { primary, capture } = scene()
    const result = renderSplitPiece({
      actionId: 'a_piece',
      tier: 'auto',
      source: primary,
      piece: { index: 1, startS: 150, endS: 200, kind: 'matched', sessionIds: ['g2-session'] },
      pieceCount: 3,
      captures: [capture],
    })
    if (!result.ok) throw new Error('expected a record')
    const markdown = result.record.markdown
    expect(markdown).toContain('(part 2 of 3)')
    expect(markdown).toContain('| **Source** | Fireflies (split) |')
    expect(SPLIT_SOURCE_LABEL).toBe('Fireflies (split)')
    expect(markdown).toContain(String(primary.sentences[5].text))
    expect(markdown).not.toContain(String(primary.sentences[0].text))
    expect(result.record.sidecar.kind).toBe('split')
    expect(result.record.sidecar.pieces).toHaveLength(1)
  })
})
