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
  // Missing is not corrupt. A legacy install upgrading for the first time has
  // no file AND no era stamps on its exchanges, and only LEGACY_MESSAGE_ERA
  // classifies an unstamped exchange as current. Rotating here would file every
  // one of them under a previous era and empty the chat on upgrade.
  if (loaded.status === 'missing') {
    cached = { v: 1, era: LEGACY_MESSAGE_ERA, startedAt: 0 }
    cachedMtimeMs = mtimeMs
    return cached
  }

  // Corrupt, or present-but-invalid: the file existed, so a real era almost
  // certainly did too, and its value is now unrecoverable. Reverting to legacy
  // would be the worst available answer -- it re-reads every era-stamped
  // exchange as a PREVIOUS era (hiding it from /all-messages) while promoting
  // unstamped ones to current, and it is indistinguishable from a reset nobody
  // asked for. Rotate explicitly and say so, so the state is self-consistent
  // and the event is diagnosable.
  console.error(
    `[message-era] ${MESSAGE_ERA_FILE} was unreadable (status=${loaded.status}); `
    + 'rotating to a fresh era. Older messages stay in day archives and remain '
    + 'reachable by session, but not by short number.',
  )
  try {
    return createMessageEra()
  } catch (err) {
    // Read-only or full data dir: degrade to legacy rather than crash the
    // server, but never cache it -- the next call retries the rotation.
    console.error('[message-era] could not persist the replacement era:', err)
    cached = null
    cachedMtimeMs = Number.NaN
    return { v: 1, era: LEGACY_MESSAGE_ERA, startedAt: 0 }
  }
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
