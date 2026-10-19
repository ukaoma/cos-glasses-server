// Key lanes K1, P11: a durable job a key profile answered keeps `lane`, `credential`, `profile`
// and `usd` on its record, through a restart, so the app's recovery path shows the cost. A
// subscription job's journal rows and snapshot carry none of them: byte for byte as before.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { QueryJobStore } from './query-job-store.js'
import { keyAnswerCompletionFields, keyAnswerJobFields } from './key-answer-fields.js'

const roots: string[] = []
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }) })
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kl-p11-jobs-'))
  roots.push(root)
  return root
}
const request = () => ({ clientJobId: randomUUID(), generation: 1, query: 'q', sessionId: 'session-p11', activityToolMode: 'preview' })
const CREDENTIAL = { kind: 'openrouter' as const, ref: 'key_0123456789ab', profileId: 'gpt-key' }
const KEY_FIELDS = ['lane', 'credential', 'profile', 'usd']

async function completeJob(root: string, extra: Record<string, unknown>) {
  const now = new Date('2026-10-19T16:00:00.000Z')
  const store = new QueryJobStore({ root, bootId: 'boot-a', now: () => new Date(now) })
  await store.init()
  const admitted = await store.admit(request())
  await store.markStarting(admitted.job.jobId)
  await store.markRunning(admitted.job.jobId, { provider: 'codex', resolvedModel: 'profile:gpt-key' })
  await store.complete(admitted.job.jobId, { text: 'answer', provider: 'codex', ...extra })
  return { jobId: admitted.job.jobId, store, now }
}

describe('durable job records of keyed answers (P11)', () => {
  it('a keyed completion keeps lane, credential, profile and usd, and a restart replays them', async () => {
    const root = await tempRoot()
    const { jobId, now } = await completeJob(root, { lane: 'key', credential: CREDENTIAL, profile: 'gpt-key', usd: 0.0123 })
    const restarted = new QueryJobStore({ root, bootId: 'boot-b', now: () => new Date(now) })
    await restarted.init()
    const snap = await restarted.getSnapshot(jobId)
    expect(snap).toMatchObject({ status: 'completed', lane: 'key', credential: CREDENTIAL, profile: 'gpt-key', usd: 0.0123 })
  })

  it('a subscription completion writes none of them: no key appears in the journal or the snapshot', async () => {
    const root = await tempRoot()
    const { jobId, store } = await completeJob(root, {})
    const snap = await store.getSnapshot(jobId)
    for (const k of KEY_FIELDS) expect(snap, k).not.toHaveProperty(k)
    const journal = (await Promise.all((await readdir(root)).filter(n => n.endsWith('.jsonl')).map(n => readFile(join(root, n), 'utf8')))).join('')
    for (const k of KEY_FIELDS) expect(journal.includes(`"${k}"`), k).toBe(false)
  })

  it('malformed key fields are dropped whole, never half kept', async () => {
    const root = await tempRoot()
    const { jobId, store } = await completeJob(root, { lane: 'key', credential: { ...CREDENTIAL, ref: 'sk-or-v1-not-a-ref' }, profile: 'gpt-key', usd: 1 })
    const snap = await store.getSnapshot(jobId)
    for (const k of KEY_FIELDS) expect(snap, k).not.toHaveProperty(k)
  })
})

describe('keyAnswerJobFields / keyAnswerCompletionFields', () => {
  it('{} for a subscription run; flattened with usd for a keyed one; profile must match the credential', () => {
    expect(keyAnswerCompletionFields(undefined)).toEqual({})
    expect(keyAnswerCompletionFields({})).toEqual({})
    expect(keyAnswerCompletionFields({ keyLane: { lane: 'key', credential: CREDENTIAL }, usd: 0.5 })).toEqual({ lane: 'key', credential: CREDENTIAL, profile: 'gpt-key', usd: 0.5 })
    expect(keyAnswerCompletionFields({ keyLane: { lane: 'direct', credential: CREDENTIAL } })).toEqual({ lane: 'direct', credential: CREDENTIAL, profile: 'gpt-key' })
    expect(keyAnswerJobFields({ lane: 'key', credential: CREDENTIAL, profile: 'other' })).toEqual({})
    expect(keyAnswerJobFields({ lane: 'subscription', credential: CREDENTIAL, profile: 'gpt-key' })).toEqual({})
    expect(keyAnswerJobFields({ lane: 'key', credential: CREDENTIAL, profile: 'gpt-key', usd: -1 })).toEqual({ lane: 'key', credential: CREDENTIAL, profile: 'gpt-key' })
  })
})
