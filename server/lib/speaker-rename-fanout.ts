// Carry a speaker rename out to the meetings that already have the old name baked in.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// `merge-profiles` folds two voice profiles together and relabels the calibration log.
// That is ALL it has ever touched -- verified in the handler, not assumed. Meetings keep
// the speaker strings that were written at transcription time, and the review panel
// re-reads those strings from disk on every request, so a merge is invisible to every
// meeting that already exists.
//
// Measured on this machine when the Luke H / Luke Henry merge ran: the split had been
// live since 2026-03-25, and every affected meeting would have rendered two Lukes
// forever. The merge fixed identification going FORWARD and nothing behind it.
//
// ---------------------------------------------------------------------------
// WHY IT DOES NOT REUSE THE PER-MEETING RELABEL ROUTE
// ---------------------------------------------------------------------------
// `POST /api/meeting/:id/relabel` also calls `enrolNamedVoice`, which folds that
// meeting's audio into the target profile. That is correct when a human names a voice:
// the embedding genuinely should learn it.
//
// It is WRONG for a merge fan-out, and not by a little. The merge has already absorbed
// those embeddings; re-enrolling the same audio across every affected meeting would
// double-count it and drag the centroid further. That matters here specifically because
// the Luke merge already moved a neighbouring speaker's similarity from 0.818 to 0.842,
// and 0.842 is close enough to the identification threshold to start producing wrong
// attributions.
//
// So this is a PURE STRING REWRITE. Same two primitives the relabel route uses --
// `relabelSidecarJson` and `relabelMeetingMarkdown` -- minus the enrolment.
//
// ---------------------------------------------------------------------------
// SAFETY
// ---------------------------------------------------------------------------
// This rewrites production meeting records, so:
//   - DRY RUN IS THE DEFAULT. Writing requires asking for it.
//   - Atomic writes only, via the same helper the rest of the server uses.
//   - iCloud conflict copies are skipped by construction. Desktop-and-Documents sync
//     creates `2026-08 2/` and `meeting 2.md`; rewriting one of those would edit a file
//     nothing reads while leaving the real one stale. Month directories must match
//     `YYYY-MM` exactly.
//   - Every skip is REPORTED rather than silently dropped, because a fan-out that
//     quietly missed files is worse than one that refused.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-fs.js'
import {
  relabelSidecarJson,
  relabelMeetingMarkdown,
  type SidecarRelabelResult,
  type MarkdownRelabelResult,
} from './meeting-relabel.js'

/** A month directory, and nothing that merely looks like one. */
const CANONICAL_MONTH = /^\d{4}-\d{2}$/

/** The chunk sidecar that drives the speaker review panel. */
const SIDECAR_SUFFIX = '.g2-chunks.json'

export interface FanOutFile {
  path: string
  /** Labels rewritten in this file. */
  labels: number
  /**
   * Something true about this file the operator should know: chunks that still carry
   * the old name after a partial relabel, or narrative prose the primitive leaves alone
   * on purpose. Absent when the rewrite was total.
   */
  note?: string
}

export interface FanOutSkip {
  path: string
  reason: string
}

export interface SpeakerRenameFanOut {
  from: string
  to: string
  dryRun: boolean
  sidecars: FanOutFile[]
  markdown: FanOutFile[]
  /** Files opened and examined, whether or not they matched. */
  scanned: number
  /** Anything deliberately not touched, and why. */
  skipped: FanOutSkip[]
}

