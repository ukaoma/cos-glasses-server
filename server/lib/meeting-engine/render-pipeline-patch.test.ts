// The pipeline patch: what apply mode ADDS to a scribe the pipeline already wrote.
//
// Synthetic fixtures only. The patch is the thing that decides what lands in a person's
// operations tree, so what it must NOT contain is tested as hard as what it must.

import { describe, expect, it } from 'vitest'
import {
  MARKER_BLENDED,
  MARKER_G2_SESSION_PREFIX,
  MARKER_G2_SOURCE_PREFIX,
  MARKER_MERGE_ACTION_PREFIX,
  PIPELINE_SOURCES_LABEL,
  SPEAKER_MAP_MIN_SENTENCES,
  SPEAKER_MAP_MIN_SHARE,
  g2SourceMarker,
  renderMergedRecord,
  renderPipelinePatch,
  speakerMapFrom,
} from './render.js'
import type { SentenceLabel } from './attribute.js'
import { firefliesMeeting, g2Capture, matchingPair, phrase } from './__fixtures__/synthetic.js'

const ACTION = 'a_0123456789abcdef'

function label(overrides: Partial<SentenceLabel>): SentenceLabel {
  return {
    index: 0,
    ffLabel: 'Speaker 1',
    g2Label: 'Nadia Okonkwo',
    resolvedLabel: 'Nadia Okonkwo',
    share: 0.9,
    similarity: 0.8,
    windowOffsetMs: 0,
    outcome: 'replaced_generic',
    humanConfirmed: false,
    ...overrides,
  }
}

