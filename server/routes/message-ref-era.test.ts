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

  it('POST /message-era/reset refuses without confirm', async () => {
    const express = (await import('express')).default
    const { messageRefRouter } = await import('./message-ref.js')
    const app = express()
    app.use(express.json())
    app.use('/api', messageRefRouter)
    const res = await new Promise<{ status: number; body: { code?: string } }>((resolve, reject) => {
      const http = app.listen(0, '127.0.0.1', async () => {
        try {
          const addr = http.address()
          const port = typeof addr === 'object' && addr ? addr.port : 0
          const response = await fetch(`http://127.0.0.1:${port}/api/message-era/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          })
          resolve({ status: response.status, body: await response.json() as { code?: string } })
        } catch (err) {
          reject(err)
        } finally {
          http.close()
        }
      })
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('confirmation_required')
  })

  it('GET /message-counter counts numbers held by not-yet-projected jobs (6.43.1)', async () => {
    writeFileSync(join(dir, 'archive', '2026-09-01.json'), JSON.stringify({
      date: '2026-09-01',
      chats: [{ id: 1, sessionId: 's', exchanges: [
        { role: 'user', content: 'q', globalMsgNum: 73, messageEra: 'era-x' },
        { role: 'assistant', content: 'a', globalMsgNum: 73, messageEra: 'era-x' },
      ] }],
    }))
    const era = await import('../lib/message-era.js')
    vi.spyOn(era, 'currentMessageEra').mockReturnValue('era-x')
    const reservations = await import('../lib/message-reservations.js')
    reservations.resetMessageReservationSourcesForTests()
    const unregister = reservations.registerMessageReservationSource(() => [{ globalMsgNum: 74, messageEra: 'era-x', owner: 'brief:2026-09-01' }])
    const express = (await import('express')).default
    const { messageRefRouter } = await import('./message-ref.js')
    const app = express()
    app.use('/api', messageRefRouter)
    try {
      const body = await new Promise<{ max: number; era: string }>((resolve, reject) => {
        const http = app.listen(0, '127.0.0.1', async () => {
          try {
            const addr = http.address()
            const port = typeof addr === 'object' && addr ? addr.port : 0
            resolve(await fetch(`http://127.0.0.1:${port}/api/message-counter`).then(r => r.json()) as { max: number; era: string })
          } catch (err) { reject(err) } finally { http.close() }
        })
      })
      expect(body).toEqual({ max: 74, era: 'era-x' })
    } finally {
      unregister()
      vi.restoreAllMocks()
    }
  })
})
