import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TITLE_STEER_FILE_NAME,
  TITLE_STEER_MAX_CHARS,
  TITLE_STEER_RETAIN_MS,
  TitleSteerError,
  createTitleSteerStore,
  effectiveSaveTitle,
  normalizeTitleSteer,
} from './meeting-title-steer.js'

// Title steer ledger (6.99.0): the name typed in COS Control while a meeting records. Synthetic text only.

const roots: string[] = []
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'cos-title-steer-'))
  roots.push(root)
  return { root, path: join(root, TITLE_STEER_FILE_NAME) }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const SID = 'mac_abcdef01-2345-6789-abcd-0123456789ab'
const failure = (fn: () => unknown): TitleSteerError => {
  try { fn() } catch (error) { if (error instanceof TitleSteerError) return error; throw error }
  throw new Error('expected a TitleSteerError')
}

describe('normalizeTitleSteer', () => {
  it('trims, collapses whitespace, turns control characters into spaces and applies NFKC', () => {
    expect(normalizeTitleSteer('  Polling   accuracy\tchat \n ')).toBe('Polling accuracy chat')
    expect(normalizeTitleSteer('Q4\u0000plan\u001fnotes\u007f!')).toBe('Q4 plan notes !')
    expect(normalizeTitleSteer('Ｑ４ plan')).toBe('Q4 plan')            // fullwidth Q4 to ASCII
    expect(normalizeTitleSteer('café')).toBe('café')            // decomposed to composed
  })

  it('drops zero-width and direction-override marks so a title cannot hide or reverse text', () => {
    for (const mark of ['\u200b', '\u200f', '\u202a', '\u202e', '\u2060', '\u2066', '\u2069', '\ufeff']) {
      expect(normalizeTitleSteer(`Pla${mark}nning`), mark.charCodeAt(0).toString(16)).toBe('Planning')
    }
  })

  it('treats null, undefined and blank as "no title"', () => {
    for (const value of [null, undefined, '', '   ', '\n\t']) expect(normalizeTitleSteer(value)).toBe('')
  })

  it('refuses anything that is not a string', () => {
    for (const value of [5, true, {}, [], ['a']]) expect(failure(() => normalizeTitleSteer(value))).toMatchObject({ reason: 'invalid_title', status: 400 })
  })

  it('caps at 120 characters AFTER trimming: 120 is kept whole, 121 is refused', () => {
    const exactly = 'a'.repeat(TITLE_STEER_MAX_CHARS)
    expect(TITLE_STEER_MAX_CHARS).toBe(120)
    expect(normalizeTitleSteer(`   ${exactly}   `)).toBe(exactly)
    expect(failure(() => normalizeTitleSteer(exactly + 'a'))).toMatchObject({ reason: 'invalid_title', status: 400 })
  })

  it('counts characters, not UTF-16 units: 120 emoji fit, 121 do not', () => {
    expect(normalizeTitleSteer('\u{1F4C8}'.repeat(120))).toBe('\u{1F4C8}'.repeat(120))
    expect(failure(() => normalizeTitleSteer('\u{1F4C8}'.repeat(121))).reason).toBe('invalid_title')
  })

  it('does not truncate: an over-long title is refused, never silently cut', () => {
    expect(() => normalizeTitleSteer('b'.repeat(500))).toThrow(TitleSteerError)
  })
})

