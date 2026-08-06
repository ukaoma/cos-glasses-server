// The rewrite primitive, exercised on content shaped like the real files.
//
// The fixtures below copy the actual formats verified on disk: a sidecar with
// `schemaVersion`/`speakers`/`chunks`, and a scribe with `## Attendees` bullets,
// LLM prose that names people by bare first name, and `[Name]:` transcript
// turns. A fixture that drifts from the real format is a test that proves
// nothing about production files.
import { describe, expect, it } from 'vitest'
import {
  detectProseReferences,
  invalidLabelReason,
  relabelMeetingMarkdown,
  relabelSidecarJson,
} from './meeting-relabel.js'

function sidecar(speakers: string[], labels: string[]): string {
  return JSON.stringify({
    schemaVersion: 2,
    sessionId: 'meeting_1786027607017_wq149x',
    startTime: 1786027607017,
    durationMs: 807222,
    canonicalProvider: 'server-whisper',
    speakers,
    chunks: labels.map((speaker, i) => ({
      text: `line ${i}`,
      speaker,
      elapsed: i * 6000,
      similarity: 0.7,
      words: [{ word: ' line', start: 0, end: 0.4, probability: 0.9 }],
    })),
  }, null, 2)
}

const SCRIBE = `# Health Score V2 Model Rebuild (G2)

| Field | Value |
|-------|-------|
| **Date** | 2026-08-06 09:46 |

## Attendees

- Luke H
- Chris Krubeck
- MU

## Summary

Luke H walked through the rebuild while Chris raised Beamer sentiment. Luke also
asked about device event logs.

## Decisions Made

- Luke H owns the back-test.

## Transcript

<details>
<summary>Click to expand transcript</summary>

[Luke H]: Engineering the back end with Tableau and the offshore team.
[Chris Krubeck]: I'd add gatekeeper as well.
[Luke H]: Right, and the model washer of all the infrastructure.
[MU]: Let's take that offline. Luke H can own the write-up.

</details>
`

describe('label validation', () => {
  it('rejects labels that would corrupt the file formats', () => {
    // `[Name]:` and `- Name` are the delimiters the files' own readers use.
    expect(invalidLabelReason('Luke]: fake')).toMatch(/bracket/)
    expect(invalidLabelReason('two\nlines')).toMatch(/bracket or newline/)
    expect(invalidLabelReason('')).toMatch(/empty/)
    expect(invalidLabelReason('  padded  ')).toMatch(/whitespace/)
    expect(invalidLabelReason('x'.repeat(121))).toMatch(/longer than/)
  })

  it('accepts real names, including ones with regex-special characters', () => {
    expect(invalidLabelReason('Luke Henry')).toBeNull()
    expect(invalidLabelReason('Luke H.')).toBeNull()      // a dot is a regex wildcard
    expect(invalidLabelReason("O'Brien (Ops)")).toBeNull()
    expect(invalidLabelReason('MU')).toBeNull()
  })
})

