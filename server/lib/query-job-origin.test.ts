import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FINGERPRINT_EXCLUDED,
  FINGERPRINT_KEYS,
  FINGERPRINT_KEYS_COVER_REQUEST,
  QUERY_JOB_ORIGIN_ID_RE,
  QueryJobValidationError,
  originWasDropped,
  parseQueryJobRequest,
  requestFingerprint,
  type QueryJobRequest,
} from './query-job-types.js'
import { QueryJobStore } from './query-job-store.js'

const minimal = {
  clientJobId: '11111111-1111-4111-8111-111111111111',
  generation: 1,
  query: 'hello',
  sessionId: 'session-origin',
}

const full16 = {
  model: 'opus',
  effort: 'high',
  cursorExecutionMode: 'ask',
  messageEra: 'era1',
  globalMsgNum: 78,
  reference: { query: 'earlier q', response: 'earlier a' },
  handoffCode: 'ABCD',
  handoffLatest: true,
  clientQueueItemId: 'q1',
  attachmentIds: [],
  attachmentRefs: [],
  activityToolMode: 'status',
}

const full = {
  ...minimal,
  generation: 2,
  model: 'opus',
  effort: 'high',
  cursorExecutionMode: 'ask',
  messageEra: 'era1',
  globalMsgNum: 78,
  reference: { query: 'earlier q', response: 'earlier a' },
  handoffCode: 'ABCD',
  handoffLatest: true,
  clientQueueItemId: 'q1',
  attachmentIds: [],
  attachmentRefs: [],
  activityToolMode: 'status',
}

/** The fingerprint EXACTLY as every build before 6.43.4 computed it: the whole
 * parsed request, canonicalised. The pick-based fingerprint must reproduce it
 * bit for bit for any request that carries no excluded key — that is what
 * lets a journal written by 6.43.3 hydrate here and vice versa. */
function legacyFingerprint(request: QueryJobRequest): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]))
  }
  return createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex')
}

describe('origin on the durable request', () => {
  it('is absent when omitted or null, and never invented from a bare string', () => {
    expect(parseQueryJobRequest(minimal).origin).toBeUndefined()
    expect(parseQueryJobRequest({ ...minimal, origin: null }).origin).toBeUndefined()
    // The phone's local stamp shape. Dropped on BOTH paths, never a 400.
    expect(parseQueryJobRequest({ ...minimal, origin: 'g2' }).origin).toBeUndefined()
    expect(parseQueryJobRequest({ ...minimal, origin: 'g2' }, { strictOrigin: true }).origin).toBeUndefined()
  })

  it('keeps a well-formed routine or task origin', () => {
    expect(parseQueryJobRequest({ ...minimal, origin: { kind: 'routine', id: 'morning-brief' } }).origin)
      .toEqual({ kind: 'routine', id: 'morning-brief' })
    expect(parseQueryJobRequest({ ...minimal, origin: { kind: 'task', id: 'a3f19c0b2d4e' } }).origin)
      .toEqual({ kind: 'task', id: 'a3f19c0b2d4e' })
    // The id alphabet admits exactly 64 chars.
    const sixtyFour = 'a'.repeat(64)
    expect(QUERY_JOB_ORIGIN_ID_RE.test(sixtyFour)).toBe(true)
    expect(QUERY_JOB_ORIGIN_ID_RE.test(`${sixtyFour}a`)).toBe(false)
  })

  it('throws on a known kind with a bad id only at admission, and drops it at hydration', () => {
    const malformed = [
      { kind: 'routine' },
      { kind: 'routine', id: 'Has Upper' },
      { kind: 'task', id: '' },
      { kind: 'task', id: 'a'.repeat(65) },
    ]
    for (const origin of malformed) {
      expect(() => parseQueryJobRequest({ ...minimal, origin }, { strictOrigin: true }))
        .toThrow(QueryJobValidationError)
      expect(parseQueryJobRequest({ ...minimal, origin }).origin).toBeUndefined()
    }
    let code: string | undefined
    try {
      parseQueryJobRequest({ ...minimal, origin: { kind: 'routine' } }, { strictOrigin: true })
    } catch (error) {
      code = (error as QueryJobValidationError).code
    }
    expect(code).toBe('invalid_origin')
  })

  it('never throws on an unknown kind, even at admission: it is dropped and reported', () => {
    // The public job route parses with strictOrigin. A newer client's kind
    // must degrade to unlabeled, never 400 every prompt it sends.
    const raw = { ...minimal, origin: { kind: 'maintenance', id: 'x' } }
    const strict = parseQueryJobRequest(raw, { strictOrigin: true })
    expect(strict.origin).toBeUndefined()
    expect(originWasDropped(raw, strict)).toBe(true)
    expect(parseQueryJobRequest(raw).origin).toBeUndefined()
  })

  it('reports a dropped origin so the store can count it', () => {
    const kept = parseQueryJobRequest({ ...minimal, origin: { kind: 'routine', id: 'morning-brief' } })
    expect(originWasDropped({ ...minimal, origin: { kind: 'routine', id: 'morning-brief' } }, kept)).toBe(false)
    const dropped = parseQueryJobRequest({ ...minimal, origin: 'g2' })
    expect(originWasDropped({ ...minimal, origin: 'g2' }, dropped)).toBe(true)
    expect(originWasDropped(minimal, parseQueryJobRequest(minimal))).toBe(false)
    expect(originWasDropped({ ...minimal, origin: null }, parseQueryJobRequest({ ...minimal, origin: null }))).toBe(false)
  })
})

