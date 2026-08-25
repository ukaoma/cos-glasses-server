import express from 'express'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { voiceRouter } from './voice.js'

// Guards POST /api/voice/enroll against the reported first-time-user failure
// (Chelsie Hodgkiss, 2026-08-25): an old client can still send a whole spoken
// sentence as ?name=, and a junk profile can never match owner_speaker_label,
// so /api/voice/status would report enrolled:false forever.

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function harness(): Promise<string> {
  const app = express()
  app.use('/api', voiceRouter)
  const server = await new Promise<Server>(resolve => {
    const s = app.listen(0, () => resolve(s))
  })
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

/** Big enough to clear the route's own >=1000-byte audio floor. */
const ENOUGH_AUDIO = Buffer.alloc(2000)

async function enroll(base: string, name: string, body: Buffer) {
  const res = await fetch(`${base}/api/voice/enroll?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(body),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

describe('POST /api/voice/enroll name validation', () => {
  it('REJECTS a spoken sentence sent as the profile name', async () => {
    const base = await harness()
    const spoken = 'Okay so I am just going to read something aloud here for thirty seconds'
    const { status, json } = await enroll(base, spoken, ENOUGH_AUDIO)
    expect(status).toBe(400)
    expect(json.success).toBe(false)
    expect(json.reason).toBe('too_long')
    expect(String(json.error)).toContain('name')
  })

  it('REJECTS "my voice" with a message pointing at the right command', async () => {
    const base = await harness()
    const { status, json } = await enroll(base, 'My Voice Please', ENOUGH_AUDIO)
    expect(status).toBe(400)
    expect(json.reason).toBe('self_referential')
    expect(String(json.error)).toContain('enroll my voice')
  })

  it('lets a real name PAST the name gate — proves the rejections above are the gate, not a dead route', async () => {
    const base = await harness()
    // Deliberately under the audio floor: reaching the DIFFERENT error proves
    // the name was accepted and execution continued.
    const { status, json } = await enroll(base, 'Chelsie Hodgkiss', Buffer.alloc(10))
    expect(status).toBe(400)
    expect(json.reason).toBeUndefined()
    expect(String(json.error)).toContain('Audio too short')
  })
})
