// X1, 7.0.34: the server-side question-hold setting that Control's Settings row writes
// (`PUT /api/session-hooks/question-hold`). One small file in the COS home: `{"mode":"on"}` or `{"mode":"off"}`.
// No file means the default (lib/full-hold.ts `questionHoldMode`). `COS_QUESTION_FULL_HOLD` in the environment
// always wins over this file; the route says so (`source: "env"`) rather than writing something that cannot apply.
//
// Read on every call, never cached: the broker reads it per question and the status per refresh, and a stale
// value after a Settings click would be a hold the person just turned off. The file is a few bytes.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-fs.js'
import { cosGlassesHome } from './claude-hooks-installer.js'
import type { QuestionHoldSetting } from './full-hold.js'

export const QUESTION_HOLD_SETTING_FILE = 'question-hold.json'

export function questionHoldSettingPath(home: string = cosGlassesHome()): string {
  return join(home, QUESTION_HOLD_SETTING_FILE)
}

/** `on`, `off`, or null for no setting (the default). An unreadable or malformed file is no setting. */
export function readQuestionHoldSetting(path: string = questionHoldSettingPath()): QuestionHoldSetting | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { mode?: unknown }
    return parsed && (parsed.mode === 'on' || parsed.mode === 'off') ? parsed.mode : null
  } catch {
    return null
  }
}

/** `on` or `off` writes the file; `default` removes it. */
export function writeQuestionHoldSetting(mode: QuestionHoldSetting | 'default', path: string = questionHoldSettingPath()): void {
  if (mode === 'default') {
    if (existsSync(path)) rmSync(path, { force: true })
    return
  }
  atomicWriteFileSync(path, JSON.stringify({ mode }) + '\n', { mode: 0o600 })
}
