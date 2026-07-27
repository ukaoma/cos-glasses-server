import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  isCursorModel,
  normalizeCursorExecutionMode,
  normalizeModelPreference,
  type CursorExecutionMode,
  type CursorModelPreference,
} from '../../shared/model-preference.js'

export const CURSOR_ENGINE_SESSION_TTL_MS = 2 * 60 * 60_000

export interface CursorEngineSession {
  key: string
  cosSessionId: string
  model: CursorModelPreference
  executionMode: CursorExecutionMode
  /** Cursor Agent CLI session_id from stream system/init — used with --resume. */
  cursorSessionId: string
  cwd: string
  savedAt: number
  lastUsedAt: number
  expiresAt: string
}

interface CursorEngineSessionFile {
  sessions: Record<string, CursorEngineSession>
  savedAt: string
}

function sessionKey(
  cosSessionId: string,
  model: CursorModelPreference,
  executionMode: CursorExecutionMode,
): string {
  return `${cosSessionId}:${model}:${executionMode}`
}

export function getCursorEngineSessionPath(): string {
  return resolve(process.env.COS_CURSOR_ENGINE_SESSIONS_FILE || '/tmp/cos-cursor-engine-sessions.json')
}

function expiresAtFrom(now: number): string {
  return new Date(now + CURSOR_ENGINE_SESSION_TTL_MS).toISOString()
}

function readStore(): CursorEngineSessionFile {
  const path = getCursorEngineSessionPath()
  if (!existsSync(path)) return { sessions: {}, savedAt: new Date().toISOString() }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CursorEngineSessionFile>
    const sessions: Record<string, CursorEngineSession> = {}
    for (const raw of Object.values(parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {})) {
      const model = normalizeModelPreference(raw?.model)
      if (!model || !isCursorModel(model) || typeof raw?.cosSessionId !== 'string') continue
      if (typeof raw?.cursorSessionId !== 'string' || !raw.cursorSessionId) continue
      const executionMode = normalizeCursorExecutionMode(raw?.executionMode)
      const key = sessionKey(raw.cosSessionId, model, executionMode)
      const normalized = { ...raw, key, model, executionMode } as CursorEngineSession
      const prior = sessions[key]
      if (!prior || normalized.lastUsedAt > prior.lastUsedAt) sessions[key] = normalized
    }
    return {
      sessions,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
    }
  } catch {
    return { sessions: {}, savedAt: new Date().toISOString() }
  }
}

function writeStore(store: CursorEngineSessionFile): void {
  const path = getCursorEngineSessionPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, path)
}

function pruneExpired(sessions: Record<string, CursorEngineSession>, now = Date.now()): Record<string, CursorEngineSession> {
  const next: Record<string, CursorEngineSession> = {}
  for (const [key, session] of Object.entries(sessions)) {
    const expiresMs = Date.parse(session.expiresAt)
    if (Number.isFinite(expiresMs) && expiresMs > now) next[key] = session
  }
  return next
}

export function getCursorEngineSession(input: {
  cosSessionId: string
  model: CursorModelPreference
  cwd: string
  executionMode?: CursorExecutionMode
}): CursorEngineSession | null {
  const store = readStore()
  const now = Date.now()
  const sessions = pruneExpired(store.sessions, now)
  const executionMode = normalizeCursorExecutionMode(input.executionMode)
  const existing = sessions[sessionKey(input.cosSessionId, input.model, executionMode)]
  if (!existing) {
    if (Object.keys(sessions).length !== Object.keys(store.sessions).length) {
      writeStore({ sessions, savedAt: new Date().toISOString() })
    }
    return null
  }
  if (existing.cwd !== input.cwd) return null
  return existing
}

export function saveCursorEngineSession(input: {
  cosSessionId: string
  model: CursorModelPreference
  cursorSessionId: string
  cwd: string
  executionMode?: CursorExecutionMode
  now?: number
}): CursorEngineSession {
  const now = input.now ?? Date.now()
  const store = readStore()
  const sessions = pruneExpired(store.sessions, now)
  const executionMode = normalizeCursorExecutionMode(input.executionMode)
  const key = sessionKey(input.cosSessionId, input.model, executionMode)
  const previous = sessions[key]
  const session: CursorEngineSession = {
    key,
    cosSessionId: input.cosSessionId,
    model: input.model,
    executionMode,
    cursorSessionId: input.cursorSessionId,
    cwd: input.cwd,
    savedAt: previous?.savedAt ?? now,
    lastUsedAt: now,
    expiresAt: expiresAtFrom(now),
  }
  sessions[key] = session
  writeStore({ sessions, savedAt: new Date().toISOString() })
  return session
}

export function clearCursorEngineSession(cosSessionId: string, model?: CursorModelPreference): number {
  const store = readStore()
  const sessions = pruneExpired(store.sessions)
  let removed = 0
  for (const key of Object.keys(sessions)) {
    const session = sessions[key]
    if (session.cosSessionId !== cosSessionId) continue
    if (model && session.model !== model) continue
    delete sessions[key]
    removed += 1
  }
  if (removed > 0) writeStore({ sessions, savedAt: new Date().toISOString() })
  return removed
}

export function listCursorEngineSessions(): CursorEngineSession[] {
  const store = readStore()
  const sessions = pruneExpired(store.sessions)
  if (Object.keys(sessions).length !== Object.keys(store.sessions).length) {
    writeStore({ sessions, savedAt: new Date().toISOString() })
  }
  return Object.values(sessions).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}
