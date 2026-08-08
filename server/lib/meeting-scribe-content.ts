// The readable meeting, and the two forms of it that leave the machine.
//
// WHAT v1 GOT WRONG, because the shape of the fix follows from it.
//
// v1 floored the attendee block and shipped every other section verbatim. On the
// 2026-08-06 IJO Post-Mortem — where the review asserts exactly ONE voice — all
// 14 unasserted names still reached the clipboard, including one Miles had
// already confirmed was never in the room, as `[Name]:` transcript labels. The
// stated contract, "only asserted voices are named", was false for the largest
// output.
//
// The fix is NOT redaction. Two reasons:
//   1. Transcript labels are EVIDENCE, and they came from the same identifier
//      whose verdict we would be applying — rewriting them is circular and
//      destroys the raw record the reviewer needs to judge for themselves.
//   2. A name in the prose is frequently a person MENTIONED, not one who SPOKE.
//      An action item naming Jessica Thompson does not claim she was in the room.
//      Stripping it would replace one wrong claim with a different one.
//
// So the output carries an ALLOWLIST: who voice matching confirmed, plus a plain
// statement that every other name below is unverified capture output. Honest,
// lossless, and short — a blocklist ran to 14 names on that meeting and 55 on
// another.
//
// v1's second error: it printed "100% of named speech" on a meeting that was
// 10.5% identified, and 49% of real meetings sit under that floor. A share is a
// fraction of the IDENTIFIED speech, so at 40% coverage "53%" may be 21% of the
// room — precise-looking and wrong. Hence SHARE_COVERAGE_FLOOR.
//
// And a correction to v1's own comment, which claimed the Control panel already
// suppressed those shares: it did not. `Views.swift` drew a percentage for every
// asserted voice with no coverage condition at all — the only `0.6` comparison in
// the app swapped a caption's colour. Measured: the panel showed shares the
// clipboard refused on 170 of 355 real meetings, while this file asserted twice
// that the two "can never disagree". The gate is now IN the panel row. Never
// describe another surface's behaviour from a comment; read its code.

/** One `## Heading` section of a scribe file, in document order. */
export interface ScribeSection {
  heading: string
  /** Body with the heading line removed, scaffolding stripped, edges trimmed. */
  body: string
}

