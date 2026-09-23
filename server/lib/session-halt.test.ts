// Halt markers (6.53.0). The store is exercised on a real temp folder whose path carries a
// dot component, as the production data home does (a fixture that cannot reproduce the
// production value is not coverage). The hook side is executed in cos-session-hook.script.test.ts;
// the last case here proves the two agree on the folder.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, afterAll } from 'vitest'
import {
  HALT_MARKER_TTL_MS,
  __resetHaltRearmsForTests,
  clearHaltMarker,
  clearHaltMarkerOnSessionEnd,
  dropHaltRearm,
  haltDeliveredTurn,
  hasPendingHaltRearm,
  rearmHaltOnPrompt,
  haltDir,
  haltMarkerPath,
  hasHaltMarker,
  sweepHaltMarkers,
  writeHaltMarker,
} from './session-halt.js'
import { hookSpoolDir } from './claude-hooks-installer.js'

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})

const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const OTHER = '80927570-0000-4000-8000-000000000000'
const NOW = 1_790_000_000_000

const folder = () => join(trackedTemp(mkdtempSync(join(tmpdir(), 'cos-halt-'))), '.cos-glasses', 'data', 'session-halt')

describe('session halt markers', () => {
  it('writes the lowercase id as the name, private, with the cancel it came from', () => {
    const dir = folder()
    expect(writeHaltMarker(SID.toUpperCase(), { at: NOW, clientCancelId: 'cc-1' }, dir)).toBe(true)
    expect(readdirSync(dir)).toEqual([SID])
    expect(JSON.parse(readFileSync(join(dir, SID), 'utf-8'))).toEqual({ at: NOW, clientCancelId: 'cc-1' })
    expect(statSync(join(dir, SID)).mode & 0o077).toBe(0)
    expect(statSync(dir).mode & 0o077).toBe(0)
    expect(hasHaltMarker(SID, dir)).toBe(true)
    expect(hasHaltMarker(SID.toUpperCase(), dir)).toBe(true)
    expect(hasHaltMarker(OTHER, dir)).toBe(false)
  })

  it('refuses anything that is not a full session id: it becomes a path and a shell test', () => {
    const dir = folder()
    for (const bad of ['', 'a4b2b4dd', '../../etc/passwd', `${SID}/x`, `${SID}.tmp`, `x${SID}`]) {
      expect(haltMarkerPath(bad, dir)).toBeNull()
      expect(writeHaltMarker(bad, { at: NOW, clientCancelId: 'cc' }, dir)).toBe(false)
      expect(clearHaltMarker(bad, dir)).toBe(false)
      expect(hasHaltMarker(bad, dir)).toBe(false)
    }
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })

  it('a write that cannot land reports false', () => {
    const root = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-halt-')))
    const blocker = join(root, 'data')
    writeFileSync(blocker, 'a file where the folder should be')
    expect(writeHaltMarker(SID, { at: NOW, clientCancelId: 'cc' }, join(blocker, 'session-halt'))).toBe(false)
  })

  it('clear removes only that session, and says whether anything was there', () => {
    const dir = folder()
    writeHaltMarker(SID, { at: NOW, clientCancelId: 'a' }, dir)
    writeHaltMarker(OTHER, { at: NOW, clientCancelId: 'b' }, dir)
    expect(clearHaltMarker(SID.toUpperCase(), dir)).toBe(true)
    expect(clearHaltMarker(SID, dir)).toBe(false)
    expect(readdirSync(dir)).toEqual([OTHER])
  })

  it('a SessionEnd clears only a marker written at or before it (a late SessionEnd never clears a newer cancel)', () => {
    const dir = folder()
    writeHaltMarker(SID, { at: NOW, clientCancelId: 'a' }, dir)
    expect(clearHaltMarkerOnSessionEnd(SID, NOW - 1, dir)).toBe(false)
    expect(hasHaltMarker(SID, dir)).toBe(true)
    expect(clearHaltMarkerOnSessionEnd(SID, Number.NaN, dir)).toBe(false)
    expect(clearHaltMarkerOnSessionEnd(SID, NOW, dir)).toBe(true)
    expect(hasHaltMarker(SID, dir)).toBe(false)
    expect(clearHaltMarkerOnSessionEnd(SID, NOW, dir)).toBe(false)
    expect(clearHaltMarkerOnSessionEnd('nope', NOW, dir)).toBe(false)
  })

  it('the sweep removes markers past the hour and keeps younger ones', () => {
    const dir = folder()
    writeHaltMarker(SID, { at: NOW - HALT_MARKER_TTL_MS, clientCancelId: 'old' }, dir)
    writeHaltMarker(OTHER, { at: NOW - HALT_MARKER_TTL_MS + 1, clientCancelId: 'young' }, dir)
    expect(sweepHaltMarkers(NOW, HALT_MARKER_TTL_MS, dir)).toBe(1)
    expect(readdirSync(dir)).toEqual([OTHER])
    expect(HALT_MARKER_TTL_MS).toBe(60 * 60_000)
  })

  it('the sweep falls back to mtime for an unreadable body, and to mtime for a marker dated in the future', () => {
    const dir = folder()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SID), 'not json')
    const old = new Date(NOW - 2 * HALT_MARKER_TTL_MS)
    utimesSync(join(dir, SID), old, old)
    writeHaltMarker(OTHER, { at: NOW + 10 * HALT_MARKER_TTL_MS, clientCancelId: 'future' }, dir)
    utimesSync(join(dir, OTHER), old, old)
    expect(sweepHaltMarkers(NOW, HALT_MARKER_TTL_MS, dir)).toBe(2)
    expect(readdirSync(dir)).toEqual([])
  })

  it('the sweep removes a name the server never writes (an abandoned .tmp), and tolerates a missing folder', () => {
    const dir = folder()
    writeHaltMarker(SID, { at: NOW, clientCancelId: 'keep' }, dir)
    writeFileSync(join(dir, `${SID}.tmp`), '{}')
    expect(sweepHaltMarkers(NOW, HALT_MARKER_TTL_MS, dir)).toBe(1)
    expect(readdirSync(dir)).toEqual([SID])
    expect(sweepHaltMarkers(NOW, HALT_MARKER_TTL_MS, join(dir, 'nope'))).toBe(0)
  })

  it('the folder is the one the hook reads: beside the spool, under the data home', () => {
    // The hook computes `$(dirname "$SPOOL")/session-halt`; the server bakes `hookSpoolDir()`
    // into the command. Under the suite's COS_DATA_DIR both resolve under that data home.
    const saved = process.env.COS_SESSION_HOOKS_SPOOL_DIR
    delete process.env.COS_SESSION_HOOKS_SPOOL_DIR
    try {
      expect(join(dirname(hookSpoolDir()), 'session-halt')).toBe(haltDir())
    } finally {
      if (saved !== undefined) process.env.COS_SESSION_HOOKS_SPOOL_DIR = saved
    }
  })
})