describe('relabelling sidecar chunks', () => {
  it('changes every chunk carrying the label when no subset is named', () => {
    const raw = sidecar(['Luke H', 'MU'], ['Luke H', 'MU', 'Luke H', 'Luke H'])
    const r = relabelSidecarJson(raw, 'Luke H', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.changed).toEqual([0, 2, 3])
    expect(r.value.coveredAllWithLabel).toBe(true)
    expect(r.value.remainingWithFrom).toBe(0)
    const doc = JSON.parse(r.value.json)
    expect(doc.chunks.map((c: { speaker: string }) => c.speaker)).toEqual(['Luke Henry', 'MU', 'Luke Henry', 'Luke Henry'])
  })

  it('changes ONLY the named chunks for a partial correction', () => {
    // The whole reason corrections are per-meeting: the identifier can be wrong
    // about one stretch without being wrong about the rest.
    const raw = sidecar(['Luke H', 'MU'], ['Luke H', 'MU', 'Luke H', 'Luke H'])
    const r = relabelSidecarJson(raw, 'Luke H', 'Luke Henry', [0, 2])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.changed).toEqual([0, 2])
    expect(r.value.remainingWithFrom).toBe(1)
    // The gate for the markdown rewrite. A partial relabel must NOT be applied
    // to the transcript, because turn indices do not match chunk indices.
    expect(r.value.coveredAllWithLabel).toBe(false)
    expect(JSON.parse(r.value.json).chunks.map((c: { speaker: string }) => c.speaker))
      .toEqual(['Luke Henry', 'MU', 'Luke Henry', 'Luke H'])
  })

  it('preserves every other field on a chunk it rewrites', () => {
    const raw = sidecar(['MU'], ['MU'])
    const r = relabelSidecarJson(raw, 'MU', 'Miles Ukaoma')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = JSON.parse(r.value.json).chunks[0]
    expect(c).toMatchObject({ text: 'line 0', elapsed: 0, similarity: 0.7 })
    expect(c.words).toHaveLength(1)   // word timings survive
  })

  it('preserves the document metadata and the pipeline write format', () => {
    const raw = sidecar(['MU'], ['MU'])
    const r = relabelSidecarJson(raw, 'MU', 'Miles Ukaoma')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(JSON.parse(r.value.json)).toMatchObject({
      schemaVersion: 2, sessionId: 'meeting_1786027607017_wq149x', durationMs: 807222,
      canonicalProvider: 'server-whisper',
    })
    // 2-space indent + trailing newline, matching durableAtomicWriteFileSync's
    // existing sidecar writes. A format change would show as a whole-file diff.
    expect(r.value.json.endsWith('}\n')).toBe(true)
    expect(r.value.json).toContain('\n  "schemaVersion": 2')
  })

  describe('the top-level speakers list', () => {
    it('replaces the old name IN PLACE when it is fully retired', () => {
      const raw = sidecar(['Anand', 'Luke H', 'MU'], ['Luke H'])
      const r = relabelSidecarJson(raw, 'Luke H', 'Luke Henry')
      expect(r.ok).toBe(true)
      if (!r.ok) return
      // Ordering preserved rather than moving the person to the end — the panel
      // and attendee renderer read this list in order.
      expect(r.value.speakers).toEqual(['Anand', 'Luke Henry', 'MU'])
    })

    it('keeps the old name when a partial relabel leaves chunks behind', () => {
      const raw = sidecar(['Luke H'], ['Luke H', 'Luke H'])
      const r = relabelSidecarJson(raw, 'Luke H', 'Luke Henry', [0])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      // Both are genuinely attributed now, so both must be listed.
      expect(r.value.speakers).toEqual(['Luke H', 'Luke Henry'])
    })

    it('does not duplicate a name that is already listed', () => {
      const raw = sidecar(['Luke H', 'Luke Henry'], ['Luke H', 'Luke Henry'])
      const r = relabelSidecarJson(raw, 'Luke H', 'Luke Henry')
      expect(r.ok).toBe(true)
      if (!r.ok) return
      // Merging a split identity: the old label disappears, no duplicate appears.
      expect(r.value.speakers).toEqual(['Luke Henry'])
    })

    it('adds the new name when the sidecar has no speakers list at all', () => {
      const doc = JSON.parse(sidecar([], ['Ext'])) as Record<string, unknown>
      delete doc.speakers
      const r = relabelSidecarJson(JSON.stringify(doc, null, 2), 'Ext', 'Luke Henry')
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.value.speakers).toEqual(['Luke Henry'])
    })
  })

  describe('refusing rather than doing something surprising', () => {
    it('refuses when no chunk carries the old label', () => {
      const r = relabelSidecarJson(sidecar(['MU'], ['MU']), 'Luke H', 'Luke Henry')
      expect(r).toEqual({ ok: false, error: 'no chunk carries "Luke H"' })
    })

    it('refuses when a named chunk does not carry the old label', () => {
      // A caller naming the wrong indices is confused about what it is
      // correcting. Silently relabelling nothing would look like success.
      const r = relabelSidecarJson(sidecar(['MU', 'Luke H'], ['MU', 'Luke H']), 'Luke H', 'Luke Henry', [0, 1])
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toContain('do not carry "Luke H"')
      expect(r.error).toContain('0')
    })

    it('refuses an out-of-range chunk index', () => {
      const r = relabelSidecarJson(sidecar(['Luke H'], ['Luke H']), 'Luke H', 'Luke Henry', [99])
      expect(r.ok).toBe(false)
    })

    it('refuses a no-op relabel', () => {
      expect(relabelSidecarJson(sidecar(['MU'], ['MU']), 'MU', 'MU'))
        .toEqual({ ok: false, error: 'from and to are the same label' })
    })

    it('refuses corrupt or unexpected sidecar content', () => {
      expect(relabelSidecarJson('{not json', 'a', 'b')).toEqual({ ok: false, error: 'sidecar is not valid JSON' })
      expect(relabelSidecarJson('[1,2,3]', 'a', 'b')).toEqual({ ok: false, error: 'sidecar is not an object' })
      expect(relabelSidecarJson('{"speakers":[]}', 'a', 'b')).toEqual({ ok: false, error: 'sidecar has no chunks array' })
    })

    it('refuses a label that would corrupt the transcript format', () => {
      const r = relabelSidecarJson(sidecar(['MU'], ['MU']), 'MU', 'Bad]: Name')
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toContain('to:')
    })

    it('survives a malformed chunk row without aborting the rest', () => {
      const doc = JSON.parse(sidecar(['Luke H'], ['Luke H', 'Luke H'])) as { chunks: unknown[] }
      doc.chunks.splice(1, 0, null)
      const r = relabelSidecarJson(JSON.stringify(doc, null, 2), 'Luke H', 'Luke Henry')
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.value.changed).toEqual([0, 2])
    })
  })
})