export interface FanOutOptions {
  /** Write. Omitted or false means report what WOULD change and touch nothing. */
  apply?: boolean
  /**
   * Include the hidden `.meeting_archive` tree.
   *
   * Off by default: it is a separate store with its own lifecycle, and sweeping it in
   * silently would triple the blast radius of a rename without anyone asking for it.
   */
  includeArchive?: boolean
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every `{domain}/meetings/{YYYY-MM}` directory under an operations root.
 *
 * Walked explicitly rather than recursively: the operations tree also holds weekly work
 * folders, intelligence libraries and caches, and a rename has no business in any of
 * them. Three known levels, and nothing else is opened.
 */
export function meetingMonthDirs(operationsDir: string, includeArchive = false): string[] {
  const out: string[] = []
  for (const domain of safeReaddir(operationsDir)) {
    if (domain.startsWith('.') && !(includeArchive && domain === '.meeting_archive')) continue
    const meetingsDir = join(operationsDir, domain, 'meetings')
    if (!isDir(meetingsDir)) {
      // `.meeting_archive` nests one level deeper: `.meeting_archive/{name}/meetings`.
      if (includeArchive && domain === '.meeting_archive') {
        for (const sub of safeReaddir(join(operationsDir, domain))) {
          const nested = join(operationsDir, domain, sub, 'meetings')
          if (isDir(nested)) out.push(...monthsIn(nested))
        }
      }
      continue
    }
    out.push(...monthsIn(meetingsDir))
  }
  return out
}

function monthsIn(meetingsDir: string): string[] {
  const out: string[] = []
  for (const month of safeReaddir(meetingsDir)) {
    // STRICT. `2026-08 2` is an iCloud conflict copy; rewriting it would edit a file
    // nothing reads and leave the real one carrying the old name.
    if (!CANONICAL_MONTH.test(month)) continue
    const dir = join(meetingsDir, month)
    if (isDir(dir)) out.push(dir)
  }
  return out
}

/**
 * Rewrite `from` to `to` across every meeting sidecar and transcript.
 *
 * Returns what changed, or what WOULD change when `apply` is not set. Never throws for
 * one bad file: an unreadable or unparsable record is reported as a skip and the sweep
 * continues, because stopping halfway would leave the library in a half-renamed state
 * that is worse than either end.
 */
export function fanOutSpeakerRename(
  operationsDir: string,
  from: string,
  to: string,
  options: FanOutOptions = {},
): SpeakerRenameFanOut {
  const apply = options.apply === true
  const result: SpeakerRenameFanOut = {
    from, to, dryRun: !apply, sidecars: [], markdown: [], scanned: 0, skipped: [],
  }
  if (!from.trim() || !to.trim() || from === to) return result

  for (const monthDir of meetingMonthDirs(operationsDir, options.includeArchive === true)) {
    for (const name of safeReaddir(monthDir)) {
      // A conflict copy of a FILE, same reasoning as the month directory.
      //
      // The marker sits before the EXTENSION CHAIN, not just before the last dot.
      // iCloud writes `sync.g2-chunks 2.json` for a sidecar and `sync 2.md` for a
      // transcript, and a sidecar belonging to an already-conflicted meeting comes
      // out as `sync 2.g2-chunks.json`. A first cut anchored the digit to the final
      // extension and let that third form straight through -- it would have rewritten
      // a duplicate nobody reads while the real file kept the old name.
      if (/ \d+(\.[A-Za-z0-9-]+)*\.(md|json)$/.test(name)) {
        result.skipped.push({ path: join(monthDir, name), reason: 'icloud conflict copy' })
        continue
      }
      const isSidecar = name.endsWith(SIDECAR_SUFFIX)
      const isMarkdown = name.endsWith('.md')
      if (!isSidecar && !isMarkdown) continue

      const path = join(monthDir, name)
      result.scanned += 1
      let raw: string
      try {
        raw = readFileSync(path, 'utf-8')
      } catch (error) {
        result.skipped.push({ path, reason: `unreadable: ${(error as Error).message}` })
        continue
      }
      // Cheap pre-filter, and deliberately loose: `from` is a SUBSTRING of the name it
      // is being merged into ("Luke H" inside "Luke Henry"), so a file holding only the
      // new name still passes here. The primitives below are exact and reject it, which
      // is why a plain no-match must not be reported as a skip -- see below.
      if (!raw.includes(from)) continue

      // TYPED, NOT DUCK-TYPED. A first cut read `changed` as a number and the field is
      // an ARRAY of chunk indices, so every sidecar would have counted zero labels and
      // been skipped -- a fan-out that reported success while rewriting nothing.
      let next: string
      let labels: number
      let note: string | undefined

      if (isSidecar) {
        const outcome = relabelSidecarJson(raw, from, to)
        if (!outcome.ok) {
          if (!isNoMatch(outcome.error)) result.skipped.push({ path, reason: outcome.error })
          continue
        }
        const value: SidecarRelabelResult = outcome.value
        next = value.json
        labels = value.changed.length
        // The primitive's own invariant, carried rather than assumed: a partial relabel
        // means chunks still hold the old name, and the markdown must NOT then be
        // rewritten by label. Reported so the operator sees it.
        if (value.remainingWithFrom > 0) {
          note = `${value.remainingWithFrom} chunk(s) still carry "${from}"`
        }
      } else {
        // A SECOND TRANSCRIPT FORMAT EXISTS AND THE PRIMITIVE DOES NOT HANDLE IT.
        //
        // `relabelMeetingMarkdown` rewrites `[Name]:` turn labels, anchored to line
        // start. Measured across the real library for the Luke rename: 17 files and 97
        // labels in that form -- and 20 files, 77 labels in a `**Name**` form it does
        // not match, 13 of those files in LIVE quilt meetings, not the archive.
        //
        // That is a 39% silent miss. Detected and REPORTED rather than fixed here: the
        // primitive is shared with the live per-meeting relabel route, and widening its
        // matcher changes behaviour for a path nobody asked me to touch. The operator
        // gets a number instead of a surprise.
        const unhandled = countBoldLabels(raw, from)
        const outcome = relabelMeetingMarkdown(raw, from, to)
        if (!outcome.ok) {
          if (!isNoMatch(outcome.error)) result.skipped.push({ path, reason: outcome.error })
          continue
        }
        const value: MarkdownRelabelResult = outcome.value
        next = value.markdown
        labels = value.attendees + value.transcript
        // Narrative prose is deliberately untouched by the primitive. Surfaced here so a
        // stale summary is something the operator knows about rather than discovers.
        const notes: string[] = []
        if (unhandled > 0) notes.push(`${unhandled} label(s) in an unhandled **${from}** format`)
        if (value.proseStale) {
          notes.push(`prose still mentions "${from}"${value.proseHits.length ? `: ${value.proseHits.slice(0, 3).join(', ')}` : ''}`)
        }
        if (notes.length > 0) note = notes.join('; ')

        // A file whose ONLY labels are in the unhandled form changes nothing, and would
        // otherwise fall out of the report entirely -- the exact silent miss this guard
        // exists to prevent. Recorded as a skip so it is visible.
        if (labels === 0 && unhandled > 0) {
          result.skipped.push({ path, reason: `${unhandled} label(s) in an unhandled **${from}** format` })
          continue
        }
      }

      if (labels === 0) continue
      if (apply) {
        try {
          atomicWriteFileSync(path, next)
        } catch (error) {
          result.skipped.push({ path, reason: `write failed: ${(error as Error).message}` })
          continue
        }
      }
      ;(isSidecar ? result.sidecars : result.markdown).push({ path, labels, note })
    }
  }
  return result
}

/**
 * Is this refusal simply "the name is not in here", rather than a problem?
 *
 * SKIPS ARE FOR THINGS A HUMAN SHOULD LOOK AT. The loose pre-filter above lets through
 * every file holding the NEW name, because the old one is a substring of it -- measured
 * on the real library, that padded the skip list with 15 files that were never affected.
 * A report where most entries are non-issues is one nobody reads, and it hides the two
 * that matter.
 */
function isNoMatch(error: string): boolean {
  return /no chunk carries|not found|does not appear|no .* labelled/i.test(error)
}

/**
 * Speaker labels in the `**Name**` transcript form, which the primitive does not rewrite.
 *
 * Counted so the report can say how much a rename LEAVES BEHIND. Anchored to line start
 * for the same reason the primitive anchors its own matcher: a bolded name inside spoken
 * text is a quote, not a label.
 */
export function countBoldLabels(markdown: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (markdown.match(new RegExp(`^\\*\\*${escaped}\\*\\*`, 'gm')) ?? []).length
}

