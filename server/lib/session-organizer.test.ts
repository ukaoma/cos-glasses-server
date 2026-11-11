// Sessions chat-style layout, step 2a: the organizer store (S1_CONTRACT_step2a.md, section A).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORGANIZER_LIMITS, OrganizerError, SessionOrganizer, cleanOrganizerText, organizerKey } from './session-organizer.js'

let dir = ''
let path = ''
let logs: string[] = []
const make = () => new SessionOrganizer(path, line => logs.push(line), () => new Date('2026-11-10T23:30:00.000Z'))
const code = (fn: () => unknown) => { try { fn(); return 'ok' } catch (e) { return e instanceof OrganizerError ? `${e.status} ${e.reason}` : String(e) } }
const onDisk = () => JSON.parse(readFileSync(path, 'utf8'))

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cos-organizer-')); path = join(dir, 'session-organizer.json'); logs = [] })
afterEach(() => { try { chmodSync(path, 0o600) } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }) })

describe('session organizer store', () => {
  it('starts empty, creates the file only on the first change, private, and counts rev per change', () => {
    const o = make()
    expect(o.isEmpty()).toBe(true)
    expect(existsSync(path)).toBe(false)
    const f = o.createFolder('  Release   notes ')
    expect(f).toMatchObject({ name: 'Release notes', count: 0 })
    expect(f.id).toMatch(/^f_[0-9a-f]{16}$/)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    o.updateSession(organizerKey('claude', 'ABC-1'), { cos_pinned: true })
    expect(o.rev()).toBe(2)
    expect(onDisk().rev).toBe(2)
  })

  it('cleans and bounds names and titles', () => {
    expect(cleanOrganizerText('a\nb\u0000c\u2028d', 60)).toBe('a b c d')
    expect(cleanOrganizerText('   ', 60)).toBeNull()
    expect(cleanOrganizerText('x'.repeat(61), 60)).toBeNull()
    expect(cleanOrganizerText(42, 60)).toBeNull()
    const o = make()
    expect(code(() => o.createFolder(''))).toBe('400 invalid_name')
    expect(code(() => o.createFolder('x'.repeat(ORGANIZER_LIMITS.folderName + 1)))).toBe('400 invalid_name')
    o.createFolder('Release')
    expect(code(() => o.createFolder('release'))).toBe('409 folder_name_taken')
    expect(code(() => o.updateSession('claude:a', { title: 'x'.repeat(ORGANIZER_LIMITS.title + 1) }))).toBe('400 invalid_title')
    expect(code(() => o.updateSession('claude:a', {}))).toBe('400 empty_change')
    expect(code(() => o.updateSession('claude:a', { cos_pinned: 'yes' }))).toBe('400 invalid_pin')
    expect(code(() => o.updateSession('claude:a', { folder_id: 'f_0000000000000000' }))).toBe('404 folder_not_found')
  })

  it('caps folders and entries', () => {
    const o = make()
    for (let i = 0; i < ORGANIZER_LIMITS.folders; i++) o.createFolder(`F${i}`)
    expect(code(() => o.createFolder('one more'))).toBe('409 too_many_folders')
  })

  it('a session lives in one folder; a change touches only the keys it names; null clears', () => {
    const o = make()
    const a = o.createFolder('A'), b = o.createFolder('B')
    const key = organizerKey('codex', '019a-THREAD')
    o.updateSession(key, { folder_id: a.id, title: 'My run' })
    expect(o.updateSession(key, { folder_id: b.id })).toEqual({ folder_id: b.id, title_override: 'My run' })
    expect(o.listFolders().map(f => [f.name, f.count])).toEqual([['A', 0], ['B', 1]])
    expect(o.updateSession(key, { title: null })).toEqual({ folder_id: b.id })
    // An entry with nothing left is removed, not kept empty.
    expect(o.updateSession(key, { folder_id: null })).toEqual({})
    expect(Object.keys(onDisk().sessions)).toEqual([])
  })

  it('two devices changing different fields of one session both land (one change per call)', () => {
    const o = make()
    const f = o.createFolder('Release')
    const key = organizerKey('claude', 'abc')
    o.updateSession(key, { folder_id: f.id }) // the phone
    o.updateSession(key, { cos_pinned: true }) // the Mac, a moment later
    expect(o.fieldsFor(key)).toEqual({ folder_id: f.id, cos_pinned: true })
  })

  it('deleting a folder releases its sessions and never deletes a session entry that still has a pin or title', () => {
    const o = make()
    const f = o.createFolder('Release')
    o.updateSession('claude:a', { folder_id: f.id })
    o.updateSession('claude:b', { folder_id: f.id, cos_pinned: true })
    o.updateSession('cursor:c', { folder_id: f.id, title: 'Kept title' })
    expect(o.deleteFolder(f.id)).toBe(3)
    expect(o.listFolders()).toEqual([])
    expect(o.fieldsFor('claude:a')).toEqual({})
    expect(o.fieldsFor('claude:b')).toEqual({ cos_pinned: true })
    expect(o.fieldsFor('cursor:c')).toEqual({ title_override: 'Kept title' })
    expect(code(() => o.deleteFolder(f.id))).toBe('404 folder_not_found')
  })

  it('keeps COS pins and folder members (not titles alone) per provider', () => {
    const o = make()
    const f = o.createFolder('Release')
    o.updateSession('claude:pinned-one', { cos_pinned: true })
    o.updateSession('codex:in-folder', { folder_id: f.id })
    o.updateSession('cursor:renamed-only', { title: 'Just a name' })
    const kept = o.keptIds()
    expect([...kept.claude]).toEqual(['pinned-one'])
    expect([...kept.codex]).toEqual(['in-folder'])
    expect([...kept.cursor]).toEqual([])
    expect(o.titleMatches('just')).toEqual([{ provider: 'cursor', session_id: 'renamed-only' }])
  })

  it('reloads what it wrote', () => {
    const o = make()
    const f = o.createFolder('Release')
    o.updateSession('claude:a', { folder_id: f.id, title: 'T' })
    const again = make()
    expect(again.listFolders()).toEqual([{ id: f.id, name: 'Release', created_at: '2026-11-10T23:30:00.000Z', count: 1 }])
    expect(again.fieldsFor('claude:a')).toEqual({ folder_id: f.id, title_override: 'T' })
    expect(again.rev()).toBe(2)
  })

  it('a file that does not parse, or has the wrong shape, is moved aside and the store starts empty', () => {
    for (const bad of ['{not json', JSON.stringify({ version: 1, rev: 1, folders: {}, sessions: { 'nope:x': { updated_at: 'x' } } })]) {
      writeFileSync(path, bad, { mode: 0o600 })
      const o = make()
      expect(o.isAvailable()).toBe(true)
      expect(o.isEmpty()).toBe(true)
      expect(readdirSync(dir).some(n => n.startsWith('session-organizer.json.corrupt-'))).toBe(true)
      for (const n of readdirSync(dir)) rmSync(join(dir, n))
    }
    expect(logs.every(l => l.includes('reason=corrupt_store'))).toBe(true)
  })

  it('a file that exists but cannot be read makes the store unavailable and is never overwritten', () => {
    const o = make()
    o.createFolder('Release')
    const before = readFileSync(path, 'utf8')
    chmodSync(path, 0o000)
    const blocked = make()
    expect(blocked.isAvailable()).toBe(false)
    expect(code(() => blocked.createFolder('Other'))).toBe('503 organizer_unavailable')
    expect(code(() => blocked.updateSession('claude:a', { cos_pinned: true }))).toBe('503 organizer_unavailable')
    chmodSync(path, 0o600)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('never logs a folder name or a title', () => {
    writeFileSync(path, '{broken', { mode: 0o600 })
    const o = make()
    const f = o.createFolder('Secret Project Falcon')
    o.updateSession('claude:a', { folder_id: f.id, title: 'Board deck for Jeremy' })
    o.renameFolder(f.id, 'Falcon Two')
    o.deleteFolder(f.id)
    expect(logs.join('\n')).not.toMatch(/Falcon|Jeremy|Board deck/)
  })
})

// Q1 FIX 2: an entry follows its Claude session when the Desktop alias appears or changes.
describe('Claude Desktop ids (Q1 FIX 2)', () => {
  it('an entry written under a Desktop id moves to the new key when the CLI id is known, never two entries', () => {
    const o = make()
    o.updateSession('claude:desk-1', { cos_pinned: true }, { desktopId: 'desk-1' })     // Desktop-only at first
    o.updateSession('claude:cli-1', { title: 'Named' }, { desktopId: 'desk-1' })          // alias appeared
    expect(Object.keys(onDisk().sessions)).toEqual(['claude:cli-1'])
    expect(o.fieldsFor('claude:cli-1')).toEqual({ cos_pinned: true, title_override: 'Named' })
    o.updateSession('claude:cli-2', { title: 'Renamed' }, { desktopId: 'desk-1' })        // alias changed
    expect(Object.keys(onDisk().sessions)).toEqual(['claude:cli-2'])
  })

  it('a row matches by key or by the Desktop id; keptIds carries the Desktop id too', () => {
    const o = make()
    o.updateSession('claude:cli-1', { cos_pinned: true }, { desktopId: 'desk-1' })
    expect(o.fieldsForAny(['claude:cli-9'], ['desk-1'])).toEqual({ cos_pinned: true })
    expect(o.fieldsForAny(['claude:cli-9'], ['desk-2'])).toEqual({})
    expect([...o.keptIds().claude].sort()).toEqual(['cli-1', 'desk-1'])
  })
})

// Q1 should-fix 3: names and titles are user text. The server keeps them exactly as typed (after removing control
// characters), never as markup, so every client must render them as untrusted text (web through esc(), the lens through
// its glyph filter, Control as plain Text); the client tests belong to W1, G1 and the Mac lane.
describe('names and titles are plain text', () => {
  it('stores markup as typed, not escaped and not stripped', () => {
    const o = make()
    const f = o.createFolder('<img src=x onerror=alert(1)> & "Q4"')
    expect(f.name).toBe('<img src=x onerror=alert(1)> & "Q4"')
    expect(o.updateSession('claude:a', { title: '<b>bold</b>' })).toEqual({ title_override: '<b>bold</b>' })
  })
})

// Q1 23:09: MEANING search (session-find) sends text to a model. Renamed titles and folder names must never reach it.
// SOURCE-SHAPE, and it says so: no session-find module may import the organizer; the keyword search that does use
// renamed titles (routes/agent-sessions.ts) is local and sends nothing out.
describe('organizer text never reaches the model-backed search', () => {
  it('no session-find module imports the organizer', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const finders = ['lib', 'routes'].flatMap(sub => {
      const dir = join(process.cwd(), 'server', sub)
      return readdirSync(dir).filter(n => n.startsWith('session-find') && n.endsWith('.ts') && !n.endsWith('.test.ts')).map(n => join(dir, n))
    })
    expect(finders.length).toBeGreaterThanOrEqual(4) // lib: session-find, -ask, -collect, -redact; routes: session-find
    for (const file of finders) expect(readFileSync(file, 'utf8')).not.toMatch(/session-organizer/)
  })
})
