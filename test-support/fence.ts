// Per-fork scratch area for the opt-in fenced test modes (COS_TEST_FENCE=1).
//
// The default run keeps ONE data home for the whole run (vitest.config.ts, added 2026-08-11 after
// the suite damaged live data) and runs one file at a time. Two files running at once would share
// that home and every fixed /tmp file, so a fenced file gets its own: one short directory under
// /tmp per forked test file, holding the data home, HOME and TMPDIR.
//
// SHORT ROOT ON PURPOSE. The occupancy probes bind unix sockets under os.tmpdir(), and a unix
// socket path is capped near 104 bytes on macOS. /tmp/cos-v-AbC123/tmp leaves room; the default
// $TMPDIR under /var/folders and a vitest-generated name did not.
//
// This module lives OUTSIDE server/ and shared/ so the npm `files` list can never pick it up
// (server/lib/package-contents.test.ts asserts it).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'

export const FENCE_FLAG = 'COS_TEST_FENCE'
export const FENCE_ROOT_PREFIX = '/tmp/cos-v-'

export interface Fence {
  root: string
  dataDir: string
  homeDir: string
  tmpDir: string
  cleanup: () => void
}

/** Only the exact string "1" enables the fence; "true", "yes" and "0" do not. */
export function fenceRequested(env: Record<string, string | undefined>): boolean {
  return env[FENCE_FLAG] === '1'
}

/**
 * Point `env` at a private scratch area and return it.
 *
 * Every COS_* value that sits under the shared data home (vitest.config.ts derives five of them
 * from it) is moved to the same relative place under the private one, so a variable added to the
 * config later is fenced without editing this file. COS_* values elsewhere are left alone.
 */
export function applyFence(env: Record<string, string | undefined>, base = FENCE_ROOT_PREFIX): Fence {
  const root = mkdtempSync(base)
  const dataDir = join(root, 'data')
  const homeDir = join(root, 'home')
  const tmpDir = join(root, 'tmp')
  for (const dir of [dataDir, homeDir, tmpDir]) mkdirSync(dir, { recursive: true })

  const shared = env.COS_DATA_DIR
  if (shared) {
    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith('COS_') || value === undefined) continue
      if (value === shared) env[key] = dataDir
      else if (value.startsWith(shared + sep)) env[key] = dataDir + value.slice(shared.length)
    }
  }
  env.COS_DATA_DIR = dataDir
  env.COS_PROFILE_PATH = join(dataDir, '.cos-profile.json')
  env.HOME = homeDir
  env.TMPDIR = tmpDir
  // Fixed /tmp files the live server shares with a test run (override env vars, default unchanged).
  env.COS_CLI_SESSIONS_FILE = join(root, 'cos-cli-sessions.json')
  env.COS_CODEX_ENGINE_SESSIONS_FILE = join(root, 'cos-codex-engine-sessions.json')
  env.COS_CURSOR_ENGINE_SESSIONS_FILE = join(root, 'cos-cursor-engine-sessions.json')
  env.COS_SPEAKER_TRAINING_DIR = join(root, 'cos-speaker-training')
  // Two caches that otherwise resolve inside the checkout (server/data), found by the first
  // live-path snapshot of the unfenced gate: cursor-model-catalog.ts and tts-cache.ts. Both read
  // their override at import, which is why this runs before the test file's imports. The TTS
  // spend LEDGER (openai-tts-budget.json) has no override and deliberately stays where it is.
  env.COS_CURSOR_MODEL_CACHE_FILE = join(dataDir, 'cursor-models-cache.json')
  env.TTS_DISK_CACHE_DIR = join(root, 'tts-cache')

  const cleanup = () => {
    // Only ever remove what this call made.
    if (!root.startsWith(base)) return
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  return { root, dataDir, homeDir, tmpDir, cleanup }
}
