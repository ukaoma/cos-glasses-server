// Message-number eras let Miles start again at #1 without deleting history.
// Old sessions/day archives remain immutable and browseable; the current era
// alone owns short voice references such as "reference message 4".
//
// Public package stores state under ~/.cos-glasses/data (dataPath), matching
// sessions/archive — never a package-relative path that vanishes on npx upgrade.
//
// Disk is authoritative across processes: reset-message-era.ts writes the file
// in a one-shot CLI; the long-lived server re-reads when mtime changes so a
// reset is visible without relying solely on an in-process cache flush.

import { statSync } from 'node:fs'
import { atomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

export const LEGACY_MESSAGE_ERA = 'legacy'

export interface MessageEraState {
  v: 1
  era: string
  startedAt: number
}

const MESSAGE_ERA_FILE = dataPath('message-era.json')

let cached: MessageEraState | null = null
let cachedMtimeMs = Number.NaN

function fileMtimeMs(): number {
  try {
    return statSync(MESSAGE_ERA_FILE).mtimeMs
  } catch {
    return Number.NaN
  }
}

function validState(value: unknown): value is MessageEraState {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<MessageEraState>
  return raw.v === 1
    && typeof raw.era === 'string'
    && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(raw.era)
    && typeof raw.startedAt === 'number'
    && Number.isFinite(raw.startedAt)
    && raw.startedAt >= 0
}

export function currentMessageEraState(): MessageEraState {
  const mtimeMs = fileMtimeMs()
  if (cached && Object.is(mtimeMs, cachedMtimeMs)) return cached

  const loaded = loadJsonOrQuarantine<unknown>(MESSAGE_ERA_FILE)
  if (loaded.status === 'ok' && validState(loaded.data)) {
    cached = loaded.data
    cachedMtimeMs = mtimeMs
    return cached
  }
  cached = { v: 1, era: LEGACY_MESSAGE_ERA, startedAt: 0 }
  cachedMtimeMs = mtimeMs
  return cached
}

export function currentMessageEra(): string {
  return currentMessageEraState().era
}

export function exchangeBelongsToEra(
  exchange: { messageEra?: unknown },
  era = currentMessageEra(),
): boolean {
  if (era === LEGACY_MESSAGE_ERA) {
    return exchange.messageEra == null || exchange.messageEra === LEGACY_MESSAGE_ERA
  }
  return exchange.messageEra === era
}

export function createMessageEra(now = Date.now()): MessageEraState {
  const stamp = new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const next: MessageEraState = {
    v: 1,
    era: `era-${stamp}`,
    startedAt: now,
  }
  atomicWriteFileSync(MESSAGE_ERA_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
  cached = next
  cachedMtimeMs = fileMtimeMs()
  return next
}

/** Test/helper: drop in-memory cache so the next read hits disk. */
export function __resetMessageEraCacheForTests(): void {
  cached = null
  cachedMtimeMs = Number.NaN
}
