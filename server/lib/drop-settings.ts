/**
 * Drop it is OFF for every user by default (plan decision 4: on for Miles's Mac at the candidate, listed before any
 * promotion). Two ways to turn it on, read at every request so no restart is needed for the file:
 * - COS_DROP_IT in the server's environment wins when it is set (1, true, yes, on; anything else is off);
 * - otherwise `data/drop-it-settings.json` `{ "enabled": true }`, written by PUT /api/drops/settings from Control.
 * A missing, unreadable or malformed file reads as off.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { securePrivateDirectory } from './secure-user-config.js'
import { MAX_ATTACHMENTS_PER_PROMPT } from '../../shared/media-attachment.js'

export const DROP_IT_PROTOCOL = 1
/** 6.99.13: files one drop takes, the Ask's own cap (shared/media-attachment.ts MAX_ATTACHMENTS_PER_PROMPT). */
export const DROP_ATTACHMENTS_MAX = MAX_ATTACHMENTS_PER_PROMPT
export const DROP_IT_SETTINGS_FILE = () => dataPath('drop-it-settings.json')

export function dropItSetting(file = DROP_IT_SETTINGS_FILE()): boolean {
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) return false
    const value = JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown }
    return value?.enabled === true
  } catch { return false }
}
export function dropItEnvValue(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const raw = env.COS_DROP_IT
  if (raw === undefined || raw.trim() === '') return null
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}
export function dropItEnabled(env: NodeJS.ProcessEnv = process.env, file = DROP_IT_SETTINGS_FILE()): boolean {
  return dropItEnvValue(env) ?? dropItSetting(file)
}
export function dropItSource(env: NodeJS.ProcessEnv = process.env): 'env' | 'settings' {
  return dropItEnvValue(env) === null ? 'settings' : 'env'
}
export function writeDropItSetting(enabled: boolean, file = DROP_IT_SETTINGS_FILE()): void {
  securePrivateDirectory(dirname(file))
  durableAtomicWriteFileSync(file, JSON.stringify({ enabled }) + '\n', { mode: 0o600 })
}

/** The capability block for /api/health and /api/models. Codes only: no counts, no words. Additive. */
export function dropItCapability(env: NodeJS.ProcessEnv = process.env, file = DROP_IT_SETTINGS_FILE()): { protocol: number; enabled: boolean; source: 'env' | 'settings'; p2Settings: number; attachments: number; thread?: { protocol: number } } {
  // p2Settings (6.99.11): GET/PUT /api/drops/settings/p2 exists. Clients that do not see it hide the P2 controls.
  // attachments (6.99.13): POST /api/drops takes this many attachmentIds. A client that does not see it sends words only.
  // thread (6.99.16): the COS thread routes (routes/cos-thread.ts), present only while Drop it is on, as they are.
  const enabled = dropItEnabled(env, file)
  return {
    protocol: DROP_IT_PROTOCOL, enabled, source: dropItSource(env), p2Settings: 1, attachments: DROP_ATTACHMENTS_MAX,
    ...(enabled ? { thread: { protocol: COS_THREAD_CAPABILITY_PROTOCOL } } : {}),
  }
}
/** 6.99.16: the COS thread's protocol (lib/cos-thread.ts COS_THREAD_PROTOCOL; kept here so this module imports nothing new). */
export const COS_THREAD_CAPABILITY_PROTOCOL = 1
