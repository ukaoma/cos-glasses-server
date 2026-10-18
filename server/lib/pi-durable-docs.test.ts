// 6.78.0 (P7 S11): the README names every 6.78.0 switch, so a person can find the kill switch
// for each feature without reading .env.example or the source.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SWITCHES = ['COS_CRASH_LOOP_PARKING', 'COS_RESTART_NOTICE', 'COS_QUERY_JOB_DELTA_JOURNAL', 'COS_MESSAGES_STEER',
  'COS_QUEUE_RECONCILE', 'COS_PIN_BOOT_REAP', 'COS_QUEUE_RESEND', 'COS_SESSION_STEER']

describe('6.78.0 switches in the docs', () => {
  it('the README names each one, and so do .env.example and the managed runtime contract', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    for (const name of SWITCHES) {
      expect(readme, name).toContain(`\`${name}\``)
      expect(example, name).toMatch(new RegExp(`^# ${name}=`, 'm'))
      expect(contract.optionalEnvironment, name).toContain(name)
    }
  })
})
