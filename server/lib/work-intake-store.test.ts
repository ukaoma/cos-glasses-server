import { afterEach, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkIntakeStore, createOptionalWorkIntakeStore, parseIntakeItem, INTAKE_LIMITS } from './work-intake-store.js'

const roots: string[] = [], stores: WorkIntakeStore[] = []
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function root(): string { const r = mkdtempSync(join(tmpdir(), 'work-intake-')); roots.push(r); return r }
function open(dir = root(), now = () => new Date('2026-09-28T15:00:00Z')): WorkIntakeStore { const s = new WorkIntakeStore(dir, now); stores.push(s); return s }

const meeting = { domain: 'quilt', month: '2026-09', filename: '2026-09-24_Bottle_QA.md', recordId: 'ops:quilt:2026-09:2026-09-24_Bottle_QA.md', title: 'Bottle QA' }
const id = (n: number) => 'wi_' + n.toString(16).padStart(32, '0')
const ask = (n = 1, extra: Record<string, unknown> = {}) => ({ id: id(n), kind: 'ask', status: 'ask', meeting, confidence: 0.9, model: 'jev-1.13.0',
  text: 'Fix the H1 (Ryan Hopkins)', owner: 'Ryan Hopkins', ownerIsMiles: false, pull: null, ...extra })
const link = (n = 2, extra: Record<string, unknown> = {}) => ({ id: id(n), kind: 'link', status: 'suggested', meeting, confidence: 0.7, model: 'jev-1.13.0',
  task: { domain: 'quilt', id: 'a'.repeat(12), workIdentity: 'b'.repeat(12), text: 'Monitor launch' }, relation: 'advanced', ...extra })

it('upserts, lists only open items and keeps the first producedAt', () => {
  const s = open()
  expect(s.upsert([ask(), link(), ask(3, { status: 'review' })])).toEqual({ inserted: 3, updated: 0, sticky: 0, rejected: [] })
  const first = s.get(id(1))!.producedAt
  expect(s.upsert([ask(1, { confidence: 0.95, producedAt: '2030-01-01T00:00:00Z' })])).toEqual({ inserted: 0, updated: 1, sticky: 0, rejected: [] })
  expect(s.get(id(1))).toMatchObject({ confidence: 0.95, producedAt: first })
  expect(s.open().map(i => i.status).sort()).toEqual(['ask', 'review', 'suggested'])
})

it.each([
  ['bad id', ask(1, { id: 'wi_x' }), 'invalid_intake_item'],
  ['link status on an ask', ask(1, { status: 'suggested' }), 'invalid_intake_status'],
  ['ask status on a link', link(2, { status: 'ask' }), 'invalid_intake_status'],
  ['unsafe meeting file', ask(1, { meeting: { ...meeting, filename: '../x.md' } }), 'invalid_intake_meeting'],
  ['unsafe domain', ask(1, { meeting: { ...meeting, domain: '../quilt' } }), 'invalid_intake_meeting'],
  ['task id', link(2, { task: { domain: 'quilt', id: 'nope', workIdentity: 'b'.repeat(12), text: 'x' } }), 'invalid_intake_task'],
  ['empty text', ask(1, { text: '  ' }), 'invalid_intake_text'],
  ['oversized text', ask(1, { text: 'x'.repeat(INTAKE_LIMITS.text + 1) }), 'invalid_intake_text'],
  ['control characters', ask(1, { text: 'a\u0007b' }), 'invalid_intake_text'],
  ['confidence', ask(1, { confidence: 1.2 }), 'invalid_intake_item'],
  ['accepted without resolution', ask(1, { status: 'accepted' }), 'invalid_intake_resolution'],
])('rejects %s', (_name, raw, code) => {
  expect(() => parseIntakeItem(raw)).toThrow(code)
})

it('drops unknown fields instead of storing them', () => {
  expect(parseIntakeItem({ ...ask(), injected: 'x' })).not.toHaveProperty('injected')
})

it('keeps a valid pull, and drops a malformed one without refusing the ask', () => {
  const pull = { kind: 'session', id: 'claude:abc', title: 'Bottle POS homepage', p: 0.8 }
  expect(parseIntakeItem(ask(1, { pull })).pull).toEqual(pull)
  for (const bad of [{ ...pull, kind: 'thread' }, { ...pull, title: 'a\rb' }, { ...pull, p: 1.2 }, { ...pull, id: '' }, 'x']) {
    expect(parseIntakeItem(ask(1, { pull: bad })).pull).toBeNull()
  }
})

it('refuses an item that claims a user decision, and a batch over the limit, without writing anything', () => {
  const dir = root(), s = open(dir)
  expect(s.upsert([ask(1, { status: 'dismissed', resolution: { action: 'dismiss', by: 'user', at: '2026-09-28T00:00:00Z' } })]))
    .toEqual({ inserted: 0, updated: 0, sticky: 0, rejected: [{ id: id(1), code: 'producer_cannot_record_user_decisions' }] })
  expect(() => s.upsert(Array.from({ length: INTAKE_LIMITS.batch + 1 }, (_, i) => ask(i + 10)))).toThrow('invalid_intake_batch')
  expect(() => s.upsert({ items: [] } as unknown as unknown[])).toThrow('invalid_intake_batch')
  expect(s.list()).toEqual([])
  expect(existsSync(join(dir, 'intake.json'))).toBe(false)
})

