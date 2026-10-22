import express from 'express'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/conversation.js', () => ({
  getOrCreateSession: () => 'active-session',
}))

import { QueryJobCoordinator } from '../lib/query-job-coordinator.js'
import { QueryJobStore } from '../lib/query-job-store.js'
import { isPublicApiRequest, requireApiToken } from '../lib/api-auth.js'
import {
  ACTIVE_QUERY_JOB_TITLE_MAX,
  activeQueryJobOrigin,
  activeQueryJobTitle,
  truncateActiveTitle,
} from '../lib/query-job-active.js'
import { createQueryJobsRouter } from './query-jobs.js'

const TOKEN = 'active-route-test-token'
const roots: string[] = []
const servers: Server[] = []
const releases: Array<() => void> = []

interface Rig {
  base: string
  coordinator: QueryJobCoordinator
  store: QueryJobStore
}

/** A runner that starts (codex, gpt-5), streams a private chunk and tool line, and answers only when released. */
async function rig(options: { maxHydratedJobs?: number; holdSession?: string } = {}): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'cos-active-query-jobs-'))
  roots.push(root)
  const store = new QueryJobStore({ root, bootId: randomUUID(), ...(options.maxHydratedJobs ? { maxHydratedJobs: options.maxHydratedJobs } : {}) })
  const coordinator = new QueryJobCoordinator(
    store,
    async context => {
      await context.callbacks.onStart({ provider: 'codex', resolvedModel: 'gpt-5', sessionId: context.request.sessionId })
      context.callbacks.onToolStatus('TOOL OUTPUT LINE reading /Users/miles/private')
      context.callbacks.onChunk('PARTIAL ANSWER TEXT')
      await new Promise<void>(resolve => { releases.push(resolve) })
      await context.callbacks.onDone({ text: 'FINAL ANSWER TEXT', provider: 'codex' })
    },
    {
      resolveSessionId: requested => requested || 'active-session',
      partialFlushMs: 0,
      ...(options.holdSession
        ? {
          acquireSessionLock: (sessionId: string) => sessionId === options.holdSession
            ? new Promise<() => void>(resolve => { releases.push(() => resolve(() => {})) })
            : () => {},
        }
        : {}),
    },
  )
  await coordinator.init()
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use(express.json())
  app.use('/api', createQueryJobsRouter(coordinator, { enabled: () => true }))
  const server = await new Promise<Server>(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  servers.push(server)
  const address = server.address()
  return { base: typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '', coordinator, store }
}

