// The meeting import routes.
//
// The run route must answer immediately: a backfill takes minutes and holds a
// maintenance lease per page, so an HTTP request that waited for it would sit
// far past COS Control's drain timeout and turn a slow vendor into a failed
// Update Server.

import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FirefliesBudget, FirefliesClient, type FirefliesTransportOutcome } from '../lib/fireflies-client.js'
import { ImportedMeetingLibrary } from '../lib/imported-meeting-library.js'
import { FirefliesImporter } from '../lib/meeting-import.js'
import { createMeetingImportRouter } from './meeting-import.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

const TRANSCRIPT = {
  id: '01KTQDNA393VRVDRF8VATAFJZR',
  title: 'Weekly planning',
  date: new Date(2026, 8, 13, 14, 30).getTime(),
  duration: 47,
  organizer_email: 'someone@example.com',
  participants: ['someone@example.com'],
  sentences: [{ speaker_name: 'Someone', speaker_id: 'a', text: 'hello', start_time: 0, end_time: 30 }],
}

async function harness(options: { mode?: 'advise' | 'imports'; key?: string | null; hold?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cos-import-route-'))
  roots.push(root)
  const now = new Date(2026, 8, 14, 9, 0, 0).getTime()
  const budget = new FirefliesBudget({ path: join(root, '.fireflies-budget.json'), now: () => now })
  const page: FirefliesTransportOutcome = {
    kind: 'http', status: 200, headers: {}, body: JSON.stringify({ data: { transcripts: [TRANSCRIPT] } }),
  }
  // A vendor that answers only when released, so "a run is in flight" is a
  // real state rather than a race with the test's own HTTP round trip.
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => { release = resolve })

  const library = new ImportedMeetingLibrary({ root: join(root, 'imports') })
  const importer = new FirefliesImporter({
    library,
    client: new FirefliesClient({
      transport: async () => {
        if (options.hold) await held
        return page
      },
      key: () => options.key ?? 'ff_key_0123456789abcdef',
      budget,
      now: () => now,
    }),
    budget,
    key: () => (options.key === null ? null : options.key ?? 'ff_key_0123456789abcdef'),
    ledgerPath: join(root, 'imports', '.fireflies-ledger.json'),
    mode: () => options.mode ?? 'imports',
    admissionsOpen: () => true,
    now: () => now,
    log: () => undefined,
  })

  const app = express()
  app.use(express.json())
  app.use('/api', createMeetingImportRouter({ importer: () => importer }))
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { base: `http://127.0.0.1:${address.port}`, importer, library, release }
}

const post = (base: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

describe('run', () => {
  it('accepts the run and answers before the work is done', async () => {
    const { base, importer, library } = await harness()
    const response = await post(base, '/api/meeting-import/fireflies/run', { windowDays: 7 })
    expect(response.status).toBe(202)
    const body = await response.json()
    expect(body.accepted).toBe(true)
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.status.state).toBe('running')

    await importer.whenIdle()
    expect(library.list()).toHaveLength(1)
  })

  it('refuses a second run while one is in flight', async () => {
    const { base, importer, release } = await harness({ hold: true })
    const first = await post(base, '/api/meeting-import/fireflies/run')
    expect(first.status).toBe(202)

    const second = await post(base, '/api/meeting-import/fireflies/run')
    expect(second.status).toBe(409)
    expect((await second.json()).error.code).toBe('import_in_progress')

    release()
    await importer.whenIdle()
  })

  it('refuses on a Mac whose pipeline owns Fireflies', async () => {
    const { base, library } = await harness({ mode: 'advise' })
    const response = await post(base, '/api/meeting-import/fireflies/run')
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('operations_pipeline_owns_fireflies')
    expect(body.error.message).not.toContain('->')
    expect(library.list()).toEqual([])
  })

  it('refuses a window it was not given, and a missing key', async () => {
    const { base } = await harness()
    const bad = await post(base, '/api/meeting-import/fireflies/run', { windowDays: 45 })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('invalid_window')

    const noKey = await harness({ key: null })
    const refused = await post(noKey.base, '/api/meeting-import/fireflies/run')
    expect(refused.status).toBe(409)
    expect((await refused.json()).error.code).toBe('fireflies_key_missing')
  })
})

describe('status', () => {
  it('reports mode, counts and budget', async () => {
    const { base, importer } = await harness()
    await post(base, '/api/meeting-import/fireflies/run')
    await importer.whenIdle()

    const status = await (await fetch(`${base}/api/meeting-import/fireflies/status`)).json()
    expect(status.mode).toBe('imports')
    expect(status.state).toBe('ok')
    expect(status.counts.imported).toBe(1)
    expect(status.budget).toMatchObject({ cap: 50 })
    expect(status.windowDays).toBe(30)
  })

  it('says refused_pipeline in advise mode', async () => {
    const { base } = await harness({ mode: 'advise' })
    const status = await (await fetch(`${base}/api/meeting-import/fireflies/status`)).json()
    expect(status).toMatchObject({ mode: 'advise', state: 'refused_pipeline' })
  })
})

describe('settings', () => {
  it('stores the plan cap and the switch', async () => {
    const { base } = await harness()
    const response = await post(base, '/api/meeting-import/fireflies/settings', { planCap: 'pro', keepImporting: false })
    expect(response.status).toBe(200)
    const status = await response.json()
    expect(status.planCap).toBe('pro')
    expect(status.keepImporting).toBe(false)
  })

  it('refuses a plan it does not know', async () => {
    const { base } = await harness()
    const response = await post(base, '/api/meeting-import/fireflies/settings', { planCap: 'enterprise' })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('invalid_plan_cap')
  })
})
