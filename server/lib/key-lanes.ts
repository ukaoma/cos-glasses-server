// Key lanes (K1, plan v4 section 3): the two predicates every key-lane branch starts with.
//
//   keyLanesEnabled()  COS_KEY_LANES=1, or data/key-lanes.json says enabled:true.
//                      COS_KEY_LANES=0 forces off and wins over the file.
//   keyLanesActive()   enabled AND provider-profiles.json holds at least one enabled profile.
//
// HARD RULE (zero impact without a key): with the switch off nothing here creates a file, opens a
// socket, starts a timer or adds a response field. Reading never creates. Every new branch in the
// server starts `if (!keyLanesActive()) return <old path>` (or keyLanesEnabled() for the exposure
// list rows), before any other new work.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { DATA_DIR, dataPath } from './data-dir.js'
import { enabledProfileCount, listProfiles } from './key-profiles.js'
import { listPublicKeys } from './key-store.js'
import type {
  KeyLanesHealthDetail,
  KeyLanesInactiveHook,
  KeyLanesInactiveReason,
  KeyLanesStatusProvider,
  PublicKeyProfileOption,
} from './key-relay-contract.js'

export const KEY_LANES_ENV = 'COS_KEY_LANES'
export const KEY_LANES_STATE_FILE = 'key-lanes.json'

export type KeyLanesEnvSwitch = 'on' | 'off' | 'unset'

/** Exactly `1` is on and exactly `0` is off; anything else (absent, empty, `true`) is unset. */
export function keyLanesEnvSwitch(env: NodeJS.ProcessEnv = process.env): KeyLanesEnvSwitch {
  const raw = env[KEY_LANES_ENV]?.trim()
  if (raw === '1') return 'on'
  if (raw === '0') return 'off'
  return 'unset'
}

export function keyLanesStatePath(): string {
  return dataPath(KEY_LANES_STATE_FILE)
}

interface KeyLanesStateFile {
  v: 1
  enabled: boolean
  updatedAt: string
}

/** The file's `enabled`, or null when it is missing or unreadable. Never writes. */
function readStateFileEnabled(): boolean | null {
  const file = keyLanesStatePath()
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<KeyLanesStateFile>
    return parsed && typeof parsed === 'object' && parsed.enabled === true
  } catch {
    // A torn or foreign file reads as off. It is never repaired or rewritten from a read.
    return false
  }
}

// The file is read once (the first call, at boot in practice) and again on enable/disable.
let fileEnabled: boolean | null | undefined

export function keyLanesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const sw = keyLanesEnvSwitch(env)
  if (sw === 'off') return false
  if (sw === 'on') return true
  if (fileEnabled === undefined) fileEnabled = readStateFileEnabled()
  return fileEnabled === true
}

export function keyLanesActive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!keyLanesEnabled(env)) return false
  return enabledProfileCount() > 0
}

/**
 * Write the state file (the enable and disable routes, and Remove all keys). This is the ONLY
 * writer of key-lanes.json. 0600, atomic, in a 0700 data dir.
 */
export function setKeyLanesEnabled(enabled: boolean, now: () => Date = () => new Date()): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const body: KeyLanesStateFile = { v: 1, enabled, updatedAt: now().toISOString() }
  durableAtomicWriteFileSync(keyLanesStatePath(), JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
  fileEnabled = enabled
}

/** Re-read the state file on the next predicate call. */
export function refreshKeyLanesEnabled(): void {
  fileEnabled = undefined
}

// ── Response fields (plan 3.1 exposure list). Omitted, never null, when off. ──

/** `/api/health`: `details.keyLanes` while enabled, nothing at all otherwise. */
export function keyLanesHealthFields(env: NodeJS.ProcessEnv = process.env): { details?: { keyLanes: KeyLanesHealthDetail } } {
  if (!keyLanesEnabled(env)) return {}
  return { details: { keyLanes: { enabled: true, active: keyLanesActive(env) } } }
}

/** `/api/models`: `keyProfiles` while active (enabled profiles whose key still exists), nothing otherwise. */
export function keyProfilesModelsField(env: NodeJS.ProcessEnv = process.env): { keyProfiles?: PublicKeyProfileOption[] } {
  if (!keyLanesActive(env)) return {}
  const kinds = new Map(listPublicKeys().map(k => [k.ref, k.kind]))
  const keyProfiles: PublicKeyProfileOption[] = []
  for (const p of listProfiles()) {
    const keyKind = kinds.get(p.keyRef)
    if (!p.enabled || !keyKind) continue
    keyProfiles.push({ id: p.id, label: p.label, engine: p.engine, model: p.model, keyKind, timeoutTier: p.timeoutTier })
  }
  return { keyProfiles }
}

// ── Seams other packages register into (P2 relay, P3 keyed sessions, P6 bindings). ──

let statusProvider: KeyLanesStatusProvider = {}
const inactiveHooks = new Map<string, KeyLanesInactiveHook>()

export function registerKeyLanesStatusProvider(provider: KeyLanesStatusProvider): void {
  statusProvider = { ...statusProvider, ...provider }
}

export function keyLanesStatusProvider(): KeyLanesStatusProvider {
  return statusProvider
}

/** Named so a re-registration replaces rather than stacks. */
export function onKeyLanesInactive(name: string, hook: KeyLanesInactiveHook): void {
  inactiveHooks.set(name, hook)
}

/** Run every hook; one failing hook never stops the others. Returns the names that threw. */
export async function runKeyLanesInactiveHooks(reason: KeyLanesInactiveReason): Promise<string[]> {
  const failed: string[] = []
  for (const [name, hook] of inactiveHooks) {
    try { await hook(reason) } catch { failed.push(name) }
  }
  return failed
}

/** Tests only: forget the cached file read and every registration. */
export function __resetKeyLanesForTests(): void {
  fileEnabled = undefined
  statusProvider = {}
  inactiveHooks.clear()
}