describe('title steer store', () => {
  it('starts empty: revision 0, no title, no timestamp', () => {
    const { path } = scratch()
    const store = createTitleSteerStore({ path })
    expect(store.get(SID)).toEqual({ sessionId: SID, title: null, revision: 0, updatedAt: null })
    expect(store.title(SID)).toBeNull()
  })

  it('sets, reads back and bumps the revision on every change', () => {
    const { path } = scratch()
    let clock = Date.parse('2026-11-03T21:00:00.000Z')
    const store = createTitleSteerStore({ path, now: () => clock })
    expect(store.set(SID, 'Polling accuracy chat', 0)).toEqual({ sessionId: SID, title: 'Polling accuracy chat', revision: 1, updatedAt: '2026-11-03T21:00:00.000Z' })
    clock += 5_000
    const second = store.set(SID, '  Polling   accuracy and weighting ', 1)
    expect(second).toEqual({ sessionId: SID, title: 'Polling accuracy and weighting', revision: 2, updatedAt: '2026-11-03T21:00:05.000Z' })
    expect(store.get(SID)).toEqual(second)
    expect(store.title(SID)).toBe('Polling accuracy and weighting')
  })

  it('clears with "" or null, keeps counting the revision, and a cleared steer feeds no save', () => {
    const { path } = scratch()
    const store = createTitleSteerStore({ path })
    store.set(SID, 'Keep this', 0)
    const cleared = store.set(SID, '', 1)
    expect(cleared).toMatchObject({ title: null, revision: 2 })
    expect(store.title(SID)).toBeNull()
    store.set(SID, 'Again', 2)
    expect(store.set(SID, null, 3)).toMatchObject({ title: null, revision: 4 })
    expect(store.title(SID)).toBeNull()
  })

  it('clearing where nothing was ever set changes nothing and writes nothing', () => {
    const { path, root } = scratch()
    const store = createTitleSteerStore({ path })
    expect(store.set(SID, '', 0)).toEqual({ sessionId: SID, title: null, revision: 0, updatedAt: null })
    expect(store.set(SID, '   ', 0).revision).toBe(0)
    expect(readdirSync(root)).toEqual([])
  })

  it('409 title_changed when expectedRevision is stale, ahead or the wrong kind of number, and the title is untouched', () => {
    const { path } = scratch()
    const store = createTitleSteerStore({ path })
    store.set(SID, 'First', 0)
    store.set(SID, 'Second', 1)
    for (const stale of [0, 1, 3]) expect(failure(() => store.set(SID, 'Third', stale))).toMatchObject({ reason: 'title_changed', status: 409 })
    expect(store.get(SID)).toMatchObject({ title: 'Second', revision: 2 })
    // A first write must name revision 0.
    expect(failure(() => store.set('meeting_other_0001', 'X', 1))).toMatchObject({ reason: 'title_changed', status: 409 })
    // A clear is a write too: a stale clear is refused.
    expect(failure(() => store.set(SID, '', 1)).reason).toBe('title_changed')
    expect(store.get(SID).title).toBe('Second')
  })

  it('400 invalid_revision for a missing, negative, fractional or string revision', () => {
    const { path } = scratch()
    const store = createTitleSteerStore({ path })
    for (const bad of [undefined, null, -1, 0.5, '0', NaN, Infinity, 2 ** 60]) {
      expect(failure(() => store.set(SID, 'X', bad)), String(bad)).toMatchObject({ reason: 'invalid_revision', status: 400 })
    }
  })

  it('400 invalid_session_id for ids the other meeting routes refuse', () => {
    const { path } = scratch()
    const store = createTitleSteerStore({ path })
    for (const bad of ['', 'ab', '../etc/passwd', 'has space', 'a'.repeat(97), 'bad/slash']) {
      expect(failure(() => store.get(bad)).reason).toBe('invalid_session_id')
      expect(failure(() => store.set(bad, 'X', 0)).reason).toBe('invalid_session_id')
    }
    expect(store.title('../etc/passwd')).toBeNull()
  })

  it('an over-long or non-string title is refused before anything is stored', () => {
    const { path, root } = scratch()
    const store = createTitleSteerStore({ path })
    expect(failure(() => store.set(SID, 'x'.repeat(121), 0)).reason).toBe('invalid_title')
    expect(failure(() => store.set(SID, 7, 0)).reason).toBe('invalid_title')
    expect(store.get(SID).revision).toBe(0)
    expect(readdirSync(root)).toEqual([])
  })

  it('persists across a reload: a new store on the same file sees the title and revision', () => {
    const { path } = scratch()
    const first = createTitleSteerStore({ path })
    first.set(SID, 'Board prep', 0)
    first.set(SID, 'Board prep and pricing', 1)
    const reloaded = createTitleSteerStore({ path })
    expect(reloaded.get(SID)).toMatchObject({ title: 'Board prep and pricing', revision: 2 })
    // The reloaded store keeps counting from where the first stopped, so an old client is still refused.
    expect(failure(() => reloaded.set(SID, 'Late', 1)).reason).toBe('title_changed')
    expect(reloaded.set(SID, 'Next', 2).revision).toBe(3)
  })

  it('a cleared steer survives a reload as a cleared steer with its revision', () => {
    const { path } = scratch()
    const first = createTitleSteerStore({ path })
    first.set(SID, 'Gone soon', 0)
    first.set(SID, '', 1)
    const reloaded = createTitleSteerStore({ path })
    expect(reloaded.get(SID)).toMatchObject({ title: null, revision: 2 })
    expect(reloaded.title(SID)).toBeNull()
  })

  it('writes a private file (0600) in a private directory and leaves no temp files', () => {
    const { root } = scratch()
    const nested = join(root, 'data')
    const path = join(nested, TITLE_STEER_FILE_NAME)
    createTitleSteerStore({ path }).set(SID, 'Private', 0)
    expect(readFileSync(path, 'utf-8')).toContain('Private')
    expect((require('node:fs').statSync(path).mode & 0o777).toString(8)).toBe('600')
    expect(readdirSync(nested)).toEqual([TITLE_STEER_FILE_NAME])
  })

  it('keeps an entry for 7 days (pinned as a literal, not read back from the constant)', () => {
    expect(TITLE_STEER_RETAIN_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('prunes on the very first read, whichever read it is: get() on a fresh store drops an expired entry', () => {
    const { path } = scratch()
    let clock = 1_000_000_000_000
    createTitleSteerStore({ path, now: () => clock }).set(SID, 'Old news', 0)
    clock += TITLE_STEER_RETAIN_MS + 1
    expect(createTitleSteerStore({ path, now: () => clock }).get(SID)).toEqual({ sessionId: SID, title: null, revision: 0, updatedAt: null })
  })

  it('prunes entries older than 7 days on read, and an expired session starts again at revision 0', () => {
    const { path } = scratch()
    let clock = 1_000_000_000_000
    const store = createTitleSteerStore({ path, now: () => clock })
    store.set(SID, 'Old news', 0)
    store.set('meeting_fresh_0001', 'Fresh', 0)
    clock += TITLE_STEER_RETAIN_MS                       // exactly 7 days: still kept
    expect(store.title(SID)).toBe('Old news')
    clock += 1                                           // one ms past: gone
    expect(store.title(SID)).toBeNull()
    expect(store.get(SID)).toMatchObject({ title: null, revision: 0 })
    expect(store.set(SID, 'Reborn', 0).revision).toBe(1)
  })

  it('pruning is written through: an expired entry is gone from the file after the next write', () => {
    const { path } = scratch()
    let clock = 1_000_000_000_000
    const store = createTitleSteerStore({ path, now: () => clock })
    store.set(SID, 'Old news', 0)
    clock += TITLE_STEER_RETAIN_MS + 1
    store.set('meeting_fresh_0001', 'Fresh', 0)
    const entries = JSON.parse(readFileSync(path, 'utf-8')).entries
    expect(Object.keys(entries)).toEqual(['meeting_fresh_0001'])
  })

  it('a failed write changes nothing: the revision and title stay, and the error is a 503', () => {
    const { root } = scratch()
    const dir = join(root, 'data')
    mkdirSync(dir)
    const path = join(dir, TITLE_STEER_FILE_NAME)
    const store = createTitleSteerStore({ path })
    store.set(SID, 'Stays', 0)
    chmodSync(dir, 0o500)                                // the directory refuses the temp file
    try {
      expect(failure(() => store.set(SID, 'Lost', 1))).toMatchObject({ reason: 'steer_persistence_failed', status: 503 })
      expect(store.get(SID)).toMatchObject({ title: 'Stays', revision: 1 })
    } finally { chmodSync(dir, 0o700) }
    // The same revision still works once the disk does.
    expect(store.set(SID, 'Now saved', 1).revision).toBe(2)
  })

  it('a corrupt file is set aside, not trusted and not deleted', () => {
    const { path, root } = scratch()
    writeFileSync(path, '{ not json')
    const store = createTitleSteerStore({ path })
    expect(store.get(SID).revision).toBe(0)
    expect(readdirSync(root).some(name => name.startsWith(`${TITLE_STEER_FILE_NAME}.corrupt.`))).toBe(true)
  })

  it('skips file entries a PUT would have refused: a bad id, revision, or an over-long title', () => {
    const { path } = scratch()
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      entries: {
        [SID]: { title: '  Fine   title ', revision: 3, updatedAt: Date.now() },
        'bad id': { title: 'x', revision: 1, updatedAt: Date.now() },
        meeting_zero_0001: { title: 'x', revision: 0, updatedAt: Date.now() },
        meeting_long_0001: { title: 'y'.repeat(500), revision: 1, updatedAt: Date.now() },
        meeting_num_0001: { title: 42, revision: 1, updatedAt: Date.now() },
      },
    }))
    const store = createTitleSteerStore({ path })
    expect(store.get(SID)).toMatchObject({ title: 'Fine title', revision: 3 })
    for (const id of ['meeting_zero_0001', 'meeting_long_0001', 'meeting_num_0001']) {
      expect(store.get(id), id).toEqual({ sessionId: id, title: null, revision: 0, updatedAt: null })
      expect(store.title(id), id).toBeNull()
    }
  })

  it('an id that fits the pattern but names an Object member reads as absent, can be set, and never touches prototypes', () => {
    const { path } = scratch()
    const store = createTitleSteerStore({ path })
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(store.get(id), id).toEqual({ sessionId: id, title: null, revision: 0, updatedAt: null })
      expect(store.title(id), id).toBeNull()
    }
    expect(store.set('__proto__', 'Odd but legal', 0)).toMatchObject({ title: 'Odd but legal', revision: 1 })
    expect(({} as Record<string, unknown>).title).toBeUndefined()
    expect(createTitleSteerStore({ path }).get('__proto__')).toMatchObject({ title: 'Odd but legal', revision: 1 })
    // Read back from the file: Object members still read as absent, and the stored `__proto__` entry is the only one there.
    const reloaded = createTitleSteerStore({ path })
    for (const id of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(reloaded.get(id), id).toEqual({ sessionId: id, title: null, revision: 0, updatedAt: null })
      expect(reloaded.title(id), id).toBeNull()
    }
  })

  it('the file is cleaned as it is rewritten: an entry the reader refused is gone after the next write', () => {
    const { path } = scratch()
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, entries: {
      'bad id': { title: 'x', revision: 1, updatedAt: Date.now() },
      meeting_zero_0001: { title: 'x', revision: 0, updatedAt: Date.now() },
      [SID]: { title: 'Good', revision: 1, updatedAt: Date.now() },
    } }))
    const store = createTitleSteerStore({ path })
    store.set('meeting_other_0001', 'Trigger a write', 0)
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8')).entries).sort()).toEqual([SID, 'meeting_other_0001'].sort())
  })
})

describe('effectiveSaveTitle', () => {
  it('a title the request sent wins, untouched', () => {
    expect(effectiveSaveTitle('Sent title', 'Steer')).toBe('Sent title')
  })
  it('no title, blank or whitespace-only title, or a non-string title falls back to the steer', () => {
    for (const sent of [undefined, null, '', '   ', 5]) expect(effectiveSaveTitle(sent, 'Steer')).toBe('Steer')
  })
  it('neither a title nor a steer is undefined, so the store files its own fallback', () => {
    expect(effectiveSaveTitle(undefined, null)).toBeUndefined()
    expect(effectiveSaveTitle('', null)).toBeUndefined()
  })
})
