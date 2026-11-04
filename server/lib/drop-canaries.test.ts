/**
 * Drop it P1 canaries (plan section 9). Each one can fail:
 *   1. Replay: over 5% filed wrong, or over 40% asked.
 *   2. Undo, every destination: in drop-service.test.ts ("Undo and Move (canary 2: every destination)").
 *   3. No text: a unique string in drops is found in any console line, the token audit, a ledger or any other data file.
 *   4. Cap at 1 token: a Jev request is made, or the drop is lost.
 *   5. Outward: any request to a host other than api.typesafe.ai, or a drop module importing a network, mail, Slack,
 *      calendar, Telegram or model client.
 *  11. Messages unchanged: after a drop, a receipt, a question, an answer and a ping, all-messages, live-chats or the
 *      lens message counter answer anything different.
 */
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DropStore, InboxFeedStore } from './drop-store.js'
import { auditDropRoute, createDropJevClient, DropRouter, jevOnlyDropClient } from './drop-router.js'
import { DropService } from './drop-service.js'
import { DATA_DIR } from './data-dir.js'
import { fakeWriters, REPLAY, scriptedAnswer, scriptedDecisionClient } from './__fixtures__/drop-fixtures.js'
import { createDropsRouter } from '../routes/drops.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks() })

function stores(root = mkdtempSync(join(tmpdir(), 'drop-canary-'))) {
  const drops = new DropStore(join(root, 'drops')), feed = new InboxFeedStore(join(root, 'inbox'))
  cleanup.push(() => { drops.close(); feed.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, drops, feed }
}
function withEnv(values: Record<string, string>) {
  const prior = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]))
  Object.assign(process.env, values)
  cleanup.push(() => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
}

describe('canary 1: replay', () => {
  it(`files ${REPLAY.length} labelled drops: at most 5% wrong, at most 40% asked`, async () => {
    expect(REPLAY.length).toBeGreaterThanOrEqual(30)
    const { drops, feed } = stores()
    const client = scriptedDecisionClient()
    const service = new DropService({ drops, feed, writers: fakeWriters(), router: new DropRouter({ client, enabled: () => true }) })
    let wrong = 0, asked = 0, right = 0
    const misses: string[] = []
    for (const [i, entry] of REPLAY.entries()) {
      const out = await service.submit({ dropId: randomUUID(), text: entry.text, source: 'mac', ...(entry.hint ? { hint: entry.hint } : {}) })
      if (out.drop.state === 'asking') { asked++; continue }
      const link = out.drop.links[0]
      const target = entry.label.target
      const targetOk = !target || (entry.label.dest === 'new_card' ? link?.domain === target
        : entry.label.dest === 'existing_card' ? link?.label === (target.length <= 60 ? target : target.slice(0, 59).trimEnd() + '…')
        : link?.label === target)
      if (out.drop.dest === entry.label.dest && targetOk) right++
      else { wrong++; misses.push(`#${i} ${out.drop.dest}`) }
    }
    const jevCalls = client.calls.length
    const tokens = client.calls.map(c => c.estimate)
    const mean = Math.round(tokens.reduce((a, b) => a + b, 0) / jevCalls)
    // Counts and ids only: this line is safe to log.
    console.info(`[drop-replay] n=${REPLAY.length} right=${right} wrong=${wrong} asked=${asked} jevCalls=${jevCalls} tokensMean=${mean} tokensMax=${Math.max(...tokens)} misses=${misses.join(',')}`)
    expect(wrong / REPLAY.length).toBeLessThanOrEqual(0.05)
    expect(asked / REPLAY.length).toBeLessThanOrEqual(0.40)
    // Rule-routed drops never reach Jev.
    expect(jevCalls).toBe(REPLAY.filter(e => e.jev).length)
  })

  it.skipIf(process.env.COS_DROP_LIVE_REPLAY !== '1')('live: the same set against TypeSafe Jev (opt-in, spends tokens)', async () => {
    const { drops, feed, root } = stores()
    const client = jevOnlyDropClient(createDropJevClient(fetch, () => new Date(), join(root, 'ledger.json')))
    const service = new DropService({ drops, feed, writers: fakeWriters(), router: new DropRouter({ client, enabled: () => true }) })
    let wrong = 0, asked = 0
    for (const entry of REPLAY) {
      const out = await service.submit({ dropId: randomUUID(), text: entry.text, source: 'mac', ...(entry.hint ? { hint: entry.hint } : {}) })
      if (out.drop.state === 'asking') asked++
      else if (out.drop.dest !== entry.label.dest) wrong++
    }
    console.info(`[drop-replay-live] n=${REPLAY.length} wrong=${wrong} asked=${asked}`)
    expect(wrong / REPLAY.length).toBeLessThanOrEqual(0.05)
    expect(asked / REPLAY.length).toBeLessThanOrEqual(0.40)
  }, 120_000)
})

