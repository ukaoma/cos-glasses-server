import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FoundationStore } from './control2-foundation.js'
const roots: string[] = []
const fixture = { meetingId: 'meeting-1', projectId: 'site-1', revision: 'r1', transcript: 'Please prepare a website preview.', ready: true }
function fresh() { const root = mkdtempSync(join(tmpdir(), 'control2-test-')); roots.push(root); return { root, store: new FoundationStore(root) } }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
describe('foundation durable source receipts', () => {
  it('replays across a fresh store without a second item', () => {
    const { root, store } = fresh(); const first = store.replay(fixture)
    const next = new FoundationStore(root).replay(fixture)
    expect(next.replayed).toBe(true); expect(next.workId).toBe(first.workId); expect(next.work).toHaveLength(1)
    expect(next.capabilities).toEqual({ publication: false, automaticExecution: false, legacyTaskMutation: false })
  })
  it('refuses reuse of a revision with different content', () => {
    const { root, store } = fresh(); store.replay(fixture); const before = readFileSync(join(root, 'journal.json'), 'utf8')
    expect(() => store.replay({ ...fixture, transcript: 'Publish now' })).toThrow('revision_conflict')
    expect(readFileSync(join(root, 'journal.json'), 'utf8')).toBe(before)
  })
  it('supersedes prior source but does not revive it on old delivery', () => {
    const { store } = fresh(); store.replay(fixture)
    const next = store.replay({ ...fixture, revision: 'r2', ready: false })
    expect(next.work.map(w => w.status)).toEqual(['blocked', 'superseded'])
    expect(store.replay(fixture).work.find(w => w.revision === 'r1')?.status).toBe('superseded')
  })
  it('refuses late alias union rather than granting duplicate authority', () => {
    const { store } = fresh(); store.replay(fixture)
    expect(() => store.replay({ ...fixture, meetingId: 'other', sourceAliases: ['meeting-1'] })).toThrow('alias_reconciliation_required')
  })
  it('persists aliases and refuses shared or reverse alias overlap', () => {
    const { root, store } = fresh(); store.replay({ ...fixture, sourceAliases: ['capture-1'] })
    const restarted = new FoundationStore(root)
    expect(() => restarted.replay({ ...fixture, meetingId: 'other', sourceAliases: ['capture-1'] })).toThrow('alias_reconciliation_required')
    expect(() => restarted.replay({ ...fixture, meetingId: 'capture-1' })).toThrow('alias_reconciliation_required')
    expect(restarted.snapshot().work).toHaveLength(1)
  })
  it('rejects serialized byte capacity before poisoning the durable journal', () => {
    const { root, store } = fresh()
    let count = 0
    for (; count < 200; count++) {
      try { store.replay({ ...fixture, meetingId: `big-${count}`, criteria: Array(12).fill('\u0001'.repeat(500)) }) }
      catch (e) { expect(String(e)).toContain('foundation_capacity_reached'); break }
    }
    expect(count).toBeGreaterThan(0); expect(count).toBeLessThan(200)
    expect(new FoundationStore(root).snapshot().work).toHaveLength(count)
    expect(readFileSync(join(root, 'journal.json')).length).toBeLessThanOrEqual(2_000_000)
  })
  it('fails closed on malformed and future journals', () => {
    const { root, store } = fresh(); writeFileSync(join(root, 'journal.json'), '{')
    expect(() => store.snapshot()).toThrow('journal_recovery_required')
    writeFileSync(join(root, 'journal.json'), JSON.stringify({ schemaVersion: 2, sequence: 0, work: [], receipts: [] }))
    expect(() => store.replay(fixture)).toThrow('journal_recovery_required')
  })
  it('refuses concurrent or unclean writer locks and symlinked journals', () => {
    const { root, store } = fresh(); writeFileSync(join(root, 'journal.lock'), '')
    expect(() => store.replay(fixture)).toThrow('journal_busy_or_recovery_required')
    rmSync(join(root, 'journal.lock')); const target = join(root, 'sentinel'); writeFileSync(target, 'protected')
    symlinkSync(target, join(root, 'journal.json')); expect(() => store.replay(fixture)).toThrow('unsafe_journal')
    expect(readFileSync(target, 'utf8')).toBe('protected')
  })
  it('rejects oversized input and ignores attempted authority injection', () => {
    const { store } = fresh(); expect(() => store.replay({ ...fixture, transcript: 'x'.repeat(32001) })).toThrow('invalid_transcript')
    const result = store.replay({ ...fixture, publication: true, dispatch: { tools: ['Bash'] } })
    expect(result.capabilities.publication).toBe(false); expect(result.capabilities.automaticExecution).toBe(false)
  })
})

it('restores durable draft bytes and fails closed if missing or changed', () => {
  const { root, store } = fresh(); const first = store.replay(fixture)
  const html = '<!doctype html><p>review me</p>'
  const sha = createHash('sha256').update(html).digest('hex')
  store.recordDraft(first.workId, fixture.revision, html, sha)
  const restored = new FoundationStore(root).snapshot().work[0].artifact!
  expect(readFileSync(restored.path, 'utf8')).toBe(html)
  writeFileSync(restored.path, 'changed')
  expect(() => new FoundationStore(root).snapshot()).toThrow('journal_recovery_required')
  rmSync(restored.path)
  expect(() => new FoundationStore(root).snapshot()).toThrow('journal_recovery_required')
})