describe('the fingerprint pick', () => {
  it('names exactly the sixteen keys the request had before origin existed', () => {
    expect([...FINGERPRINT_KEYS]).toEqual([
      'clientJobId', 'generation', 'query', 'sessionId', 'model', 'effort',
      'cursorExecutionMode', 'messageEra', 'globalMsgNum', 'reference', 'handoffCode',
      'handoffLatest', 'clientQueueItemId', 'attachmentIds', 'attachmentRefs',
      'activityToolMode',
    ])
    expect(FINGERPRINT_KEYS).not.toContain('origin')
    // Every request key is in exactly one list; the type-level assertion is
    // what fails a build when a key is added without picking a side.
    expect([...FINGERPRINT_EXCLUDED]).toEqual(['origin', 'dispatch'])
    expect(FINGERPRINT_KEYS_COVER_REQUEST).toBe(true)
  })

  it('is byte-identical to the whole-request hash for a minimal (7-key) request', () => {
    const parsed = parseQueryJobRequest(minimal)
    expect(Object.keys(parsed)).toHaveLength(7)
    expect(requestFingerprint(parsed)).toBe(legacyFingerprint(parsed))
  })

  it('is byte-identical to the whole-request hash for a full (16-key) request', () => {
    const parsed = parseQueryJobRequest(full)
    expect(Object.keys(parsed)).toHaveLength(16)
    expect(requestFingerprint(parsed)).toBe(legacyFingerprint(parsed))
  })

  it('does not change when an origin is added, and survives a parser that drops it', () => {
    const plain = parseQueryJobRequest(full)
    const stamped = parseQueryJobRequest({ ...full, origin: { kind: 'routine', id: 'morning-brief' } })
    expect(stamped.origin).toBeDefined()
    expect(requestFingerprint(stamped)).toBe(requestFingerprint(plain))
    // Rollback direction: an older build's whitelist drops `origin` and hashes
    // the whole request — which is exactly the legacy hash of the plain one.
    expect(legacyFingerprint(plain)).toBe(requestFingerprint(stamped))
  })

  it('never materialises an absent optional as null (a null would change the legacy hash)', () => {
    // The parser's conditional spreads are what keep an absent key absent; a
    // pick written as `?? null` would make the minimal request hash differ
    // from its legacy hash. Prove the property directly on the minimal shape.
    const parsed = parseQueryJobRequest(minimal)
    const withNulls = { ...parsed, model: null, effort: null, reference: null } as unknown as QueryJobRequest
    expect(legacyFingerprint(withNulls)).not.toBe(legacyFingerprint(parsed))
    expect(requestFingerprint(parsed)).toBe(legacyFingerprint(parsed))
  })
})