// 6.53.3 (review A6): a turn COS handed into the open session while a cancel was on its way.
// The hook deletes the marker on UserPromptSubmit, and the delivered turn's own prompt can
// come AFTER the write (a busy session takes it when its current run ends).
describe('the marker for a handed-off turn survives that turn\'s own UserPromptSubmit (6.53.3)', () => {
  afterEach(() => __resetHaltRearmsForTests())
  const marker = { at: NOW, clientCancelId: 'cc-handoff-1' }
  const PROMPT = 'keep going on the parser'

  it('re-arms once, on the first prompt at or after the send that carries the delivered text', () => {
    const dir = folder()
    expect(haltDeliveredTurn(SID, marker, { promptMarker: PROMPT, after: NOW, rearm: true, now: NOW }, dir)).toBe(true)
    expect(hasHaltMarker(SID, dir)).toBe(true)
    // The hook's own UserPromptSubmit deletes it (modelled here), then the server re-arms.
    clearHaltMarker(SID, dir)
    // Someone else's prompt: never the one that re-arms (the person's own next desk prompt).
    expect(rearmHaltOnPrompt(SID, NOW + 5, 'something else entirely', dir, NOW + 5)).toBe(false)
    // A prompt from before the send.
    expect(rearmHaltOnPrompt(SID, NOW - 1, PROMPT, dir, NOW + 6)).toBe(false)
    expect(hasHaltMarker(SID, dir)).toBe(false)
    expect(rearmHaltOnPrompt(SID.toUpperCase(), NOW + 10, `peer: ${PROMPT}`, dir, NOW + 10)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, SID), 'utf-8'))).toEqual(marker)
    // One shot.
    clearHaltMarker(SID, dir)
    expect(rearmHaltOnPrompt(SID, NOW + 20, PROMPT, dir, NOW + 20)).toBe(false)
    expect(hasHaltMarker(SID, dir)).toBe(false)
  })

  it('no re-arm when the turn has visibly started, and none past the marker\'s hour or after SessionEnd', () => {
    const dir = folder()
    expect(haltDeliveredTurn(SID, marker, { promptMarker: PROMPT, after: NOW, rearm: false, now: NOW }, dir)).toBe(true)
    expect(hasPendingHaltRearm(SID)).toBe(false)
    clearHaltMarker(SID, dir)
    expect(rearmHaltOnPrompt(SID, NOW + 10, PROMPT, dir, NOW + 10)).toBe(false)

    haltDeliveredTurn(SID, marker, { promptMarker: PROMPT, after: NOW, rearm: true, now: NOW }, dir)
    clearHaltMarker(SID, dir)
    expect(rearmHaltOnPrompt(SID, NOW + HALT_MARKER_TTL_MS + 1, PROMPT, dir, NOW + HALT_MARKER_TTL_MS + 1)).toBe(false)
    expect(hasPendingHaltRearm(SID)).toBe(false)

    haltDeliveredTurn(SID, marker, { promptMarker: PROMPT, after: NOW, rearm: true, now: NOW }, dir)
    clearHaltMarker(SID, dir)
    dropHaltRearm(SID.toUpperCase())
    expect(rearmHaltOnPrompt(SID, NOW + 10, PROMPT, dir, NOW + 10)).toBe(false)
    expect(hasHaltMarker(SID, dir)).toBe(false)
  })

  it('a marker that cannot be written is reported, and nothing is left pending', () => {
    const root = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-halt-')))
    const blocker = join(root, 'data')
    writeFileSync(blocker, 'a file where the folder should be')
    expect(haltDeliveredTurn(SID, marker, { promptMarker: PROMPT, after: NOW, rearm: true, now: NOW }, join(blocker, 'session-halt'))).toBe(false)
    expect(hasPendingHaltRearm(SID)).toBe(false)
  })
})
