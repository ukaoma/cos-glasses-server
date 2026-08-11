import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Test isolation for the data home. Added 2026-08-11 after the suite caused real
 * production damage.
 *
 * WHAT HAPPENED. `server/lib/data-dir.ts` resolves DATA_DIR from COS_DATA_DIR and
 * otherwise defaults to ~/.cos-glasses/data — the LIVE data home of the running
 * server. There was no vitest config, so isolation was per-file discipline only:
 * 37 of 166 test files set COS_DATA_DIR, and every other file touching a
 * dataPath()-backed module wrote to production. Running a batch of tests on
 * 2026-08-11 13:41:
 *
 *   - wrote openai-whisper-budget.json with usdToday 10.02 against a $5/day cap,
 *     which DISARMED cloud Whisper — the documented fallback for the whisper-server
 *     stall and segfault class — for the rest of the day, on fabricated spend
 *   - drained archive-budget.json to 30/30, after which every archive summary
 *     silently degrades to fallback text with no error
 *   - created 13 archive days dated 1998 and 1999 that the companion's archive list
 *     renders, because listArchiveDates() is a bare readdirSync
 *
 * None of it was visible in a test report. Each test's own cleanup targeted the
 * repo-relative path its module used to resolve, so the writes landed somewhere the
 * cleanup never looked.
 *
 * WHY CONFIG-LEVEL AND NOT PER-FILE. DATA_DIR is a module-scope const evaluated at
 * import time, so a test that sets process.env inside beforeEach is already too
 * late. `test.env` is applied before any test module loads, which is the only point
 * where this can be made true for all 166 files at once. Per-file discipline had
 * 129 chances to be forgotten and was.
 *
 * Files that set COS_DATA_DIR themselves still win — this is a floor, not a ceiling.
 *
 * NOT redirected here, deliberately:
 *   - COS_SCRIPTS_DIR. python-bridge.ts uses it to locate cos_api_bridge.py and
 *     takes an "absent" branch when it is missing, so pointing it at a temp dir
 *     would silently change which code path several tests exercise. Note that
 *     session-log.ts writes .glasses_sessions.jsonl under SCRIPTS_DIR, i.e. inside
 *     a git repo — a real issue, but a module design question, not this one.
 *   - openai-tts-budget.ts, which still resolves its ledger relative to __dirname
 *     rather than dataPath(). That is why routes/tts.test.ts wipes a cost ledger in
 *     the checkout on every run. Migrating it belongs with that fix.
 */
const isolatedDataDir = mkdtempSync(join(tmpdir(), 'cos-server-test-data-'))

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts'],
    env: {
      COS_DATA_DIR: isolatedDataDir,
      COS_PROFILE_PATH: join(isolatedDataDir, '.cos-profile.json'),
    },
  },
})
