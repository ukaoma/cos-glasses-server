// Fireflies API key storage.
//
// PUSH-ONLY, like the OpenAI key before it: COS Control posts the key, the
// server stores it at 0600 under the data home, and from then on every surface
// gets metadata only. No route, log line, status payload or error message ever
// returns the key.
//
// The env override exists for managed installs that provision secrets outside
// the app. It WINS over the stored file, and `status()` says so, so a user who
// saved a key into a box that already has one in its environment is told which
// one is live instead of being quietly ignored.
//
// DELIBERATELY NOT A SECOND READER OF THE COS PIPELINE .env. speaker-trainer.ts
// reads FIREFLIES_API_KEY out of the COS scripts directory for its own
// (unrelated, pipeline-only) training path. Reading that file here would mean
// saving a key in Control silently enabled a different feature on a pipeline
// Mac; keeping the two sources separate is what makes "a key file alone does
// not enable /api/voice/train" true and testable.

import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { FirefliesBudget, FirefliesClient, createFetchTransport, type FirefliesKeyCheck } from './fireflies-client.js'
import { importsRoot } from './imported-meeting-library.js'
import { securePrivateDirectory, secureExistingPrivateFile } from './secure-user-config.js'

export const FIREFLIES_KEY_ENV = 'FIREFLIES_API_KEY'
export const FIREFLIES_KEY_MIN_LENGTH = 16
export const FIREFLIES_KEY_MAX_LENGTH = 512
/** Printable ASCII with no spaces. A key with whitespace is a paste accident. */
export const FIREFLIES_KEY_PATTERN = /^[\x21-\x7e]+$/

export type FirefliesKeySource = 'env' | 'config' | 'none'

export interface FirefliesKeyStatus {
  configured: boolean
  source: FirefliesKeySource
  savedAt?: string
  validatedAt?: string
  lastCheck?: Omit<FirefliesKeyCheck, 'cached'>
}

export class FirefliesKeyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'FirefliesKeyError'
  }
}

interface KeyFile {
  version: 1
  key: string
  savedAt: string
  validatedAt?: string
  lastCheck?: Omit<FirefliesKeyCheck, 'cached'>
}

export class FirefliesKeyStore {
  readonly path: string

  constructor(options: { path?: string } = {}) {
    this.path = options.path ?? dataPath('fireflies-key.json')
  }

  private read(): KeyFile | null {
    let raw: string
    try {
      secureExistingPrivateFile(this.path)
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as Partial<KeyFile>
      if (typeof parsed?.key !== 'string' || parsed.key.trim().length === 0) return null
      return {
        version: 1,
        key: parsed.key.trim(),
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
        ...(typeof parsed.validatedAt === 'string' ? { validatedAt: parsed.validatedAt } : {}),
        ...(parsed.lastCheck && typeof parsed.lastCheck === 'object' ? { lastCheck: parsed.lastCheck } : {}),
      }
    } catch {
      return null
    }
  }

  private write(file: KeyFile): void {
    securePrivateDirectory(dirname(this.path))
    durableAtomicWriteFileSync(this.path, JSON.stringify(file, null, 2), { mode: 0o600 })
  }

  /** The live key and where it came from, or null when none is reachable. */
  resolve(): { key: string; source: Exclude<FirefliesKeySource, 'none'> } | null {
    const fromEnv = process.env[FIREFLIES_KEY_ENV]?.trim()
    if (fromEnv) return { key: fromEnv, source: 'env' }
    const file = this.read()
    return file ? { key: file.key, source: 'config' } : null
  }

  key(): string | null {
    return this.resolve()?.key ?? null
  }

  save(rawKey: unknown): { savedAt: string } {
    if (typeof rawKey !== 'string') {
      throw new FirefliesKeyError(400, 'key_required', 'A Fireflies API key is required.')
    }
    const key = rawKey.trim()
    if (key.length < FIREFLIES_KEY_MIN_LENGTH || key.length > FIREFLIES_KEY_MAX_LENGTH) {
      throw new FirefliesKeyError(400, 'key_length_invalid', `The key should be ${FIREFLIES_KEY_MIN_LENGTH} to ${FIREFLIES_KEY_MAX_LENGTH} characters.`)
    }
    if (!FIREFLIES_KEY_PATTERN.test(key)) {
      throw new FirefliesKeyError(400, 'key_shape_invalid', 'The key contains spaces or characters a Fireflies key never has.')
    }
    const savedAt = new Date().toISOString()
    this.write({ version: 1, key, savedAt })
    return { savedAt }
  }

  delete(): void {
    try {
      const stat = lstatSync(this.path)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new FirefliesKeyError(500, 'key_path_unsafe', 'The stored key path is not a regular file.')
      }
      unlinkSync(this.path)
    } catch (error) {
      if (error instanceof FirefliesKeyError) throw error
      // Absent is the desired end state.
    }
  }

  /** Remember what the vendor said, so status does not have to spend a call. */
  recordCheck(check: FirefliesKeyCheck): void {
    const file = this.read()
    if (!file) return
    const { cached: _cached, ...rest } = check
    this.write({
      ...file,
      ...(check.state === 'ok' ? { validatedAt: check.checkedAt } : {}),
      lastCheck: rest,
    })
  }

  status(): FirefliesKeyStatus {
    const file = this.read()
    const resolved = this.resolve()
    if (!resolved) return { configured: false, source: 'none' }
    return {
      configured: true,
      source: resolved.source,
      ...(file?.savedAt ? { savedAt: file.savedAt } : {}),
      ...(file?.validatedAt ? { validatedAt: file.validatedAt } : {}),
      ...(file?.lastCheck ? { lastCheck: file.lastCheck } : {}),
    }
  }
}

let keyStore: FirefliesKeyStore | null = null
let budget: FirefliesBudget | null = null
let client: FirefliesClient | null = null

export function getFirefliesKeyStore(): FirefliesKeyStore {
  keyStore ??= new FirefliesKeyStore()
  return keyStore
}

export function getFirefliesBudget(): FirefliesBudget {
  budget ??= new FirefliesBudget({ path: importsRoot('.fireflies-budget.json') })
  return budget
}

export function getFirefliesClient(): FirefliesClient {
  client ??= new FirefliesClient({
    transport: createFetchTransport(),
    key: () => getFirefliesKeyStore().key(),
    budget: getFirefliesBudget(),
  })
  return client
}
