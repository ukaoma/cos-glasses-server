import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { chmodSync, mkdirSync } from 'node:fs'

// Runtime state directory. Defaults to ~/.cos-glasses/data — a writable location
// that survives `npx` cache churn and works on global/Docker installs. (Writing
// inside the package dir would crash on a read-only install and lose state +
// the saved OpenAI key across upgrades.) Override with COS_DATA_DIR.
export const DATA_DIR = process.env.COS_DATA_DIR
  ? resolve(process.env.COS_DATA_DIR)
  : join(homedir(), '.cos-glasses', 'data')

try {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  chmodSync(DATA_DIR, 0o700)
} catch { /* best effort — individual writers also tolerate a missing dir */ }

/** Build a path under the runtime data directory. */
export function dataPath(...parts: string[]): string {
  return join(DATA_DIR, ...parts)
}
