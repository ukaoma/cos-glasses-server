// Merge fan-out carries exact speaker names through the durable correction core.
// Enrollment stays off: the profile merge already absorbed those voice samples.
// Missing copies, unavailable raw maps and legacy markdown-only records are
// explicit skips. A merge must never silently fall back to a chunks-only write.

import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { renameMeetingSpeaker } from './held-naming-batches.js'

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
    return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()
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
 * Preserve the existing report/error shape while executing each session through
 * the shared two-copy, ledgered correction core. Dry-run remains the default.
 * Sequential awaits are intentional: all correction entrypoints share one lock.
 */
export async function fanOutSpeakerRename(
  operationsDir: string,
  from: string,
  to: string,
  options: FanOutOptions = {},
): Promise<SpeakerRenameFanOut> {
  const apply = options.apply === true
  const result: SpeakerRenameFanOut = {
    from, to, dryRun: !apply, sidecars: [], markdown: [], scanned: 0, skipped: [],
  }
  if (!from.trim() || !to.trim() || from === to) return result
  const entries = new Map<string, string>()
  const canonicalSources = new Map<string, string>()
  for (const monthDir of meetingMonthDirs(operationsDir, options.includeArchive === true)) {
    for (const name of safeReaddir(monthDir).sort()) {
      const path = join(monthDir, name)
      if (/ \d+(\.[A-Za-z0-9-]+)*\.(md|json)$/.test(name)) {
        result.skipped.push({ path, reason: 'icloud conflict copy' })
        continue
      }
      if (!name.endsWith(SIDECAR_SUFFIX) && !name.endsWith('.md')) continue
      result.scanned++
      try {
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a canonical regular file')
        const raw = readFileSync(path, 'utf8')
        entries.set(path, raw)
        canonicalSources.set(realpathSync(path), raw)
      } catch (error) {
        result.skipped.push({ path, reason: `unreadable: ${errorText(error)}` })
      }
    }
  }
  const sessions = new Set<string>()
  const coveredMarkdown = new Set<string>()
  for (const [path, raw] of entries) {
    if (!path.endsWith(SIDECAR_SUFFIX)) continue
    const markdownPath = path.slice(0, -SIDECAR_SUFFIX.length) + '.md'
    coveredMarkdown.add(markdownPath)
    if (!raw.includes(from)) continue
    try {
      const doc = JSON.parse(raw)
      if (!doc || Array.isArray(doc) || typeof doc !== 'object') throw new Error('sidecar is not a JSON object')
      if (!carriesSpeaker(doc, from)) continue
      if (typeof doc.sessionId !== 'string' || !doc.sessionId.trim()) {
        throw new Error('missing session identity; cannot verify both meeting copies')
      }
      if (sessions.has(doc.sessionId)) {
        result.skipped.push({ path, reason: 'duplicate session sidecar; session already examined' })
        continue
      }
      sessions.add(doc.sessionId)
      const outcome = await renameMeetingSpeaker(doc.sessionId, from, to, {
        apply, operationsDir: realpathSync(operationsDir), expectedSidecarPath: path,
      })
      if (outcome.error) throw new Error(outcome.error)
      for (const copy of outcome.copies) {
        const note = copy.unresolvedTurns > 0
          ? `${copy.unresolvedTurns} transcript turn(s) could not be aligned; labels newer than graph`
          : undefined
        if (copy.labels > 0) result.sidecars.push({ path: copy.sidecarPath, labels: copy.labels, note })
        if (copy.transcript + copy.attendees > 0) {
          const prose = canonicalSources.get(copy.meetingPath) ?? entries.get(copy.meetingPath)
          const stale = prose && proseMentions(prose, from) ? `prose still mentions "${from}"` : undefined
          result.markdown.push({ path: copy.meetingPath, labels: copy.transcript + copy.attendees,
            note: [note, stale].filter(Boolean).join('; ') || undefined })
        }
        coveredMarkdown.add(copy.meetingPath)
      }
    } catch (error) {
      result.skipped.push({ path, reason: `${apply ? 'write failed' : 'preview refused'}: ${errorText(error)}` })
    }
  }
  // Cloud-only and archived markdown has no raw G2 position authority. Keep it
  // visible in the report rather than rewriting an attendee or quoted name.
  for (const [path, raw] of entries) {
    if (!path.endsWith('.md') || coveredMarkdown.has(path) || !raw.includes(from)) continue
    if (hasNamedLabel(raw, from)) result.skipped.push({
      path, reason: 'no G2 session sidecar; transcript labels cannot be safely aligned',
    })
  }
  return result
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function carriesSpeaker(doc: Record<string, any>, name: string): boolean {
  return (Array.isArray(doc.chunks) && doc.chunks.some((chunk: any) => chunk?.speaker === name))
    || (Array.isArray(doc.chunkEntries) && doc.chunkEntries.some((entry: any) => entry?.chunk?.speaker === name))
    || (Array.isArray(doc.batchSegments) && doc.batchSegments.some((segment: any) =>
      Array.isArray(segment?.speakerWords) && segment.speakerWords.some((word: any) => word?.speaker === name)))
}

function escapedName(name: string): string { return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function hasNamedLabel(markdown: string, name: string): boolean {
  const escaped = escapedName(name)
  return new RegExp(`^(?:\\[${escaped}\\]:|\\*\\*${escaped}(?::\\*\\*|\\*\\*)|[-*] ${escaped}$)`, 'm').test(markdown)
}
function proseMentions(markdown: string, name: string): boolean {
  const prose = markdown.replace(/^## (?:Attendees|Transcript)[^\n]*\n[\s\S]*?(?=^## |$(?![\s\S]))/gm, '')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapedName(name)}(?![\\p{L}\\p{N}])`, 'u').test(prose)
}

/** Kept for callers that count the older bold speaker-label format. */
export function countBoldLabels(markdown: string, name: string): number {
  return (markdown.match(new RegExp(`^\\*\\*${escapedName(name)}\\*\\*`, 'gm')) ?? []).length
}
