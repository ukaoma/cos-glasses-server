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
  readMergeModeFile,
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