/** A fetch that answers like TypeSafe and records every host it was asked for. */
function recordingFetch() {
  const hosts: string[] = []
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    hosts.push(new URL(String(url)).host)
    const body = JSON.parse(String(init?.body ?? '{}'))
    const answers = scriptedAnswer(body.questions, { dest: { new_card: 0.9, note: 0.1 }, domain: 'work', domainP: 0.9, clear: 0.8 })
    return new Response(JSON.stringify({ answers, model: 'jev-1.13.0', usage: { input_tokens: 777 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return { impl, hosts }
}

function filesUnder(dir: string, skip: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) out.push(...filesUnder(path, skip))
    else if (st.isFile() && !skip(path) && st.size < 5_000_000) out.push(path)
  }
  return out
}

describe('canaries 3 and 5: no drop text in any log, ledger or audit; nothing outward but Jev', () => {
  it('runs every destination through the real Jev client and finds the marker only in the two stores', async () => {
    const MARKER = `zqxmarker${randomUUID().slice(0, 8)}`
    // The global decision provider says SubQ: Drop it is pinned to Jev, so nothing may go anywhere but TypeSafe.
    withEnv({ TYPESAFE_API_KEY: 'test-key-not-real', COS_DECISION_PROVIDER: 'subq', COS_DROP_DAILY_TOKENS: '300000' })
    const { root, drops, feed } = stores()
    const ledger = join(root, 'jev-drop-usage.json')
    const net = recordingFetch()
    const realFetch = globalThis.fetch
    globalThis.fetch = net.impl as unknown as typeof fetch
    cleanup.push(() => { globalThis.fetch = realFetch })
    const lines: string[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')) })
    }
    const auditFile = process.env.COS_TOKEN_AUDIT_FILE!
    const auditBefore = existsSync(auditFile) ? readFileSync(auditFile, 'utf8').length : 0
    const writers = fakeWriters({ candidates: () => ({ domains: [{ name: 'work', label: 'Work' }, { name: 'personal', label: 'Personal' }], cards: [], threads: [] }) })
    const client = jevOnlyDropClient(createDropJevClient(net.impl as unknown as typeof fetch, () => new Date(), ledger))
    const service = new DropService({ drops, feed, writers, router: new DropRouter({ client, enabled: () => true, audit: auditDropRoute }) })

    const texts = [`Draft the ${MARKER} onboarding email`, `remind me to call ${MARKER}`, `remember that ${MARKER} likes green tea in the morning`, `what is ${MARKER}?`, `note ${MARKER} sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH`]
    const ids: string[] = []
    for (const text of texts) ids.push((await service.submit({ dropId: randomUUID(), text, source: 'mac' })).drop.id)
    await service.undo(ids[0])
    await service.history({ q: MARKER })
    writers.missing.add('captureCard')
    await service.submit({ dropId: randomUUID(), text: `Draft the ${MARKER} follow up email`, source: 'mac' })

    // Canary 5: only api.typesafe.ai was called, and only for the Jev-routed drops (the redacted one never went).
    expect(net.hosts.length).toBe(2)
    expect(new Set(net.hosts)).toEqual(new Set(['api.typesafe.ai']))
    for (const call of net.impl.mock.calls) expect(String(call[1]?.body)).not.toMatch(/sk-ant/)

    // Canary 3: the marker is nowhere but the drop and feed stores.
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.toLowerCase()).not.toContain(MARKER)
    const audit = existsSync(auditFile) ? readFileSync(auditFile, 'utf8').slice(auditBefore) : ''
    expect(audit).toMatch(/"caller":"drop"/)
    expect(audit).not.toContain(MARKER)
    expect(readFileSync(ledger, 'utf8')).not.toContain(MARKER)
    const isStore = (p: string) => p.endsWith(join('drops', 'drops.json')) || p.endsWith(join('inbox', 'feed.json'))
    const others = [...filesUnder(root, isStore), ...filesUnder(DATA_DIR, () => false)]
    for (const path of others) expect(readFileSync(path, 'utf8'), path).not.toContain(MARKER)
    expect(readFileSync(join(root, 'drops', 'drops.json'), 'utf8')).toContain(MARKER)  // the check can find it where it belongs
  })

  it('no drop module imports a network, mail, Slack, calendar, Telegram, Messages or model client', () => {
    const dir = resolve(import.meta.dirname)
    const files = ['drop-store.ts', 'drop-router.ts', 'drop-service.ts', 'drop-destinations.ts', 'drop-settings.ts', '../routes/drops.ts']
    const forbidden = /from\s+['"](?:node:)?(?:https?|net|dgram|tls|http2)['"]|undici|telegram|slack|mail|calendar|conversation|message-era|message-ref|display-bus|claude|openai|anthropic|ollama|codex|cursor|llm|query-job/i
    for (const file of files) {
      const imports = readFileSync(join(dir, file), 'utf8').split('\n').filter(l => /^\s*import\b|from\s+['"]/.test(l))
      for (const line of imports) expect(line, `${file}: ${line}`).not.toMatch(forbidden)
    }
  })
})

describe('canary 3b: a drop holding a secret never reaches memory, the Ask job or Jev', () => {
  it('remember, a question and a plain drop with a key are kept as notes, and no writer or classifier sees them', async () => {
    const { drops, feed } = stores()
    const writers = fakeWriters()
    const client = scriptedDecisionClient()
    const service = new DropService({ drops, feed, writers, router: new DropRouter({ client, enabled: () => true }) })
    const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'
    for (const text of [`remember the staging key is ${KEY} for the demo account`, `what does ${KEY} unlock?`, `remind me to rotate ${KEY}`, `Draft a card with ${KEY}`]) {
      const out = await service.submit({ dropId: randomUUID(), text, source: 'mac' })
      expect(out.drop, text).toMatchObject({ dest: 'note', route: { by: 'fallback', reason: 'redacted' } })
      expect(out.next).toBeUndefined()
      expect(out.items.at(-1)!.line).toBe('It looked like it held a password or key, so it was not sent for filing.')
      await expect(service.move(out.drop.id, { dest: 'memory' })).rejects.toMatchObject({ code: 'redacted' })
    }
    // The memory writer stands in for the bridge's embed-and-store: it was never called.
    expect(writers.calls).toEqual([])
    expect(client.calls).toHaveLength(0)
  })
})

describe('canary 4: cap at 1 token', () => {
  it('makes no Jev request, and the drop is kept as a note with the reason', async () => {
    withEnv({ TYPESAFE_API_KEY: 'test-key-not-real', COS_DECISION_PROVIDER: 'jev', COS_DROP_DAILY_TOKENS: '1' })
    const { root, drops, feed } = stores()
    const net = recordingFetch()
    const client = jevOnlyDropClient(createDropJevClient(net.impl as unknown as typeof fetch, () => new Date(), join(root, 'ledger.json')))
    const service = new DropService({ drops, feed, writers: fakeWriters(), router: new DropRouter({ client, enabled: () => true }) })
    const out = await service.submit({ dropId: randomUUID(), text: 'Draft the onboarding email sequence for new liquor stores', source: 'mac' })
    expect(net.impl).not.toHaveBeenCalled()
    expect(out.drop).toMatchObject({ dest: 'note', state: 'filed', route: { by: 'fallback', reason: 'jev_cap_reached' } })
    expect(drops.get(out.drop.id)!.text).toBe('Draft the onboarding email sequence for new liquor stores')
  })
})

describe('canary 11: Messages unchanged', () => {
  it('a drop, receipt, question, answer, undo and ping add no Messages row and do not move the message counter', async () => {
    const { sessionsRouter } = await import('../routes/sessions.js')
    const { messageRefRouter } = await import('../routes/message-ref.js')
    const { drops, feed } = stores()
    const service = new DropService({ drops, feed, writers: fakeWriters(), router: new DropRouter({ client: scriptedDecisionClient(), enabled: () => true }) })
    const app = express(); app.use(express.json())
    app.use('/api', sessionsRouter); app.use('/api', messageRefRouter)
    app.use('/api', createDropsRouter({ enabled: () => true, service: () => service }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    cleanup.push(() => new Promise<void>(r => server.close(() => r())))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
    const snapshot = async () => Promise.all(['/sessions/today/all-messages', '/sessions/today/live-chats', '/message-counter']
      .map(async p => { const res = await fetch(base + p); return `${res.status} ${await res.text()}` }))
    const before = await snapshot()
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json() as Promise<any>)
    const filed = await post('/drops', { dropId: randomUUID(), text: 'Draft the onboarding email sequence for new liquor stores', source: 'mac' })
    const asked = await post('/drops', { dropId: randomUUID(), text: 'Call Dale about the Kickoff deck', source: 'mac' })
    await post('/inbox/action', { itemId: asked.items.find((i: { kind: string }) => i.kind === 'question').id, action: 'choose:o1' })
    await post(`/drops/${filed.drop.id}/undo`, {})
    const at = new Date().toISOString()
    feed.insert([{ id: `fi_${'9'.repeat(32)}`, kind: 'ping', threadId: 'ping-test-1', createdAt: at, readAt: null, source: 'cos', line: '3 follow-ups are ready.', links: [], actions: [], state: 'live', key: 'ping:test:1' }])
    expect((await fetch(base + '/inbox/summary').then(r => r.json()) as any).unread).toBeGreaterThan(0)
    expect(await snapshot()).toEqual(before)
  })
})
