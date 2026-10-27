// 6.94.0: saved Mac recordings filed into the COS meeting library.
//
// Runs against temp trees only: a realistic operations path (spaces, dots, a domain folder) with
// a contract fake of sync_meetings.py (see __fixtures__/fake-sync-meetings.ts), and a temp
// recordings root. Importing server modules runs them, so COS_DATA_DIR, HOME and
// COS_PROFILE_PATH point at scratch directories before the first import.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFakeInvocations, writeFakeSyncMeetings } from './__fixtures__/fake-sync-meetings.js'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cos-mac-library-')))
const saved = { ...process.env }
let handoff: typeof import('./g2-ops-handoff.js')
let runner: typeof import('./g2-enrichment-runner.js')

const SESSION = 'mac_8743a230-7f8f-4d59-a0de-5ffdfdcd5801'
const CAPS = { schema: 1, g2_import: 1, mac_import: 1, mac_twins: 2 }

function macMarkdown(source = '| **Source** | Mac System Audio |'): string {
  return [
    '# Mac recording 10:02 AM', '', '| Field | Value |', '|-------|-------|',
    '| **Date** | 2026-10-27 |', '| **Time** | 10:02 AM |', '| **Duration** | 27 minutes |',
    source,
    '| **Capture source** | mac_system_audio |', '| **Captured voices** | Other participants only |',
    '| **Domain** | personal |', '| **Transfer integrity** | 100% |', '| **Transcription quality** | batch |',
    '', '## Summary', '', 'ARR passed 100 million in July; EBITDA on plan; Q1 2027 is a reforecast.',
    '', '## Transcript', '', '[Ext]: Year-to-date results first.', '',
  ].join('\n')
}

function g2Markdown(): string {
  return [
    '# G2 Recording 2026-10-27 1001', '', '| Field | Value |', '|-------|-------|',
    '| **Date** | 2026-10-27 |', '| **Time** | 10:01 AM |', '| **Duration** | 27 minutes |',
    '| **Source** | G2 Glasses |', '| **Domain** | personal |', '', '## Summary', '',
    '*Standalone recording — canonical transcript shown in meeting detail.*', '', '## Transcript', '',
    '[Jeremy]: Year-to-date results first.', '',
  ].join('\n')
}

interface Tree { root: string; ops: string; scripts: string; recordings: string }

function makeTree(): Tree {
  const root = mkdtempSync(join(scratch, 'tree-'))
  const ops = join(root, 'Ukaoma Chief Of Staff', 'MU-Chief.Staff', 'operations')
  for (const domain of ['quilt', 'personal']) mkdirSync(join(ops, domain, 'meetings', '2026-10'), { recursive: true })
  const scripts = join(ops, 'scripts')
  mkdirSync(scripts, { recursive: true })
  const recordings = join(root, 'COS Glasses.data', 'recordings')
  mkdirSync(join(recordings, '2026-10'), { recursive: true })
  return { root, ops, scripts, recordings }
}

function writeRecording(tree: Tree, name: string, markdown: string, sidecar: Record<string, unknown>): string {
  const path = join(tree.recordings, '2026-10', name)
  writeFileSync(path, markdown)
  writeFileSync(path.replace(/\.md$/, '.g2-chunks.json'), JSON.stringify(sidecar))
  return path
}

const macSidecar = { schemaVersion: 2, sourceType: 'mac_system_audio', captureSource: { sourceType: 'mac_system_audio', captureId: SESSION }, sessionId: SESSION, speakers: [] }
const g2Sidecar = { schemaVersion: 2, sessionId: 'meeting_1793113298813_d0bm6p', speakers: ['Jeremy'] }

function libraryFiles(ops: string): string[] {
  const out: string[] = []
  for (const domain of ['quilt', 'personal']) {
    const dir = join(ops, domain, 'meetings', '2026-10')
    if (existsSync(dir)) for (const name of readdirSync(dir)) out.push(`${domain}/${name}`)
  }
  return out.sort()
}

beforeAll(async () => {
  process.env.COS_DATA_DIR = join(scratch, 'data')
  process.env.HOME = join(scratch, 'home')
  process.env.COS_PROFILE_PATH = join(scratch, 'profile.json')
  mkdirSync(process.env.HOME, { recursive: true })
  delete process.env.COS_SCRIPTS_DIR
  delete process.env.COS_OPERATIONS_DIR
  handoff = await import('./g2-ops-handoff.js')
  runner = await import('./g2-enrichment-runner.js')
})

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => handoff.resetSyncCapabilitiesCache())
afterEach(() => { delete process.env.COS_SCRIPTS_DIR })

