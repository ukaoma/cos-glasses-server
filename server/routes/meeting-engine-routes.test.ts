// The three routes COS Control (WS6) calls.
//
// Driven through a REAL express app over a real socket, not by calling the handlers, so the
// status codes, the JSON shapes, the body parsing and the route ORDER are what is asserted.
// Route order matters here: `/meeting-actions/revert-all` is a literal that would otherwise
// be read as an action whose id is the string "revert-all".

import express from 'express'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActionRefusedError, type MeetingMergeRunner } from '../lib/meeting-actions.js'
import { createMeetingActionsRouter } from './meeting-actions.js'
import { createMeetingEngineRouter } from './meeting-engine.js'
import { createMeetingSuggestionsRouter } from './meeting-suggestions.js'

interface Calls {
  listSuggestions: Array<string | undefined>
  listActions: number[]
  accept: string[]
  confirm: string[]
  dismiss: string[]
  revert: Array<{ id: string; dryRun?: boolean; previewHash?: string }>
  revertAll: Array<{ dryRun?: boolean; previewHash?: string }>
  setMode: unknown[]
}

let calls: Calls
let refuse: ActionRefusedError | null
let servers: Array<ReturnType<express.Express['listen']>> = []

function fakeRunner(): MeetingMergeRunner {
  const reject = async <T>(value: T): Promise<T> => {
    if (refuse) throw refuse
    return value
  }
  return {
    listSuggestions: (state?: string) => { calls.listSuggestions.push(state); if (refuse) throw refuse; return [{ id: 's_1', state: state ?? 'all' }] },
    listActions: (limit: number) => { calls.listActions.push(limit); if (refuse) throw refuse; return [{ id: 'a_1' }] },
    acceptSuggestion: (id: string) => { calls.accept.push(id); return reject({ ok: true, actionId: 'a_1' }) },
    confirmSuggestion: (id: string) => { calls.confirm.push(id); return reject({ ok: true }) },
    dismissSuggestion: (id: string) => { calls.dismiss.push(id); return reject({ ok: true }) },
    revert: (id: string, options: { dryRun?: boolean; previewHash?: string }) => {
      calls.revert.push({ id, ...options })
      return reject({ ok: true, state: 'reverted' })
    },
    revertAll: (options: { dryRun?: boolean; previewHash?: string }) => {
      calls.revertAll.push(options)
      return reject({ previewHash: 'f'.repeat(64), actions: ['a_1'] })
    },
    status: () => reject({ mode: 'advise', pipelineSees: null, mismatch: false, counts: { auto: 0, suggested: 0, none: 0, reverted: 0, pending: 0, failed: 0 }, running: false }),
    setMode: (mode: unknown) => { calls.setMode.push(mode); if (refuse) throw refuse; return Promise.resolve({ mode }) },
  } as unknown as MeetingMergeRunner
}

