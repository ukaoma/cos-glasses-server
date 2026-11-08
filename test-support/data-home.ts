import { mkdtempSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Called by setupFiles, before any product module captures an env-backed path. */
export function allocateTestDataHome(env: NodeJS.ProcessEnv): string {
  const root = env.COS_VITEST_RUN_DATA_DIR
  if (!root || !isAbsolute(root)) {
    throw new Error('Missing absolute COS_VITEST_RUN_DATA_DIR from vitest.config.ts')
  }
  // Always derive from the run root, never a prior file's overridden COS_DATA_DIR.
  // The config process removes the complete run root on exit.
  const home = mkdtempSync(join(root, 'suite-'))
  Object.assign(env, {
    COS_DATA_DIR: home,
    COS_PROFILE_PATH: join(home, '.cos-profile.json'),
    COS_TOKEN_AUDIT_FILE: join(home, 'token-audit.jsonl'),
    COS_CURSOR_SPAWN_ROOT: join(home, 'cursor-cli'),
    COS_CURSOR_SPAWN_SOURCE: join(home, 'cursor-home'),
    COS_MAINTENANCE_GATE_PATH: join(home, 'maintenance', 'maintenance-gate.json'),
  })
  return home
}
