// 6.94.0 golden: a G2 meeting saved through the real save route with COS operations configured
// files exactly as server 6.93.0 (f0449b3) did, for both a locked-import sync_meetings.py and an
// older one: the same local markdown and sidecar, the same staged operations copy, the same
// arguments and COS_G2_IMPORT_ROOT, the same response. The fixture was recorded by running this
// harness on f0449b3; timestamps, the temp root and the server instance id are normalized.
// sync_meetings.py is a contract fake run by this Node, so nothing reaches a model or an index.
import express from 'express'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, it, vi } from 'vitest'

const SID = 'meeting_1793113298813_d0bm6p'
const golden = JSON.parse(readFileSync(new URL('./__fixtures__/g2-filing-golden-6.93.0.json', import.meta.url), 'utf8'))

function fakeScript(scripts: string, locked: boolean) {
  mkdirSync(join(scripts, 'venv', 'bin'), { recursive: true })
  const shim = join(scripts, 'venv', 'bin', 'python3')
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`); chmodSync(shim, 0o755)
  const flag = locked ? '--g2-import-' + 'file' : '--g2-file'
  writeFileSync(join(scripts, 'sync_meetings.py'), `
const fs = require('fs'), path = require('path'); const args = process.argv.slice(2)
fs.appendFileSync(path.join(__dirname, 'invocations.jsonl'), JSON.stringify({ args, importRoot: process.env.COS_G2_IMPORT_ROOT || null, unbuffered: process.env.PYTHONUNBUFFERED || null }) + '\\n')
${locked ? "// supports " + "--g2-import-file" : ''}
const at = args.indexOf(${JSON.stringify(flag)}); const target = args[at + 1]
const dest = path.join(__dirname, '..', 'quilt', 'meetings', '2026-10', 'Filed_(G2).md')
fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, fs.readFileSync(target))
process.stdout.write('COS_G2_RESULT=' + JSON.stringify({ status: 'enriched', path: dest, title: 'Filed (G2)' }) + '\\n')
`)
}

function walk(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) Object.assign(out, walk(full, base))
    else out[relative(base, full)] = readFileSync(full, 'utf8')
  }
  return out
}

function normalize(text: string, root: string): string {
  return text.split(root).join('<ROOT>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<ISO>')
    .replace(/"serverInstanceId":\s*"[^"]*"/g, '"serverInstanceId":"<ID>"')
}

async function scenario(locked: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cos-golden-g2-')))
  const ops = join(root, 'Ukaoma Chief Of Staff', 'MU-Chief.Staff', 'operations')
  for (const d of ['quilt', 'personal']) mkdirSync(join(ops, d, 'meetings', '2026-10'), { recursive: true })
  const scripts = join(ops, 'scripts'); fakeScript(scripts, locked)
  process.env.COS_DATA_DIR = join(root, 'data'); process.env.HOME = join(root, 'home'); mkdirSync(process.env.HOME, { recursive: true })
  process.env.COS_PROFILE_PATH = join(root, 'profile.json'); process.env.COS_SCRIPTS_DIR = scripts
  vi.resetModules()
  vi.doMock('../lib/meeting-summary-persistence.js', () => ({ enrichStandaloneMeeting: vi.fn(async () => {}) }))
  vi.doMock('../lib/profile.js', () => ({ loadProfileObject: () => ({}), getDomainKeywords: () => ({}), getVocabulary: () => [], getOwnerName: () => 'COS', getOwnerSpeakerLabel: () => 'MU', getWhisperCorrections: () => '' }))
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { MeetingFinalizationJobStore } = await import('../lib/meeting-finalization-jobs.js')
  const { initializeServerInstanceId } = await import('../lib/server-instance-id.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const pin = initializeServerInstanceId(join(root, 'server-instance-id'))
  const store = new MeetingStore(join(root, 'data', 'recordings'))
  let state = 'active'
  const chunks = [0, 1, 2].map(i => ({ text: `ARR crossed one hundred million, line ${i}.`, speaker: 'Jeremy Sokolic', elapsed: i * 10_000, similarity: 0.91 }))
  const sessions = {
    getTranscript: () => (state === 'active' ? chunks.map(c => `[${c.speaker}]: ${c.text}`).join('\n') : null),
    getStartTime: () => (state === 'active' ? 1793113298813 : null),
    getChunks: () => chunks,
    getChunkEntries: () => chunks.map((chunk, chunkIndex) => ({ chunkIndex, chunk })),
    getProviderCandidates: () => ({}),
    getIntegrity: () => ({ received: 3, stored: 3, maxIndex: 2, expected: 3, missingIndices: [], completeness: 1 }),
    drainAudioWrites: async () => {}, hasAudio: () => false, moveAudioToPending: () => null,
    delete: () => { state = 'closed' }, getState: () => state,
    getLedger: () => ({ state, received: [0, 1, 2], asrCompleted: [0, 1, 2], maxChunkIndex: 2, lastActivityAt: 1 }),
  }
  const background: Promise<void>[] = []
  const app = express(); app.use(express.json())
  app.use('/api', createMeetingRouter({ store, sessions: sessions as never, emit: vi.fn(), finalizationJobs: new MeetingFinalizationJobStore(join(root, 'data', 'jobs')), runBatch: async () => { throw new Error('no batch') }, scheduleBackground: t => { background.push(t) } }))
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const port = (server.address() as { port: number }).port
  const res = await fetch(`http://127.0.0.1:${port}/api/meeting/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-COS-Server-Instance': pin }, body: JSON.stringify({ sessionId: SID }) })
  const body = await res.json()
  await Promise.allSettled(background.splice(0))
  await new Promise(r => setTimeout(r, 50))
  await new Promise(resolve => server.close(resolve))
  const out = {
    status: res.status,
    response: JSON.parse(normalize(JSON.stringify({ ...body, receiptVersion: body.receiptVersion }), root)),
    recordings: Object.fromEntries(Object.entries(walk(join(root, 'data', 'recordings'))).map(([k, v]) => [k, normalize(v, root)])),
    operations: Object.fromEntries(Object.entries(walk(ops)).filter(([k]) => !k.startsWith('scripts/venv')).map(([k, v]) => [k, normalize(v, root)])),
  }
  for (const m of ['meeting-summary-persistence', 'profile']) vi.doUnmock(`../lib/${m}.js`)
  rmSync(root, { recursive: true, force: true })
  return out
}

it('files a G2 save byte-identically to 6.93.0 through the locked import', async () => {
  expect(await scenario(true)).toEqual(golden.locked)
}, 60_000)
it('files a G2 save byte-identically to 6.93.0 through an older sync script', async () => {
  expect(await scenario(false)).toEqual(golden.older)
}, 60_000)
