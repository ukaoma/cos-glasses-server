// Execution tests for sendAudioFile, run over a real HTTP listener.
//
// THE POINT OF THIS FILE. The defect it pins was invisible to the entire suite
// because every other audio test points COS_DATA_DIR at `mkdtemp` under
// `os.tmpdir()` — `/var/folders/...` on macOS, `/tmp/...` on Linux — and neither
// can contain a dot component. The real default data home is `~/.cos-glasses`,
// which does. So the tests were structurally incapable of reproducing a default
// install, and stayed green while playback was dead for every user.
//
// Every case below therefore serves from a directory whose name starts with a
// dot ON PURPOSE. Nothing here asserts on source text: each case performs a real
// fetch and checks the bytes that came back, because the failure mode was a
// route that returned 404 HTML where WAV bytes were expected.

import express from 'express'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sendAudioFile } from './send-audio.js'

let server: Server | null = null
let root = ''

/** Minimal 44-byte RIFF header plus one sample — enough to be a real file. */
function wavBytes(): Buffer {
  const header = Buffer.alloc(46)
  header.write('RIFF', 0)
  header.writeUInt32LE(38, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(2, 40)
  return header
}

async function serve(path: string): Promise<Response> {
  const app = express()
  app.get('/audio', (_req, res) => sendAudioFile(res, path))
  server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test listener unavailable')
  return fetch(`http://127.0.0.1:${address.port}/audio`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'send-audio-'))
})

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = null
  }
  rmSync(root, { recursive: true, force: true })
})

describe('sendAudioFile', () => {
  it('serves a WAV from a dot-directory, which is the default data home', async () => {
    // `.cos-glasses` reproduces the real layout. Without dotfiles:'allow' this
    // is a 404 and the reviewer hears nothing.
    const dir = join(root, '.cos-glasses', 'data', 'meeting-audio', 'session_1')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'chunk_0000.wav')
    writeFileSync(path, wavBytes())

    const response = await serve(path)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('audio/wav')
    const body = Buffer.from(await response.arrayBuffer())
    expect(body.subarray(0, 4).toString()).toBe('RIFF')
    expect(body.subarray(8, 12).toString()).toBe('WAVE')
    expect(body).toEqual(wavBytes())
  })

  it('serves a WAV nested under several dot-directories', async () => {
    // One dot component is the default; a user who relocates the data home can
    // easily produce more (`~/.local/share/.cos`). send checks EVERY component.
    const dir = join(root, '.local', 'share', '.cos', 'ext-audio', 'session_2')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'ext_chunk7_1786058043306.wav')
    writeFileSync(path, wavBytes())

    const response = await serve(path)

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(wavBytes())
  })

  it('still serves a WAV from a path with no dot component', async () => {
    // The pre-fix behaviour, which is what made the bug look like it did not
    // exist. This must keep working.
    const dir = join(root, 'plain', 'voice-audio', 'Queen Ukaoma')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'sample.wav')
    writeFileSync(path, wavBytes())

    const response = await serve(path)

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(wavBytes())
  })
})