export interface ParsedScribe {
  /** The `# Title` line, or '' when the file has none. */
  title: string
  sections: ScribeSection[]
  summary: string
  topics: string
  decisions: string
  actions: string
  transcript: string
  /**
   * The heading the transcript body actually came FROM.
   *
   * When a file has no real transcript, a `Transcript Enrichment (from raw
   * recording)` note wins by default and v1 relabelled derived analysis as
   * `## Transcript` while destroying its real heading — the reader could not
   * tell. Carry the heading and print it.
   */
  transcriptHeading: string
  /**
   * Further transcript-ish sections beyond the longest. Carried so nothing is
   * lost, but they belong ONLY in the full form — 112 real scribes have two.
   */
  otherTranscripts: ScribeSection[]
  /**
   * Sections that are none of the above, in document order.
   *
   * v1 discarded these, losing 116,820 characters across the corpus including
   * `Granola Structured Notes (canonical)` — Miles's own write-up — and
   * `Fathom Action Items (with exact timestamps)`. "Copy the meeting" has to
   * copy the meeting.
   */
  extras: ScribeSection[]
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/
const FENCE = /^\s*(```|~~~)/

/**
 * Strip markdown scaffolding that is structure rather than content.
 *
 * 160 of 227 real scribes wrap the transcript in a `<details>` disclosure and
 * 161 end with a generator stamp. Both land in whatever the final section is, and
 * both are noise in every destination — the stamp especially, because it is
 * generation time and reads like meeting content.
 */
export function cleanBody(body: string): string {
  const kept: string[] = []
  for (const line of body.split('\n')) {
    const t = line.trim()
    // `<details open>` and `<details markdown="1">` both occur in LLM-authored
    // markdown and neither matched the bare-tag test.
    if (/^<\/?details(\s[^>]*)?>$/i.test(t)) continue
    if (/^<summary>.*<\/summary>$/i.test(t)) continue
    // Internal pipeline triage markers. `g2-needs-domain-review` reached 129 of
    // 362 reachable clipboards — more frequent than the generator stamp, and it
    // is not meeting content.
    if (/^<!--[\s\S]*-->$/.test(t)) continue
    kept.push(line)
  }
  // Drop trailing rules AND the blank lines between them, left orphaned by the
  // stamp that sat underneath. Popping rules alone stops at the first blank line
  // the stamp left behind, so the rule survived — caught by test, not by reading.
  // The generator stamp is stripped HERE, as a footer, by POSITION not wording.
  // Measured across 1,227 real stamps, four different generator names appear
  // ("Meeting Intelligence System", "COS Split Pipeline", "COS Meeting
  // Intelligence", "Manual Granola Paste"), so any name-anchored regex leaks
  // some — I tried one and it leaked 7. Being the last line IS the invariant,
  // and it also means a mid-body italic line a human wrote ("the deck was
  // *Generated by the team* last week") now survives, where the old
  // line-by-line filter deleted it wherever it appeared.
  const trailingNoise = (line: string) =>
    line.trim() === '' ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    /^\*Generated by .*\*$/i.test(line.trim())
  while (kept.length > 0 && trailingNoise(kept[kept.length - 1])) kept.pop()
  return kept.join('\n').trim()
}

/**
 * Split a scribe into its `##` sections.
 *
 * FENCE-AWARE. A `#` inside a fenced code block is code, not a heading. Without
 * this, a fence truncates its section at the first `##` inside it and can lift a
 * shell comment into the meeting title. No real scribe carries a fence today, but
 * the Granola sections are LLM-authored markdown, so one will arrive.
 *
 * `###` subheadings stay INSIDE their parent — Action Items splitting into High
 * Confidence / Needs Review is one section's body, not two sections.
 */
export function parseScribe(markdown: string): ParsedScribe {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let title = ''
  const sections: ScribeSection[] = []
  let current: ScribeSection | null = null
  let inFence = false

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence
    if (!inFence) {
      const m = HEADING.exec(line)
      if (m && m[1].length === 1 && !title) { title = m[2].trim(); continue }
      if (m && m[1].length === 2) {
        if (current) sections.push({ ...current, body: cleanBody(current.body) })
        current = { heading: m[2], body: '' }
        continue
      }
    }
    if (current) current.body += line + '\n'
  }
  if (current) sections.push({ ...current, body: cleanBody(current.body) })

  const used = new Set<ScribeSection>()
  /** Exact heading match, first name wins. */
  const exact = (...names: string[]): string => {
    for (const n of names) {
      const s = sections.find(x => x.heading.toLowerCase() === n.toLowerCase() && !used.has(x))
      if (s) { used.add(s); return s.body }
    }
    return ''
  }
  /**
   * CONTAINS match, longest body wins.
   *
   * Prefix matching is the obvious rule and it is WRONG: 113 scribes head the
   * transcript `G2 Speaker-Separated Transcript` — the speaker-attributed one,
   * the most useful thing to hand a model — which does not start with the word.
   * Measured across 1,930 transcript headings, prefix catches 94%, contains 100%.
   * Longest-body separates a real transcript from a short
   * `Transcript Enrichment (from raw recording)` note in the same file.
   */
  const otherTranscripts: ScribeSection[] = []
  let transcriptHeading = ''
  const contains = (needle: string): string => {
    const hits = sections
      .filter(x => {
        const h = x.heading.toLowerCase()
        // `## Attendees (from transcript)` is eligible on a naive match and would
        // promote the unfloored attendee list — the thing this module drops — into
        // the transcript slot. Never let an attendee heading win.
        return h.includes(needle) && !h.includes('attendee') && !used.has(x)
      })
      .sort((a, b) => b.body.length - a.body.length)
    if (hits.length === 0) return ''
    transcriptHeading = hits[0].heading
    // Consume EVERY transcript-ish section. Keeping only the longest let the
    // losers fall through to `extras`, and `extras` goes into BOTH clipboard
    // forms — so the "compact, no transcript" summary shipped a second full
    // transcript on 112 of 2,090 real scribes, worst case 78,652 characters,
    // directly above its own "Transcript omitted" line.
    for (const h of hits) used.add(h)
    otherTranscripts.push(...hits.slice(1))
    return hits[0].body
  }

  const summary = exact('Summary')
  const topics = exact('Topics Discussed', 'Topics')
  const decisions = exact('Decisions Made', 'Decisions')
  const actions = exact('Action Items', 'Actions')
  const transcript = contains('transcript')
  // Attendees is consumed and DROPPED on purpose: it is the unfloored label list
  // this module exists to replace. CONTAINS, not exact — `## Attendees (from
  // transcript)` slipped past the exact match, fell through to `extras`, and
  // printed the unfloored names verbatim in both clipboard forms.
  for (const x of sections) {
    if (x.heading.toLowerCase().includes('attendee')) used.add(x)
  }

  return {
    title,
    sections,
    // Heading-less fallback drops the `# Title` line the parser already consumed;
    // 18 real files otherwise printed their title twice in the clipboard.
    summary: summary || (sections.length === 0 ? cleanBody(markdown.split('\n').filter(l => !/^#\s+/.test(l)).join('\n')) : ''),
    topics,
    decisions,
    actions,
    transcript,
    transcriptHeading,
    otherTranscripts,
    extras: sections.filter(x => !used.has(x) && x.body.trim().length > 0),
  }
}

/**
 * The meeting's calendar date, as `YYYY-MM-DD`.
 *
 * `startTime` is epoch MILLISECONDS (measured: 1786123940914), not ISO. Slicing
 * the stringified number gave "1786123940" — a plausible-looking date field
 * holding a timestamp. LOCAL date, because the scribe filename uses the local day
 * and a UTC conversion would disagree with the file late in the evening.
 */
export function meetingDate(startTime: unknown): string {
  let ms: number | null = null
  if (typeof startTime === 'number' && Number.isFinite(startTime)) {
    // Seconds-vs-ms by magnitude, but only within a plausible capture era:
    // startTime = 1 was read as 1 second and rendered "1969-12-31".
    ms = startTime < 1e12 ? (startTime > 1e8 ? startTime * 1000 : 0) : startTime
  } else if (typeof startTime === 'string' && startTime.trim()) {
    const numeric = Number(startTime)
    const t = Number.isFinite(numeric)
      ? (numeric < 1e12 ? numeric * 1000 : numeric)
      // A date-only ISO string parses as UTC midnight, so a local getDate()
      // then reports the PREVIOUS day. Pin it to local noon.
      : (/^\d{4}-\d{2}-\d{2}$/.test(startTime.trim())
        ? Date.parse(`${startTime.trim()}T12:00:00`)
        : Date.parse(startTime))
    if (Number.isFinite(t)) ms = t
  }
  // 0 and negatives are not real capture times; they rendered as "1969-12-31".
  if (ms === null || ms <= 0) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A voice as the clipboard should describe it. */
export interface AttendeeLine {
  label: string
  /** False when the review refuses to assert this name. */
  asserted: boolean
  speakingMs: number
  /** Share of identified speech, 0..1, or null when unknown/unnamed. */
  share: number | null
  /**
   * WHY this name is asserted. `nameAsserted` is one boolean over THREE
   * different warrants — passed the cosine floor, a human typed it, or the
   * wearer is exempt because identity comes from holding the device. v1 printed
   * all three as "Voice matching confirmed", which is false for two of them and
   * is exactly the laundering this module exists to prevent. The review already
   * carries both flags; the route discarded them.
   */
  isOwner: boolean
  confirmedByHuman: boolean
}

/**
 * Coverage below which per-voice shares are NOT reported.
 *
 * Mirrors Control's `speakingCoverage < 0.6` gate exactly, so the clipboard and
 * the panel can never disagree about whether a share is trustworthy. 49% of real
 * meetings sit below it.
 */
export const SHARE_COVERAGE_FLOOR = 0.6

function mmss(ms: number): string {
  // NaN survives Math.max and renders "NaNm NaNs".
  if (!Number.isFinite(ms)) return '0s'
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s}s`
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

export interface AttendeeRenderOptions {
  /**
   * Identified share of voiced time, 0..1, or null when unknown. Null suppresses
   * shares — failing closed, because unknown coverage cannot justify a
   * precise-looking percentage.
   */
  coverage: number | null
  /**
   * UNION of unattributed speaking time, from the review.
   *
   * Required rather than optional so it cannot be forgotten. Summing per-voice
   * figures double-counts crosstalk: v1 printed "30m 21s across 15 voices" inside
   * a 26-minute meeting while the union on the same review said 22m 17s. The
   * server CHANGELOG states the invariant that sum breaks.
   */
  unattributedMs: number
  /**
   * UNION of all voiced time. Used only to detect that the rows overlap — see
   * the crosstalk note in `renderAttendees`. 0 disables the check.
   */
  voicedMs: number
}

/** The attendee block, floor-applied. */
export function renderAttendees(voices: AttendeeLine[], o: AttendeeRenderOptions): string {
  const named = voices.filter(v => v.asserted).sort((a, b) => b.speakingMs - a.speakingMs)
  const rest = voices.filter(v => !v.asserted)
  // A share needs someone to be a share OF. With one named voice it is always
  // "100% of identified speech" — 23 real meetings — and on screen that reads as
  // "he did all the talking" when the same meeting had 6m 29s unidentified.
  const showShares = o.coverage !== null &&
    o.coverage >= SHARE_COVERAGE_FLOOR &&
    named.length >= 2
  const out: string[] = []
  for (const v of named) {
    const pct = showShares && v.share !== null
      ? ` · ${Math.round(v.share * 100)}% of identified speech`
      : ''
    out.push(`- ${v.label}: ${mmss(v.speakingMs)}${pct}`)
  }
  if (rest.length > 0) {
    out.push(`- Unidentified: ${mmss(o.unattributedMs)} across ${rest.length} ` +
             `voice${rest.length === 1 ? '' : 's'} the review could not name`)
  }
  // Each figure above is that voice's OWN union of speaking time, so crosstalk is
  // counted once per person — but two people talking over each other is counted
  // once EACH, and the rows then add to more than the meeting. 34 of 323 real
  // meetings overflow, worst case 71m of rows inside 66 minutes. The numbers are
  // right; adding them is what misleads, so say so rather than shrink anyone.
  const rowTotal = named.reduce((t, v) => t + (Number.isFinite(v.speakingMs) ? v.speakingMs : 0), 0) +
    (rest.length > 0 && Number.isFinite(o.unattributedMs) ? o.unattributedMs : 0)
  if (o.voicedMs > 0 && rowTotal > o.voicedMs * 1.02) {
    out.push(`- (these overlap: people talked over each other, so the rows add to ` +
             `more than the ${mmss(o.voicedMs)} of talking)`)
  }
  return out.length > 0 ? out.join('\n') : '- (no voices identified)'
}

/**
 * The provenance block: who was confirmed, and a warning covering everyone else.
 *
 * An ALLOWLIST rather than a blocklist. The prose and transcript below carry raw
 * capture labels, some of which the review rejected, and a reader pasting this
 * into a model has no other way to tell which. Naming the confirmed set is short
 * and complete.
 */
export function renderProvenance(voices: AttendeeLine[], coverage: number | null): string {
  const named = voices.filter(v => v.asserted)
  // Quoted because a label may legitimately contain a comma — `invalidLabelReason`
  // rejects brackets and newlines but not commas, and a typed "Smith, John" would
  // otherwise read as two confirmed people.
  const q = (v: AttendeeLine) => `"${v.label}"`
  const clauses: string[] = []
  const owner = named.filter(v => v.isOwner).map(q)
  const human = named.filter(v => !v.isOwner && v.confirmedByHuman).map(q)
  const matched = named.filter(v => !v.isOwner && !v.confirmedByHuman).map(q)
  if (owner.length) clauses.push(`${owner.join(', ')} by wearing the device`)
  if (matched.length) clauses.push(`${matched.join(', ')} by voice match`)
  if (human.length) clauses.push(`${human.join(', ')} because a human named that voice`)
  const lines: string[] = [
    clauses.length > 0
      ? `Names established here: ${clauses.join('; ')}.`
      : 'No name in this meeting was established by any means.',
    'Every other name below — and any different spelling of the ones just listed — ' +
    'comes from the raw capture or the write-up and was NOT confirmed. Some may be ' +
    'people mentioned rather than people present.',
  ]
  if (coverage !== null && coverage < SHARE_COVERAGE_FLOOR) {
    lines.push(
      `Only ${Math.round(coverage * 100)}% of the voice in this meeting was ` +
      'identified, so speaking shares are not reported.',
    )
  }
  return lines.join(' ')
}

export interface ClipboardInput {
  /**
   * Which business this meeting belongs to, when known.
   *
   * 98 of 251 real meetings are `personal`, and 25 of 251 summaries carry
   * compensation, termination, or legal content — while the buttons are framed
   * for Slack and email. Nothing in the payload distinguished a 1:1 about
   * someone's bonus from a marketing sync. The sibling /speakers route already
   * carries this; this one dropped it.
   */
  domain: string
  /**
   * Characters of transcript present in the RECORDING, whether or not a write-up
   * exists. Distinguishes "not written up yet" from "nobody spoke".
   */
  capturedChars: number
  /** UNION of voiced time, for the crosstalk-overflow note. */
  voicedMs: number
  title: string
  date: string
  durationMin: number
  attendees: AttendeeLine[]
  scribe: ParsedScribe
  /** Both required, so neither can be omitted. See AttendeeRenderOptions. */
  coverage: number | null
  unattributedMs: number
}

/**
 * Per-extra size ceiling for the COMPACT form.
 *
 * A heading cannot be trusted to reveal a transcript: one real scribe carries a
 * full one under `## G2 Glasses Enrichment ... (Combined)`. Gating on SIZE
 * catches that generically, where a keyword list never would. The full form has
 * no ceiling.
 */
export const SUMMARY_EXTRA_MAX_CHARS = 2000

function header(i: ClipboardInput, compact: boolean): string[] {
  const when = [i.date, i.durationMin > 0 ? `${i.durationMin} minutes` : '']
    .filter(Boolean).join(' · ')
  const parts = [`# ${i.title || 'Untitled meeting'}`]
  // Domain on the same line as the date. A reader about to paste this into a
  // channel should see "personal" before they see the content, not after.
  const line = [when, i.domain ? `${i.domain.replace(/_/g, ' ')} meeting` : ''].filter(Boolean).join(' · ')
  if (line) parts.push(line)
  if (i.domain === 'personal') {
    parts.push('', '> Personal meeting. Check before pasting this anywhere shared.')
  }
  parts.push(
    '', '## Who spoke',
    renderAttendees(i.attendees, {
      coverage: i.coverage, unattributedMs: i.unattributedMs, voicedMs: i.voicedMs,
    }),
    '', renderProvenance(i.attendees, i.coverage),
  )
  for (const [heading, body] of [
    ['Summary', i.scribe.summary],
    ['Topics', i.scribe.topics],
    ['Decisions', i.scribe.decisions],
    ['Action items', i.scribe.actions],
  ] as const) {
    if (body.trim()) parts.push('', `## ${heading}`, body.trim())
  }
  for (const s of i.scribe.extras) {
    const body = s.body.trim()
    if (compact && body.length > SUMMARY_EXTRA_MAX_CHARS) {
      parts.push('', `## ${s.heading}`, `_Omitted from the summary (${body.length} characters). Use Copy full._`)
      continue
    }
    parts.push('', `## ${s.heading}`, body)
  }
  return parts
}

/** Compact form: for pasting into a message. No transcript. */
export function clipboardSummary(i: ClipboardInput): string {
  const parts = header(i, true)
  // State that a transcript exists but was omitted. Without this, a reader
  // holding only the summary cannot tell whether one exists at all.
  const tx = i.scribe.transcript.trim()
  if (tx) parts.push('', `_Transcript omitted (${tx.length} characters). Use Copy full for it._`)
  return parts.join('\n') + '\n'
}

/** Full form: everything including the transcript, for pasting into a model. */
export function clipboardFull(i: ClipboardInput): string {
  const parts = header(i, false)
  const tx = i.scribe.transcript.trim()
  // The section's OWN heading, so a `Transcript Enrichment` note is never
  // presented as the transcript.
  // "(no transcript in this scribe)" was a lie on 140 of 399 real sidecars: the
  // write-up has not been generated yet, while the recording itself holds the
  // speech — one case today had 27,442 characters sitting in the sidecar this
  // route had just parsed. Say which of the two is actually true.
  const fallback = i.capturedChars > 0
    ? `(no write-up saved for this meeting yet — ${i.capturedChars} characters of ` +
      `transcript are in the recording, and will appear here once it is written up)`
    : '(no transcript in this scribe)'
  parts.push('', `## ${i.scribe.transcriptHeading || 'Transcript'}`, tx || fallback)
  // Additional transcript sections, full form only.
  for (const o of i.scribe.otherTranscripts) {
    if (o.body.trim()) parts.push('', `## ${o.heading}`, o.body.trim())
  }
  return parts.join('\n') + '\n'
}
