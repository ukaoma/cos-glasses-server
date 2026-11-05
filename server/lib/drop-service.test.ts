import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DropStore, InboxFeedStore, type DropDest } from './drop-store.js'
import { DropRouter } from './drop-router.js'
import { DropService, kindFor, statusOf } from './drop-service.js'
import { fakeWriters, scriptedDecisionClient, type FakeWriters } from './__fixtures__/drop-fixtures.js'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()) })

function harness(options: { writers?: FakeWriters; routerOn?: boolean; askLookup?: ConstructorParameters<typeof DropService>[0]['askLookup'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drop-service-'))
  let clock = new Date('2026-11-04T15:00:00.000Z')
  const now = () => clock
  const drops = new DropStore(join(root, 'drops'), now), feed = new InboxFeedStore(join(root, 'inbox'), now)
  const writers = options.writers ?? fakeWriters()
  const client = scriptedDecisionClient()
  const router = new DropRouter({ client, enabled: () => options.routerOn ?? true })
  const service = new DropService({ drops, feed, router, writers, now, timezone: () => 'America/Chicago', askLookup: options.askLookup })
  cleanup.push(() => { drops.close(); feed.close(); rmSync(root, { recursive: true, force: true }) })
  return { service, drops, feed, writers, client, root, advance: (ms: number) => { clock = new Date(clock.getTime() + ms) },
    reopen: () => { drops.close(); feed.close(); const d = new DropStore(join(root, 'drops'), now), f = new InboxFeedStore(join(root, 'inbox'), now)
      cleanup.push(() => { d.close(); f.close() }); return { service: new DropService({ drops: d, feed: f, router, writers, now }), drops: d, feed: f } } }
}
const drop = (text: string, extra: Record<string, unknown> = {}) => ({ dropId: randomUUID(), text, source: 'mac' as const, ...extra })

describe('filing', () => {
  it('a sure new card is captured with its id, and the receipt links the card', async () => {
    const h = harness()
    const out = await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    expect(out.drop).toMatchObject({ state: 'filed', dest: 'new_card', kind: 'task', status: 'open', canUndo: true })
    expect(out.drop.links[0]).toMatchObject({ kind: 'card', domain: 'work' })
    expect(out.items.map(i => i.kind)).toEqual(['drop', 'receipt'])
    expect(out.items[1]).toMatchObject({ title: 'Filed to Work, Work', line: 'New card in the Inbox.', readAt: expect.any(String) })
    expect(out.items[1].actions.map(a => a.id)).toEqual(['open_card', 'undo', 'move'])
  })

  it('rule routes skip Jev', async () => {
    const h = harness()
    const reminder = await h.service.submit(drop('remind me Thursday to send the numbers'))
    const memory = await h.service.submit(drop('remember that the Tulsa store prefers email'))
    const ask = await h.service.submit(drop('what did we decide about the price test?'))
    expect(h.client.calls).toHaveLength(0)
    // P2: the time is read at filing. Wednesday 9:00 CST, so Thursday is tomorrow at 9:00 CST.
    expect(reminder.drop).toMatchObject({ dest: 'reminder', kind: 'reminder', remind: { at: '2026-11-05T15:00:00.000Z', tz: 'America/Chicago', firedAt: null } })
    expect(memory.drop).toMatchObject({ dest: 'memory', links: [{ kind: 'memory' }] })
    expect(ask.drop).toMatchObject({ dest: 'ask', state: 'asked' })
    expect(ask.next).toEqual({ kind: 'ask', prompt: 'what did we decide about the price test?' })
  })

  it('an unsure drop asks one question with the top two readings and Just a note', async () => {
    const h = harness()
    const out = await h.service.submit(drop('Call Dale about the Kickoff deck'))
    expect(out.drop.state).toBe('asking')
    const q = out.items.find(i => i.kind === 'question')!
    expect(q.title).toBe('Is this a task for you, or a note on the Kickoff 2027 Planning thread?')
    expect(q.readAt).toBeNull()
    expect(q.actions.map(a => a.id)).toEqual(['choose:o1', 'choose:o2', 'choose:note'])
    const chosen = await h.service.choose(q.id, 'o2')
    expect(chosen.drop).toMatchObject({ state: 'filed', dest: 'thread', route: { by: 'user' } })
    expect(chosen.items.map(i => i.kind)).toEqual(['drop', 'question', 'answer', 'receipt'])
    expect(chosen.items[1]).toMatchObject({ state: 'done', actions: [] })
    expect(h.writers.calls).toContain('sourceThread:thread-1')
    // A second tap on the same question changes nothing.
    const again = await h.service.choose(q.id, 'o1')
    expect(again.drop.dest).toBe('thread')
    expect(h.writers.calls.filter(c => c.startsWith('captureCard'))).toHaveLength(0)
  })

  it('a session follow-up is held, and Sent spends the hold', async () => {
    const h = harness()
    const out = await h.service.submit(drop('also add the Q4 numbers to the summary', { hint: { sessionId: 'claude:5f1c', label: 'Marketing priorities slides' } }))
    expect(out.drop).toMatchObject({ state: 'held', dest: 'session', hold: { sessionId: 'claude:5f1c', label: 'Marketing priorities slides' } })
    expect(out.items[1].title).toBe('Held for Marketing priorities slides')
    const sent = await h.service.holdSent(out.drop.id)
    expect(sent.drop).toMatchObject({ state: 'filed', canUndo: false, status: 'done' })
    await expect(h.service.undo(out.drop.id)).rejects.toMatchObject({ code: 'undo_expired' })
  })

  it('Jev unavailable keeps a plain note and says why', async () => {
    const h = harness({ routerOn: false })
    const out = await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    expect(out.drop).toMatchObject({ dest: 'note', route: { by: 'fallback', reason: 'router_off' } })
    expect(out.items[1]).toMatchObject({ title: 'Kept as a note', line: 'Automatic filing is off on this server.' })
  })

  it('a memory too short for the memory contract is kept as a note, with words that do not suggest Move', async () => {
    const h = harness()
    const out = await h.service.submit(drop('remember coffee black'))
    expect(out.drop).toMatchObject({ dest: 'note', route: { by: 'rule', reason: 'memory_too_short' } })
    expect(out.items.at(-1)!.line).toBe('Memories need a full sentence, so this one is kept as a note.')
    expect(out.items.at(-1)!.line).not.toMatch(/move/i)
  })

  it('a missing bridge verb keeps a plain note with the reason', async () => {
    const h = harness({ writers: fakeWriters({ missing: ['captureCard', 'captureMemory'] }) })
    const card = await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    expect(card.drop).toMatchObject({ dest: 'note', links: [], route: { reason: 'destination_unavailable' } })
    expect(card.items[1].line).toBe('Filing there needs a COS update on this Mac.')
    const memory = await h.service.submit(drop('remember the alarm code changed'))
    expect(memory.drop.dest).toBe('note')
  })

  it('a repeated dropId answers the first result, also while the first is still running', async () => {
    const h = harness()
    const input = drop('Draft the onboarding email sequence for new liquor stores')
    const [a, b] = await Promise.all([h.service.submit(input), h.service.submit(input)])
    expect(a.drop.id).toBe(b.drop.id)
    expect(b.replayed).toBe(true)
    const c = await h.service.submit({ ...input, text: 'other words' })
    expect(c).toMatchObject({ replayed: true, drop: { text: input.text } })
    expect(h.writers.calls.filter(x => x.startsWith('captureCard'))).toHaveLength(1)
    expect(h.client.calls).toHaveLength(1)
  })

  it('refuses bad input before saving anything', async () => {
    const h = harness()
    await expect(h.service.submit({ dropId: 'nope', text: 'x', source: 'mac' })).rejects.toMatchObject({ code: 'invalid_drop_id' })
    await expect(h.service.submit(drop('x'.repeat(2001)))).rejects.toMatchObject({ code: 'invalid_text' })
    await expect(h.service.submit(drop('  '))).rejects.toMatchObject({ code: 'invalid_text' })
    await expect(h.service.submit({ ...drop('ok'), source: 'email' as never })).rejects.toMatchObject({ code: 'invalid_source' })
    expect(h.drops.list()).toHaveLength(0)
  })

  it('a drop left routing by a restart becomes a note with a receipt', async () => {
    const h = harness()
    const id = randomUUID(), at = new Date().toISOString()
    h.drops.insert({ id, text: 'half filed', source: 'mac', createdAt: at, updatedAt: at, state: 'routing', dest: null, kind: 'note', links: [], route: null, undoUntil: null, timeline: [{ at, state: 'routing' }] })
    const { service } = h.reopen()
    expect(service.get(id)).toMatchObject({ drop: { state: 'filed', dest: 'note', route: { reason: 'interrupted' } } })
  })
})

describe('Undo and Move (canary 2: every destination)', () => {
  const cases: Array<[string, DropDest, Record<string, unknown>?]> = [
    ['Draft the onboarding email sequence for new liquor stores', 'new_card'],
    ['Add the Clover switcher stat to the price test card', 'existing_card'],
    ['Trade show budget might need another booth panel', 'thread'],
    ['remember that the Tulsa store prefers email', 'memory'],
    ['also add the Q4 numbers to the summary', 'session', { hint: { sessionId: 'claude:5f1c', label: 'Slides' } }],
    ['Interesting thought: loyalty points could work for pet stores', 'note'],
    ['remind me to call the bank tomorrow', 'reminder'],
  ]
  it.each(cases)('%s (%s): Undo leaves every store as it was, apart from the archived row', async (text, dest, extra) => {
    const h = harness()
    const before = { cards: [...h.writers.cards.values()].filter(c => !c.archived).length, memories: [...h.writers.memories.values()].filter(m => !m.pruned).length,
      threads: [...h.writers.threadSources.values()].filter(t => !t.removed).length }
    const out = await h.service.submit(drop(text, extra))
    expect(out.drop.dest).toBe(dest)
    const undone = await h.service.undo(out.drop.id)
    const after = { cards: [...h.writers.cards.values()].filter(c => !c.archived).length, memories: [...h.writers.memories.values()].filter(m => !m.pruned).length,
      threads: [...h.writers.threadSources.values()].filter(t => !t.removed).length }
    expect(after).toEqual(before)
    expect(undone.drop).toMatchObject({ state: 'undone', status: 'undone', links: [], canUndo: false })
    expect(undone.drop.hold).toBeUndefined(); expect(undone.drop.remind).toBeUndefined()
    // Nothing is deleted: the drop stays in History, and its words stay in the chat.
    expect(h.drops.get(out.drop.id)!.text).toBe(text)
    expect(undone.items.filter(i => i.state === 'live' && i.actions.length)).toHaveLength(0)
    expect(undone.items.at(-1)).toMatchObject({ kind: 'receipt', title: 'Undone' })
    // Undo again is a no-op.
    expect((await h.service.undo(out.drop.id)).replayed).toBe(true)
  })

  it('a card that was already there is only unlinked by Undo, never archived', async () => {
    const h = harness()
    h.writers.cards.set('aaaaaaaaaaaa', { domain: 'work', text: 'Draft the onboarding email sequence for new liquor stores', archived: false, touched: false })
    const out = await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    expect(out.drop.links[0]).toMatchObject({ kind: 'card', id: 'aaaaaaaaaaaa', created: false })
    expect(out.items.at(-1)!.title).toBe('Already in Work, Work')
    const undone = await h.service.undo(out.drop.id)
    expect(undone.drop.state).toBe('undone')
    expect(h.writers.cards.get('aaaaaaaaaaaa')!.archived).toBe(false)
    expect(h.writers.calls.filter(c => c.startsWith('archiveCard'))).toHaveLength(0)
  })

  it('a memory accepted since is left alone by Undo', async () => {
    const h = harness()
    const out = await h.service.submit(drop('remember that the Tulsa store prefers email'))
    ;[...h.writers.memories.values()][0].reviewed = true
    await expect(h.service.undo(out.drop.id)).rejects.toMatchObject({ code: 'edited', message: 'The memory was reviewed since, so Undo leaves it alone.' })
    expect([...h.writers.memories.values()][0].pruned).toBe(false)
    expect(h.drops.get(out.drop.id)!.state).toBe('filed')
  })

  it('filing a memory again after Undo is a new capture, never the set-aside row', async () => {
    const h = harness()
    const out = await h.service.submit(drop('remember that the Tulsa store prefers email'))
    await h.service.move(out.drop.id, { dest: 'note' })
    const back = await h.service.move(out.drop.id, { dest: 'memory' })
    const ids = [...h.writers.memories.keys()]
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(back.drop.links[0].id).toBe(ids[1])
    expect(h.writers.memories.get(ids[0])!.pruned).toBe(true)
  })

  it('a move target the store would refuse is refused before anything is undone', async () => {
    const h = harness()
    const out = await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    await expect(h.service.move(out.drop.id, { dest: 'thread', target: { id: 'thread-3', label: 'bad\u0007label' } })).rejects.toMatchObject({ code: 'invalid_target' })
    await expect(h.service.move(out.drop.id, { dest: 'thread', target: { id: 'thread-3', label: 'x'.repeat(201) } })).rejects.toMatchObject({ code: 'invalid_target' })
    expect([...h.writers.cards.values()][0].archived).toBe(false)
    expect(h.writers.calls.filter(c => c.startsWith('sourceThread'))).toHaveLength(0)
    expect(h.drops.get(out.drop.id)).toMatchObject({ state: 'filed', dest: 'new_card' })
  })

  it('a card picked by Jev whose words hold control characters still files with a clean label', async () => {
    const card = { id: 'bbbbbbbbbbbb', workIdentity: 'bbbbbbbbbbbb', domain: 'work', text: 'Run the price test\u0007 for a first-month discount' }
    const h = harness({ writers: fakeWriters({ candidates: () => ({ domains: [{ name: 'work', label: 'Work' }], cards: [card], threads: [] }) }) })
    const client = { provider: 'jev' as const, ask: async () => ({ provider: 'jev' as const, inputTokens: 1, answers: {
      dest: { probabilities: { existing_card: 0.95, new_card: 0.02, memory: 0.01, note: 0.02 } }, card: { probabilities: { c0: 0.95, none: 0.05 } }, clear: { noul: 0.9 } } }) }
    const service = new DropService({ drops: h.drops, feed: h.feed, writers: h.writers, router: new DropRouter({ client, enabled: () => true }) })
    const out = await service.submit(drop('Add the Clover stat to the price test card'))
    expect(out.drop).toMatchObject({ state: 'filed', dest: 'existing_card', links: [{ kind: 'card', id: 'bbbbbbbbbbbb' }] })
    expect(out.drop.links[0].label).not.toMatch(/[\x00-\x1f]/)
  })

  it('refuses after 24 hours', async () => {
    const h = harness()
    const out = await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    h.advance(24 * 60 * 60_000 + 1)
    await expect(h.service.undo(out.drop.id)).rejects.toMatchObject({ code: 'undo_expired', status: 409 })
    expect([...h.writers.cards.values()][0].archived).toBe(false)
  })

  it('refuses when the card was edited since', async () => {
    const h = harness()
    const out = await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    ;[...h.writers.cards.values()][0].touched = true
    await expect(h.service.undo(out.drop.id)).rejects.toMatchObject({ code: 'edited' })
    expect(h.drops.get(out.drop.id)!.state).toBe('filed')
  })

  it('refuses when the thread note was edited since', async () => {
    const h = harness()
    const out = await h.service.submit(drop('Trade show budget might need another booth panel'))
    ;[...h.writers.threadSources.values()][0].touched = true
    await expect(h.service.undo(out.drop.id)).rejects.toMatchObject({ code: 'edited' })
  })

  it('an ask cannot be undone; the answer stays', async () => {
    const h = harness()
    const out = await h.service.submit(drop('what did we decide?'))
    await expect(h.service.undo(out.drop.id)).rejects.toMatchObject({ code: 'undo_not_available' })
  })

  it('Move is Undo then filing where picked, with no Jev call', async () => {
    const h = harness()
    const out = await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    const calls = h.client.calls.length
    const moved = await h.service.move(out.drop.id, { dest: 'thread', target: { id: 'thread-3', label: 'Pricing tests' } })
    expect(h.client.calls.length).toBe(calls)
    expect([...h.writers.cards.values()][0].archived).toBe(true)
    expect(moved.drop).toMatchObject({ dest: 'thread', route: { by: 'user' }, links: [{ kind: 'thread', id: 'thread-3' }] })
    expect(moved.items.at(-1)!.title).toBe('Moved. Added to the Pricing tests thread')
  })

  it('Move from an open question files without Undo', async () => {
    const h = harness()
    const out = await h.service.submit(drop('Call Dale about the Kickoff deck'))
    const moved = await h.service.move(out.drop.id, { dest: 'memory' })
    expect(moved.drop).toMatchObject({ state: 'filed', dest: 'memory' })
    expect(moved.items.find(i => i.kind === 'question')).toMatchObject({ state: 'done' })
  })

  it('two taps at once: the second gets drop_busy', async () => {
    const h = harness()
    const out = await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    const results = await Promise.allSettled([h.service.undo(out.drop.id), h.service.undo(out.drop.id)])
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(h.writers.calls.filter(c => c.startsWith('archiveCard'))).toHaveLength(1)
  })
})

describe('the chat', () => {
  it('summary counts unread questions and follow-ups, and read marks through an item', async () => {
    const h = harness()
    await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    const q = await h.service.submit(drop('Call Dale about the Kickoff deck'))
    const s = h.service.summary()
    expect(s.unread).toBe(1)
    expect(s.lastLine).toMatch(/^Is this a task for you/)
    const question = q.items.find(i => i.kind === 'question')!
    expect(h.service.markRead(question.id)).toMatchObject({ unread: 0 })
    expect(h.service.summary().version).toBeGreaterThan(s.version)
  })

  it('pages the feed forward from an item', async () => {
    const h = harness()
    for (let i = 0; i < 3; i++) await h.service.submit(drop(`Book the dentist for the kids ${i}`))
    const all = h.service.feed()
    expect(all.items.length).toBeGreaterThan(3)
    const after = h.service.feed({ after: all.items[1].id, limit: 2 })
    expect(after.items.map(i => i.id)).toEqual(all.items.slice(2, 4).map(i => i.id))
    expect(after.more).toBe(true)
  })

  it('posts a finished answer once, unread, with a link to Messages', async () => {
    const lookup = vi.fn(async () => ({ status: 'completed', response: 'We picked $10 off the first month.', sessionId: 'sess-1' }))
    const h = harness({ askLookup: lookup })
    const out = await h.service.submit(drop('what did we decide about the price test?'))
    expect(await h.service.syncAsks()).toBe(0)  // not linked yet: nothing to look up
    const job = randomUUID()
    await h.service.linkAsk(out.drop.id, job, 1)
    expect(await h.service.syncAsks()).toBe(1)
    expect(await h.service.syncAsks()).toBe(0)
    expect(lookup).toHaveBeenCalledTimes(1)  // an answered ask is not looked up again
    const items = h.service.get(out.drop.id).items
    expect(items.filter(i => i.kind === 'followup')).toHaveLength(1)
    expect(items.at(-1)).toMatchObject({ kind: 'followup', line: 'We picked $10 off the first month.', readAt: null, links: [{ kind: 'session', id: 'sess-1' }] })
    expect(h.service.get(out.drop.id).drop.status).toBe('done')
  })
})

describe('retention', () => {
  it('an undone drop and its chat lines are gone after 30 days; a filed one stays', async () => {
    const h = harness()
    const kept = await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    const gone = await h.service.submit(drop('Trade show budget might need another booth panel'))
    await h.service.undo(gone.drop.id)
    h.advance(31 * 86_400_000)
    await h.service.submit(drop('Book the dentist for the kids'))
    expect(h.drops.get(gone.drop.id)).toBeUndefined()
    expect(h.feed.list().filter(i => i.threadId === gone.drop.id)).toEqual([])
    expect(h.feed.list().filter(i => i.threadId === kept.drop.id && i.kind === 'drop')).toHaveLength(1)
    // A reopen purges too: a chat line left behind (say, a stop between the two writes) never outlives its drop.
    const orphan = randomUUID(), at = new Date().toISOString()
    h.feed.insert([{ id: `fi_${'7'.repeat(32)}`, kind: 'drop', threadId: orphan, createdAt: at, readAt: at, source: 'mac', line: 'left behind', links: [], actions: [], state: 'live', key: `${orphan}:drop` }])
    const { feed } = h.reopen()
    expect(feed.list().some(i => i.threadId === gone.drop.id || i.threadId === orphan)).toBe(false)
    expect(feed.list().some(i => i.threadId === kept.drop.id)).toBe(true)
  })
})

describe('History', () => {
  it('filters by words over text and link labels, kind and status, newest first', async () => {
    const h = harness()
    await h.service.submit(drop('Draft the onboarding email sequence for new liquor stores'))
    h.advance(1000)
    await h.service.submit(drop('Trade show budget might need another booth panel'))
    h.advance(1000)
    const undone = await h.service.submit(drop('Interesting thought: loyalty points could work for pet stores'))
    await h.service.undo(undone.drop.id)
    const all = await h.service.history()
    expect(all.drops.map(d => d.kind)).toEqual(['idea', 'note', 'task'])
    expect((await h.service.history({ q: 'trade show' })).drops).toHaveLength(1)
    expect((await h.service.history({ q: 'Trade show budget thread' })).drops).toHaveLength(0)
    expect((await h.service.history({ kind: 'task' })).drops).toHaveLength(1)
    expect((await h.service.history({ status: 'undone' })).drops.map(d => d.id)).toEqual([undone.drop.id])
    expect((await h.service.history({ status: 'open' })).cardStates).toBe('read')
  })

  it('derives status from the card stage', () => {
    const base = { id: 'x', text: 't', source: 'mac' as const, createdAt: '', updatedAt: '', state: 'filed' as const, dest: 'new_card' as const, kind: 'task' as const,
      links: [{ kind: 'card' as const, id: 'abcabcabcabc', label: 'Work', domain: 'work' }], route: null, undoUntil: null, timeline: [] }
    expect(statusOf(base, new Map([['abcabcabcabc', { workStage: 'qa', checked: false }]]))).toBe('in_progress')
    expect(statusOf(base, new Map([['abcabcabcabc', { workStage: 'complete', checked: true }]]))).toBe('done')
    expect(statusOf(base, null)).toBe('open')
    expect(kindFor('note', 0.49)).toBe('idea')
    expect(kindFor('note', 0.5)).toBe('note')
  })
})

describe('P2 reminders in the service', () => {
  it('a reminder with a time says when, in his words', async () => {
    const h = harness()
    const out = await h.service.submit(drop('remind me Thursday to send Gina the JCK numbers'))
    const receipt = out.items.find(i => i.kind === 'receipt')!
    expect(receipt).toMatchObject({ title: 'Reminder set: tomorrow 9:00 AM', line: 'I will remind you: send Gina the JCK numbers.' })
    expect(receipt.needsReply).toBeUndefined()
    expect(receipt.actions.map(a => a.id)).toEqual(['undo', 'move'])
  })

  it('no time: the receipt asks once, waits on him, and a pick sets the time and clears the wait', async () => {
    const h = harness()
    const out = await h.service.submit(drop('remind me to call mom'))
    const ask = out.items.find(i => i.kind === 'receipt')!
    expect(out.drop.remind).toMatchObject({ at: null })
    expect(ask).toMatchObject({ title: 'When should I remind you?', line: 'I could not read a time for: call mom.', needsReply: true })
    expect(ask.actions.map(a => a.id)).toEqual(['when:tomorrow_9', 'when:monday_9', 'undo', 'move'])
    expect(h.service.summary().waiting).toBe(1)
    const set = await h.service.setReminderTime(ask.id, 'tomorrow_9')
    expect(set.drop.remind).toMatchObject({ at: '2026-11-05T15:00:00.000Z' })
    expect(h.feed.get(ask.id)!.state).toBe('done')
    expect(h.service.summary().waiting).toBe(0)
    const latest = h.feed.list().filter(i => i.kind === 'receipt' && i.state === 'live')
    expect(latest.map(i => i.title)).toEqual(['Reminder set: tomorrow 9:00 AM'])
  })

  it('refuses a past time, a time over a year out, and an undone reminder', async () => {
    const h = harness()
    const out = await h.service.submit(drop('remind me to call mom'))
    const ask = out.items.find(i => i.kind === 'receipt')!
    await expect(h.service.setReminderTime(ask.id, '2026-11-04T14:00:00.000Z')).rejects.toMatchObject({ code: 'invalid_time' })
    await expect(h.service.setReminderTime(ask.id, '2028-01-01T15:00:00.000Z')).rejects.toMatchObject({ code: 'invalid_time' })
    await expect(h.service.setReminderTime(ask.id, 'sometime')).rejects.toMatchObject({ code: 'invalid_time' })
    await h.service.undo(out.drop.id)
    await expect(h.service.setReminderTime(ask.id, 'tomorrow_9')).rejects.toMatchObject({ code: 'not_a_live_reminder' })
  })

  it('Done and Snooze on a fired reminder ping', async () => {
    const h = harness()
    const out = await h.service.submit(drop('remind me tomorrow at 9am to stretch'))
    const id = out.drop.id
    const [ping] = h.feed.insert([{ id: 'fi_' + 'a'.repeat(32), kind: 'ping', threadId: 'fi_' + 'a'.repeat(32), createdAt: new Date().toISOString(), readAt: null, source: 'cos',
      line: 'Reminder: stretch', links: [{ kind: 'reminder', id, label: 'stretch' }], actions: [{ id: 'snooze_1h', label: 'Snooze 1 hour' }], state: 'live', key: `reminder:${id}:x` }])
    const snoozed = h.service.reminderAction(ping.id, 'snooze_1h')
    expect(snoozed.item.state).toBe('done')
    expect(snoozed.drop.remind).toMatchObject({ at: '2026-11-04T16:00:00.000Z', snoozes: 1 })
    expect(() => h.service.reminderAction(ping.id, 'launch')).toThrow()
    expect(() => h.service.reminderAction(out.items[0].id, 'reminder_done')).toThrow()  // not a ping
    // Done is final: its time can no longer be changed from the receipt.
    const [ping2] = h.feed.insert([{ id: 'fi_' + 'b'.repeat(32), kind: 'ping', threadId: 'fi_' + 'b'.repeat(32), createdAt: new Date().toISOString(), readAt: null, source: 'cos',
      line: 'Reminder: stretch', links: [{ kind: 'reminder', id, label: 'stretch' }], actions: [], state: 'live', key: `reminder:${id}:y` }])
    h.service.reminderAction(ping2.id, 'reminder_done')
    const receipt = h.feed.list().find(i => i.kind === 'receipt' && i.threadId === id)!
    await expect(h.service.setReminderTime(receipt.id, 'monday_9')).rejects.toMatchObject({ code: 'not_a_live_reminder' })
  })
})
