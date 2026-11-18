/**
 * 7.0.59: the overnight mail scan as the Today summary reads it (Miles approved 11/18: "Good Morning + Today", then
 * "Start it").
 *
 * Google blocks the COS OAuth app on his work domain, so mail is read through the Spark CLI, read-only per account in
 * Spark Desktop, by a zero-model LaunchAgent (com.cos.mail-intel-scan, 05:30 daily; MU-Chief-Staff
 * operations/scripts/mail_intel_scan.py). It writes mail_intel.json (schema 1) and appends one line per run to
 * runs.jsonl beside it, both mode 600, outside git and iCloud. This server only READS them.
 *
 * What reaches the model, from at most BRIEF_MAIL_ITEMS_MAX of the scan's ranked `top` items: the inbox (the scan's
 * domain label), who (the people profile's name, else the sender's display name), their role, whether it was sent to
 * the person, the subject and the first words. All of it is untrusted email text: secrets, long tokens, email
 * addresses, URLs, ids and paths are taken out and each field is bounded (scrubMailText). The sender's address, the
 * message link, the message id and the account address are never read into the result.
 *
 * Never silence: no file, a file that cannot be read, a scan over 16 hours old, or a last run that failed each give one
 * reason, and the prompt says `mail unavailable: <reason>`.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BRIEF_MAIL_ITEMS_MAX, scrubRecentText, type BriefMail, type BriefMailItem } from './today-brief.js'

/** The scan file. COS_MAIL_INTEL_PATH overrides it (tests); runs.jsonl is read from the same folder. */
export const MAIL_INTEL_DEFAULT_PATH = join(homedir(), 'cos-data', 'mail-intel', 'mail_intel.json')
/** Older than this, the scan is not "overnight" any more: 05:30's scan is used until 21:30. */
export const MAIL_INTEL_MAX_AGE_MS = 16 * 60 * 60 * 1000
/** A scan stamped further ahead than this (a clock that moved) is not trusted. */
export const MAIL_INTEL_FUTURE_SKEW_MS = 10 * 60 * 1000
/** The scan file is about 60 KB; anything past this is not the scan. */
export const MAIL_INTEL_MAX_BYTES = 4 * 1024 * 1024
/** Only the tail of runs.jsonl is read: the last record is the one that counts. */
export const MAIL_RUNS_TAIL_BYTES = 64 * 1024

export const MAIL_UNAVAILABLE = {
  missing: 'no overnight scan was found',
  unreadable: 'the scan file could not be read',
  stale: 'the overnight scan is over 16 hours old',
  failed: 'the last scan failed',
} as const

const LIMITS = { inbox: 30, who: 60, role: 60, subject: 110, snippet: 160 }

// Any email address, and the URL shapes an email carries that scrubText's http(s) rule does not: www., mailto:, and a
// bare domain with a path ("acme.com/unsubscribe").
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
const URLISH = /\b(?:https?:\/\/|www\.|mailto:)\S*|\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\/\S*/gi

/**
 * One field of email text made safe for the prompt: addresses and URL shapes out FIRST (before anything is cut, so a
 * cut can never leave half an address that no rule matches), then the transcript rules (secrets, long tokens, short
 * hashes, ids, paths, control characters, one line, bounded; a double quote becomes a single one).
 */
export function scrubMailText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const s = value.replace(EMAIL, ' ').replace(URLISH, ' ')
  // A stray @ left by an address the rule above did not take whole ("name@localhost") goes too.
  return scrubRecentText(s, max).replace(/@/g, ' ').replace(/\s+/g, ' ').trim()
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const errCode = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '')

/** One ranked item as the prompt may see it, or null when nothing in it is usable. Reads only the named fields. */
export function mailItemOf(raw: unknown): BriefMailItem | null {
  if (!record(raw)) return null
  const person = record(raw.person) ? raw.person : null
  const inbox = scrubMailText(typeof raw.domain === 'string' ? raw.domain.replace(/[_-]+/g, ' ') : '', LIMITS.inbox)
  const who = scrubMailText(person?.name, LIMITS.who) || scrubMailText(raw.from_name, LIMITS.who)
  const role = scrubMailText(person?.role, LIMITS.role)
  const addressed = raw.addressed === 'to' || raw.addressed === 'cc' || raw.addressed === 'other' ? raw.addressed : ''
  const subject = scrubMailText(raw.subject, LIMITS.subject)
  const snippet = scrubMailText(raw.snippet, LIMITS.snippet)
  if (!subject && !snippet) return null
  return { inbox, who, role, addressed, subject, snippet }
}

/** The last record in runs.jsonl, or null when there is none or it cannot be read (only ok:false refuses). */
function lastRun(file: string): Record<string, unknown> | null {
  let fd: number | null = null
  try {
    const size = statSync(file).size
    const len = Math.min(size, MAIL_RUNS_TAIL_BYTES)
    const buf = Buffer.alloc(len)
    fd = openSync(file, 'r')
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean)
    const last = lines[lines.length - 1]
    if (!last) return null
    const parsed: unknown = JSON.parse(last)
    return record(parsed) ? parsed : null
  } catch {
    return null
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* closed */ }
  }
}

export interface MailIntelReadOptions { path?: string; now?: number; env?: NodeJS.ProcessEnv }

/** The overnight mail for the Today summary: up to five cleaned items, or one reason they are not there. Never throws. */
export function readMailIntel(opts: MailIntelReadOptions = {}): BriefMail {
  const env = opts.env ?? process.env
  const file = opts.path ?? (env.COS_MAIL_INTEL_PATH?.trim() || MAIL_INTEL_DEFAULT_PATH)
  const now = opts.now ?? Date.now()
  const run = lastRun(join(dirname(file), 'runs.jsonl'))
  if (run && run.ok === false) return { items: [], unavailable: MAIL_UNAVAILABLE.failed }
  let raw: unknown
  try {
    if (statSync(file).size > MAIL_INTEL_MAX_BYTES) return { items: [], unavailable: MAIL_UNAVAILABLE.unreadable }
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { items: [], unavailable: errCode(e) === 'ENOENT' ? MAIL_UNAVAILABLE.missing : MAIL_UNAVAILABLE.unreadable }
  }
  if (!record(raw) || raw.schema !== 1 || !Array.isArray(raw.top)) return { items: [], unavailable: MAIL_UNAVAILABLE.unreadable }
  const at = typeof raw.generated_at === 'string' ? Date.parse(raw.generated_at) : NaN
  if (!Number.isFinite(at) || at - now > MAIL_INTEL_FUTURE_SKEW_MS) return { items: [], unavailable: MAIL_UNAVAILABLE.unreadable }
  if (now - at > MAIL_INTEL_MAX_AGE_MS) return { items: [], unavailable: MAIL_UNAVAILABLE.stale }
  const items: BriefMailItem[] = []
  for (const row of raw.top) {
    if (items.length >= BRIEF_MAIL_ITEMS_MAX) break
    const item = mailItemOf(row)
    if (item) items.push(item)
  }
  return { items }
}
