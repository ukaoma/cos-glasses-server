// Key lanes (K1, plan v4 sections 4, 10.3, 12): the saved provider keys, `data/provider-keys.json`.
//
// The only file on the Mac that holds a real key. 0600, written atomically into the 0700 data
// dir, never followed through a symlink. Nothing here logs a secret, and the only function that
// returns one is readKeySecretForRelay (P2's relay and P5's in-process direct lane). Routes,
// health, diagnostics and ledgers get PublicKeyRecord: ref, kind, last 4, cap, times.
//
// Reading never creates: a missing file is an empty store, a corrupt one reads as empty and is
// left exactly where it is.
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { DATA_DIR, dataPath } from './data-dir.js'
import type { KeyKind, KeyRef, PublicKeyRecord } from './key-relay-contract.js'
import { KEY_KINDS, KEY_REF_RE } from './key-relay-contract.js'

export const KEY_STORE_FILE = 'provider-keys.json'
export const DEFAULT_KEY_CAP_USD = 1.0
export const KEY_CAP_LIMITS = { minUsd: 0.01, maxUsd: 1000 } as const
const MAX_SECRET_CHARS = 512

interface StoredKey extends PublicKeyRecord {
  secret: string
}
interface KeyStoreFile {
  v: 1
  keys: StoredKey[]
}

export function keyStorePath(): string {
  return dataPath(KEY_STORE_FILE)
}

/** Parse a private JSON state file without creating, repairing or moving anything. */
export function readPrivateJsonFile(file: string): unknown {
  if (!existsSync(file)) return undefined
  const st = lstatSync(file)
  if (st.isSymbolicLink() || !st.isFile()) return undefined
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

/** Atomic 0600 write into the 0700 data dir. */
export function writePrivateJsonFile(file: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('refusing to write through a symlink')
  durableAtomicWriteFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

function isStoredKey(v: unknown): v is StoredKey {
  if (!v || typeof v !== 'object') return false
  const k = v as Partial<StoredKey>
  return typeof k.ref === 'string' && KEY_REF_RE.test(k.ref)
    && typeof k.kind === 'string' && (KEY_KINDS as readonly string[]).includes(k.kind)
    && typeof k.secret === 'string' && k.secret.length > 0
    && typeof k.capUsd === 'number' && Number.isFinite(k.capUsd)
    && typeof k.savedAt === 'string'
}

let cache: { stamp: string; keys: StoredKey[] } | null = null

function readStore(): StoredKey[] {
  const file = keyStorePath()
  let stamp: string
  try {
    const st = statSync(file)
    stamp = `${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {
    cache = null
    return []
  }
  if (cache?.stamp === stamp) return cache.keys
  const parsed = readPrivateJsonFile(file) as Partial<KeyStoreFile> | undefined
  const keys = parsed && Array.isArray(parsed.keys) ? parsed.keys.filter(isStoredKey) : []
  cache = { stamp, keys }
  return keys
}

function writeStore(keys: StoredKey[]): void {
  const body: KeyStoreFile = { v: 1, keys }
  writePrivateJsonFile(keyStorePath(), body)
  cache = null
}

function toPublic(k: StoredKey): PublicKeyRecord {
  return {
    ref: k.ref,
    kind: k.kind,
    last4: k.last4,
    capUsd: k.capUsd,
    savedAt: k.savedAt,
    ...(k.validatedAt ? { validatedAt: k.validatedAt } : {}),
    ...(k.kind === 'openai-compatible' && k.baseUrl ? { baseUrl: k.baseUrl } : {}),
  }
}

export function listPublicKeys(): PublicKeyRecord[] {
  return readStore().map(toPublic)
}

export function getPublicKey(ref: string): PublicKeyRecord | undefined {
  const k = readStore().find(x => x.ref === ref)
  return k ? toPublic(k) : undefined
}

/** P2 relay and P5 direct lane ONLY. No route, health field, log or diagnostic may call this. */
export function readKeySecretForRelay(ref: KeyRef): string | null {
  return readStore().find(x => x.ref === ref)?.secret ?? null
}

// ── Validation (shape only; the provider check is in routes/key-lanes.ts) ──

export function isKeyKind(v: unknown): v is KeyKind {
  return typeof v === 'string' && (KEY_KINDS as readonly string[]).includes(v)
}

/** A plain-language refusal, or null when the secret has the right shape for its kind. */
export function keyShapeProblem(kind: KeyKind, secret: unknown): string | null {
  if (typeof secret !== 'string' || !secret.trim()) return 'Paste the key.'
  const s = secret.trim()
  if (s.length > MAX_SECRET_CHARS || /\s/.test(s) || !/^[\x21-\x7e]+$/.test(s)) return 'That does not look like a key. Paste it again.'
  if (kind === 'openrouter' && !s.startsWith('sk-or-')) return 'That is not an OpenRouter key. It starts with sk-or-.'
  if (kind === 'anthropic' && !s.startsWith('sk-ant-')) return 'That is not an Anthropic key. It starts with sk-ant-.'
  if (kind === 'openai' && !s.startsWith('sk-')) return 'That is not an OpenAI key. It starts with sk-.'
  if (s.length < 20) return 'That key is too short. Paste the whole key.'
  return null
}

/** A cap in USD rounded to cents, or null when out of range. Absent means the default. */
export function normalizeCapUsd(v: unknown): number | null {
  if (v === undefined) return DEFAULT_KEY_CAP_USD
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const cents = Math.round(v * 100) / 100
  return cents >= KEY_CAP_LIMITS.minUsd && cents <= KEY_CAP_LIMITS.maxUsd ? cents : null
}

/** A custom OpenAI-compatible base URL (Mac only), normalized without a trailing slash, or null. */
export function normalizeCompatibleBaseUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null
  try {
    const u = new URL(v.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.username || u.password || u.search || u.hash) return null
    return u.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

export interface SaveKeyInput {
  kind: KeyKind
  secret: string
  capUsd: number
  validatedAt?: string
  baseUrl?: string
}

/** Save a validated key. The same secret saved twice keeps its ref (cap and times refresh). */
export function saveKey(input: SaveKeyInput, now: () => Date = () => new Date()): PublicKeyRecord {
  const secret = input.secret.trim()
  const keys = [...readStore()]
  const at = now().toISOString()
  const existing = keys.findIndex(k => k.kind === input.kind && k.secret === secret)
  const record: StoredKey = {
    ref: existing >= 0 ? keys[existing].ref : `key_${randomBytes(6).toString('hex')}`,
    kind: input.kind,
    secret,
    last4: secret.slice(-4),
    capUsd: input.capUsd,
    savedAt: existing >= 0 ? keys[existing].savedAt : at,
    ...(input.validatedAt ? { validatedAt: input.validatedAt } : {}),
    ...(input.kind === 'openai-compatible' && input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  }
  if (existing >= 0) keys[existing] = record
  else keys.push(record)
  writeStore(keys)
  return toPublic(record)
}

/** Change one key's daily cap (Control's last saved value is the one that counts, plan 4.5). */
export function updateKeyCap(ref: string, capUsd: number): PublicKeyRecord | undefined {
  const keys = [...readStore()]
  const i = keys.findIndex(k => k.ref === ref)
  if (i < 0) return undefined
  keys[i] = { ...keys[i], capUsd }
  writeStore(keys)
  return toPublic(keys[i])
}

/** Remove all keys (plan 12). True when a file was deleted. */
export function deleteKeyStore(): boolean {
  cache = null
  const file = keyStorePath()
  if (!existsSync(file)) return false
  unlinkSync(file)
  return true
}
