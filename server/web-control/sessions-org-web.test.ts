/**
 * 7.0.23, step 2b-2 of the chat-style Sessions: folders, COS pins and rename on S1's organizer (contract at 469a334).
 * These run app.js's own text against fakes: the folder read and an older server's 404, the row and folder menus,
 * the exact request each action sends, the inline forms, the refusal words, the reread after a change (waiting for a
 * list read already in flight), and names and titles drawn as text only. The flows run in WebKit too
 * (W1_evidence/two_column/org_check.cjs).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
function slice(text: string, start: string, end: string): string {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length)
  expect(a, start).toBeGreaterThan(-1)
  expect(b, end).toBeGreaterThan(a)
  return text.slice(a, b)
}
const SRC = slice(APP, '  // ── folders, COS pins and rename (7.0.23, step 2b-2', '  // The list, under the hero.')
const esc = (t: unknown) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

type Row = Record<string, unknown>
function kit(o: { rows?: Row[]; api?: (p: string, opts?: any) => Promise<unknown>; inflight?: Promise<unknown> | null } = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = []
  const order: string[] = []
  let renders = 0, heads = 0
  const SL: any = { inflight: o.inflight ?? null }
  const SXL: any = { place: { x: 'today' }, open: {} }
  let active: any = null
  const els: Record<string, any> = {}
  const deps: any = {
    SXL, SL, SX_OLDER_MS: 60000, SX: { view: 'sessions' }, state: { pane: 'sessions' }, Date, esc, Promise,
    api: (path: string, opts: any = {}) => { calls.push({ path, method: opts.method || 'GET', body: opts.body }); order.push('api ' + (opts.method || 'GET') + ' ' + path); return o.api ? o.api(path, opts) : Promise.resolve({}) },
    sxQueryActive: () => false,
    renderSessionGroups: () => { renders++; order.push('render') },
    // A redraw while the new list lands uses up a placement reset made before it (what happened on the page).
    loadSessions: () => { order.push('loadSessions'); SXL.place = { x: 'held by a redraw in between' }; return Promise.resolve() },
    sxPaintListHead: () => { heads++ },
    splitSessionId: (p: string, id: string) => ({ provider: p || 'claude', id: String(id || '') }),
    sxAllRows: () => o.rows ?? [],
    sxRowKey: (s: Row) => String(s.provider || 'claude') + '|' + String(s.session_id).toLowerCase(),
    sxProviderLabel: (p: string) => (p === 'codex' ? 'Codex' : 'Claude'),
    $: (id: string) => els[id] || null,
    window: { innerWidth: 1119, innerHeight: 787 },
    document: { get activeElement() { return active }, body: { appendChild: (e: any) => { els[e.id] = e } }, createElement: () => ({ classList: { add() {}, remove() {} }, setAttribute() {}, style: {}, querySelector: () => null, offsetWidth: 220, offsetHeight: 160 }) },
  }
  // eslint-disable-next-line no-new-func
  const k = new Function('deps', `with (deps) {\n${SRC}\nreturn { SXF, load: sxLoadFolders, done: sxOrgDone, words: sxOrgWords, rowMenu: sxRowMenuHtml, folderMenu: sxFolderMenuHtml, click: sxOrgClick, submit: sxOrgSubmit, editing: sxEditing, inline: sxInlineHtml };\n}`)(deps)
  return { k, calls, order, SXL, SL, renders: () => renders, heads: () => heads, setActive: (a: any) => { active = a } }
}
const btn = (attrs: Record<string, string>) => ({ getAttribute: (n: string) => attrs[n] ?? null, setAttribute() {}, getBoundingClientRect: () => ({ top: 100, bottom: 140, right: 400 }) })
const flush = () => new Promise(r => setTimeout(r, 0))

describe('the folder read', () => {
  it('reads the folders once a minute at most and keeps them by id', async () => {
    const h = kit({ api: () => Promise.resolve({ rev: 3, folders: [{ id: 'f_1', name: 'Release', count: 2 }] }) })
    await h.k.load()
    expect(h.k.SXF.ok).toBe(true)
    expect(h.k.SXF.byId.f_1.name).toBe('Release')
    await h.k.load()
    expect(h.calls).toHaveLength(1)
    await h.k.load(true)
    expect(h.calls, 'forced after a change').toHaveLength(2)
  })
  it('an older server (404): no organizer, and it is not asked again', async () => {
    const h = kit({ api: () => Promise.reject(Object.assign(new Error('x'), { status: 404 })) })
    await h.k.load()
    expect(h.k.SXF.ok).toBe(false)
    await h.k.load(true)
    expect(h.calls).toHaveLength(1)
  })
})

describe('the menus', () => {
  it('a row: Pin, Move to folder, Rename', () => {
    const html = kit().k.rowMenu({ provider: 'claude', session_id: 'a' }, 'claude|a', false)
    expect([...html.matchAll(/data-sx="([a-z-]+)"[^>]*>([^<]+)</g)].map(m => m[2])).toEqual(['Pin', 'Move to folder', 'Rename'])
  })
  it('a COS pin offers Unpin; an agent’s own pin is said, with no Pin or Unpin', () => {
    const h = kit()
    expect(h.k.rowMenu({ provider: 'claude', session_id: 'a', cos_pinned: true }, 'claude|a', false)).toContain('>Unpin<')
    const nat = h.k.rowMenu({ provider: 'codex', session_id: 'a', pinned: true }, 'codex|a', false)
    expect(nat).toContain('<p class="sx-pop-note">Pinned in Codex</p>')
    expect(nat).not.toContain('data-sx="org-pin"')
  })
  it('Move to folder: each folder (names as text), the current one checked, and No folder', () => {
    const h = kit()
    h.k.SXF.folders = [{ id: 'f_1', name: '<b>Release</b>' }, { id: 'f_2', name: 'Ops' }]
    const html = h.k.rowMenu({ provider: 'claude', session_id: 'a', folder_id: 'f_2' }, 'claude|a', true)
    expect(html).toContain('aria-checked="false" data-sx="org-move" data-key="claude|a" data-folder="f_1">&lt;b&gt;Release&lt;/b&gt;</button>')
    expect(html).toContain('aria-checked="true" data-sx="org-move" data-key="claude|a" data-folder="f_2">Ops</button>')
    expect(html).toContain('data-folder="">No folder</button>')
    expect(html).not.toContain('<b>')
  })
  it('no folders yet: says how to make one', () => {
    expect(kit().k.rowMenu({ provider: 'claude', session_id: 'a' }, 'claude|a', true)).toContain('No folders yet. Make one with New folder at the top of the list.')
  })
  it('a folder: Rename and Delete folder; a first tap on Delete arms it and says what happens', () => {
    const h = kit()
    expect(h.k.folderMenu('f_1')).toContain('>Delete folder<')
    h.k.SXF.armDelete = 'f_1'
    expect(h.k.folderMenu('f_1')).toContain('>Tap again to delete the folder. Its sessions go back to their day group.<')
  })
})

describe('each action sends one small request', () => {
  const rows = [{ provider: 'claude', session_id: 'AbC/1' }]
  it('Pin and Unpin: cos_pinned on the session’s own path, its id encoded', async () => {
    const h = kit({ rows })
    h.k.click('org-pin', btn({ 'data-key': 'claude|abc/1' }))
    await flush()
    expect(h.calls[0]).toEqual({ path: '/api/agent-sessions/claude/AbC%2F1/organizer', method: 'PATCH', body: { cos_pinned: true } })
    const u = kit({ rows: [{ ...rows[0], cos_pinned: true }] })
    u.k.click('org-pin', btn({ 'data-key': 'claude|abc/1' }))
    await flush()
    expect(u.calls[0]!.body).toEqual({ cos_pinned: false })
  })
  it('Move to folder and No folder', async () => {
    const h = kit({ rows })
    h.k.click('org-move', btn({ 'data-key': 'claude|abc/1', 'data-folder': 'f_9' }))
    h.k.click('org-move', btn({ 'data-key': 'claude|abc/1', 'data-folder': '' }))
    await flush()
    expect(h.calls.filter(c => c.method !== 'GET').map(c => c.body), 'the writes (a folder reread follows each)').toEqual([{ folder_id: 'f_9' }, { folder_id: null }])
  })
  it('Use the agent’s title clears the rename', async () => {
    const h = kit({ rows })
    h.k.click('rename-clear', btn({ 'data-id': 'claude|abc/1' }))
    await flush()
    expect(h.calls[0]!.body).toEqual({ title: null })
  })
  it('Delete folder takes two taps, then one DELETE; nothing on the first', async () => {
    const h = kit()
    const b = btn({ 'data-id': 'f_1' })
    h.k.click('folder-delete', b)
    expect(h.calls).toEqual([])
    expect(h.k.SXF.armDelete).toBe('f_1')
    h.k.click('folder-delete', b)
    await flush()
    expect(h.calls[0]).toEqual({ path: '/api/session-folders/f_1', method: 'DELETE', body: undefined })
  })
  it('Cancel closes every form', () => {
    const h = kit()
    Object.assign(h.k.SXF, { newOpen: true, renaming: 'x', folderRenaming: 'y' })
    h.k.click('inline-cancel', btn({}))
    expect([h.k.SXF.newOpen, h.k.SXF.renaming, h.k.SXF.folderRenaming]).toEqual([false, '', ''])
  })
})

describe('the inline forms', () => {
  const form = (kind: string, id: string, value: string) => ({ getAttribute: (n: string) => (n === 'data-sx-form' ? kind : n === 'data-id' ? id : null), querySelector: () => ({ value, blur() {} }) })
  it('New folder: an empty name is refused here; a name is one POST', async () => {
    const h = kit()
    h.k.submit(form('new-folder', '', '   '))
    expect(h.calls).toEqual([])
    expect(h.k.SXF.note).toBe('A folder name is 1 to 60 characters.')
    h.k.submit(form('new-folder', '', ' Release '))
    await flush()
    expect(h.calls[0]).toEqual({ path: '/api/session-folders', method: 'POST', body: { name: 'Release' } })
  })
  it('Rename folder is a PATCH of its name; Rename a session sends the title, or null when emptied', async () => {
    const h = kit({ rows: [{ provider: 'claude', session_id: 'a' }] })
    h.k.submit(form('folder-rename', 'f_1', 'Ops'))
    h.k.submit(form('rename', 'claude|a', 'New title'))
    h.k.submit(form('rename', 'claude|a', ''))
    await flush()
    expect(h.calls.filter(c => c.method !== 'GET').map(c => [c.method, c.path, c.body])).toEqual([
      ['PATCH', '/api/session-folders/f_1', { name: 'Ops' }],
      ['PATCH', '/api/agent-sessions/claude/a/organizer', { title: 'New title' }],
      ['PATCH', '/api/agent-sessions/claude/a/organizer', { title: null }]])
  })
  it('a form’s value is drawn as text in its field', () => {
    const html = kit().k.inline('rename', 'claude|a', 'Rename this session', '"><img src=x>', '')
    expect(html).toContain('value="&quot;&gt;&lt;img src=x&gt;"')
    expect(html).toContain('maxlength="120"')
    expect(kit().k.inline('new-folder', '', 'New folder', '', '')).toContain('maxlength="60"')
  })
  it('a field in the list is never drawn over: renderSessionGroups waits while one has focus', () => {
    const h = kit()
    h.setActive({ closest: (s: string) => (s === '#sessions-list form.sx-inline' ? {} : null) })
    expect(h.k.editing()).toBe(true)
    expect(APP).toContain('if (!sxQueryActive() && typeof sxEditing === \'function\' && sxEditing()) { sxRegroupLater(); return; }')
  })
  it('a row being renamed carries data-edit, not data-session, so Save or Enter never opens the session', () => {
    expect(APP).toContain(`return '<div class="sx-r editing" data-edit="' + id + '">'`)
  })
})

describe('after a change, and when it is refused', () => {
  it('waits for a list read already in flight, then reads the list again, then places every row fresh and draws', async () => {
    let release!: () => void
    const inflight = new Promise<void>(r => { release = r })
    const h = kit({ inflight, api: () => Promise.resolve({ folders: [] }) })
    const done = h.k.done()
    await flush()
    expect(h.order.includes('loadSessions'), 'not before the read in flight ends').toBe(false)
    release()
    await done
    const i = h.order.indexOf('loadSessions')
    expect(i).toBeGreaterThan(-1)
    expect(h.order.slice(i)).toEqual(['loadSessions', 'render'])
    expect(h.SXL.place, 'every row placed fresh, at once').toBe(null)
  })
  it('each refusal in plain words; anything else says to check the Mac', () => {
    const k = kit().k
    expect(k.words({ code: 'folder_name_taken' })).toBe('A folder already has that name.')
    expect(k.words({ code: 'alias_conflict' })).toBe('Claude is still settling which session this is. Try again in a moment.')
    expect(k.words({ code: 'organizer_unavailable' })).toBe('Folders, pins and titles are not available on the Mac right now.')
    expect(k.words({ code: 'weird' })).toBe('That did not save. Check that the Mac is awake, then try again.')
  })
  it('a refused change shows its words in the list head', async () => {
    const h = kit({ rows: [{ provider: 'claude', session_id: 'a' }], api: () => Promise.reject(Object.assign(new Error('x'), { code: 'too_many_entries' })) })
    h.k.click('org-pin', btn({ 'data-key': 'claude|a' }))
    await flush(); await flush()
    expect(h.k.SXF.note).toBe('This Mac keeps folders, pins and titles for 5,000 sessions at most.')
    expect(h.heads()).toBe(1)
  })
})
