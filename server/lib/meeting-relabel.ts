// Rewriting a speaker label inside one meeting's files.
//
// Pure over strings: every function takes file content and returns file content,
// so each rule below is testable by execution rather than by reading it.
//
// THE CONSTRAINT THAT SHAPES THIS FILE. The markdown transcript is NOT an
// index-parallel rendering of the chunk sidecar. Measured on a real meeting
// (2026-08-06 Health Score V2): 135 sidecar chunks collapse to 46 speaker runs,
// while the markdown carries 70 turns — and they disagree on who spoke, with the
// markdown's 4th turn attributed to Joe Karbowski where the sidecar's 4th run
// says Richard Jenkins. The transcript was rendered from a different
// segmentation pass. So:
//
//   * There is NO mapping from a chunk index to a transcript turn.
//   * A relabel of EVERY chunk carrying a label can still be applied to the
//     markdown, because "all X becomes Y" needs no index alignment.
//   * A relabel of a SUBSET of chunks cannot touch the markdown transcript at
//     all. Rewriting by label would relabel turns the human never selected.
//
// `coveredAllWithLabel` on the sidecar result is how the caller knows which case
// it is. It is returned as DATA rather than left as a rule to remember.
//
// AND WHAT IS NEVER REWRITTEN: the Summary / Topics / Decisions / Action Items
// prose. It refers to people by bare first name — 6 of 12 speakers did so on the
// meeting above — and this org has two Kyles, two Jacobuses and two Chrises, so
// a first-name substitution in narrative text would rewrite sentences about
// somebody else. Reported as `proseStale` instead.

