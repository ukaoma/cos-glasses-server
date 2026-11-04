import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DropStore, DropStoreError, InboxFeedStore, parseDropRecord, type DropRecord, type FeedItem } from './drop-store.js'

const roots: string[] = []
const open: Array<{ close(): void }> = []
function root(): string { const r = mkdtempSync(join(tmpdir(), 'drop-store-')); roots.push(r); return r }
afterEach(() => { open.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })) })

const ID = '3f0c9a52-1b2d-4c8e-9f10-2a3b4c5d6e7f'
const at = '2026-11-04T15:00:00.000Z'
const drop = (over: Partial<DropRecord> = {}): DropRecord => ({ id: ID, text: 'Draft the onboarding email', source: 'mac', createdAt: at, updatedAt: at,
  state: 'routing', dest: null, kind: 'note', links: [], route: null, undoUntil: null, timeline: [{ at, state: 'routing' }], ...over })
const item = (over: Partial<FeedItem> = {}): FeedItem => ({ id: `fi_${'a'.repeat(32)}`, kind: 'receipt', threadId: ID, createdAt: at, readAt: null,
  source: 'cos', line: 'Kept as a note', links: [], actions: [], state: 'live', key: `${ID}:receipt:1`, ...over })
const now = () => new Date(at)

describe('DropStore', () => {
  it('inserts once per drop id and returns the first record on a repeat', () => {
    const r = root(); const store = new DropStore(join(r, 'drops'), now); open.push(store)
    expect(store.insert(drop()).inserted).toBe(true)
    const again = store.insert(drop({ text: 'different words' }))
    expect(again.inserted).toBe(false)
    expect(again.drop.text).toBe('Draft the onboarding email')
    expect(store.list()).toHaveLength(1)
  })

  it('writes a 0700 folder and a 0600 file, and refuses a second writer', () => {
    const r = root(); const store = new DropStore(join(r, 'drops'), now); open.push(store)
    store.insert(drop())
    expect(statSync(join(r, 'drops')).mode & 0o777).toBe(0o700)
    expect(statSync(join(r, 'drops', 'drops.json')).mode & 0o777).toBe(0o600)
    expect(() => new DropStore(join(r, 'drops'), now)).toThrowError(expect.objectContaining({ code: 'drop_store_locked' }))
  })

  it('refuses a folder other users can read', () => {
    const r = root(); const dir = join(r, 'drops')
    new DropStore(dir, now).close()
    chmodSync(dir, 0o755)
    expect(() => new DropStore(dir, now)).toThrowError(expect.objectContaining({ code: 'drop_store_unsafe' }))
  })

  it('sets one bad row aside and keeps the rest', () => {
    const r = root(); const dir = join(r, 'drops')
    const s1 = new DropStore(dir, now); s1.insert(drop()); s1.close()
    const file = join(dir, 'drops.json')
    const journal = JSON.parse(readFileSync(file, 'utf8'))
    journal.drops.push({ id: 'not-a-uuid', text: 'x' })
    writeFileSync(file, JSON.stringify(journal), { mode: 0o600 })
    const s2 = new DropStore(dir, now); open.push(s2)
    expect(s2.list().map(d => d.id)).toEqual([ID])
    expect(s2.quarantineCount()).toBe(1)
  })

  it('answers recovery_required for an unreadable journal instead of starting empty', () => {
    const r = root(); const dir = join(r, 'drops')
    new DropStore(dir, now).close()
    writeFileSync(join(dir, 'drops.json'), '{not json', { mode: 0o600 })
    expect(() => new DropStore(dir, now)).toThrowError(expect.objectContaining({ code: 'drop_store_recovery_required' }))
  })

  it('validates an update before writing it', () => {
    const r = root(); const store = new DropStore(join(r, 'drops'), now); open.push(store)
    store.insert(drop())
    expect(() => store.update(ID, d => ({ ...d, state: 'nonsense' as never }))).toThrow(DropStoreError)
    expect(store.get(ID)!.state).toBe('routing')
  })

  it('drops undone records after 30 days and others after a year', () => {
    const r = root(); let clock = new Date(at)
    const store = new DropStore(join(r, 'drops'), () => clock); open.push(store)
    store.insert(drop({ state: 'undone' }))
    store.insert(drop({ id: '3f0c9a52-1b2d-4c8e-9f10-2a3b4c5d6e70', state: 'filed', dest: 'note' }))
    clock = new Date(Date.parse(at) + 31 * 86_400_000)
    store.insert(drop({ id: '3f0c9a52-1b2d-4c8e-9f10-2a3b4c5d6e71', createdAt: clock.toISOString(), updatedAt: clock.toISOString() }))
    expect(store.list().map(d => d.id).sort()).toEqual(['3f0c9a52-1b2d-4c8e-9f10-2a3b4c5d6e70', '3f0c9a52-1b2d-4c8e-9f10-2a3b4c5d6e71'])
  })

  it('rejects text over 2,000 characters', () => {
    expect(() => parseDropRecord(drop({ text: 'x'.repeat(2001) }))).toThrow(DropStoreError)
  })
})

describe('InboxFeedStore', () => {
  it('inserts each key exactly once, even inside one batch', () => {
    const r = root(); const feed = new InboxFeedStore(join(r, 'inbox'), now); open.push(feed)
    const first = feed.insert([item(), item({ id: `fi_${'b'.repeat(32)}`, line: 'second copy' })])
    expect(first).toHaveLength(2)
    expect(first[1].id).toBe(first[0].id)
    feed.insert([item({ id: `fi_${'c'.repeat(32)}` })])
    expect(feed.list()).toHaveLength(1)
    expect(feed.version()).toBe(1)
  })

  it('keeps the exactly-once key across a restart', () => {
    const r = root(); const dir = join(r, 'inbox')
    const f1 = new InboxFeedStore(dir, now); f1.insert([item()]); f1.close()
    const f2 = new InboxFeedStore(dir, now); open.push(f2)
    f2.insert([item({ id: `fi_${'d'.repeat(32)}` })])
    expect(f2.list()).toHaveLength(1)
    expect(f2.version()).toBe(1)
  })

  it('bumps the version on every change and never lets an update rewrite a key', () => {
    const r = root(); const feed = new InboxFeedStore(join(r, 'inbox'), now); open.push(feed)
    const [a] = feed.insert([item()])
    feed.update(new Set([a.id]), i => ({ ...i, readAt: at }))
    expect(feed.version()).toBe(2)
    expect(() => feed.update(new Set([a.id]), i => ({ ...i, key: 'other' }))).toThrow(DropStoreError)
  })

  it('drops receipts after 30 days but keeps drop lines for a year', () => {
    const r = root(); let clock = new Date(at)
    const feed = new InboxFeedStore(join(r, 'inbox'), () => clock); open.push(feed)
    feed.insert([item(), item({ id: `fi_${'e'.repeat(32)}`, kind: 'drop', key: `${ID}:drop`, source: 'mac' })])
    clock = new Date(Date.parse(at) + 31 * 86_400_000)
    feed.insert([item({ id: `fi_${'f'.repeat(32)}`, key: 'later', createdAt: clock.toISOString() })])
    expect(feed.list().map(i => i.key).sort()).toEqual([`${ID}:drop`, 'later'])
  })
})
