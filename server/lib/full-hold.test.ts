// X1: the full hold's switches and its engine gate (lib/full-hold.ts).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { approvalFullHoldEnabled, engineProvenForFullHold, fullHoldSwitches, parseEngineVersion, questionFullHoldEnabled, versionAtLeast, waitingQuestionWordsEnabled } from './full-hold.js'

describe('the switches', () => {
  it('both full-hold switches default OFF', () => {
    expect(fullHoldSwitches({})).toEqual({ questions: false, approvals: false })
  })
  it('the row-words switch defaults ON (Miles 22:10) and reads off only for an explicit off', () => {
    expect(waitingQuestionWordsEnabled({})).toBe(true)
    for (const off of ['0', 'false', 'off']) expect(waitingQuestionWordsEnabled({ COS_WAITING_QUESTION_WORDS: off })).toBe(false)
  })
  it('read the one switch grammar, each its own name', () => {
    for (const on of ['1', 'true', 'on', ' ON ']) {
      expect(questionFullHoldEnabled({ COS_QUESTION_FULL_HOLD: on })).toBe(true)
      expect(approvalFullHoldEnabled({ COS_APPROVAL_FULL_HOLD: on })).toBe(true)
      expect(waitingQuestionWordsEnabled({ COS_WAITING_QUESTION_WORDS: on })).toBe(true)
    }
    for (const off of ['0', 'false', 'off', '', 'yes', '2']) {
      expect(questionFullHoldEnabled({ COS_QUESTION_FULL_HOLD: off })).toBe(false)
      expect(approvalFullHoldEnabled({ COS_APPROVAL_FULL_HOLD: off })).toBe(false)
    }
    expect(fullHoldSwitches({ COS_QUESTION_FULL_HOLD: '1' })).toEqual({ questions: true, approvals: false })
    expect(fullHoldSwitches({ COS_APPROVAL_FULL_HOLD: '1' })).toEqual({ questions: false, approvals: true })
  })
})

describe('the engine gate', () => {
  it('admits the proven floors and anything newer', () => {
    for (const engine of [
      { entrypoint: 'cli', version: '2.1.321', host: 'terminal' }, { entrypoint: 'cli', version: '2.1.400', host: 'terminal' }, { entrypoint: 'cli', version: '2.2', host: 'terminal' }, { entrypoint: 'cli', version: '3.0.0', host: 'terminal' },
      { entrypoint: 'claude-desktop', version: '2.1.317', host: 'desktop-app' }, { entrypoint: 'claude-desktop', version: '2.1.318', host: 'desktop-app' },
    ] as const) expect(engineProvenForFullHold(engine)).toBe(true)
  })
  it('refuses a proven version running where its dialog is not (a print run, a mislabelled host, no host read)', () => {
    for (const engine of [
      { entrypoint: 'cli', version: '2.1.322', host: 'other' }, { entrypoint: 'cli', version: '2.1.322', host: 'desktop-app' }, { entrypoint: 'cli', version: '2.1.322' },
      { entrypoint: 'claude-desktop', version: '2.1.317', host: 'other' }, { entrypoint: 'claude-desktop', version: '2.1.317', host: 'terminal' }, { entrypoint: 'claude-desktop', version: '2.1.317' },
    ]) expect(engineProvenForFullHold(engine as never)).toBe(false)
  })
  it('refuses older, unknown, unparseable and missing', () => {
    for (const engine of [
      null, undefined, { entrypoint: null, version: '9.9.9', host: 'terminal' }, { entrypoint: 'cli', version: '2.1.320', host: 'terminal' }, { entrypoint: 'cli', version: '2.0.999', host: 'terminal' }, { entrypoint: 'cli', version: '1.9.400', host: 'terminal' },
      { entrypoint: 'claude-desktop', version: '2.1.316', host: 'desktop-app' }, { entrypoint: 'sdk-cli', version: '2.1.400', host: 'terminal' }, { entrypoint: 'cli', version: null, host: 'terminal' },
      { entrypoint: 'cli', version: '2.1.321-beta', host: 'terminal' }, { entrypoint: 'cli', version: 'v2.1.321', host: 'terminal' }, { entrypoint: '__proto__', version: '9', host: 'terminal' }, { entrypoint: 'toString', version: '9', host: 'terminal' },
      // An entrypoint with no floor and no host entry: only the own-property guard stands between it and a missing floor.
      { entrypoint: 'vscode', version: '9.9.9' }, { entrypoint: 'vscode', version: '9.9.9', host: undefined },
    ]) expect(engineProvenForFullHold(engine as never)).toBe(false)
  })
  it('compares part by part', () => {
    expect(parseEngineVersion('2.1.321')).toEqual([2, 1, 321])
    expect(parseEngineVersion('2.1.321.4')).toEqual([2, 1, 321, 4])
    expect(parseEngineVersion('2.1.321.4.5')).toBeNull()
    expect(versionAtLeast([2, 1, 321], [2, 1, 321])).toBe(true)
    expect(versionAtLeast([2, 1], [2, 1, 1])).toBe(false)
    expect(versionAtLeast([2, 10, 0], [2, 9, 999])).toBe(true)
  })
})

describe('the documented route (final review S6)', () => {
  // A Control-managed server reads ~/.cos-glasses/.env itself (server/env.ts, loaded first by bootstrap.ts),
  // so these work there; listing them is what documents them and what the managed contract promises.
  it('all three switches are in the managed runtime contract and in .env.example, commented out at their non-default values', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
    for (const [key, shown] of [['COS_QUESTION_FULL_HOLD', '1'], ['COS_APPROVAL_FULL_HOLD', '1'], ['COS_WAITING_QUESTION_WORDS', '0']] as const) {
      expect(contract.optionalEnvironment, key).toContain(key)
      expect(example, key).toContain(`\n# ${key}=${shown}\n`)
      // Never set live by the example: an uncommented line would turn it on for anyone who copies the file.
      expect(example, key).not.toMatch(new RegExp(`^${key}=`, 'm'))
    }
  })
})