async function active(base: string, token: string | null = TOKEN): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}/api/query-jobs/active`, token ? { headers: { 'X-Cos-Token': token } } : {})
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text), text }
}

async function until(read: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await read()) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function waitStatus(store: QueryJobStore, jobId: string, statuses: string[]): Promise<void> {
  await until(async () => statuses.includes((await store.getSnapshot(jobId)).status), `${jobId} to reach ${statuses.join('|')}`)
}

function person(query: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { clientJobId: randomUUID(), generation: 1, query, model: 'opus', messageEra: 'era1', globalMsgNum: 41, ...extra }
}

afterAll(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

describe('GET /api/query-jobs/active', () => {
  let shared: Rig
  beforeAll(async () => { shared = await rig() })

  it('needs the API token (401 without it) and is not a public path', async () => {
    expect(isPublicApiRequest('GET', '/query-jobs/active')).toBe(false)
    const missing = await active(shared.base, null)
    expect(missing.status).toBe(401)
    expect(missing.body).toMatchObject({ error: 'unauthorized' })
    const wrong = await active(shared.base, 'not-the-token')
    expect(wrong.status).toBe(401)
  })

  it('answers an empty list with now and count (not the :jobId route)', async () => {
    const before = Date.now()
    const { status, body } = await active(shared.base)
    expect(status).toBe(200)
    expect(body).toEqual({ protocolVersion: 1, enabled: true, now: expect.any(String), count: 0, items: [] })
    expect(Date.parse(body.now)).toBeGreaterThanOrEqual(before - 1)
  })

  it('lists one running job with its fields and none of its prompt body, answer or tool output', async () => {
    const admission = await shared.coordinator.submit(person('What is on my calendar today?\nSECRET SECOND LINE OF THE PROMPT', {
      reference: { query: 'PRIVATE REFERENCE QUESTION', response: 'PRIVATE REFERENCE ANSWER' },
    }))
    const jobId = admission.job.jobId
    await waitStatus(shared.store, jobId, ['running'])
    await until(async () => (await shared.store.getSnapshot(jobId)).partialText.length > 0, 'the partial chunk')

    const { status, body, text } = await active(shared.base)
    expect(status).toBe(200)
    expect(body.count).toBe(1)
    expect(body.items).toHaveLength(1)
    const item = body.items[0]
    expect(item).toEqual({
      jobId,
      generation: 1,
      origin: 'person',
      state: 'running',
      status: 'running',
      acceptedAt: expect.any(String),
      startedAt: expect.any(String),
      elapsedMs: expect.any(Number),
      provider: 'codex',
      model: 'opus',
      resolvedModel: 'gpt-5',
      messageNo: 41,
      title: 'What is on my calendar today?',
    })
    expect(item.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(item.elapsedMs).toBeLessThan(60_000)
    for (const leak of ['SECRET SECOND LINE', 'PRIVATE REFERENCE', 'PARTIAL ANSWER', 'TOOL OUTPUT', '/Users/miles', 'active-session']) {
      expect(text).not.toContain(leak)
    }

    // Finished: the job leaves the list.
    releases.shift()!()
    await waitStatus(shared.store, jobId, ['completed'])
    const after = await active(shared.base)
    expect(after.body.count).toBe(0)
    expect(after.body.items).toEqual([])
    expect(after.text).not.toContain('FINAL ANSWER')
  })

  it('excludes failed and canceled jobs as well as completed ones', async () => {
    const admission = await shared.coordinator.submit(person('Cancel me please'))
    await waitStatus(shared.store, admission.job.jobId, ['running'])
    expect((await active(shared.base)).body.count).toBe(1)
    await shared.coordinator.cancel(admission.job.jobId, 1)
    await waitStatus(shared.store, admission.job.jobId, ['canceled'])
    expect((await active(shared.base)).body).toMatchObject({ count: 0, items: [] })
    releases.shift()?.()
  })

  it('truncates a long first line to 80 characters, ellipsis included, at a word break', async () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const admission = await shared.coordinator.submit(person(`\n\n   \n${words}\nsecond line never shown`))
    await waitStatus(shared.store, admission.job.jobId, ['running'])
    const { body, text } = await active(shared.base)
    const title: string = body.items.find((row: any) => row.jobId === admission.job.jobId).title
    expect(Array.from(title).length).toBeLessThanOrEqual(ACTIVE_QUERY_JOB_TITLE_MAX)
    expect(title.endsWith('…')).toBe(true)
    expect(words.startsWith(title.slice(0, -1))).toBe(true)
    expect(title.slice(0, -1).endsWith(' ')).toBe(false)
    // Cut back to a word break: the last word shown is a whole word.
    expect(words.split(' ')).toContain(title.slice(0, -1).split(' ').pop())
    expect(text).not.toContain('word39')
    expect(text).not.toContain('second line')
    releases.shift()!()
    await waitStatus(shared.store, admission.job.jobId, ['completed'])
  })
})

describe('active job states, origins and bounds', () => {
  it('shows a job held behind its session as queued (status accepted, no startedAt, no provider yet)', async () => {
    const held = await rig({ holdSession: 'held-session' })
    const admission = await held.coordinator.submit(person('Queued question', { sessionId: 'held-session' }))
    await new Promise(resolve => setTimeout(resolve, 30))
    const { body } = await active(held.base)
    expect(body.count).toBe(1)
    expect(body.items[0]).toMatchObject({ jobId: admission.job.jobId, state: 'queued', status: 'accepted', title: 'Queued question' })
    expect(body.items[0]).not.toHaveProperty('startedAt')
    expect(body.items[0]).not.toHaveProperty('provider')
  })

  it('counts a live job whose record is not held in memory, and never a finished one, without reading the journal', async () => {
    const small = await rig({ maxHydratedJobs: 1 })
    // A finished job, then evicted from memory by the next admission: neither listed nor counted.
    const done = await small.coordinator.submit(person('Finished question', { globalMsgNum: 40 }))
    await waitStatus(small.store, done.job.jobId, ['running'])
    releases.pop()!()
    await waitStatus(small.store, done.job.jobId, ['completed'])
    const first = await small.coordinator.submit(person('First live question'))
    await waitStatus(small.store, first.job.jobId, ['running'])
    expect(small.store.getHealth().hydratedJobs).toBe(1)
    expect((await active(small.base)).body).toMatchObject({ count: 1, items: [expect.objectContaining({ jobId: first.job.jobId })] })
    // A second live job evicts the first from memory: it is counted, not listed.
    const second = await small.coordinator.submit(person('Second live question', { globalMsgNum: 42 }))
    await until(async () => (await active(small.base)).body.items.some((row: any) => row.jobId === second.job.jobId), 'the second job')
    const { body } = await active(small.base)
    expect(body.count).toBe(2)
    expect(body.items).toHaveLength(1)
  })

  it('carries at most 50 items while count says how many there are', async () => {
    const many = await rig({ holdSession: 'many-session' })
    for (let i = 0; i < 52; i++) await many.coordinator.submit(person(`Held question ${i}`, { sessionId: 'many-session', globalMsgNum: 100 + i }))
    const { body } = await active(many.base)
    expect(body.count).toBe(52)
    expect(body.items).toHaveLength(50)
    // Oldest first.
    expect(body.items[0].title).toBe('Held question 0')
    expect(body.items.map((row: any) => row.acceptedAt)).toEqual([...body.items.map((row: any) => row.acceptedAt)].sort())
  })

  it('labels routine, task, person and other origins from the job record', () => {
    expect(activeQueryJobOrigin({ origin: { kind: 'routine', id: 'morning-brief' }, globalMsgNum: 9 })).toEqual({ origin: 'routine', originId: 'morning-brief' })
    expect(activeQueryJobOrigin({ origin: { kind: 'task', id: 'a1b2c3d4e5f6' } })).toEqual({ origin: 'task', originId: 'a1b2c3d4e5f6' })
    expect(activeQueryJobOrigin({ globalMsgNum: 12 })).toEqual({ origin: 'person' })
    expect(activeQueryJobOrigin({})).toEqual({ origin: 'other' })
  })
})

describe('activeQueryJobTitle', () => {
  it('is the first non-blank line, plain and on one line', () => {
    expect(activeQueryJobTitle('\r\n  \nHello there\nsecond')).toBe('Hello there')
    expect(activeQueryJobTitle('Tabs\tand   spaces  ')).toBe('Tabs and spaces')
    expect(activeQueryJobTitle('one two')).toBe('one')
    expect(activeQueryJobTitle('')).toBe('')
    expect(activeQueryJobTitle('\n\n')).toBe('')
  })

  it('reads only the first 1,000 characters of a prompt to find that line', () => {
    expect(activeQueryJobTitle(`${' '.repeat(990)}\nLate line`)).toBe('Late line')
    expect(activeQueryJobTitle(`${' '.repeat(1_000)}\nLate line`)).toBe('')
  })

  it('redacts credentials and local paths with the job store patterns', () => {
    const title = activeQueryJobTitle('Use Bearer abcdefghijklmnop to read /Users/miles/secret/plan.md')
    expect(title).not.toContain('abcdefghijklmnop')
    expect(title).not.toContain('/Users/miles')
    expect(title).toContain('[redacted]')
  })

  it('cuts at exactly 80 characters and leaves a short line alone', () => {
    const exact = 'x'.repeat(ACTIVE_QUERY_JOB_TITLE_MAX)
    expect(activeQueryJobTitle(exact)).toBe(exact)
    const over = 'y'.repeat(ACTIVE_QUERY_JOB_TITLE_MAX + 1)
    const cut = activeQueryJobTitle(over)
    expect(Array.from(cut)).toHaveLength(ACTIVE_QUERY_JOB_TITLE_MAX)
    expect(cut).toBe(`${'y'.repeat(ACTIVE_QUERY_JOB_TITLE_MAX - 1)}…`)
    expect(truncateActiveTitle('short')).toBe('short')
  })

  it('cuts back to a word break in the second half, and hard-cuts a long word', () => {
    expect(truncateActiveTitle('abcdefgh '.repeat(12))).toBe(`${'abcdefgh '.repeat(8).trimEnd()}\u2026`)
    expect(truncateActiveTitle(`hi ${'x'.repeat(100)}`)).toBe(`hi ${'x'.repeat(76)}\u2026`)
  })

  it('never splits an emoji', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
    const cut = truncateActiveTitle(family.repeat(100))
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.slice(0, -1).split(family).every(part => part === '')).toBe(true)
  })
})
