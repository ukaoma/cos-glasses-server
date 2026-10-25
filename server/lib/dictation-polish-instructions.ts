import { createHash } from 'node:crypto'
import { readFileSync, statSync, unlinkSync } from 'node:fs'
import { atomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

/**
 * 6.85.0: "Your polish instructions". One user setting, extra direction for AI polish that is
 * layered AFTER COS's built-in polish rules (dictation-clean.ts). Miles, 2026-10-21: "we still
 * want to keep all of our kind of general rules, but this would allow them to provide further
 * steer."
 *
 * - One string, at most CUSTOM_INSTRUCTIONS_MAX_CHARS (JavaScript string length, UTF-16 units,
 *   the same unit Control counts), after sanitizing.
 * - Empty is off: the assembled prompt is byte-identical to 6.83.1 (golden test).
 * - Stored atomically in the server's data dir, mode 0600. Removing it (Clear) deletes the file.
 * - The text is never logged. Telemetry carries `customInstructions: true|false` and
 *   `instructionsHash` (8 hex characters of a SHA-256), never the words.
 */
export const CUSTOM_INSTRUCTIONS_MAX_CHARS = 1_000
/** A body this large is refused before it is sanitized at all. */
export const CUSTOM_INSTRUCTIONS_MAX_RAW_CHARS = 8_000
export const CUSTOM_INSTRUCTIONS_FILE = 'dictation-polish-instructions.json'
/** Bumped when the request or prompt contract changes; clients read it from capabilities. */
export const CUSTOM_INSTRUCTIONS_PROTOCOL = 1

/**
 * The prompt's own delimiters. A preference that contains one could close its block early and
 * write text the model would read as COS's, so every one of them is removed, in any case and
 * with any spacing or attributes. 6.91.0: the learned-style block's tag too.
 */
const RESERVED_TAG = /<\s*\/?\s*(?:user-style-preferences|learned-style|known-spellings|dictation)\b[^>]*>/gi
/** C0 and C1 controls other than line feed and tab, plus DEL. */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g
/** Invisible format characters: zero-width, bidi embeddings, overrides and isolates, BOM, soft hyphen. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

export type SanitizeResult =
  | { ok: true; value: string }
  | { ok: false; error: 'not_a_string' | 'too_long'; maxChars: number; length?: number }

/** What is stored and what the model sees. Pure: no file access. */
export function sanitizeCustomInstructions(raw: unknown): SanitizeResult {
  if (typeof raw !== 'string') return { ok: false, error: 'not_a_string', maxChars: CUSTOM_INSTRUCTIONS_MAX_CHARS }
  if (raw.length > CUSTOM_INSTRUCTIONS_MAX_RAW_CHARS) {
    return { ok: false, error: 'too_long', maxChars: CUSTOM_INSTRUCTIONS_MAX_CHARS, length: raw.length }
  }
  const value = raw
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .replace(RESERVED_TAG, '')
    .split('\n').map(line => line.replace(/[ ]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (value.length > CUSTOM_INSTRUCTIONS_MAX_CHARS) {
    return { ok: false, error: 'too_long', maxChars: CUSTOM_INSTRUCTIONS_MAX_CHARS, length: value.length }
  }
  return { ok: true, value }
}

/** 8 hex characters: enough to tell two settings apart in a log, never the text. '' for none. */
export function customInstructionsHash(value: string): string {
  return value ? createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8) : ''
}

const filePath = () => dataPath(CUSTOM_INSTRUCTIONS_FILE)

export interface StoredInstructions { customInstructions: string; updatedAt: string | null }

let cache: { mtimeMs: number; size: number; value: StoredInstructions } | null = null
let warned = false

function warnOnce(reason: string): void {
  if (warned) return
  warned = true
  // The reason only. The file's contents are the user's words and are never logged.
  console.warn(`[dictation-polish] ${CUSTOM_INSTRUCTIONS_FILE} ${reason}; polish runs without custom instructions until it is saved again`)
}

/**
 * The stored setting, sanitized again on every read (a hand-edited file gets the same rules as
 * a PUT). Missing, unreadable, malformed or over the cap reads as off. Cheap: mtime-cached.
 */
export function readCustomInstructions(): StoredInstructions {
  const off: StoredInstructions = { customInstructions: '', updatedAt: null }
  let stat: { mtimeMs: number; size: number }
  try { const s = statSync(filePath()); stat = { mtimeMs: s.mtimeMs, size: s.size } } catch { cache = null; return off }
  if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return { ...cache.value }
  let value = off
  try {
    const parsed = JSON.parse(readFileSync(filePath(), 'utf8'))
    const clean = sanitizeCustomInstructions(parsed?.customInstructions)
    if (clean.ok) {
      value = { customInstructions: clean.value, updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null }
    } else {
      warnOnce(clean.error === 'too_long' ? 'is over the length limit' : 'has no instructions string')
    }
  } catch {
    warnOnce('is unreadable')
  }
  cache = { ...stat, value }
  return { ...value }
}

/** Save an already-sanitized value. Empty deletes the file, which is the off state. */
export function writeCustomInstructions(value: string, now: Date = new Date()): StoredInstructions {
  cache = null
  if (!value) {
    try { unlinkSync(filePath()) } catch (err: any) { if (err?.code !== 'ENOENT') throw err }
    return { customInstructions: '', updatedAt: null }
  }
  const stored: StoredInstructions = { customInstructions: value, updatedAt: now.toISOString() }
  atomicWriteFileSync(filePath(), JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 })
  return stored
}

export function __resetCustomInstructionsCacheForTests(): void { cache = null; warned = false }
