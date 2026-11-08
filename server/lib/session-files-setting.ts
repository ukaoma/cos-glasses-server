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
 * - QA 7.0.0: only a file that is not there (first use) gets the default. A saved file that is damaged, unreadable or
 *   not this schema fails CLOSED (source 'damaged', off): it may have said off, and a privacy switch never turns itself
 *   back on. The Settings row says so, and saving from it writes a good file again.
 *
 * Preview engine phase 1: link cards (outputLinks) and GET /api/preview/... ride the same switch, default on.
 *
 * Off means: GET .../output-images/:id/content, .../output-files/:id/content and .../tool-images/:id/content answer 403 previews_off before any
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
import { withoutLinkMarkers } from './session-links.js'

export const SESSION_FILES_SETTINGS_FILE = 'web-session-files-settings.json'
export type SessionFilesSource = 'env' | 'settings' | 'default' | 'damaged'
export interface SessionFilesSetting { enabled: boolean; source: SessionFilesSource; saved: boolean | null }
export interface SessionFilesSettingStore {
  read(): SessionFilesSetting
  set(enabled: boolean): SessionFilesSetting
}

export function createSessionFilesSetting(deps: { file: () => string; env?: () => Record<string, string | undefined> }): SessionFilesSettingStore {
  const env = deps.env ?? (() => process.env)
  // 'absent' only for ENOENT (first use). Any other read error, bad JSON or a foreign shape is 'damaged'.
  type Saved = { kind: 'absent' } | { kind: 'damaged' } | { kind: 'saved'; enabled: boolean }
  const saved = (): Saved => {
    let text: string
    try { text = readFileSync(deps.file(), 'utf8') } catch (e) {
      return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'damaged' }
    }
    try {
      const raw = JSON.parse(text) as unknown
      if (raw && typeof raw === 'object' && (raw as { schema?: unknown }).schema === 1 && typeof (raw as { enabled?: unknown }).enabled === 'boolean') {
        return { kind: 'saved', enabled: (raw as { enabled: boolean }).enabled }
      }
    } catch { /* damaged */ }
    return { kind: 'damaged' }
  }
  const store: SessionFilesSettingStore = {
    read() {
      const s = saved()
      const value = s.kind === 'saved' ? s.enabled : null
      // Only an off value forces anything; readSwitch with an ON fallback is false exactly for 0, false and off.
      if (!readSwitch(env().COS_WEB_SESSION_FILES, true)) return { enabled: false, source: 'env', saved: value }
      if (s.kind === 'saved') return { enabled: s.enabled, source: 'settings', saved: s.enabled }
      if (s.kind === 'damaged') return { enabled: false, source: 'damaged', saved: null }
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

/** Turns with every image and file descriptor (tool-result and prompt images too) removed and `previewsOff` marked where there were any. Pure. */
export function withoutPreviews(turns: SessionTurn[]): SessionTurn[] {
  return turns.map(t => {
    if (!t.outputImages?.length && !t.outputFiles?.length && !t.toolImages?.length && !t.toolImagesMore && !t.outputLinks?.length) return t
    const { outputImages: _i, outputFiles: _f, toolImages: _t, toolImagesMore: _m, outputLinks: _l, ...rest } = t
    // Preview engine phase 1: link cards ride this switch. Off, a card marker turns back into the link's words, so not
    // even a count reaches the browser. The Mac path was already gone from the text (session-links.ts).
    return { ...rest, ...(_l?.length ? { text: withoutLinkMarkers(rest.text) } : {}), previewsOff: true as const }
  })
}
