// 6.78.0 (P7 S3): the one reader every 6.78.0 switch uses, and proof each switch reads through it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSwitch } from './env-switch.js'
import { isCrashLoopParkingEnabled } from './boot-resume.js'
import { messagesSteerEnabled, queryJobDeltaJournalEnabled, restartNoticeEnabled } from './query-job-feature.js'
import { pinBootReapEnabled, queueReconcileEnabled, queueResendEnabled, sessionSteerEnabled } from './thread-turn-queue.js'

describe('readSwitch', () => {
  it('1, true and on are on; 0, false and off are off; case and space are ignored; anything else is the default', () => {
    for (const fallback of [true, false]) {
      for (const value of ['1', 'true', 'on', ' On ', 'TRUE']) expect(readSwitch(value, fallback), value).toBe(true)
      for (const value of ['0', 'false', 'off', ' OFF ', 'False']) expect(readSwitch(value, fallback), value).toBe(false)
      for (const value of [undefined, '', ' ', 'yes', 'no', '2', '01']) expect(readSwitch(value, fallback), String(value)).toBe(fallback)
    }
  })
})

/** The eight 6.78.0 switches, their reader and their default. */
const SWITCHES_678: Array<[string, (env: NodeJS.ProcessEnv) => boolean, boolean]> = [
  ['COS_CRASH_LOOP_PARKING', env => isCrashLoopParkingEnabled(env), true],
  ['COS_RESTART_NOTICE', env => restartNoticeEnabled(env), true],
  ['COS_QUERY_JOB_DELTA_JOURNAL', env => queryJobDeltaJournalEnabled(env), false],
  ['COS_MESSAGES_STEER', env => messagesSteerEnabled(env), false],
  ['COS_QUEUE_RECONCILE', env => queueReconcileEnabled(env), true],
  ['COS_PIN_BOOT_REAP', env => pinBootReapEnabled(env), true],
  ['COS_QUEUE_RESEND', env => queueResendEnabled(env), true],
  ['COS_SESSION_STEER', env => sessionSteerEnabled(env), false],
]

describe('every 6.78.0 switch reads through it', () => {
  const switches = SWITCHES_678
  for (const [name, read, fallback] of switches) {
    it(`${name} (default ${fallback ? 'on' : 'off'})`, () => {
      for (const value of [undefined, '', 'yes', '1', 'true', 'on', '0', 'false', 'off', ' Off ']) {
        expect(read({ [name]: value } as NodeJS.ProcessEnv), `${name}=${value}`).toBe(readSwitch(value, fallback))
      }
    })
  }

  it('the eight are all the 6.78.0 switches in the managed runtime contract', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    for (const [name] of switches) expect(contract.optionalEnvironment, name).toContain(name)
  })
})