describe('journal hydration with an origin', () => {
  let root = ''
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })

  it('hydrates a job admitted with an origin on a second boot, origin intact', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-origin-store-'))
    const first = new QueryJobStore({ root, bootId: randomUUID() })
    await first.init()
    const admitted = await first.admit({
      ...minimal,
      clientJobId: randomUUID(),
      origin: { kind: 'routine', id: 'morning-brief' },
    })
    expect(admitted.created).toBe(true)
    const second = new QueryJobStore({ root, bootId: randomUUID() })
    const health = await second.init()
    const execution = await second.getExecution(admitted.job.jobId)
    expect(execution.request.origin).toEqual({ kind: 'routine', id: 'morning-brief' })
    expect(health.fingerprintMismatches).toBe(0)
    expect(health.originDropped).toBe(0)
  })

  it('counts a bare-string origin at admission without rejecting the job', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-origin-store-'))
    const store = new QueryJobStore({ root, bootId: randomUUID() })
    await store.init()
    const admitted = await store.admit({ ...minimal, clientJobId: randomUUID(), origin: 'g2' })
    expect(admitted.created).toBe(true)
    const execution = await store.getExecution(admitted.job.jobId)
    expect(execution.request.origin).toBeUndefined()
    expect(store.getHealth().originDropped).toBe(1)
  })

  it('rejects a known kind with a bad id at admission with invalid_origin', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-origin-store-'))
    const store = new QueryJobStore({ root, bootId: randomUUID() })
    await store.init()
    await expect(store.admit({ ...minimal, clientJobId: randomUUID(), origin: { kind: 'routine', id: 'Has Upper' } }))
      .rejects.toMatchObject({ code: 'invalid_origin' })
  })

  it('admits an unknown kind, dropped and counted once per job created (not per retry)', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-origin-store-'))
    const store = new QueryJobStore({ root, bootId: randomUUID() })
    await store.init()
    const clientJobId = randomUUID()
    const first = await store.admit({ ...minimal, clientJobId, origin: { kind: 'maintenance', id: 'x' } })
    expect(first.created).toBe(true)
    // The durable-client retry: same identity, same body. Not a second drop.
    const retry = await store.admit({ ...minimal, clientJobId, origin: { kind: 'maintenance', id: 'x' } })
    expect(retry.created).toBe(false)
    expect(store.getHealth().originDropped).toBe(1)
  })

  /** The journal partition(s) under a store root, as parsed records. */
  function readJournal(storeRoot: string): Array<{ file: string; lines: Array<Record<string, unknown>> }> {
    return readdirSync(storeRoot).filter(name => name.endsWith('.jsonl')).map(file => ({
      file,
      lines: readFileSync(join(storeRoot, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>),
    }))
  }
  function rewriteAccepted(storeRoot: string, mutate: (record: Record<string, unknown>) => void): void {
    for (const { file, lines } of readJournal(storeRoot)) {
      for (const record of lines) if (record.type === 'accepted') mutate(record)
      writeFileSync(join(storeRoot, file), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    }
  }

  it('does not hydrate a record whose stored fingerprint disagrees, and counts it', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-origin-store-'))
    const first = new QueryJobStore({ root, bootId: randomUUID() })
    await first.init()
    const admitted = await first.admit({ ...minimal, clientJobId: randomUUID() })
    rewriteAccepted(root, record => { record.requestFingerprint = 'f'.repeat(64) })
    const second = new QueryJobStore({ root, bootId: randomUUID() })
    const health = await second.init()
    expect(health.fingerprintMismatches).toBe(1)
    expect(health.hydratedJobs).toBe(0)
    await expect(second.getExecution(admitted.job.jobId)).rejects.toMatchObject({ code: 'query_job_not_found' })
  })

  it('hydrates a record carrying a kind this build does not know, dropped and counted exactly once across an eviction replay', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-origin-store-'))
    const writer = new QueryJobStore({ root, bootId: randomUUID() })
    await writer.init()
    const admitted = await writer.admit({ ...minimal, clientJobId: randomUUID() })
    rewriteAccepted(root, record => {
      (record.request as Record<string, unknown>).origin = { kind: 'maintenance', id: 'x' }
    })
    // One hydrated-job slot: admitting a second job evicts the first, and the
    // next read replays its record through applyRecord a second time.
    const reader = new QueryJobStore({ root, bootId: randomUUID(), maxHydratedJobs: 1 })
    const health = await reader.init()
    expect(health.originDropped).toBe(1)
    expect(health.fingerprintMismatches).toBe(0)
    await reader.admit({ ...minimal, clientJobId: randomUUID(), sessionId: 'session-other' })
    const execution = await reader.getExecution(admitted.job.jobId)
    expect(execution.request.origin).toBeUndefined()
    expect(reader.getHealth().originDropped).toBe(1)
  })

  it('hydrates a journal actually written by 6.43.3, with matching fingerprints (the fixture, not an oracle)', async () => {
    // server/lib/__fixtures__/query-jobs-6.43.3/ was produced by the 6.43.3
    // QueryJobStore (git archive e7fc47f~1) admitting a full 16-key request and
    // a minimal one, with the clock pinned to 2099 so retention never expires
    // it. A test that hydrates real bytes cannot be repaired by editing an
    // oracle; only by keeping the fingerprint byte-compatible.
    root = mkdtempSync(join(tmpdir(), 'cos-origin-store-'))
    const fixtureDir = new URL('./__fixtures__/query-jobs-6.43.3/', import.meta.url)
    const files = readdirSync(fixtureDir).filter(name => name.endsWith('.jsonl'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) copyFileSync(new URL(file, fixtureDir), join(root, file))
    const store = new QueryJobStore({ root, bootId: randomUUID(), now: () => new Date('2099-01-01T13:00:00Z') })
    const health = await store.init()
    expect(health.hydratedJobs).toBe(2)
    expect(health.fingerprintMismatches).toBe(0)
    expect(health.originDropped).toBe(0)
    expect(health.malformedRows).toBe(0)
    const full = await store.admit({
      ...full16,
      clientJobId: '11111111-1111-4111-8111-111111111111',
      generation: 2,
      query: 'written by 6.43.3',
      sessionId: 'session-6-43-3',
    })
    // Same identity, same sixteen keys: the 6.43.3 job is returned, not conflicted.
    expect(full.created).toBe(false)
    expect(full.job.clientJobId).toBe('11111111-1111-4111-8111-111111111111')
  })
})