describe('what the patch adds', () => {
  const pair = matchingPair({ k: 40 })

  it('emits the sections the pipeline splices before the transcript', () => {
    const patch = renderPipelinePatch({
      actionId: ACTION,
      tier: 'auto',
      primary: pair.meeting,
      captures: [pair.capture],
      evidence: { k1: 40, k2: 0 },
    })
    expect(patch.sections.join('\n')).toContain('## G2 Capture')
  })

  it('emits an Alternate Transcript section only when there is a duplicate recording', () => {
    const base = { actionId: ACTION, tier: 'auto' as const, primary: pair.meeting, captures: [pair.capture], evidence: { k1: 40, k2: 0 } }
    expect(renderPipelinePatch(base).sections.join('\n')).not.toContain('## Alternate Transcript')
    const alternate = firefliesMeeting({ id: 'f2', startMs: pair.meeting.startMs, durationS: 1800, phrases: [phrase('altw', 6, 60)] })
    expect(renderPipelinePatch({ ...base, alternates: [alternate] }).sections.join('\n')).toContain('## Alternate Transcript')
  })

  it('writes the Sources row in the form the private blend already writes', () => {
    // The pipeline's own blend writes `Fireflies + G2 Glasses`. A merged scribe has to be
    // indistinguishable from a hand-blended one to every existing reader of that row.
    const patch = renderPipelinePatch({ actionId: ACTION, tier: 'auto', primary: pair.meeting, captures: [pair.capture], evidence: { k1: 40, k2: 0 } })
    expect(patch.rows[0]).toBe(`| **Sources** | ${PIPELINE_SOURCES_LABEL} |`)
    expect(PIPELINE_SOURCES_LABEL).toBe('Fireflies + G2 Glasses')
  })

  it('writes a Speaker Verification row, saying none when nothing was verified', () => {
    const quiet = g2Capture({ sessionId: 's-quiet', startMs: pair.meeting.startMs, durationMs: 1800_000, phrases: pair.phrases, offsetMs: 0, labels: [] })
    const patch = renderPipelinePatch({ actionId: ACTION, tier: 'auto', primary: pair.meeting, captures: [quiet], evidence: { k1: 40, k2: 0 } })
    expect(patch.rows[1]).toBe('| **Speaker Verification** | none |')
  })

  it('stamps the blend marker, the merge-action marker, and one pair per capture', () => {
    const second = g2Capture({ sessionId: 's2', startMs: pair.meeting.startMs + 60_000, durationMs: 600_000, phrases: pair.phrases, offsetMs: 0 })
    const patch = renderPipelinePatch({
      actionId: ACTION,
      tier: 'auto',
      primary: pair.meeting,
      captures: [pair.capture, second],
      evidence: { k1: 40, k2: 0 },
      sidecarRelPathBySession: { s1: 'personal/meetings/2026-08/a.g2-chunks.json', s2: 'personal/meetings/2026-08/b.g2-chunks.json' },
    })
    expect(patch.markers[0]).toBe(MARKER_BLENDED)
    // The BASENAME, not the relative path: the pipeline writes the basename and compares
    // what it finds against what it would write.
    expect(patch.markers).toContain(`${MARKER_G2_SOURCE_PREFIX}a.g2-chunks.json -->`)
    expect(patch.markers).not.toContain(`${MARKER_G2_SOURCE_PREFIX}personal/meetings/2026-08/a.g2-chunks.json -->`)
    expect(patch.markers).toContain(`${MARKER_G2_SESSION_PREFIX}s1 -->`)
    expect(patch.markers).toContain(`${MARKER_G2_SESSION_PREFIX}s2 -->`)
    expect(patch.markers[patch.markers.length - 1]).toBe(`${MARKER_MERGE_ACTION_PREFIX}${ACTION} -->`)
  })

  // The pipeline's `g2_source_marker()` is `sidecar_path.name.replace('--', '- -')` wrapped
  // in a comment. These cases are the whole of that contract, byte for byte, because the
  // pipeline compares the marker it READS against the marker it would WRITE: a form that
  // differs by one character reads as "another tool wrote this" and `blend_verified` fails.
  it.each([
    ['personal/meetings/2026-08/a.g2-chunks.json', '<!-- g2-source: a.g2-chunks.json -->'],
    ['a.g2-chunks.json', '<!-- g2-source: a.g2-chunks.json -->'],
    // `--` cannot appear inside an HTML comment; the pipeline escapes it to hyphen-space-hyphen.
    ['quilt/meetings/2026-08/2026-08-20_Q3--review.g2-chunks.json', '<!-- g2-source: 2026-08-20_Q3- -review.g2-chunks.json -->'],
    // `str.replace` is non-overlapping on both sides, so four hyphens give exactly two escapes.
    ['x----y.g2-chunks.json', '<!-- g2-source: x- -- -y.g2-chunks.json -->'],
  ])('writes %s as the pipeline writes it', (relPath, expected) => {
    expect(g2SourceMarker(relPath)).toBe(expected)
    expect(g2SourceMarker(relPath)).not.toContain('-->'.repeat(2))
  })

  it('carries the basename through renderPipelinePatch, not just the helper', () => {
    const patch = renderPipelinePatch({
      actionId: ACTION,
      tier: 'auto',
      primary: pair.meeting,
      captures: [pair.capture],
      evidence: { k1: 40, k2: 0 },
      sidecarRelPathBySession: { s1: 'quilt/meetings/2026-08/2026-08-20_Q3--review.g2-chunks.json' },
    })
    expect(patch.markers).toContain('<!-- g2-source: 2026-08-20_Q3- -review.g2-chunks.json -->')
  })

  /**
   * The property the escape EXISTS for, asserted rather than assumed.
   *
   * The four cases above pin the exact string, which is the right pin against the pipeline.
   * They do not say what makes that string correct: `--` cannot appear inside an HTML
   * comment. `plutil` accepts one, Python's `plistlib` and every strict parser reject the
   * whole document, and a scribe is read by more than one parser. This checks the COMMENT,
   * not the string: body between `<!--` and `-->`, no `--` anywhere in it, and exactly one
   * opener and one terminator.
   */
  it.each([
    ['a plain name', 'personal/meetings/2026-08/a.g2-chunks.json'],
    ['one double hyphen', 'quilt/meetings/2026-08/2026-08-20_Q3--review.g2-chunks.json'],
    ['a leading double hyphen', '--weekly.g2-chunks.json'],
    ['a trailing double hyphen before the close', 'weekly--.g2-chunks.json'],
    ['two separated double hyphens', 'a--b--c.g2-chunks.json'],
    ['a single hyphen, which needs no escape', '2026-08-20_Weekly.g2-chunks.json'],
    // ADVERSARIAL, and the only case where the early-termination assertion below can fail.
    // On a real sidecar name it cannot: the name always ends `.g2-chunks.json` and carries
    // no `>`, so asserting one terminator there is decoration. Here, dropping the escape
    // puts a literal `-->` inside the body and the comment closes early.
    ['a name containing a comment terminator', 'a-->b.g2-chunks.json'],
  ])('emits a well-formed HTML comment for %s', (_label, relPath) => {
    const marker = g2SourceMarker(relPath)
    expect(marker.startsWith('<!--')).toBe(true)
    expect(marker.endsWith('-->')).toBe(true)
    // ORDER MATTERS. The `--` check below is strictly stronger and would short-circuit this
    // one, so the terminator assertion would never actually run and could not fail. Asserted
    // FIRST, it is the thing the `a-->b` row exists to exercise: with the escape removed the
    // body holds a literal `-->` and the comment closes early, and this line goes red.
    expect(marker.split('-->')).toHaveLength(2)
    expect(marker.split('<!--')).toHaveLength(2)
    const body = marker.slice('<!--'.length, -'-->'.length)
    expect(body).not.toContain('--')
  })

  /**
   * A KNOWN LIMIT of the shared escape, pinned so it is visible rather than assumed fixed.
   *
   * `str.replace('--', '- -')` is NON-OVERLAPPING, on both sides of the boundary. Over a run
   * of three or more hyphens it therefore leaves a `--` behind: `x----y` becomes `x- -- -y`,
   * which still cannot appear inside an HTML comment.
   *
   * THE SERVER MUST NOT FIX THIS ALONE. The pipeline compares the marker it READS against
   * the marker it would WRITE (`sync_meetings.g2_source_marker()`), so a server that escaped
   * more thoroughly would write a marker the pipeline reads as another tool's — which is the
   * exact failure the basename change was made to end. Closing it means changing both sides
   * in one step, and a committed fixture on the pipeline side pins one of these strings.
   *
   * REACHABLE BY CONSTRUCTION, not merely unobserved. The pipeline's
   * `scribe_generator.sanitize_filename` strips only `<>:"/\|?*` and collapses whitespace;
   * it never touches hyphens. `Roadmap---Final` survives into the scribe stem and from there
   * into this basename, and that is a title someone types meaning a separator.
   *
   * WHY IT IS STILL SAFE. Every reader of this marker on both sides is a SUBSTRING test
   * (`sync_meetings.py:1589`, `:1613`, `:2806`, `g2_blend_backfill.py:221`), and the server
   * never reads `g2-source` back at all. No HTML parser touches it, and the escape always
   * breaks up `-->`, so the comment can never terminate early. The damage is a technically
   * malformed comment that nothing in the system objects to.
   */
  it.each([
    ['three hyphens', 'x---y.g2-chunks.json', '<!-- g2-source: x- --y.g2-chunks.json -->'],
    ['four hyphens', 'x----y.g2-chunks.json', '<!-- g2-source: x- -- -y.g2-chunks.json -->'],
    ['five hyphens', 'x-----y.g2-chunks.json', '<!-- g2-source: x- -- --y.g2-chunks.json -->'],
  ])('matches the pipeline byte for byte on %s, and still leaves a -- in the body', (_label, relPath, expected) => {
    const marker = g2SourceMarker(relPath)
    // Parity with the pipeline is the contract, and it holds.
    expect(marker).toBe(expected)
    // The comment is NOT well formed, and saying so is the point of this test.
    expect(marker.slice('<!--'.length, -'-->'.length)).toContain('--')
    // It still cannot terminate the comment early, which is the damage that would matter.
    expect(marker.split('-->')).toHaveLength(2)
  })

  it('still declares every session when no sidecar path is known', () => {
    // The `g2-session` marker is what WS5's list and `findCosOperationsMeetingBySessionId`
    // read to resolve speaker review on a merged scribe. Losing it because a sidecar path
    // was unavailable would silently take speaker review away from that meeting.
    const patch = renderPipelinePatch({ actionId: ACTION, tier: 'auto', primary: pair.meeting, captures: [pair.capture], evidence: { k1: 40, k2: 0 } })
    expect(patch.markers).toContain(`${MARKER_G2_SESSION_PREFIX}s1 -->`)
    expect(patch.markers.some(marker => marker.startsWith(MARKER_G2_SOURCE_PREFIX))).toBe(false)
  })
})