describe('relabelling the meeting markdown', () => {
  it('rewrites the attendee bullet and every transcript turn label', () => {
    const r = relabelMeetingMarkdown(SCRIBE, 'Luke H', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.attendees).toBe(1)
    expect(r.value.transcript).toBe(2)
    expect(r.value.markdown).toContain('- Luke Henry\n')
    expect(r.value.markdown).toContain('[Luke Henry]: Engineering the back end')
    expect(r.value.markdown).toContain('[Luke Henry]: Right, and the model washer')
    expect(r.value.markdown).not.toContain('[Luke H]:')
  })

  it('leaves a name SPOKEN inside a transcript turn alone', () => {
    // "Luke H can own the write-up" is a quote. Rewriting it would put words in
    // someone's mouth.
    const r = relabelMeetingMarkdown(SCRIBE, 'Luke H', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.markdown).toContain("[MU]: Let's take that offline. Luke H can own the write-up.")
  })

  it('NEVER rewrites narrative prose, and reports it as stale instead', () => {
    const r = relabelMeetingMarkdown(SCRIBE, 'Luke H', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Summary and Decisions still say the old name. Left alone on purpose.
    expect(r.value.markdown).toContain('Luke H walked through the rebuild')
    expect(r.value.markdown).toContain('- Luke H owns the back-test.')
    expect(r.value.proseStale).toBe(true)
    // Both forms reported: the full label AND the bare first name, which is the
    // form that makes a blind substitution dangerous.
    expect(r.value.proseHits).toContain('Luke H')
    expect(r.value.proseHits).toContain('Luke')
  })

  it('drops the old bullet instead of duplicating an attendee already listed', () => {
    const md = SCRIBE.replace('- Luke H\n', '- Luke H\n- Luke Henry\n')
    const r = relabelMeetingMarkdown(md, 'Luke H', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const attendees = r.value.markdown.split('## Summary')[0]
    expect(attendees.match(/^- Luke Henry$/gm)).toHaveLength(1)
    expect(attendees).not.toContain('- Luke H\n')
    expect(r.value.attendees).toBe(1)
  })

  it('does not touch an attendee bullet for a DIFFERENT person whose name extends the label', () => {
    // 'Luke H' must not match '- Luke Henry'. This is the exact split-identity
    // pair from the live profile store, so a prefix match would silently merge
    // two people.
    const md = SCRIBE.replace('- Chris Krubeck', '- Luke Henry')
    const r = relabelMeetingMarkdown(md, 'Luke H', 'Chris Krubeck')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.markdown).toContain('- Luke Henry')
    expect(r.value.attendees).toBe(1)
  })

  it('does not touch a transcript label for a different person with a longer name', () => {
    const md = SCRIBE.replace('[Chris Krubeck]:', '[Luke Henry]:')
    const r = relabelMeetingMarkdown(md, 'Luke H', 'MU')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.markdown).toContain('[Luke Henry]: I\'d add gatekeeper')
    expect(r.value.transcript).toBe(2)   // the two [Luke H]: turns, not the [Luke Henry]: one
  })

  it('handles a name containing regex metacharacters literally', () => {
    const md = SCRIBE.replace(/Luke H/g, 'Luke H.')
    const r = relabelMeetingMarkdown(md, 'Luke H.', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.transcript).toBe(2)
    expect(r.value.attendees).toBe(1)
  })

  it('is a clean no-change when the label is absent', () => {
    const r = relabelMeetingMarkdown(SCRIBE, 'Nobody Here', 'Someone Else')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.markdown).toBe(SCRIBE)
    expect(r.value.attendees).toBe(0)
    expect(r.value.transcript).toBe(0)
  })

  it('works on a scribe with no Attendees section', () => {
    // Verified on disk: the 2026-08-05 $100M ARR scribe has Summary but no
    // Attendees section at all.
    const md = SCRIBE.replace(/## Attendees[\s\S]*?(?=## Summary)/, '')
    const r = relabelMeetingMarkdown(md, 'Luke H', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.attendees).toBe(0)
    expect(r.value.transcript).toBe(2)
  })

  it('works on a scribe with no Transcript section', () => {
    const md = SCRIBE.split('## Transcript')[0]
    const r = relabelMeetingMarkdown(md, 'Luke H', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.attendees).toBe(1)
    expect(r.value.transcript).toBe(0)
  })

  it('ignores an INDENTED bullet — a sub-item is not an attendee line', () => {
    // Without the start anchor, `  - Luke H` under another attendee would be
    // rewritten as though it were its own attendee entry.
    // The indented bullet must carry NO trailing text: with trailing text the
    // `$` anchor already blocks the match, so such a fixture cannot tell an
    // anchored pattern from an unanchored one.
    const md = SCRIBE.replace('- Chris Krubeck', '- Chris Krubeck\n  - Luke H')
    const r = relabelMeetingMarkdown(md, 'Luke H', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.markdown).toContain('\n  - Luke H\n')
    expect(r.value.attendees).toBe(1)
  })

  it('ignores a label-shaped string INSIDE a spoken turn', () => {
    // Only a turn-initial `[Name]:` is a label. The same text mid-utterance is
    // something the speaker said, and rewriting it edits the record of speech.
    const md = SCRIBE.replace(
      "[MU]: Let's take that offline.",
      "[MU]: The log line read [Luke H]: ready, so take that offline.",
    )
    const r = relabelMeetingMarkdown(md, 'Luke H', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.markdown).toContain('read [Luke H]: ready')
    expect(r.value.transcript).toBe(2)   // the two real turns only
  })

  it('treats a dot in a name as a literal, not a wildcard', () => {
    // 'Luke H.' unescaped is the regex `Luke H<any char>`, which also matches
    // '- Luke Ho' — a different person silently relabelled.
    const md = SCRIBE.replace('- Chris Krubeck', '- Luke H.\n- Luke Ho')
    const r = relabelMeetingMarkdown(md, 'Luke H.', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.markdown).toContain('- Luke Ho')
    expect(r.value.markdown).toContain('- Luke Henry')
    expect(r.value.attendees).toBe(1)
  })

  it('confines the attendee rewrite to the Attendees section', () => {
    // A `- Luke H owns the back-test.` bullet lives under Decisions Made. It is
    // prose in list clothing and must not be treated as an attendee line.
    const r = relabelMeetingMarkdown(SCRIBE, 'Luke H', 'Luke Henry')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.markdown).toContain('- Luke H owns the back-test.')
  })
})

