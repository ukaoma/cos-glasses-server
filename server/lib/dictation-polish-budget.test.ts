import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  localDay, polishBudgetExhausted, polishCountToday, polishDailyCap, recordPolishCall,
} from './dictation-polish-budget.js'

let dir = ''
const file = () => join(dir, 'count.json')

describe('6.79.1 per-caller polish budgets', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cos-polish-budget-'))
    process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE = file()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE
    rmSync(dir, { recursive: true, force: true })
  })

  it('defaults: message 300, meeting 200, prompt draft 200', () => {
    expect(polishDailyCap('message', {})).toBe(300)
    expect(polishDailyCap('meeting', {})).toBe(200)
    expect(polishDailyCap('prompt_draft', {})).toBe(200)
  })

  it('each bucket reads its own variable; the old shared cap is the message fallback only', () => {
    const env = {
      COS_DICTATION_AUTOCLEAN_MAX_PER_DAY: '450',
      COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MEETING: '40',
      COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_PROMPT_DRAFT: '25',
    }
    expect(polishDailyCap('message', env)).toBe(450)
    expect(polishDailyCap('meeting', env)).toBe(40)
    expect(polishDailyCap('prompt_draft', env)).toBe(25)
    expect(polishDailyCap('meeting', { COS_DICTATION_AUTOCLEAN_MAX_PER_DAY: '450' })).toBe(200)
    expect(polishDailyCap('prompt_draft', { COS_DICTATION_AUTOCLEAN_MAX_PER_DAY: '450' })).toBe(200)
    expect(polishDailyCap('message', { ...env, COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE: '600' })).toBe(600)
  })

  it('a value that is not a positive whole number is the default (or the message fallback)', () => {
    for (const bad of ['', ' ', '0', '-5', '2.5', 'abc', '1e2']) {
      expect(polishDailyCap('meeting', { COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MEETING: bad }), bad).toBe(200)
      expect(polishDailyCap('message', { COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE: bad, COS_DICTATION_AUTOCLEAN_MAX_PER_DAY: '450' }), bad).toBe(450)
      expect(polishDailyCap('message', { COS_DICTATION_AUTOCLEAN_MAX_PER_DAY: bad }), bad).toBe(300)
    }
  })

  it('a call spends only its own bucket, in one file stamped with the local day', () => {
    recordPolishCall('meeting')
    recordPolishCall('meeting')
    recordPolishCall('message')
    expect(polishCountToday('meeting')).toBe(2)
    expect(polishCountToday('message')).toBe(1)
    expect(polishCountToday('prompt_draft')).toBe(0)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ date: localDay(), counts: { message: 1, meeting: 2, prompt_draft: 0 } })
  })

  it('exhausted at the cap, not before', () => {
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MEETING = '2'
    try {
      recordPolishCall('meeting')
      expect(polishBudgetExhausted('meeting')).toBe(false)
      recordPolishCall('meeting')
      expect(polishBudgetExhausted('meeting')).toBe(true)
      expect(polishBudgetExhausted('message')).toBe(false)
    } finally { delete process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MEETING }
  })

  it('a pre-6.79.1 file, another day, or junk reads as zero', () => {
    writeFileSync(file(), JSON.stringify({ date: localDay(), count: 450 }))
    expect(polishCountToday('message')).toBe(0)
    writeFileSync(file(), JSON.stringify({ date: '2020-01-01', counts: { message: 9, meeting: 9, prompt_draft: 9 } }))
    expect(polishCountToday('meeting')).toBe(0)
    writeFileSync(file(), JSON.stringify({ date: localDay(), counts: { message: 'x', meeting: -3, prompt_draft: 1.5 } }))
    for (const bucket of ['message', 'meeting', 'prompt_draft'] as const) expect(polishCountToday(bucket)).toBe(0)
    writeFileSync(file(), 'not json')
    expect(polishCountToday('message')).toBe(0)
    recordPolishCall('message')
    expect(polishCountToday('message')).toBe(1)
  })

  it('the day rolls at local midnight', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 19, 23, 59, 0))
    recordPolishCall('message')
    expect(polishCountToday('message')).toBe(1)
    expect(localDay()).toBe('2026-10-19')
    vi.setSystemTime(new Date(2026, 9, 20, 0, 1, 0))
    expect(localDay()).toBe('2026-10-20')
    expect(polishCountToday('message')).toBe(0)
  })
})

/** Every dictation polish and prompt-edit variable a managed install must forward. */
const DICTATION_KEYS = ['COS_DICTATION_AUTOCLEAN_MAX_PER_DAY', 'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE', 'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MEETING',
  'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_PROMPT_DRAFT', 'COS_DICTATION_POLISH_PROMPT', 'COS_DICTATION_FILLER_PASS',
  'COS_DICTATION_PREWARM', 'COS_DICTATION_POLISH_SKIP_CLEAN',
  // 6.92.0: the five 6.83.1 and 6.91.0 keys this test missed.
  'COS_DICTATION_SPOKEN_PATHS', 'COS_DICTATION_PROMPT_VERSION', 'COS_DICTATION_LEARNED_STYLE', 'COS_DICTATION_MEANING_GUARD', 'COS_DICTATION_REGISTERS',
  // 6.92.0: the slow breaker and prompt edit's switch, cap and existing settings.
  'COS_DICTATION_SLOW_BREAKER_ABORTS', 'COS_DICTATION_SLOW_BREAKER_MS',
  'COS_PROMPT_EDIT', 'COS_PROMPT_EDIT_DAILY_CAP', 'COS_PROMPT_EDIT_MODEL', 'COS_PROMPT_EDIT_EFFORT', 'COS_PROMPT_EDIT_TIMEOUT_MS']

describe('6.79.1 managed runtime forwarding', () => {
  it('lists every dictation polish variable in optionalEnvironment', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    expect(DICTATION_KEYS).toHaveLength(20)
    for (const key of DICTATION_KEYS) expect(contract.optionalEnvironment, key).toContain(key)
  })

  it('6.92.0: documents every one in .env.example', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
    for (const key of DICTATION_KEYS) expect(example, key).toMatch(new RegExp(`^# ${key}=`, 'm'))
  })
})
