// Shared OpenAI API key resolver — used by Whisper (transcribe + transcribe-stream)
// and TTS (voice output). Single source of truth so we don't drift across callers.
//
// Resolution order (v5.9.5 — phone-set key support added between env and .env):
//   1. process.env.OPENAI_API_KEY       — admin override / .env / shell. Wins.
//   2. server/data/openai-key.json      — written by POST /api/openai-key/set,
//                                         shape: { key, savedAt, validatedAt }.
//                                         New in v5.9.5 — lets the phone Settings
//                                         panel configure the key without ever
//                                         editing a .env file.
//   3. COS_SCRIPTS_DIR/.env regex       — legacy fallback for COS pipeline mode.
//
// Cached after first successful resolution. clearCachedKey() is exposed so the
// new POST/DELETE handlers can force a re-read after the user updates the key.
//
// Throws if no key is reachable so callers can choose to surface a clean
// 401/503 instead of a network attempt.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COS_SCRIPTS_DIR } from './python-bridge.js'
import { secureExistingPrivateFile } from './secure-user-config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Path to the phone-set key file. Lives next to other server-managed JSON
 *  state in server/data/. The directory is gitignored so the key never lands
 *  in version control. */
import { dataPath } from './data-dir.js'
export const KEY_FILE_PATH = dataPath('openai-key.json')

/** Source of the currently-resolved key. Useful for diagnostics + the
 *  Settings status display ("Active (env)" vs "Active (saved Apr 28)"). */
export type KeySource = 'env' | 'config' | 'scripts-env' | 'none'

interface KeyConfigFile {
  key: string
  savedAt: string
  validatedAt?: string
}

interface ResolvedKey {
  key: string
  source: Exclude<KeySource, 'none'>
  /** ISO timestamp the file was first written (only set when source==='config'). */
  savedAt?: string
  /** ISO timestamp of the last successful /v1/models validation
   *  (only set when source==='config'). */
  validatedAt?: string
}

let cachedResolution: ResolvedKey | null = null

/** Clear the in-process cache so the next getOpenAIKey() / tryGetOpenAIKey()
 *  call re-resolves from disk + env. Call after writing or deleting
 *  server/data/openai-key.json. */
export function clearCachedKey(): void {
  cachedResolution = null
}

function readConfigFile(): KeyConfigFile | null {
  if (!existsSync(KEY_FILE_PATH)) return null
  try {
    secureExistingPrivateFile(KEY_FILE_PATH)
    const raw = readFileSync(KEY_FILE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<KeyConfigFile>
    if (!parsed || typeof parsed.key !== 'string' || !parsed.key.trim()) return null
    return {
      key: parsed.key.trim(),
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
      validatedAt: typeof parsed.validatedAt === 'string' ? parsed.validatedAt : undefined,
    }
  } catch {
    return null
  }
}

function resolveFromScratch(): ResolvedKey | null {
  // 1. process.env wins — supports ad-hoc overrides + the .env file loaded by env.ts
  if (process.env.OPENAI_API_KEY) {
    return { key: process.env.OPENAI_API_KEY, source: 'env' }
  }

  // 2. Phone-set key file (v5.9.5)
  const cfg = readConfigFile()
  if (cfg) {
    return {
      key: cfg.key,
      source: 'config',
      savedAt: cfg.savedAt,
      validatedAt: cfg.validatedAt,
    }
  }

  // 3. COS scripts .env regex fallback
  if (COS_SCRIPTS_DIR) {
    const envPaths = [
      resolve(COS_SCRIPTS_DIR, '.env'),
      resolve(COS_SCRIPTS_DIR, '../../.env'),
    ]
    for (const envPath of envPaths) {
      try {
        const content = readFileSync(envPath, 'utf-8')
        const match = content.match(/^OPENAI_API_KEY=(.+)$/m)
        if (match) {
          return { key: match[1].trim(), source: 'scripts-env' }
        }
      } catch { /* try next */ }
    }
  }

  return null
}

/** Resolve and cache the key, throwing if no source is reachable. */
export function getOpenAIKey(): string {
  if (cachedResolution) return cachedResolution.key
  const resolved = resolveFromScratch()
  if (!resolved) {
    throw new Error('OPENAI_API_KEY not found — set in process.env, save via Settings, or add to COS .env files')
  }
  cachedResolution = resolved
  return resolved.key
}

/** Returns the key if resolvable, else null — for endpoints that need to degrade gracefully. */
export function tryGetOpenAIKey(): string | null {
  try {
    return getOpenAIKey()
  } catch {
    return null
  }
}

/** Diagnostic snapshot for /api/openai-key/status and /api/health.
 *  NEVER returns the actual key string — callers only get the source +
 *  metadata so the Settings panel can render "Active (saved Apr 28)" without
 *  exposing the secret. */
export function getKeyStatus(): {
  hasKey: boolean
  source: KeySource
  savedAt?: string
  validatedAt?: string
} {
  // Force a fresh resolution so we reflect the file/env state at call time.
  // Callers that need the raw key still go through getOpenAIKey() which
  // separately caches.
  const resolved = resolveFromScratch()
  if (!resolved) return { hasKey: false, source: 'none' }
  return {
    hasKey: true,
    source: resolved.source,
    savedAt: resolved.savedAt,
    validatedAt: resolved.validatedAt,
  }
}
