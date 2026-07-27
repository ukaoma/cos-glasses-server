import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// COS_SCRIPTS_DIR is a module-load-time const in python-bridge.js, so every
// case that stages an env must reset the module registry and re-import — a
// static import would freeze whatever env the worker started with.

async function freshMemoryModule(): Promise<typeof import('./live-cues-memory.js')> {
  vi.resetModules()
  return import('./live-cues-memory.js')
}

describe('parseExploreOutput', () => {
  it('strips the --explore chrome and keeps the answer', async () => {
    const { parseExploreOutput } = await freshMemoryModule()
    const raw = [
      'Exploring entity: CaratIQ',
      '--------------------------------------------------',
      'CaratIQ is a jewelry POS competitor first raised in the March pricing call.',
      'They compete with Jewel360 on cloud retail.',
      '',
      '[12.3s | mode: local]',
    ].join('\n')
    expect(parseExploreOutput(raw)).toBe(
      'CaratIQ is a jewelry POS competitor first raised in the March pricing call.\nThey compete with Jewel360 on cloud retail.',
    )
  })

  it('strips the question-path Query:/Mode: header lines too', async () => {
    const { parseExploreOutput } = await freshMemoryModule()
    const raw = 'Query: budget\nMode: local\n--------------------------------------------------\nanswer text'
    expect(parseExploreOutput(raw)).toBe('answer text')
  })

  it('returns empty string for chrome-only output', async () => {
    const { parseExploreOutput } = await freshMemoryModule()
    expect(parseExploreOutput('Exploring entity: X\n---------------------------------------------\n[1.0s | mode: local]')).toBe('')
  })
})

describe('lightragBudgetAllows', () => {
  let scriptsDir: string
  const originalScriptsDir = process.env.COS_SCRIPTS_DIR
  const originalReserve = process.env.COS_LIVE_CUES_LIGHTRAG_RESERVE

  beforeEach(() => {
    scriptsDir = mkdtempSync(join(tmpdir(), 'live-cues-mem-'))
    process.env.COS_SCRIPTS_DIR = scriptsDir
    delete process.env.COS_LIVE_CUES_LIGHTRAG_RESERVE
  })

  afterEach(() => {
    rmSync(scriptsDir, { recursive: true, force: true })
    if (originalScriptsDir === undefined) delete process.env.COS_SCRIPTS_DIR
    else process.env.COS_SCRIPTS_DIR = originalScriptsDir
    if (originalReserve === undefined) delete process.env.COS_LIVE_CUES_LIGHTRAG_RESERVE
    else process.env.COS_LIVE_CUES_LIGHTRAG_RESERVE = originalReserve
  })

  it('allows spending while the shared query pool retains more than the reserve', async () => {
    const today = new Date().toISOString().slice(0, 10)
    writeFileSync(join(scriptsDir, '.lightrag_daily_calls.json'), JSON.stringify({ date: today, query: 10 }))
    const { lightragBudgetAllows } = await freshMemoryModule()
    expect(lightragBudgetAllows()).toBe(true)
  })

  it('refuses once remaining pool is at or below the reserve floor', async () => {
    const today = new Date().toISOString().slice(0, 10)
    // 200-pool with 90 spent leaves 110 remaining, below the 120 reserve.
    writeFileSync(join(scriptsDir, '.lightrag_daily_calls.json'), JSON.stringify({ date: today, query: 90 }))
    const { lightragBudgetAllows } = await freshMemoryModule()
    expect(lightragBudgetAllows()).toBe(false)
  })

  it('ignores a stale counter from a previous day', async () => {
    writeFileSync(join(scriptsDir, '.lightrag_daily_calls.json'), JSON.stringify({ date: '2020-01-01', query: 199 }))
    const { lightragBudgetAllows } = await freshMemoryModule()
    expect(lightragBudgetAllows()).toBe(true)
  })

  it('fails toward NOT spending when the counter is unreadable', async () => {
    writeFileSync(join(scriptsDir, '.lightrag_daily_calls.json'), 'not json {')
    const { lightragBudgetAllows } = await freshMemoryModule()
    expect(lightragBudgetAllows()).toBe(false)
  })
})