it('answers bad items per item so one record never blocks the rest of a producer batch', () => {
  const s = open()
  const result = s.upsert([ask(1), ask(2, { text: '  ' }), 'junk', link(3, { task: null }), { ...ask(4), id: 'wi_short' }, ask(5)])
  expect(result).toEqual({ inserted: 2, updated: 0, sticky: 0, rejected: [
    { id: id(2), code: 'invalid_intake_text' }, { id: null, code: 'invalid_intake_item' },
    { id: id(3), code: 'invalid_intake_task' }, { id: null, code: 'invalid_intake_item' },
  ] })
  expect(s.list().map(i => i.id).sort()).toEqual([id(1), id(5)])
})

it('keeps a known review reason on an ask and drops an unknown one or one on a link', () => {
  const s = open()
  s.upsert([ask(1, { status: 'review', reason: 'outside_window' }), ask(2, { status: 'review', reason: 'because' }), link(3, { reason: 'unclear_task' })])
  expect(s.get(id(1))!.reason).toBe('outside_window')
  expect(s.get(id(2))).not.toHaveProperty('reason')
  expect(s.get(id(3))).not.toHaveProperty('reason')
  expect(parseIntakeItem(ask(4, { reason: 'unclear_task' })).reason).toBe('unclear_task')
  expect(parseIntakeItem(ask(5, { reason: 'owner_uncertain' })).reason).toBe('owner_uncertain')
})

it('keeps a user decision and a producer card sticky against later producer upserts', async () => {
  const s = open()
  s.upsert([ask(1), ask(4, { status: 'accepted', resolution: { action: 'accept', by: 'producer', at: '2026-09-28T00:00:00Z', taskId: 'c'.repeat(12) } })])
  await s.resolve(id(1), async () => ({ action: 'dismiss' }))
  expect(s.upsert([ask(1), ask(4)])).toEqual({ inserted: 0, updated: 0, sticky: 2, rejected: [] })
  expect(s.get(id(1))!.status).toBe('dismissed')
  expect(s.get(id(4))).toMatchObject({ status: 'accepted', resolution: { by: 'producer', taskId: 'c'.repeat(12) } })
})

it('serializes resolution per item and makes a repeat decision idempotent', async () => {
  const s = open(); s.upsert([ask()])
  let release!: () => void
  const first = s.resolve(id(1), () => new Promise(r => { release = () => r({ action: 'accept', taskId: 'd'.repeat(12) }) }))
  await expect(s.resolve(id(1), async () => ({ action: 'dismiss' }))).rejects.toThrow('intake_busy')
  release()
  expect(await first).toMatchObject({ status: 'accepted', resolution: { action: 'accept', by: 'user', taskId: 'd'.repeat(12) } })
  let called = false
  expect(await s.resolve(id(1), async () => { called = true; return { action: 'dismiss' } })).toMatchObject({ status: 'accepted' })
  expect(called).toBe(false)
  await expect(s.resolve(id(9), async () => ({ action: 'dismiss' }))).rejects.toThrow('intake_not_found')
})

it('a failed accept leaves the item open', async () => {
  const s = open(); s.upsert([ask()])
  await expect(s.resolve(id(1), async () => { throw new Error('bridge down') })).rejects.toThrow('bridge down')
  expect(s.get(id(1))!.status).toBe('ask')
})

it('persists across restart, quarantines one bad record, and prunes old decisions', async () => {
  const dir = root()
  const s = open(dir); s.upsert([ask(1), ask(2), link(3)])
  await s.resolve(id(2), async () => ({ action: 'dismiss' }))
  s.close(); stores.splice(stores.indexOf(s), 1)
  const file = join(dir, 'intake.json'), journal = JSON.parse(readFileSync(file, 'utf8'))
  journal.items.push({ id: 'broken' })
  writeFileSync(file, JSON.stringify(journal)); chmodSync(file, 0o600)
  const later = open(dir, () => new Date('2026-12-15T00:00:00Z'))  // 78 days on: the dismissed item is past retention
  expect(later.quarantineCount()).toBe(1)
  expect(later.list().map(i => i.id).sort()).toEqual([id(1), id(2), id(3)])
  later.upsert([ask(1)])
  expect(later.list().map(i => i.id).sort()).toEqual([id(1), id(3)])
  expect(JSON.parse(readFileSync(file, 'utf8')).quarantined).toEqual([{ id: 'broken' }])
})

it('refuses a second writer, an unsafe directory and an unreadable journal, and the optional wrapper keeps boot alive', () => {
  const dir = root(); open(dir)
  expect(() => new WorkIntakeStore(dir)).toThrow('intake_store_locked')
  const loose = root(); chmodSync(loose, 0o755)
  expect(() => new WorkIntakeStore(loose)).toThrow('intake_store_unsafe')
  const corrupt = root(); writeFileSync(join(corrupt, 'intake.json'), '{nope'); chmodSync(join(corrupt, 'intake.json'), 0o600)
  expect(() => new WorkIntakeStore(corrupt)).toThrow('intake_store_recovery_required')
  expect(createOptionalWorkIntakeStore(() => new WorkIntakeStore(corrupt))).toBeNull()
})
