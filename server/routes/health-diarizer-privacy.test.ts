// QA 6.61.0 blocker: /api/health is public (no token, by design: api-auth exempts
// it) and the server listens on the LAN. After a final pass it published the
// channel map (speaker names) and raw error text (paths with the meeting title).
// It may publish codes and counts only.
import express from 'express'
import type { Server } from 'node:http'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { requireApiToken } from '../lib/api-auth.js'
import { FINAL_REASON_CODES, runNemotronFinalPass } from '../lib/nemotron-final.js'
import { activityOf, fakeNemotronHome, wavOf } from '../lib/__fixtures__/nemotron-helpers.js'
import { healthRouter } from './health.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) { try { chmodSync(root, 0o700) } catch {} rmSync(root, { recursive: true, force: true }) } })

function boardPrepMeeting() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-health-')); roots.push(dir)
  const audioDir = join(dir, 'pending'); mkdirSync(audioDir)
  const who = ['Silas Larson', 'Silas Larson', 'Silas Larson', 'Jeremy Sokolic', 'Jeremy Sokolic', 'Jeremy Sokolic']
  const entries = who.map((speaker, i) => {
    const wav = wavOf(6, () => 10)
    writeFileSync(join(audioDir, `chunk_${String(i).padStart(4, '0')}.wav`), wav)
    return { chunkIndex: i, chunk: { text: `w${i}a w${i}b`, speaker, elapsed: i * 6000, similarity: 0.8, audioSha256: createHash('sha256').update(wav).digest('hex') } }
  })
  const meetingPath = join(dir, '2026-10-02_Board_Prep_with_Jeremy.md')
  const sidecarPath = meetingPath.replace(/\.md$/, '.g2-chunks.json')
  writeFileSync(sidecarPath, JSON.stringify({ chunks: entries.map(e => e.chunk), chunkEntries: entries, batchApplied: false }))
  writeFileSync(meetingPath, `# m\n\n## Transcript\n\n${entries.map(e => `[Ext]: ${e.chunk.text}`).join('\n')}\n`)
  const home = fakeNemotronHome(); roots.push(home)
  return { dir, audioDir, meetingPath, sidecarPath, home }
}

async function publicHealth(): Promise<{ status: number; text: string; body: any }> {
  const app = express()
  app.use('/api', requireApiToken('secret-token-qa'))
  app.use('/api', healthRouter)
  const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  try {
    const port = (server.address() as { port: number }).port
    const response = await fetch(`http://127.0.0.1:${port}/api/health`) // no X-Cos-Token
    const text = await response.text()
    return { status: response.status, text, body: JSON.parse(text) }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

const LEAKS = ['Silas', 'Jeremy', 'Sokolic', 'Board_Prep', tmpdir(), 'qa-health-', 'EACCES', 'permission denied', '.g2-chunks.json']

it('unauthenticated /api/health after a final pass carries no speaker name, no path and no raw error text', async () => {
  const applied = boardPrepMeeting()
  const outcome = await runNemotronFinalPass({ ...applied, env: { COS_DIARIZER: 'nemotron' }, log: () => {},
    run: async () => activityOf(37, [[0, 0, 18], [1, 18, 36]]) as never })
  expect(outcome.status).toBe('applied')
  expect(outcome.mapped).toEqual({ 0: 'Silas Larson', 1: 'Jeremy Sokolic' }) // the server log still has it

  const first = await publicHealth()
  expect(first.status).toBe(200)
  for (const leak of LEAKS) expect(first.text).not.toContain(leak)
  expect(first.body.readiness.diarizer.final.last).toMatchObject({ status: 'applied', reasonCode: null, mappedChannels: 2, channels: 2 })

  // A failure whose raw message names the sidecar's path (and so the meeting's title).
  const failing = boardPrepMeeting()
  chmodSync(failing.sidecarPath, 0o000)
  const failed = await runNemotronFinalPass({ ...failing, env: { COS_DIARIZER: 'nemotron' }, log: () => {}, run: async () => activityOf(37, []) as never })
  chmodSync(failing.sidecarPath, 0o600)
  expect(failed).toMatchObject({ status: 'failed', reason: 'error' })
  expect(failed.detail).toContain('EACCES')

  const second = await publicHealth()
  for (const leak of LEAKS) expect(second.text).not.toContain(leak)
  expect(second.body.readiness.diarizer.final.last).toMatchObject({ status: 'failed', reasonCode: 'error', mappedChannels: null })
  for (const key of Object.keys(second.body.readiness.diarizer.final.counts)) {
    expect(key === 'applied' || FINAL_REASON_CODES.some(code => key === `skipped:${code}` || key === `failed:${code}`)).toBe(true)
  }
}, 30_000)
