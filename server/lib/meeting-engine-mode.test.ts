// The one predicate and the one mode file four processes have to agree on.

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MERGE_MODE_FILENAME,
  MERGE_MODE_SCHEMA,
  meetingEngineIsPipelineMac,
  meetingEngineMode,
  meetingEngineModeDetail,
  mergeModeFilePath,
  readMergeModeFile,
  readMergeModeRecord,
  resetRememberedMacClass,
  writeMergeModeFile,
} from './meeting-engine-mode.js'
import * as handoff from './g2-ops-handoff.js'

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-mode-'))
  dirs.push(dir)
  return dir
}

function modeFile(dir: string): string {
  return join(dir, MERGE_MODE_FILENAME)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('reading the mode file', () => {
  it('answers advise when the file is not there', () => {
    expect(readMergeModeFile(modeFile(scratch()))).toBe('advise')
  })

  it('reads apply, and reads advise', () => {
    const dir = scratch()
    writeFileSync(modeFile(dir), JSON.stringify({ schema: MERGE_MODE_SCHEMA, mode: 'apply', changedAt: 'x', changedBy: 'control' }))
    expect(readMergeModeFile(modeFile(dir))).toBe('apply')
    writeFileSync(modeFile(dir), JSON.stringify({ schema: MERGE_MODE_SCHEMA, mode: 'advise', changedAt: 'x', changedBy: 'control' }))
    expect(readMergeModeFile(modeFile(dir))).toBe('advise')
  })

  // Every failure lands on advise. The safe mode is the one that writes nothing into a
  // person's meeting tree, so a file that cannot be understood must never read as
  // permission to write there.
  it.each([
    ['unparseable bytes', '{not json'],
    ['an empty file', ''],
    ['a schema it does not know', JSON.stringify({ schema: 99, mode: 'apply' })],
    ['no schema at all', JSON.stringify({ mode: 'apply' })],
    ['a mode it does not know', JSON.stringify({ schema: 1, mode: 'yolo' })],
    ['an array', '[]'],
    ['a bare string', '"apply"'],
  ])('answers advise for %s', (_label, body) => {
    const dir = scratch()
    writeFileSync(modeFile(dir), body)
    expect(readMergeModeFile(modeFile(dir))).toBe('advise')
  })

  it('answers advise for a file it cannot read', () => {
    const dir = scratch()
    const path = modeFile(dir)
    writeFileSync(path, JSON.stringify({ schema: 1, mode: 'apply' }), { mode: 0o600 })
    chmodSync(path, 0o000)
    expect(readMergeModeFile(path)).toBe('advise')
    chmodSync(path, 0o600)
  })
})

describe('writing the mode file', () => {
  it('writes the schema, the mode, when and who, at 0600', () => {
    const dir = scratch()
    const record = writeMergeModeFile('apply', { path: modeFile(dir), now: () => 1_757_000_000_000 })
    expect(record).toMatchObject({ schema: MERGE_MODE_SCHEMA, mode: 'apply', changedBy: 'control' })
    expect(statSync(modeFile(dir)).mode & 0o777).toBe(0o600)
    const written = JSON.parse(readFileSync(modeFile(dir), 'utf8'))
    expect(written.mode).toBe('apply')
    expect(Date.parse(written.changedAt)).toBe(1_757_000_000_000)
  })

  it('round trips through the reader', () => {
    const dir = scratch()
    writeMergeModeFile('apply', { path: modeFile(dir) })
    expect(readMergeModeFile(modeFile(dir))).toBe('apply')
    writeMergeModeFile('advise', { path: modeFile(dir) })
    expect(readMergeModeFile(modeFile(dir))).toBe('advise')
  })
})

describe('the predicate', () => {
  it('is imports on a Mac with no pipeline, whatever the mode file says', () => {
    // A Mac with no pipeline has no operations tree to advise about, so the file is not
    // consulted at all: the server does the importing itself.
    vi.spyOn(handoff, 'g2RecordingsReachOperations').mockReturnValue(false)
    expect(meetingEngineMode()).toBe('imports')
    expect(meetingEngineIsPipelineMac()).toBe(false)
  })

  it('reads the file on a Mac with a pipeline', () => {
    vi.spyOn(handoff, 'g2RecordingsReachOperations').mockReturnValue(true)
    expect(meetingEngineIsPipelineMac()).toBe(true)
    // The data home is the vitest-isolated one and has no mode file, so this is the
    // absent-file default rather than a leftover from another test.
    expect(meetingEngineMode()).toBe('advise')
  })
})

/**
 * QA round 1: a transient missing venv must not flip a pipeline Mac to imports.
 *
 * `g2RecordingsReachOperations()` is a LIVE probe — it stats the COS venv's python and
 * `sync_meetings.py`. Those go missing for reasons that have nothing to do with this Mac's
 * identity: iCloud evicting the checkout, a pip rebuild, COS Control changing
 * `COS_SCRIPTS_DIR` between two reads. Every one of them answered `imports`, and `imports` is
 * the one mode that lets the server import Fireflies meetings the pipeline already files.
 *
 * A LIVE POSITIVE STILL WINS, always. The asymmetry is the point: being wrong towards advise
 * writes nothing, and being wrong towards imports writes a second copy of every meeting.
 */
describe('remembering the Mac class', () => {
  beforeEach(() => {
    resetRememberedMacClass()
    try { rmSync(mergeModeFilePath()) } catch { /* nothing to clear */ }
  })

  afterEach(() => {
    resetRememberedMacClass()
    try { rmSync(mergeModeFilePath()) } catch { /* nothing to clear */ }
  })

  it('records pipeline on a Mac that reaches operations', () => {
    vi.spyOn(handoff, 'g2RecordingsReachOperations').mockReturnValue(true)
    expect(meetingEngineModeDetail()).toMatchObject({ mode: 'advise', observedMacClass: 'pipeline', macClassChanged: false })
    expect(readMergeModeRecord()!.macClass).toBe('pipeline')
    expect(readMergeModeRecord()!.changedBy).toBe('server')
  })

  it('keeps the recorded mode, and raises the alarm, on a transient negative', () => {
    vi.spyOn(handoff, 'g2RecordingsReachOperations').mockReturnValue(true)
    meetingEngineModeDetail()
    writeMergeModeFile('apply', { macClass: 'pipeline' })
    resetRememberedMacClass()
    vi.spyOn(handoff, 'g2RecordingsReachOperations').mockReturnValue(false)
    const detail = meetingEngineModeDetail()
    expect(detail.mode).toBe('apply')
    expect(detail.observedMacClass).toBe('standalone')
    expect(detail.recordedMacClass).toBe('pipeline')
    expect(detail.macClassChanged).toBe(true)
    // And the mode file is NOT rewritten to standalone by a probe that may be wrong.
    expect(readMergeModeRecord()!.macClass).toBe('pipeline')
  })

  it('is still imports on a Mac that has never seen a pipeline', () => {
    vi.spyOn(handoff, 'g2RecordingsReachOperations').mockReturnValue(false)
    const detail = meetingEngineModeDetail()
    expect(detail.mode).toBe('imports')
    expect(detail.observedMacClass).toBe('standalone')
    expect(detail.macClassChanged).toBe(false)
    expect(readMergeModeRecord()!.macClass).toBe('standalone')
  })

  it('a live positive overrides a recorded standalone, and says the class changed', () => {
    vi.spyOn(handoff, 'g2RecordingsReachOperations').mockReturnValue(false)
    meetingEngineModeDetail()
    resetRememberedMacClass()
    vi.spyOn(handoff, 'g2RecordingsReachOperations').mockReturnValue(true)
    const detail = meetingEngineModeDetail()
    expect(detail.mode).toBe('advise')
    expect(detail.macClassChanged).toBe(true)
    expect(readMergeModeRecord()!.macClass).toBe('pipeline')
  })

  it('writes the class at most once per process, not once per call', () => {
    // `meetingEngineMode()` runs on every list, detail, status poll and import refusal.
    vi.spyOn(handoff, 'g2RecordingsReachOperations').mockReturnValue(true)
    meetingEngineModeDetail()
    const first = readFileSync(mergeModeFilePath(), 'utf8')
    for (let i = 0; i < 20; i++) meetingEngineModeDetail()
    expect(readFileSync(mergeModeFilePath(), 'utf8')).toBe(first)
  })

  it('keeps the class through a mode change written by Control', () => {
    vi.spyOn(handoff, 'g2RecordingsReachOperations').mockReturnValue(true)
    meetingEngineModeDetail()
    writeMergeModeFile('apply')
    expect(readMergeModeRecord()).toMatchObject({ mode: 'apply', macClass: 'pipeline', changedBy: 'control' })
  })
})