describe('what the patch must NOT contain', () => {
  const pair = matchingPair({ k: 40 })
  const patch = renderPipelinePatch({
    actionId: ACTION,
    tier: 'auto',
    primary: firefliesMeeting({
      id: 'f1',
      startMs: pair.meeting.startMs,
      durationS: 1800,
      phrases: pair.phrases,
      title: 'Quarterly planning',
      summary: 'A summary the pipeline wrote',
      actionItems: ['An item the pipeline extracted'],
      participants: ['Nadia Okonkwo'],
    }),
    captures: [pair.capture],
    evidence: { k1: 40, k2: 0 },
  })
  const everything = [...patch.sections, ...patch.rows, ...patch.markers].join('\n')

  // v3 blocker 11: the scribe being patched is RICHER than anything this module renders.
  // Emitting a title, summary, action items or the Fireflies transcript would give the
  // pipeline material to overwrite them with.
  it.each([
    ['a title', '# Quarterly planning'],
    ['a summary section', '## Summary'],
    ['an action items section', '## Action Items'],
    ['an attendees section', '## Attendees'],
    ['a transcript section', '## Transcript'],
    ['a Sources table', '| Role | Kind | Id |'],
    ['a Date row', '| **Date** |'],
    ['a Domain row', '| **Domain** |'],
  ])('never emits %s', (_label, needle) => {
    expect(everything).not.toContain(needle)
  })

  it('emits strictly less than the whole merged record does', () => {
    const whole = renderMergedRecord({ actionId: ACTION, tier: 'auto', primary: pair.meeting, captures: [pair.capture], evidence: { k1: 40, k2: 0 } })
    expect(whole.ok).toBe(true)
    if (!whole.ok) return
    expect(everything.length).toBeLessThan(whole.record.markdown.length)
  })
})

