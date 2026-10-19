import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

/**
 * 6.79.1: one daily polish budget per caller instead of one shared cap.
 *
 * Through 6.79.0 every autoclean (Mac dictation, G2 messages, G2 live meeting lines,
 * prompt drafts) counted against COS_DICTATION_AUTOCLEAN_MAX_PER_DAY. On 2026-10-19 the
 * glasses' meeting lines spent it by late morning and every Mac dictation after that came
 * back unpolished in ~60 ms with no reason given. A caller now only spends its own bucket.
 *
 * - message: POST /api/dictation/finalize surface "message" (Mac dictation, G2 messages;
 *   each one an explicit user action). Default 300. COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE,
 *   falling back to the pre-6.79.1 COS_DICTATION_AUTOCLEAN_MAX_PER_DAY so an existing .env keeps working.
 * - meeting: POST /api/dictation/finalize surface "meeting". Default 200. ..._MEETING.
 * - prompt_draft: prompt-draft finalize and retry. Default 200. ..._PROMPT_DRAFT.
 *
 * The day is the server's LOCAL calendar day (it was the UTC day, which reset at 7 PM in
 * Austin). One count file holds all three buckets; a pre-6.79.1 file ({date, count}) reads
 * as zero for every bucket, so an upgrade starts each bucket fresh.
 */
export type PolishBucket = 'message' | 'meeting' | 'prompt_draft'
export const POLISH_BUCKETS: readonly PolishBucket[] = ['message', 'meeting', 'prompt_draft']

const DEFAULT_CAPS: Record<PolishBucket, number> = { message: 300, meeting: 200, prompt_draft: 200 }
const CAP_ENV: Record<PolishBucket, string> = {
  message: 'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE',
  meeting: 'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MEETING',
  prompt_draft: 'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_PROMPT_DRAFT',
}

const countFile = () => process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE || dataPath('.dictation_autoclean_count.json')

function positiveInt(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? ''
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value > 0 ? value : null
}

export function localDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function polishDailyCap(bucket: PolishBucket, env: NodeJS.ProcessEnv = process.env): number {
  const own = positiveInt(env[CAP_ENV[bucket]])
  if (own !== null) return own
  if (bucket === 'message') {
    const legacy = positiveInt(env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY)
    if (legacy !== null) return legacy
  }
  return DEFAULT_CAPS[bucket]
}

function readCounts(): Record<PolishBucket, number> {
  const counts: Record<PolishBucket, number> = { message: 0, meeting: 0, prompt_draft: 0 }
  try {
    const raw = JSON.parse(readFileSync(countFile(), 'utf-8'))
    if (raw?.date !== localDay() || !raw.counts || typeof raw.counts !== 'object') return counts
    for (const bucket of POLISH_BUCKETS) {
      const value = raw.counts[bucket]
      if (Number.isInteger(value) && value > 0) counts[bucket] = value
    }
  } catch {}
  return counts
}

export function polishCountToday(bucket: PolishBucket): number {
  return readCounts()[bucket]
}

export function polishBudgetExhausted(bucket: PolishBucket): boolean {
  return polishCountToday(bucket) >= polishDailyCap(bucket)
}

export function recordPolishCall(bucket: PolishBucket): void {
  try {
    const file = countFile()
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
    const counts = readCounts()
    counts[bucket] += 1
    atomicWriteFileSync(file, JSON.stringify({ date: localDay(), counts }), { mode: 0o600 })
  } catch {}
}