describe('detecting prose references', () => {
  it('ignores the attendee list and the transcript', () => {
    const md = `## Attendees\n\n- Luke H\n\n## Summary\n\nNothing about anyone.\n\n## Transcript\n\n[Luke H]: hello Luke H\n`
    expect(detectProseReferences(md, 'Luke H')).toEqual([])
  })

  it('finds the full label in prose', () => {
    const md = `## Attendees\n\n- Luke H\n\n## Summary\n\nLuke H owns it.\n`
    expect(detectProseReferences(md, 'Luke H')).toEqual(['Luke H', 'Luke'])
  })

  it('finds a bare first name even when the full label is absent', () => {
    const md = `## Attendees\n\n- Luke Henry\n\n## Summary\n\nLuke pushed back on the label.\n`
    expect(detectProseReferences(md, 'Luke Henry')).toEqual(['Luke'])
  })

  it('does not report a single-word label twice', () => {
    const md = `## Summary\n\nMU asked for the numbers.\n`
    expect(detectProseReferences(md, 'MU')).toEqual(['MU'])
  })

  it('does not match a name embedded in a longer word', () => {
    const md = `## Summary\n\nThe MUSIC vertical grew. Extension work continues.\n`
    expect(detectProseReferences(md, 'MU')).toEqual([])
    expect(detectProseReferences(md, 'Ext')).toEqual([])
  })
})