/** A label that would corrupt the file formats it gets written into. */
export function invalidLabelReason(label: string): string | null {
  if (label.trim() === '') return 'label is empty'
  if (label !== label.trim()) return 'label has leading or trailing whitespace'
  if (label.length > 120) return 'label is longer than 120 characters'
  // `[Name]:` delimits transcript turns and `- Name` delimits attendees; a
  // label containing these would make the file unparseable by its own readers.
  if (/[\[\]\n\r]/.test(label)) return 'label contains a bracket or newline'
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface SidecarRelabelResult {
  /** Serialized in the same shape the pipeline writes: 2-space indent, trailing newline. */
  json: string
  /** Chunk indices whose speaker actually changed. */
  changed: number[]
  /**
   * True when no chunk still carries `from` after this relabel. ONLY then may the
   * caller rewrite the markdown transcript by label. See the file header.
   */
  coveredAllWithLabel: boolean
  /** The top-level `speakers` array after the relabel. */
  speakers: string[]
  /** Chunks still carrying `from` — non-zero for a deliberate partial relabel. */
  remainingWithFrom: number
}

export type RelabelOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Relabel chunks in a `.g2-chunks.json` sidecar.
 *
 * `chunks` empty means every chunk carrying `from`. An explicit list restricts
 * the change to those indices — the partial case, which exists because the
 * identifier can mishear one stretch of a meeting without being wrong about the
 * rest.
 */
export function relabelSidecarJson(
  raw: string,
  from: string,
  to: string,
  chunks: number[] = [],
): RelabelOutcome<SidecarRelabelResult> {
  if (from === to) return { ok: false, error: 'from and to are the same label' }
  for (const [which, label] of [['from', from], ['to', to]] as const) {
    const bad = invalidLabelReason(label)
    if (bad) return { ok: false, error: `${which}: ${bad}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'sidecar is not valid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'sidecar is not an object' }
  }
  const doc = parsed as Record<string, unknown>
  const rows = doc.chunks
  if (!Array.isArray(rows)) return { ok: false, error: 'sidecar has no chunks array' }

  const restrict = chunks.length > 0 ? new Set(chunks) : null
  // A caller naming indices that do not carry `from` is confused about what it
  // is correcting; failing loudly beats silently relabelling nothing.
  if (restrict) {
    const mismatched = chunks.filter(i => {
      const row = rows[i]
      return !row || typeof row !== 'object' || (row as Record<string, unknown>).speaker !== from
    })
    if (mismatched.length > 0) {
      return { ok: false, error: `chunks do not carry "${from}": ${mismatched.slice(0, 8).join(', ')}` }
    }
  }

  const changed: number[] = []
  let remainingWithFrom = 0
  rows.forEach((row, i) => {
    // The `typeof` half guards the cast below rather than any behaviour — a
    // truthy non-object can never satisfy `.speaker === from`, so it is
    // deliberately not claimed as tested.
    if (!row || typeof row !== 'object') return
    const r = row as Record<string, unknown>
    if (r.speaker !== from) return
    if (restrict && !restrict.has(i)) { remainingWithFrom++; return }
    r.speaker = to
    changed.push(i)
  })

  if (changed.length === 0) return { ok: false, error: `no chunk carries "${from}"` }

  // Keep the top-level speaker list truthful: it is what the review panel and
  // the attendee renderer read, so a stale entry shows a person who is no longer
  // attributed anything.
  const existing = Array.isArray(doc.speakers) ? doc.speakers.filter((s): s is string => typeof s === 'string') : []
  const speakers = [...existing]
  if (!speakers.includes(to)) {
    // Replace in place when `from` is being fully retired, so the list keeps its
    // original ordering rather than moving the person to the end.
    const at = speakers.indexOf(from)
    if (at >= 0 && remainingWithFrom === 0) speakers[at] = to
    else speakers.push(to)
  } else if (remainingWithFrom === 0) {
    // `to` already listed and `from` fully retired — merging a split identity.
    // Drop the old entry rather than leaving a name nothing is attributed to.
    const at = speakers.indexOf(from)
    if (at >= 0) speakers.splice(at, 1)
  }
  doc.speakers = speakers

  return {
    ok: true,
    value: {
      json: `${JSON.stringify(doc, null, 2)}\n`,
      changed,
      coveredAllWithLabel: remainingWithFrom === 0,
      speakers,
      remainingWithFrom,
    },
  }
}

export interface MarkdownRelabelResult {
  markdown: string
  /** Attendee bullet lines changed or removed. */
  attendees: number
  /** `[Name]:` turn labels rewritten. */
  transcript: number
  /**
   * True when the old label still appears in narrative prose, which is left
   * untouched on purpose. The caller records this so a human can be told the
   * summary predates their correction.
   */
  proseStale: boolean
  /** The prose forms found, for an honest message rather than a bare boolean. */
  proseHits: string[]
}

/** Byte range of a `## Heading` section, or null when absent. */
function sectionRange(md: string, heading: string): { start: number; end: number } | null {
  const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm')
  const m = re.exec(md)
  if (!m) return null
  const start = m.index + m[0].length
  const next = /^##\s+/m.exec(md.slice(start))
  return { start, end: next ? start + next.index : md.length }
}

/**
 * Rewrite the structured label positions in a meeting markdown file.
 *
 * ONLY sound when every chunk carrying `from` is being relabelled — this works
 * by label, not by index, and the markdown's turn segmentation does not match
 * the sidecar's. See the file header.
 */
export function relabelMeetingMarkdown(
  md: string,
  from: string,
  to: string,
  options: { removeAttendee?: boolean } = {},
): RelabelOutcome<MarkdownRelabelResult> {
  if (from === to) return { ok: false, error: 'from and to are the same label' }
  for (const [which, label] of [['from', from], ['to', to]] as const) {
    const bad = invalidLabelReason(label)
    if (bad) return { ok: false, error: `${which}: ${bad}` }
  }

  let out = md
  let attendees = 0
  let transcript = 0

  // --- Attendees: exact bullet lines only, inside the Attendees section only.
  const att = sectionRange(out, 'Attendees')
  if (att) {
    const body = out.slice(att.start, att.end)
    // Anchored at BOTH ends, and `[ \t]` rather than `\s` so a pattern can never
    // run past its own line. Without the end anchor, `- Luke H` matches the
    // PREFIX of `- Luke Henry` and deleting it leaves the fragment `enry`.
    const line = (label: string) => `^-[ \t]+${escapeRegExp(label)}[ \t]*$`
    // A de-attribution must DELETE the attendee bullet, never rename it. Renaming
    // writes `- Unidentified 2` into the attendee list as though it were a
    // person, and the COS pipeline that BUILDS attendees deliberately excludes
    // unidentified labels (sync_meetings.py filters them) while every reader —
    // parseAttendees, extractAttendees, the Python prep generators — takes the
    // bullet at face value. So a rename here injects a phantom attendee that
    // downstream treats as real.
    const alreadyListed = options.removeAttendee || new RegExp(line(to), 'm').test(body)
    let rewritten: string
    if (alreadyListed) {
      // Both names present: drop the old bullet instead of creating a duplicate
      // attendee. This is the normal case when merging a split identity.
      rewritten = body.replace(new RegExp(`${line(from)}\\n?`, 'gm'), () => { attendees++; return '' })
    } else {
      rewritten = body.replace(new RegExp(line(from), 'gm'), () => { attendees++; return `- ${to}` })
    }
    out = out.slice(0, att.start) + rewritten + out.slice(att.end)
  }

  // --- Transcript: `[Name]:` at line start only. A name appearing inside spoken
  //     text is a quote, not a label, and must not be touched.
  const tr = sectionRange(out, 'Transcript')
  if (tr) {
    const body = out.slice(tr.start, tr.end)
    const rewritten = body.replace(
      new RegExp(`^\\[${escapeRegExp(from)}\\]:`, 'gm'),
      () => { transcript++; return `[${to}]:` },
    )
    out = out.slice(0, tr.start) + rewritten + out.slice(tr.end)
  }

  // --- Prose: detect, never rewrite.
  const proseHits = detectProseReferences(out, from)

  return {
    ok: true,
    value: { markdown: out, attendees, transcript, proseStale: proseHits.length > 0, proseHits },
  }
}

/**
 * Forms of `label` still present in narrative prose.
 *
 * Searches everything except the attendee list and the transcript — the
 * transcript's body is spoken words, and a name said aloud is a quote rather
 * than a stale attribution.
 */
export function detectProseReferences(md: string, label: string): string[] {
  const ranges = [sectionRange(md, 'Attendees'), sectionRange(md, 'Transcript')].filter(
    (r): r is { start: number; end: number } => r !== null,
  )
  let prose = ''
  let cursor = 0
  for (const r of ranges.sort((a, b) => a.start - b.start)) {
    prose += md.slice(cursor, r.start)
    cursor = Math.max(cursor, r.end)
  }
  prose += md.slice(cursor)

  const hits: string[] = []
  const full = new RegExp(`\\b${escapeRegExp(label)}\\b`)
  if (full.test(prose)) hits.push(label)
  const first = label.split(/\s+/)[0]
  // Only a multi-word label has a distinct bare-first-name form. 'MU' or 'Ext'
  // would otherwise be reported twice for the same match.
  if (first && first !== label && new RegExp(`\\b${escapeRegExp(first)}\\b`).test(prose)) hits.push(first)
  return hits
}
