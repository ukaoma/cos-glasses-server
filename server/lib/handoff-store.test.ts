import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildHandoffPromptContext,
  claimHandoff,
  createHandoff,
  getHandoff,
  getLatestHandoff,
  getLiveClaudeRuntime,
  getLiveCodexRuntime,
} from './handoff-store.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cos-handoff-test-'))
  process.env.COS_HANDOFF_STORE_FILE = join(dir, 'handoffs.json')
})

afterEach(() => {
  delete process.env.COS_HANDOFF_STORE_FILE
  rmSync(dir, { recursive: true, force: true })
})

describe('handoff store', () => {
  it('creates, fetches, claims, and keeps claimed records addressable by code', async () => {
    const created = await createHandoff({
      title: 'Budget review',
      summary: 'Continue the budget thread.',
      currentGoal: 'Prepare next response.',
      nextStep: 'Open in Codex.',
      source: 'g2',
      target: 'codex',
      createdBy: 'g2',
      deviceId: 'test-device',
    })

    expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(await getHandoff(created.code)).toMatchObject({ code: created.code, status: 'open' })

    const claimed = await claimHandoff(created.code, 'codex')
    expect(claimed).toMatchObject({ code: created.code, status: 'claimed', claimedBy: 'codex' })
    expect(await getHandoff(created.code)).toMatchObject({ code: created.code, status: 'claimed' })
  })

  it('scopes latest to open target records', async () => {
    await createHandoff({ title: 'Desktop', summary: 'A', currentGoal: 'A', nextStep: 'A', source: 'g2', target: 'desktop' })
    const g2 = await createHandoff({ title: 'G2', summary: 'B', currentGoal: 'B', nextStep: 'B', source: 'desktop', target: 'g2' })
    await claimHandoff(g2.code, 'g2')
    await createHandoff({ title: 'New G2', summary: 'C', currentGoal: 'C', nextStep: 'C', source: 'desktop', target: 'g2' })

    const latest = await getLatestHandoff({ target: 'g2' })
    expect(latest?.title).toBe('New G2')
  })

  it('separates snapshot and runtime expiry', async () => {
    const expiredRuntime = new Date(Date.now() - 1000).toISOString()
    const created = await createHandoff({
      title: 'Runtime',
      summary: 'Runtime test',
      currentGoal: 'Continue',
      nextStep: 'Resume if possible',
      runtime: {
        codex: { codexThreadId: 'thread-1', expiresAt: expiredRuntime },
        claude: { cliSessionId: 'claude-1', expiresAt: expiredRuntime },
      },
    })

    const context = buildHandoffPromptContext(created)
    expect(await getHandoff(created.code)).not.toBeNull()
    expect(getLiveCodexRuntime(context)).toBeUndefined()
    expect(getLiveClaudeRuntime(context)).toBeUndefined()
  })

  it('quarantines corrupt JSON and starts fresh', async () => {
    writeFileSync(process.env.COS_HANDOFF_STORE_FILE!, '{bad json')
    const created = await createHandoff({ title: 'Fresh', summary: 'OK', currentGoal: 'Go', nextStep: 'Next' })
    expect(await getHandoff(created.code)).toMatchObject({ code: created.code })
  })

  it('serializes concurrent creates without clobbering', async () => {
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => createHandoff({
      title: `Handoff ${i}`,
      summary: `Summary ${i}`,
      currentGoal: 'Continue',
      nextStep: 'Next',
    })))

    const codes = new Set(created.map(h => h.code))
    expect(codes.size).toBe(12)
    for (const handoff of created) {
      expect(await getHandoff(handoff.code)).toMatchObject({ code: handoff.code })
    }
  })
})
