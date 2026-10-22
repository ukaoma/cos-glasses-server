// 6.86.0: POST /api/mac-recording/start { liveCues: true } arms live cues for the recording. The answer never fails the
// start, a bad flag admits nothing, and a start without the flag is answered exactly as 6.85.0 answered it.
import express from 'express'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root: string, server: Server, base: string
const arm = vi.fn()
const id = 'mac_1b2c3d4e-0000-4000-8000-00000000abcd'

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cos-mac-cues-')); process.env.COS_DATA_DIR = root; vi.resetModules(); arm.mockReset()
  arm.mockImplementation(() => {
    // Armed only after the recording is admitted: the registry file exists by then.
    expect(existsSync(join(root, 'mac-recordings', id + '.json'))).toBe(true)
    return { armed: true, kinds: ['reinforce', 'challenge', 'decision', 'promise', 'followUp'], cuesGenerated: 0, paused: false, pauseSeq: 0 }
  })
  vi.doMock('../lib/server-instance-id.js', () => ({ getServerInstanceId: () => 'server-mac' }))
  vi.doMock('../lib/live-cues-v2.js', async original => ({ ...await original<typeof import('../lib/live-cues-v2.js')>(), armMacLiveCues: arm }))
  const stream = await import('./transcribe-stream.js')
  const app = express(); app.use(express.json()); app.use('/api', stream.transcribeStreamRouter)
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api'
})
afterEach(async () => {
  await new Promise<void>(resolve => server?.listening ? server.close(() => resolve()) : resolve())
  vi.resetModules(); vi.doUnmock('../lib/server-instance-id.js'); vi.doUnmock('../lib/live-cues-v2.js')
  delete process.env.COS_DATA_DIR; rmSync(root, { recursive: true, force: true })
})
async function start(extra: Record<string, unknown> = {}) {
  const response = await fetch(base + '/mac-recording/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-COS-Server-Instance': 'server-mac' },
    body: JSON.stringify({ captureId: id, startTime: 1700000000000, sourceType: 'mac_system_audio', ...extra }),
  })
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}

describe('Mac recording start arms live cues on request (6.86.0)', () => {
  it('without liveCues: no arm, and no liveCues key in the answer', async () => {
    const res = await start()
    expect(res.status).toBe(200)
    expect(res.json).not.toHaveProperty('liveCues')
    expect(arm).not.toHaveBeenCalled()
    expect((await start({ liveCues: false })).json).not.toHaveProperty('liveCues')
    expect(arm).not.toHaveBeenCalled()
  })

  it('liveCues: true arms the capture once per start (a replayed start re-asks; arming is idempotent) and returns the answer', async () => {
    const res = await start({ liveCues: true })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ captureId: id, replayed: false, liveCues: { armed: true, kinds: ['reinforce', 'challenge', 'decision', 'promise', 'followUp'] } })
    expect(arm).toHaveBeenCalledTimes(1)
    expect(arm).toHaveBeenCalledWith(id)
    const again = await start({ liveCues: true })
    expect(again.json).toMatchObject({ replayed: true, liveCues: { armed: true } })
    expect(arm).toHaveBeenCalledTimes(2)
  })

  it('a refusal is a reason in the answer, never a failed start', async () => {
    arm.mockImplementation(() => ({ armed: false, reason: 'budget_exhausted' }))
    expect(await start({ liveCues: true })).toMatchObject({ status: 200, json: { captureId: id, liveCues: { armed: false, reason: 'budget_exhausted' } } })
  })

  it('an arm that throws still starts the recording, answering unavailable', async () => {
    arm.mockImplementation(() => { throw new Error('boom') })
    const res = await start({ liveCues: true })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ captureId: id, liveCues: { armed: false, reason: 'unavailable' } })
  })

  it('a liveCues that is not a boolean is refused before anything is written', async () => {
    for (const bad of ['yes', 1, null, {}]) {
      const res = await start({ liveCues: bad })
      expect(res.status, String(bad)).toBe(400)
      expect(res.json.reason).toBe('invalid_live_cues')
    }
    expect(existsSync(join(root, 'mac-recordings', id + '.json'))).toBe(false)
    expect(arm).not.toHaveBeenCalled()
  })
})