describe('sync capability probe', () => {
  it('never spawns an older sync_meetings.py, which has no --capabilities', async () => {
    const tree = makeTree()
    const script = writeFakeSyncMeetings(tree.scripts)
    const probe = vi.fn()
    expect(await handoff.readSyncCapabilities(join(tree.scripts, 'venv/bin/python3'), script, probe))
      .toEqual({ macImport: false, reason: 'sync_script_upgrade_required' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('reads mac_import from the real spawn and caches it until the script changes', async () => {
    const tree = makeTree()
    const script = writeFakeSyncMeetings(tree.scripts, { capabilities: CAPS })
    const python = join(tree.scripts, 'venv/bin/python3')
    expect(await handoff.readSyncCapabilities(python, script)).toEqual({ macImport: true, reason: null })
    expect(await handoff.readSyncCapabilities(python, script)).toEqual({ macImport: true, reason: null })
    expect(readFakeInvocations(tree.scripts).map(call => call.args)).toEqual([['--capabilities']])
    writeFakeSyncMeetings(tree.scripts, { capabilities: { schema: 1, g2_import: 1 } })
    utimesSync(script, new Date(), new Date(Date.now() + 5_000))
    expect(await handoff.readSyncCapabilities(python, script)).toEqual({ macImport: false, reason: 'sync_script_upgrade_required' })
    expect(readFakeInvocations(tree.scripts)).toHaveLength(2)
  })

  it('does not cache a failed or unreadable probe', async () => {
    const tree = makeTree()
    const script = writeFakeSyncMeetings(tree.scripts, { capabilities: CAPS })
    const failing = vi.fn(async () => ({ code: 1, stdout: '' }))
    expect(await handoff.readSyncCapabilities('py', script, failing)).toEqual({ macImport: false, reason: 'capability_probe_failed' })
    expect(await handoff.readSyncCapabilities('py', script, failing)).toEqual({ macImport: false, reason: 'capability_probe_failed' })
    expect(failing).toHaveBeenCalledTimes(2)
    const garbage = vi.fn(async () => ({ code: 0, stdout: 'not json' }))
    expect(await handoff.readSyncCapabilities('py', script, garbage)).toEqual({ macImport: false, reason: 'capability_probe_unreadable' })
    const ok = vi.fn(async () => ({ code: 0, stdout: 'noise\n{"mac_import": 1, "mac_twins": 2}\n' }))
    expect(await handoff.readSyncCapabilities('py', script, ok)).toEqual({ macImport: true, reason: null })
  })

  it('refuses a script that can import Mac recordings but has no twin rule', async () => {
    const tree = makeTree()
    const script = writeFakeSyncMeetings(tree.scripts, { capabilities: { schema: 1, g2_import: 1, mac_import: 1 } })
    expect(await handoff.readSyncCapabilities(join(tree.scripts, 'venv/bin/python3'), script))
      .toEqual({ macImport: false, reason: 'sync_script_upgrade_required' })
    const local = writeRecording(tree, '2026-10-27_Mac_recording_t.md', macMarkdown(), macSidecar)
    process.env.COS_SCRIPTS_DIR = tree.scripts
    expect(await handoff.fileMacRecordingInLibrary(local)).toEqual({ outcome: 'standalone', reason: 'sync_script_upgrade_required' })
    expect(readFakeInvocations(tree.scripts).filter(call => call.args[0] === '--mac-import-file')).toEqual([])
    const twinsOnly = vi.fn(async () => ({ code: 0, stdout: '{"mac_twins": 2}\n' }))
    handoff.resetSyncCapabilitiesCache()
    expect(await handoff.readSyncCapabilities('py', script, twinsOnly)).toEqual({ macImport: false, reason: 'sync_script_upgrade_required' })
    // mac_twins 1 knew G2 twins only: a Mac + Fireflies meeting would be filed twice.
    const g2TwinsOnly = vi.fn(async () => ({ code: 0, stdout: '{"mac_import": 1, "mac_twins": 1}\n' }))
    handoff.resetSyncCapabilitiesCache()
    expect(await handoff.readSyncCapabilities('py', script, g2TwinsOnly)).toEqual({ macImport: false, reason: 'sync_script_upgrade_required' })
    const later = vi.fn(async () => ({ code: 0, stdout: '{"mac_import": 1, "mac_twins": 3}\n' }))
    handoff.resetSyncCapabilitiesCache()
    expect(await handoff.readSyncCapabilities('py', script, later)).toEqual({ macImport: true, reason: null })
  })
})

describe('exact-sync arguments', () => {
  it('gives a Mac recording its own import and never a G2 flag', () => {
    expect(runner.buildExactG2SyncArgs('/s/sync_meetings.py', '/r/2026-10/m.md', false, true, true))
      .toEqual(['/s/sync_meetings.py', '--mac-import-file', '/r/2026-10/m.md', '--quiet'])
  })

  it('leaves every G2 combination exactly as 6.93.0 built it', () => {
    const b = runner.buildExactG2SyncArgs
    expect(b('/s', '/m', false, false)).toEqual(['/s', '--g2-only', '--g2-file', '/m', '--quiet'])
    expect(b('/s', '/m', false, true)).toEqual(['/s', '--g2-only', '--g2-import-file', '/m', '--quiet'])
    expect(b('/s', '/m', true, true)).toEqual(['/s', '--g2-only', '--g2-import-file', '/m', '--g2-claim-only', '--quiet'])
    expect(b('/s', '/m', true, false)).toEqual(['/s', '--g2-only', '--g2-file', '/m', '--g2-claim-only', '--quiet'])
  })
})

describe('the G2 path refuses a Mac or iPhone recording', () => {
  it('never relabels Mac System Audio or iPhone Microphone as G2 Glasses', () => {
    expect(() => handoff.patchRecordingForG2Pipeline(macMarkdown())).toThrow(/Refusing to relabel/)
    expect(() => handoff.patchRecordingForG2Pipeline(macMarkdown('| **Source** | Other |'))).toThrow(/Refusing to relabel/)
    expect(() => handoff.patchRecordingForG2Pipeline('# x\n\n| **Source** | iPhone Microphone |\n')).toThrow(/Refusing to relabel/)
    expect(handoff.patchRecordingForG2Pipeline(g2Markdown())).toContain('| **Source** | G2 Glasses |')
  })

  it('refuses a Mac sidecar under a G2 header at staging, writing nothing', () => {
    const tree = makeTree()
    const local = writeRecording(tree, '2026-10-27_G2_Recording_x.md', g2Markdown(), macSidecar)
    process.env.COS_OPERATIONS_DIR = tree.ops
    try {
      expect(() => handoff.stageRecordingIntoOperations(local)).toThrow(/Mac or iPhone recording through the G2 import/)
    } finally {
      delete process.env.COS_OPERATIONS_DIR
    }
    expect(libraryFiles(tree.ops)).toEqual([])
  })

  it('stages a genuine G2 recording exactly as before', () => {
    const tree = makeTree()
    const local = writeRecording(tree, '2026-10-27_G2_Recording_y.md', g2Markdown(), g2Sidecar)
    process.env.COS_OPERATIONS_DIR = tree.ops
    try {
      const staged = handoff.stageRecordingIntoOperations(local)
      expect(staged).toBe(join(tree.ops, 'personal', 'meetings', '2026-10', '2026-10-27_G2_Recording_y.md'))
      expect(readFileSync(staged!, 'utf8')).toBe(handoff.patchRecordingForG2Pipeline(g2Markdown(), { phase: 'final' }))
    } finally {
      delete process.env.COS_OPERATIONS_DIR
    }
  })

  it('isNonG2CaptureRecording reads the sidecar when the header is silent', () => {
    expect(handoff.isNonG2CaptureRecording('# x\n', { sourceType: 'mac_system_audio' })).toBe(true)
    expect(handoff.isNonG2CaptureRecording('# x\n', { captureSource: { sourceType: 'iphone_microphone' } })).toBe(true)
    expect(handoff.isNonG2CaptureRecording('# x\n', { sessionId: 'meeting_1' })).toBe(false)
    expect(handoff.isNonG2CaptureRecording(g2Markdown(), null)).toBe(false)
  })
})

describe('fileMacRecordingInLibrary', () => {
  it('files a Mac recording end to end through --mac-import-file into a realistic operations tree', async () => {
    const tree = makeTree()
    writeFakeSyncMeetings(tree.scripts, { capabilities: CAPS })
    const local = writeRecording(tree, '2026-10-27_Mac_recording_10_02_AM_444eab55.md', macMarkdown(), macSidecar)
    const before = readFileSync(local)
    process.env.COS_SCRIPTS_DIR = tree.scripts
    const filing = await handoff.fileMacRecordingInLibrary(local)
    const filed = join(tree.ops, 'quilt', 'meetings', '2026-10', '2026-10-27_Q4_Plan_and_Investor_Process_(Mac).md')
    expect(filing).toEqual({ outcome: 'filed', path: filed, status: 'enriched' })
    expect(readFakeInvocations(tree.scripts)).toEqual([
      { args: ['--capabilities'], importRoot: null },
      { args: ['--mac-import-file', local, '--quiet'], importRoot: tree.recordings },
    ])
    expect(libraryFiles(tree.ops)).toEqual([
      'quilt/2026-10-27_Q4_Plan_and_Investor_Process_(Mac).g2-chunks.json',
      'quilt/2026-10-27_Q4_Plan_and_Investor_Process_(Mac).md',
    ])
    expect(readFileSync(filed, 'utf8')).toContain('| **Source** | Mac System Audio |')
    expect(readFileSync(local)).toEqual(before)
  })

  it('a second filing of the same capture is the pipeline\'s idempotent answer, not a second file', async () => {
    const tree = makeTree()
    writeFakeSyncMeetings(tree.scripts, { capabilities: CAPS })
    const local = writeRecording(tree, '2026-10-27_Mac_recording_10_02_AM_444eab55.md', macMarkdown(), macSidecar)
    process.env.COS_SCRIPTS_DIR = tree.scripts
    await handoff.fileMacRecordingInLibrary(local)
    const again = await handoff.fileMacRecordingInLibrary(local)
    expect(again).toMatchObject({ outcome: 'filed', status: 'already-enriched' })
    expect(libraryFiles(tree.ops)).toHaveLength(2)
  })

  it('stays standalone with an older sync_meetings.py and never mislabels the file as G2', async () => {
    const tree = makeTree()
    writeFakeSyncMeetings(tree.scripts)
    const local = writeRecording(tree, '2026-10-27_Mac_recording_10_02_AM_444eab55.md', macMarkdown(), macSidecar)
    const before = readFileSync(local)
    process.env.COS_SCRIPTS_DIR = tree.scripts
    expect(await handoff.fileMacRecordingInLibrary(local)).toEqual({ outcome: 'standalone', reason: 'sync_script_upgrade_required' })
    expect(readFakeInvocations(tree.scripts)).toEqual([])
    expect(libraryFiles(tree.ops)).toEqual([])
    expect(readFileSync(local)).toEqual(before)
  })

  it('stays standalone without operations, and refuses a G2 recording', async () => {
    const tree = makeTree()
    writeFakeSyncMeetings(tree.scripts, { capabilities: CAPS })
    const mac = writeRecording(tree, '2026-10-27_Mac_recording_a.md', macMarkdown(), macSidecar)
    expect(await handoff.fileMacRecordingInLibrary(mac)).toEqual({ outcome: 'standalone', reason: 'operations_not_configured' })
    process.env.COS_SCRIPTS_DIR = tree.scripts
    const g2 = writeRecording(tree, '2026-10-27_G2_Recording_b.md', g2Markdown(), g2Sidecar)
    await expect(handoff.fileMacRecordingInLibrary(g2)).rejects.toThrow(/Not a Mac system-audio recording/)
    const relabelled = writeRecording(tree, '2026-10-27_Mac_recording_c.md', macMarkdown('| **Source** | G2 Glasses |'), macSidecar)
    await expect(handoff.fileMacRecordingInLibrary(relabelled)).rejects.toThrow(/Not a Mac system-audio recording/)
    expect(readFakeInvocations(tree.scripts)).toEqual([])
  })

  it('throws when the pipeline runs and fails, so the caller can log it', async () => {
    const tree = makeTree()
    writeFakeSyncMeetings(tree.scripts, { capabilities: CAPS, macImportExit: 2 })
    const local = writeRecording(tree, '2026-10-27_Mac_recording_d.md', macMarkdown(), macSidecar)
    process.env.COS_SCRIPTS_DIR = tree.scripts
    const runEnrichment = (options: Parameters<typeof runner.runG2EnrichmentWithRetry>[0]) =>
      runner.runG2EnrichmentWithRetry({ ...options, retryDelaysMs: [0] })
    await expect(handoff.fileMacRecordingInLibrary(local, { runEnrichment })).rejects.toThrow(/Mac library filing failed after 1 attempt/)
    expect(libraryFiles(tree.ops)).toEqual([])
  })
})

describe('the G2 hand-off refuses a Mac recording even when asked', () => {
  it('handoffMeetingToOperations rejects before spawning anything', async () => {
    const tree = makeTree()
    writeFakeSyncMeetings(tree.scripts, { capabilities: CAPS })
    const local = writeRecording(tree, '2026-10-27_Mac_recording_e.md', macMarkdown(), macSidecar)
    process.env.COS_SCRIPTS_DIR = tree.scripts
    vi.resetModules()
    const fresh = await import('./g2-ops-handoff.js')
    await expect(fresh.handoffMeetingToOperations(local)).rejects.toThrow(/Refusing a Mac or iPhone recording on the G2 import/)
    expect(readFakeInvocations(tree.scripts)).toEqual([])
    expect(dirname(local)).toBe(join(tree.recordings, '2026-10'))
  })
})
