// Key lanes K1, package P6 (plan v4 5.2): the sites that REJECT a key profile. A brief, a task
// dispatch and Work never run on a key in K1. With lanes off each site answers a profile exactly
// as 6.79.0 does (its own generic refusal); with lanes enabled it says why.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p6-rejects-'))
const dataDir = join(scratch, 'data')
mkdirSync(dataDir, { recursive: true })
process.env.HOME = scratch
process.env.COS_DATA_DIR = dataDir
process.env.COS_PROFILE_PATH = join(dataDir, 'profile.json')
delete process.env.COS_KEY_LANES

const lanes = await import('./key-lanes.js')
const brief = await import('./morning-brief-config.js')
const { taskDispatchModel } = await import('./task-store.js')
const { parseHandoffRequest } = await import('./work-handoff-requests.js')
const work = await import('./work-activity.js')

const PROFILE = 'profile:sonnet55'
const fail = (fn: () => unknown): { code?: string; status?: number; message?: string } => {
  try { fn(); return {} } catch (e) { return e as never }
}

beforeEach(() => {
  delete process.env.COS_KEY_LANES
  lanes.refreshKeyLanesEnabled()
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

describe('morning brief (morning-brief-config.ts :412 patch, :449 coerce)', () => {
  const base = () => brief.defaultMorningBriefConfig(new Date('2026-10-19T12:00:00Z'))

  it('lanes off: a profile is the 6.79.0 "Unknown model preference." refusal', () => {
    const e = fail(() => brief.applyMorningBriefPatch(base(), { model: PROFILE }))
    expect([e.code, e.message]).toEqual(['invalid_model', 'Unknown model preference.'])
  })

  it('lanes on: a profile is refused with the scheduled-brief line; a model slot still saves', () => {
    process.env.COS_KEY_LANES = '1'
    const e = fail(() => brief.applyMorningBriefPatch(base(), { model: PROFILE }))
    expect([e.code, e.message]).toEqual(['key_profile_not_allowed', 'Key profiles cannot run scheduled briefs.'])
    expect(brief.applyMorningBriefPatch(base(), { model: 'haiku' }).model).toBe('haiku')
    // Junk that is not a profile keeps its generic refusal.
    expect(fail(() => brief.applyMorningBriefPatch(base(), { model: 'gpt-9' })).code).toBe('invalid_model')
  })

  it('a profile on disk is dropped at load (never a keyed brief), lanes on or off', () => {
    for (const sw of [undefined, '1']) {
      if (sw) process.env.COS_KEY_LANES = sw
      const config = brief.coerceMorningBriefConfig({ ...base(), model: PROFILE })
      expect(config).not.toHaveProperty('model')
    }
  })
})

describe('task dispatch (task-store.ts :196 taskDispatchModel)', () => {
  it('a forged profile model dispatches on the subscription default, never the key', () => {
    const forged = { ...brief.defaultMorningBriefConfig(), model: PROFILE as never }
    expect(taskDispatchModel(forged)).toBe('sonnet')
    expect(taskDispatchModel({ ...forged, model: 'opus' })).toBe('opus')
  })
})

describe('Work handoff requests (work-handoff-requests.ts :138)', () => {
  const uuid = '00000001-0000-4000-8000-000000000000'
  const body = (model: unknown) => ({ clientRequestId: uuid, domain: 'business', workIdentity: 'a'.repeat(12),
    expectedTaskRevision: 'b'.repeat(64), intent: 'start', mode: 'newSession', destinationSource: 'user', model })

  it('lanes off: a profile is the 6.79.0 "Choose a model slot" refusal', () => {
    const e = fail(() => parseHandoffRequest(body(PROFILE), 'sonnet'))
    expect([e.code, e.status, e.message]).toEqual(['invalid_handoff_request', 400, 'Choose a model slot this server knows.'])
  })

  it('lanes on: a profile is refused with the Work line; a model slot still parses', () => {
    process.env.COS_KEY_LANES = '1'
    const e = fail(() => parseHandoffRequest(body(PROFILE), 'sonnet'))
    expect([e.code, e.status, e.message]).toEqual(['key_profile_not_allowed', 400, 'Key sessions are not in Work yet.'])
    expect(parseHandoffRequest(body('codex-frontier'), 'sonnet').input.model).toBe('codex-frontier')
  })
})

describe('Work drafts (work-activity.ts :364 draftDestination)', () => {
  it('a draft naming a profile has no saved destination (Control never sends it as one)', () => {
    const identity = 'a'.repeat(12)
    const row = { id: identity, domain: 'business', title: 'Board title', text: 'Board text', workIdentity: identity, meetingRefs: [] }
    const draft = (modelID: string) => ({ sourceID: `task:business:${identity}`, sourceRevision: work.controlSnapshotRevision(row),
      mode: 'newSession', sessionID: '', provider: 'claude', modelID, prompt: 'draft prompt', editVersion: 1 })
    const journal = (modelID: string) => ({ available: true as const, receipts: [], drafts: [draft(modelID)] })
    expect(work.savedDestinationFor(journal('opus'), row)).toEqual({ mode: 'newSession', provider: 'claude', model: 'opus' })
    process.env.COS_KEY_LANES = '1'
    expect(work.savedDestinationFor(journal(PROFILE), row)).toBeUndefined()
  })
})