async function base(): Promise<string> {
  const app = express()
  app.use(express.json())
  const runner = () => fakeRunner()
  app.use('/api', createMeetingSuggestionsRouter({ runner }))
  app.use('/api', createMeetingActionsRouter({ runner }))
  app.use('/api', createMeetingEngineRouter({ runner }))
  const server = await new Promise<ReturnType<typeof app.listen>>(done => {
    const listener = app.listen(0, '127.0.0.1', () => done(listener))
  })
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function post(url: string, body: unknown = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

beforeEach(() => {
  calls = { listSuggestions: [], listActions: [], accept: [], confirm: [], dismiss: [], revert: [], revertAll: [], setMode: [] }
  refuse = null
})

afterEach(async () => {
  for (const server of servers) await new Promise<void>(done => server.close(() => done()))
  servers = []
})

describe('suggestions', () => {
  it('lists, and passes the state filter through', async () => {
    const url = await base()
    const res = await fetch(`${url}/api/meeting-suggestions?state=open`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ suggestions: [{ id: 's_1', state: 'open' }] })
    expect(calls.listSuggestions).toEqual(['open'])
  })

  it('never caches a list of things waiting to be decided', async () => {
    const url = await base()
    const res = await fetch(`${url}/api/meeting-suggestions`)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('routes accept, confirm and dismiss to their own verbs', async () => {
    const url = await base()
    await post(`${url}/api/meeting-suggestions/s_abc/accept`)
    await post(`${url}/api/meeting-suggestions/s_abc/confirm`)
    await post(`${url}/api/meeting-suggestions/s_abc/dismiss`)
    expect(calls).toMatchObject({ accept: ['s_abc'], confirm: ['s_abc'], dismiss: ['s_abc'] })
  })

  it('renders a refusal as its own status and code', async () => {
    const url = await base()
    refuse = new ActionRefusedError(409, 'suggestion_stale', 'Look again.')
    const res = await post(`${url}/api/meeting-suggestions/s_abc/accept`)
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: { code: 'suggestion_stale', message: 'Look again.' } })
  })

  it('renders an unexpected failure as a 500 with a code, not a stack', async () => {
    const url = await base()
    refuse = new Error('kaboom at /Users/someone/secret/path') as ActionRefusedError
    const res = await post(`${url}/api/meeting-suggestions/s_abc/dismiss`)
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('secret')
    expect(res.body).toMatchObject({ error: { code: 'meeting_suggestion_dismiss_failed' } })
  })
})

describe('actions', () => {
  it('lists with a default limit', async () => {
    const url = await base()
    await fetch(`${url}/api/meeting-actions`)
    expect(calls.listActions).toEqual([100])
  })

  it('honours a limit and bounds it', async () => {
    const url = await base()
    await fetch(`${url}/api/meeting-actions?limit=5`)
    await fetch(`${url}/api/meeting-actions?limit=99999`)
    await fetch(`${url}/api/meeting-actions?limit=nonsense`)
    await fetch(`${url}/api/meeting-actions?limit=-3`)
    expect(calls.listActions).toEqual([5, 1000, 100, 100])
  })

  it('passes dryRun and previewHash to revert', async () => {
    const url = await base()
    await post(`${url}/api/meeting-actions/a_abc/revert`, { dryRun: true })
    await post(`${url}/api/meeting-actions/a_abc/revert`, { previewHash: 'a'.repeat(64) })
    expect(calls.revert).toEqual([
      { id: 'a_abc', dryRun: true, previewHash: undefined },
      { id: 'a_abc', dryRun: false, previewHash: 'a'.repeat(64) },
    ])
  })

  it('drops a preview hash that is not one', async () => {
    // The hash reaches a comparison, never a path, but a caller sending junk should get
    // `preview_required` rather than a mismatch it cannot explain.
    const url = await base()
    await post(`${url}/api/meeting-actions/a_abc/revert`, { previewHash: '../../etc/passwd' })
    expect(calls.revert[0].previewHash).toBeUndefined()
  })

  it('reads revert-all as the literal route, not as an action id', async () => {
    const url = await base()
    await post(`${url}/api/meeting-actions/revert-all`, { dryRun: true })
    expect(calls.revertAll).toEqual([{ dryRun: true, previewHash: undefined }])
    expect(calls.revert).toEqual([])
  })

  it('renders a revert refusal as its status and code', async () => {
    const url = await base()
    refuse = new ActionRefusedError(409, 'revert_in_progress', 'Already running.')
    const res = await post(`${url}/api/meeting-actions/a_abc/revert`, { previewHash: 'a'.repeat(64) })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: { code: 'revert_in_progress', message: 'Already running.' } })
  })
})

describe('the engine', () => {
  it('reports status and does not cache it', async () => {
    const url = await base()
    const res = await fetch(`${url}/api/meeting-engine/status`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mode: 'advise', mismatch: false })
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('passes the requested mode through', async () => {
    const url = await base()
    const res = await post(`${url}/api/meeting-engine/mode`, { mode: 'apply' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ mode: 'apply' })
    expect(calls.setMode).toEqual(['apply'])
  })

  it('renders a synchronous mode refusal as its own status', async () => {
    // `setMode` refuses synchronously (wrong Mac, bad value, work in flight) and only then
    // returns a promise. A handler that caught only one of those turns a 409 into a 500.
    const url = await base()
    refuse = new ActionRefusedError(409, 'apply_in_flight', 'A merge is still finishing.')
    const res = await post(`${url}/api/meeting-engine/mode`, { mode: 'apply' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: { code: 'apply_in_flight', message: 'A merge is still finishing.' } })
  })

  it('renders a status failure as a 500 with a code', async () => {
    const url = await base()
    refuse = new Error('unreadable') as ActionRefusedError
    const res = await fetch(`${url}/api/meeting-engine/status`)
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: { code: 'meeting_engine_status_unavailable' } })
  })

  it('passes an unknown mode through so the runner is the one that refuses it', async () => {
    // Validation lives in ONE place. A route that also validated would be a second copy to
    // keep in step with the runner's rules.
    const url = await base()
    await post(`${url}/api/meeting-engine/mode`, { mode: 'yolo' })
    expect(calls.setMode).toEqual(['yolo'])
  })
})
