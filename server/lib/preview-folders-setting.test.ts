/** Preview engine phase 1: the Settings extra-folders list. Atomic, 0600, fails closed, broad roots refused. */
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkFolder, createPreviewFoldersSetting, folderDisplay, PREVIEW_FOLDERS_MAX } from './preview-folders-setting.js'

const made: string[] = []
afterEach(() => { for (const p of made.splice(0)) { try { chmodSync(p, 0o700) } catch { /* gone */ } rmSync(p, { recursive: true, force: true }) } })
function setup() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'cos folders-'))); made.push(top)
  const home = join(top, 'home')
  for (const d of ['cos-worktrees', 'cos-release-candidates', 'Documents/GitHub', 'Library/Caches', '.cos-glasses/data', '.ssh', '.codex/sessions', '.claude/projects', '.config/gh', 'file-dir']) mkdirSync(join(home, d), { recursive: true })
  writeFileSync(join(home, 'file-dir', 'a.txt'), 'x')
  const file = join(top, 'data', 'web-preview-folders.json')
  return { top, home, file, store: createPreviewFoldersSetting({ file: () => file, home: () => home }) }
}

describe('checkFolder', () => {
  it('accepts project folders, absolute or ~/, stored canonical', () => {
    const s = setup()
    expect(checkFolder('~/cos-worktrees', s.home)).toEqual({ ok: true, path: join(s.home, 'cos-worktrees') })
    expect(checkFolder(join(s.home, 'Documents', 'GitHub'), s.home)).toEqual({ ok: true, path: join(s.home, 'Documents', 'GitHub') })
    symlinkSync(join(s.home, 'cos-worktrees'), join(s.home, 'wt-link'))
    expect(checkFolder('~/wt-link', s.home)).toEqual({ ok: true, path: join(s.home, 'cos-worktrees') })
  })
  it('refuses relative, missing, a file, broad roots, a folder holding a broad root, and private folders', () => {
    const s = setup()
    const code = (v: unknown) => { const r = checkFolder(v, s.home); return r.ok ? 'ok' : r.code }
    expect(code('cos-worktrees')).toBe('not_absolute')
    expect(code('')).toBe('not_absolute')
    expect(code(42)).toBe('not_absolute')
    expect(code('~/nope')).toBe('missing')
    expect(code('~/file-dir/a.txt')).toBe('not_folder')
    for (const broad of ['/', '~', '~/Documents', '~/Library', '~/.cos-glasses', '/Volumes', '/Users', '/tmp', '/private']) expect(code(broad), broad).toBe('broad')
    expect(code(s.top), 'a folder that contains home').toBe('broad')
    expect(code('~/Library/Caches')).toBe('private')
    expect(code('~/.cos-glasses/data')).toBe('private')
    expect(code('~/.ssh')).toBe('private')
    // QA 7.0.5 (agent 2 C-W1): the AI apps' folders, and anything inside them, hold sign-in tokens.
    for (const p of ['~/.codex', '~/.codex/sessions', '~/.claude', '~/.claude/projects', '~/.config', '~/.config/gh']) expect(code(p), p).toBe('private')
    symlinkSync(join(s.home, '.claude', 'projects'), join(s.home, 'claude-link'))
    expect(code('~/claude-link'), 'a link into ~/.claude is judged where it points').toBe('private')
    symlinkSync(join(s.home, 'Library'), join(s.home, 'lib-link'))
    expect(code('~/lib-link'), 'a link to a broad root is that root').toBe('broad')
    expect(code('~/x'.repeat(600))).toBe('too_long')
  })
  it('shows ~/ inside home', () => {
    expect(folderDisplay('/h/cos-worktrees', '/h')).toBe('~/cos-worktrees')
    expect(folderDisplay('/Volumes/W/x', '/h')).toBe('/Volumes/W/x')
  })
})

describe('the stored list', () => {
  it('starts empty; saves atomically with mode 0600; dedupes', () => {
    const s = setup()
    expect(s.store.read()).toEqual({ folders: [], source: 'default' })
    const r = s.store.set(['~/cos-worktrees', join(s.home, 'cos-worktrees'), '~/cos-release-candidates'])
    expect(r).toEqual({ ok: true, setting: { folders: [join(s.home, 'cos-worktrees'), join(s.home, 'cos-release-candidates')], source: 'settings' } })
    expect(statSync(s.file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toEqual({ schema: 1, folders: [join(s.home, 'cos-worktrees'), join(s.home, 'cos-release-candidates')] })
    expect(s.store.set([])).toEqual({ ok: true, setting: { folders: [], source: 'settings' } })
  })
  it('one bad folder refuses the whole save and names it; nothing is written', () => {
    const s = setup()
    s.store.set(['~/cos-worktrees'])
    const r = s.store.set(['~/cos-release-candidates', '~/Documents'])
    expect(r).toEqual({ ok: false, errors: [{ index: 1, code: 'broad', message: expect.stringContaining('too broad') }] })
    expect(s.store.read().folders).toEqual([join(s.home, 'cos-worktrees')])
    expect(s.store.set('~/x')).toMatchObject({ ok: false })
    expect(s.store.set(Array.from({ length: PREVIEW_FOLDERS_MAX + 1 }, () => '~/cos-worktrees'))).toMatchObject({ ok: false, errors: [{ code: 'too_many' }] })
  })
  it('a damaged, foreign or unreadable file fails CLOSED: no extra folders', () => {
    const s = setup()
    mkdirSync(join(s.top, 'data'), { recursive: true })
    for (const text of ['{', '{"schema":2,"folders":[]}', '{"schema":1,"folders":"~/x"}', '{"schema":1,"folders":[1]}', 'null']) {
      writeFileSync(s.file, text)
      expect(s.store.read(), text).toEqual({ folders: [], source: 'damaged' })
    }
    writeFileSync(s.file, '{"schema":1,"folders":[]}'); chmodSync(s.file, 0o000)
    expect(s.store.read().source).toBe('damaged')
    chmodSync(s.file, 0o600)
  })
  it('a stored folder that is gone, or became a link to a broad root, stops counting at once', () => {
    const s = setup()
    mkdirSync(join(s.home, 'tmpw'))
    s.store.set(['~/tmpw', '~/cos-worktrees'])
    rmSync(join(s.home, 'tmpw'), { recursive: true })
    expect(s.store.read().folders).toEqual([join(s.home, 'cos-worktrees')])
    rmSync(join(s.home, 'cos-worktrees'), { recursive: true }); symlinkSync(join(s.home, 'Library'), join(s.home, 'cos-worktrees'))
    expect(s.store.read().folders).toEqual([])
  })
})
