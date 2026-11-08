/**
 * "Show files and images your sessions make" (6.99.35). Miles asked where a person opts in to the images (6.99.28) and
 * files (SendUserFile) Control Web shows from a session's project folder. This is that switch, stored the way the
 * Today summary switch is (lib/today-brief.ts): a small private JSON file in the data folder, written atomically.
 *
 * - DEFAULT ON, as both features shipped.
 * - The Settings toggle (Control Web, Settings, Privacy) saves { schema: 1, enabled } to web-session-files-settings.json.
 * - COS_WEB_SESSION_FILES=0 (or false, off) on the Mac forces it OFF, whatever was saved. No value forces it on: an
 *   environment that wants previews leaves the variable unset.
 * - Read on every request, so a change applies at once and a restart is never needed.
 *
 * Off means: GET .../output-images/:id/content and .../output-files/:id/content answer 403 previews_off before any
 * transcript or file is read, and the session detail's turns carry `previewsOff: true` instead of image and file
 * descriptors (withoutPreviews), so not even a name reaches the browser.
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { readSwitch } from './env-switch.js'
import { securePrivateDirectory } from './secure-user-config.js'
import type { SessionTurn } from './agent-session-turns.js'

export const SESSION_FILES_SETTINGS_FILE = 'web-session-files-settings.json'
export type SessionFilesSource = 'env' | 'settings' | 'default'
export interface SessionFilesSetting { enabled: boolean; source: SessionFilesSource; saved: boolean | null }
export interface SessionFilesSettingStore {
  read(): SessionFilesSetting
  set(enabled: boolean): SessionFilesSetting
}

export function createSessionFilesSetting(deps: { file: () => string; env?: () => Record<string, string | undefined> }): SessionFilesSettingStore {
  const env = deps.env ?? (() => process.env)
  const saved = (): boolean | null => {
    try {
      const raw = JSON.parse(readFileSync(deps.file(), 'utf8')) as unknown
      if (raw && typeof raw === 'object' && (raw as { schema?: unknown }).schema === 1 && typeof (raw as { enabled?: unknown }).enabled === 'boolean') {
        return (raw as { enabled: boolean }).enabled
      }
    } catch { /* absent or damaged: nothing saved */ }
    return null
  }
  const store: SessionFilesSettingStore = {
    read() {
      const s = saved()
      // Only an off value forces anything; readSwitch with an ON fallback is false exactly for 0, false and off.
      if (!readSwitch(env().COS_WEB_SESSION_FILES, true)) return { enabled: false, source: 'env', saved: s }
      if (s !== null) return { enabled: s, source: 'settings', saved: s }
      return { enabled: true, source: 'default', saved: null }
    },
    set(enabled) {
      const file = deps.file()
      securePrivateDirectory(dirname(file))
      durableAtomicWriteFileSync(file, JSON.stringify({ schema: 1, enabled }) + '\n', { mode: 0o600 })
      return store.read()
    },
  }
  return store
}

/** The server's switch, in the data folder. */
export const sessionFilesSetting = createSessionFilesSetting({ file: () => dataPath(SESSION_FILES_SETTINGS_FILE) })

/** Turns with every image and file descriptor removed and `previewsOff` marked where there were any. Pure. */
export function withoutPreviews(turns: SessionTurn[]): SessionTurn[] {
  return turns.map(t => {
    if (!t.outputImages?.length && !t.outputFiles?.length) return t
    const { outputImages: _i, outputFiles: _f, ...rest } = t
    return { ...rest, previewsOff: true as const }
  })
}
