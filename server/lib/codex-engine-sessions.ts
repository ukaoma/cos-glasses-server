import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  isCodexModel,
  normalizeModelPreference,
  type CodexModelPreference,
} from '../../shared/model-preference.js'
import { isKeyProfileId } from '../../shared/key-preference.js'

export const CODEX_ENGINE_SESSION_TTL_MS = 2 * 60 * 60_000

export type CodexTrustMode = 'read-only' | 'workspace-write'

export interface CodexEngineSession {
  key: string
  cosSessionId: string
  model: CodexModelPreference
  codexThreadId: string
  cwd: string
  trustMode: CodexTrustMode
  savedAt: number
  lastUsedAt: number
  expiresAt: string
  engineFingerprint: string
  /**
   * Key lanes (P11): the key profile this thread runs under. Its own slot, so a keyed turn and a
   * subscription turn of one COS session never overwrite each other's resume. Absent on every
   * subscription row, which keeps its 6.79.0 key and bytes.
   */
  profileId?: string
}

interface CodexEngineSessionFile {
  sessions: Record<string, CodexEngineSession>
  savedAt: string
}

function sessionKey(cosSessionId: string, model: CodexModelPreference, profileId?: string): string {
  return profileId ? `${cosSessionId}:${model}:profile:${profileId}` : `${cosSessionId}:${model}`
}

function slotProfile(raw: unknown): string | undefined {
  return isKeyProfileId(raw) ? raw : undefined
}

export function getCodexEngineSessionPath(): string {
  return resolve(process.env.COS_CODEX_ENGINE_SESSIONS_FILE || '/tmp/cos-codex-engine-sessions.json')
}

function expiresAtFrom(now: number): string {
  return new Date(now + CODEX_ENGINE_SESSION_TTL_MS).toISOString()
}

function readStore(): CodexEngineSessionFile {
  const path = getCodexEngineSessionPath()
  if (!existsSync(path)) return { sessions: {}, savedAt: new Date().toISOString() }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CodexEngineSessionFile>
    const sessions: Record<string, CodexEngineSession> = {}
    for (const raw of Object.values(parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {})) {
      const model = normalizeModelPreference(raw?.model)
      if (
        !model ||
        !isCodexModel(model) ||
        typeof raw?.cosSessionId !== 'string' ||
        typeof raw?.codexThreadId !== 'string' ||
        typeof raw?.cwd !== 'string' ||
        (raw?.trustMode !== 'read-only' && raw?.trustMode !== 'workspace-write') ||
        typeof raw?.lastUsedAt !== 'number' ||
        typeof raw?.expiresAt !== 'string'
      ) continue
      if (raw.profileId !== undefined && !slotProfile(raw.profileId)) continue
      const key = sessionKey(raw.cosSessionId, model, slotProfile(raw.profileId))
      const normalized = { ...raw, key, model } as CodexEngineSession
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

function writeStore(store: CodexEngineSessionFile): void {
  const path = getCodexEngineSessionPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, path)
}

function pruneExpired(sessions: Record<string, CodexEngineSession>, now = Date.now()): Record<string, CodexEngineSession> {
  const next: Record<string, CodexEngineSession> = {}
  for (const [key, session] of Object.entries(sessions)) {
    const expiresMs = Date.parse(session.expiresAt)
    if (Number.isFinite(expiresMs) && expiresMs > now) next[key] = session
  }
  return next
}

export function getCodexEngineSession(input: {
  cosSessionId: string
  model: CodexModelPreference
  cwd: string
  trustMode: CodexTrustMode
  engineFingerprint?: string
  profileId?: string
}): CodexEngineSession | null {
  const { engineFingerprint = '', ...rest } = input
  const store = readStore()
  const now = Date.now()
  const sessions = pruneExpired(store.sessions, now)
  const existing = sessions[sessionKey(rest.cosSessionId, rest.model, slotProfile(rest.profileId))]
  if (!existing) {
    if (Object.keys(sessions).length !== Object.keys(store.sessions).length) {
      writeStore({ sessions, savedAt: new Date().toISOString() })
    }
    return null
  }
  if (existing.cwd !== rest.cwd || existing.trustMode !== rest.trustMode) return null
  if ((existing.engineFingerprint ?? '') !== (engineFingerprint ?? '')) return null
  return existing
}

export function saveCodexEngineSession(input: {
  cosSessionId: string
  model: CodexModelPreference
  codexThreadId: string
  cwd: string
  trustMode: CodexTrustMode
  now?: number
  engineFingerprint?: string
  profileId?: string
}): CodexEngineSession {
  const now = input.now ?? Date.now()
  const store = readStore()
  const sessions = pruneExpired(store.sessions, now)
  const profileId = slotProfile(input.profileId)
  const key = sessionKey(input.cosSessionId, input.model, profileId)
  const previous = sessions[key]
  const session: CodexEngineSession = {
    key,
    cosSessionId: input.cosSessionId,
    model: input.model,
    codexThreadId: input.codexThreadId,
    cwd: input.cwd,
    trustMode: input.trustMode,
    savedAt: previous?.savedAt ?? now,
    lastUsedAt: now,
    expiresAt: expiresAtFrom(now),
    engineFingerprint: input.engineFingerprint ?? '',
    ...(profileId ? { profileId } : {}),
  }
  sessions[key] = session
  writeStore({ sessions, savedAt: new Date().toISOString() })
  return session
}

/**
 * With a model, clears that model's slot of one lane only: the subscription slot, or with
 * `profileId` that profile's slot. Without a model (deleting the COS session), every slot.
 */
export function clearCodexEngineSession(cosSessionId: string, model?: CodexModelPreference, profileId?: string): number {
  const store = readStore()
  const sessions = pruneExpired(store.sessions)
  let removed = 0
  for (const key of Object.keys(sessions)) {
    const session = sessions[key]
    if (session.cosSessionId !== cosSessionId) continue
    if (model && session.model !== model) continue
    if (model && (session.profileId ?? undefined) !== slotProfile(profileId)) continue
    delete sessions[key]
    removed += 1
  }
  if (removed > 0) writeStore({ sessions, savedAt: new Date().toISOString() })
  return removed
}

export function listCodexEngineSessions(): CodexEngineSession[] {
  const store = readStore()
  const sessions = pruneExpired(store.sessions)
  if (Object.keys(sessions).length !== Object.keys(store.sessions).length) {
    writeStore({ sessions, savedAt: new Date().toISOString() })
  }
  return Object.values(sessions).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}
