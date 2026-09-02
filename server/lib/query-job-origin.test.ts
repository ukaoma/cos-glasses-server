import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FINGERPRINT_KEYS,
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

  it('throws on a malformed origin object only at admission, and drops it at hydration', () => {
    const malformed = [
      { kind: 'maintenance', id: 'x' },
      { kind: 'routine' },
      { kind: 'routine', id: 'Has Upper' },
      { kind: 'task', id: '' },
    ]
    for (const origin of malformed) {
      expect(() => parseQueryJobRequest({ ...minimal, origin }, { strictOrigin: true }))
        .toThrow(QueryJobValidationError)
      expect(parseQueryJobRequest({ ...minimal, origin }).origin).toBeUndefined()
    }
    try {
      parseQueryJobRequest({ ...minimal, origin: { kind: 'maintenance', id: 'x' } }, { strictOrigin: true })
    } catch (error) {
      expect((error as QueryJobValidationError).code).toBe('invalid_origin')
    }
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

  it('omits absent keys rather than materialising them (the null-pick mutation)', () => {
    // A pick written as `?? null` would make the minimal request hash differ
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

  it('rejects a malformed origin object at admission with invalid_origin', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-origin-store-'))
    const store = new QueryJobStore({ root, bootId: randomUUID() })
    await store.init()
    await expect(store.admit({ ...minimal, clientJobId: randomUUID(), origin: { kind: 'maintenance', id: 'x' } }))
      .rejects.toMatchObject({ code: 'invalid_origin' })
  })
})
