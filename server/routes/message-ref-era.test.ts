import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('message-ref era scoping', () => {
  const prevData = process.env.COS_DATA_DIR
  let dir = ''

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'cos-message-ref-era-'))
    process.env.COS_DATA_DIR = dir
    mkdirSync(join(dir, 'archive'), { recursive: true })
  })

  afterEach(() => {
    if (prevData === undefined) delete process.env.COS_DATA_DIR
    else process.env.COS_DATA_DIR = prevData
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('ignores legacy high numbers after a fresh era is created', async () => {
    writeFileSync(join(dir, 'archive', '2026-07-19.json'), JSON.stringify({
      date: '2026-07-19',
      chats: [{
        id: 1,
        sessionId: 'old',
        exchanges: [
          { role: 'user', content: 'old q', globalMsgNum: 17931 },
          { role: 'assistant', content: 'old a', globalMsgNum: 17931 },
        ],
      }],
    }))

    const era = await import('../lib/message-era.js')
    const ref = await import('./message-ref.js')
    expect(ref.maxGlobalMsgNumInDir(join(dir, 'archive'))).toBe(17931)

    const next = era.createMessageEra(1_700_000_000_200)
    expect(ref.maxGlobalMsgNumInDir(join(dir, 'archive'), next.era)).toBe(0)

    writeFileSync(join(dir, 'archive', '2026-07-27.json'), JSON.stringify({
      date: '2026-07-27',
      chats: [{
        id: 1,
        sessionId: 'new',
        exchanges: [
          { role: 'user', content: 'new q', globalMsgNum: 1, messageEra: next.era },
          { role: 'assistant', content: 'new a', globalMsgNum: 1, messageEra: next.era },
        ],
      }],
    }))
    expect(ref.maxGlobalMsgNumInDir(join(dir, 'archive'), next.era)).toBe(1)
  })
})