describe('the speaker map', () => {
  it('maps a generic label held outright by one G2 name', () => {
    const labels = Array.from({ length: 10 }, (_, index) => label({ index, similarity: 0.8 }))
    expect(speakerMapFrom(labels)).toEqual({ 'Speaker 1': { name: 'Nadia Okonkwo', similarity: 0.8, sentences: 10 } })
  })

  it('never maps a label that already names a person', () => {
    // D13: a voiceprint does not overwrite a name a person or a calendar gave. The map is
    // applied to EVERY line carrying the label, so mapping a real name would rewrite lines
    // no capture ever covered.
    const labels = Array.from({ length: 10 }, (_, index) => label({ index, ffLabel: 'Priya Raghunathan' }))
    expect(speakerMapFrom(labels)).toEqual({})
  })

  it('refuses below the sentence floor even at complete agreement', () => {
    // LITERALS, not `SPEAKER_MAP_MIN_SENTENCES - 1`. A count derived from the constant
    // moves with it, so lowering the floor to 1 would still pass: the mutation gate found
    // exactly that and the test proved nothing about the number.
    expect(SPEAKER_MAP_MIN_SENTENCES).toBe(5)
    expect(speakerMapFrom(Array.from({ length: 4 }, (_, index) => label({ index })))).toEqual({})
    expect(Object.keys(speakerMapFrom(Array.from({ length: 5 }, (_, index) => label({ index }))))).toEqual(['Speaker 1'])
  })

  it('refuses below the share floor', () => {
    // 6 of 10 is 0.6, under 0.7. 7 of 10 is exactly the floor and is allowed.
    const six = Array.from({ length: 10 }, (_, index) => label({ index, ...(index < 6 ? {} : { g2Label: null }) }))
    expect(speakerMapFrom(six)).toEqual({})
    const seven = Array.from({ length: 10 }, (_, index) => label({ index, ...(index < 7 ? {} : { g2Label: null }) }))
    expect(Object.keys(speakerMapFrom(seven))).toEqual(['Speaker 1'])
    expect(SPEAKER_MAP_MIN_SHARE).toBe(0.7)
  })

  it('refuses when two names both claim the label', () => {
    // A generic label two people share is a label no single name may be written onto.
    const labels = [
      ...Array.from({ length: 8 }, (_, index) => label({ index })),
      ...Array.from({ length: 8 }, (_, index) => label({ index: index + 8, g2Label: 'Tobias Lindqvist' })),
    ]
    expect(speakerMapFrom(labels)).toEqual({})
  })

  it('ignores a generic G2 winner', () => {
    const labels = Array.from({ length: 10 }, (_, index) => label({ index, g2Label: 'Speaker 2' }))
    expect(speakerMapFrom(labels)).toEqual({})
  })

  it('reports the median similarity, not the best one', () => {
    const labels = Array.from({ length: 5 }, (_, index) => label({ index, similarity: [0.6, 0.7, 0.8, 0.9, 0.99][index] }))
    expect(speakerMapFrom(labels)['Speaker 1'].similarity).toBe(0.8)
  })

  it('is deterministic in key order', () => {
    const labels = [
      ...Array.from({ length: 6 }, (_, index) => label({ index, ffLabel: 'Speaker 2', g2Label: 'Tobias Lindqvist' })),
      ...Array.from({ length: 6 }, (_, index) => label({ index: index + 6 })),
    ]
    expect(Object.keys(speakerMapFrom(labels))).toEqual(['Speaker 1', 'Speaker 2'])
  })
})
