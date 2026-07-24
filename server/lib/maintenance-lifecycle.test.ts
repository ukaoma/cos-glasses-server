import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MaintenanceLifecycle,
  MaintenanceLifecycleError,
  type MaintenanceDrainRequest,
} from './maintenance-lifecycle.js'

const roots: string[] = []
const nonce = 'rev4_controller_nonce_0123456789abcdefABCDEF'
const nonceSha256 = createHash('sha256').update(nonce, 'utf8').digest('hex')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(initialBoot = 'boot-a', initialGeneration = 'generation-a') {
  const root = mkdtempSync(join(tmpdir(), 'cos-maintenance-'))
  roots.push(root)
  const path = join(root, 'maintenance-drain.json')
  let now = Date.parse('2026-07-23T12:00:00.000Z')
  let bootId = initialBoot
  let generationId = initialGeneration
  const options = {
    path,
    now: () => now,
    bootId: () => bootId,
    serverInstanceId: () => 'instance-a',
    generationId: () => generationId,
    managed: () => true,
  }
  return {
    path,
    options,
    setNow: (value: number) => { now = value },
    setIdentity: (boot: string, generation: string) => { bootId = boot; generationId = generation },
  }
}

function crossBootRequest(overrides: Partial<MaintenanceDrainRequest> = {}): MaintenanceDrainRequest {
  return {
    serverInstanceId: 'instance-a',
    bootId: 'boot-a',
    generationId: 'generation-a',
    operationId: 'operation-1',
    operationKind: 'server_restart',
    scope: 'cross_boot',
    postcondition: 'authorized_successor_adopted',
    nonceSha256,
    authorizedSuccessorGenerations: ['generation-b', 'generation-a'],
    ...overrides,
  }
}

const credentials = (leaseId: string, operationId = 'operation-1', rawNonce = nonce) => ({
  leaseId,
  operationId,
  nonce: rawNonce,
})

describe('maintenance lifecycle rev4 committed operations', () => {
  it('atomically closes admission and requires operation/lease/nonce source proof', () => {
    const { path, options } = fixture()
    const lifecycle = new MaintenanceLifecycle(options)
    const existing = lifecycle.acquire('durable_query', { phase: 'queued' })
    const leaseId = lifecycle.beginDrain(crossBootRequest())

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 2,
      leaseId,
      operationId: 'operation-1',
      nonceSha256,
      scope: 'cross_boot',
      expiresAt: null,
    })
    expect(() => lifecycle.acquire('legacy_query')).toThrowError(MaintenanceLifecycleError)
    expect(lifecycle.snapshot(credentials(leaseId))).toMatchObject({
      state: 'draining', activeTotal: 1, queuedTransitions: 1, safeToRestart: false,
      restartProof: {
        leaseMatches: true, operationMatches: true, nonceMatches: true, sourceIdentityMatches: true,
      },
    })

    existing.release()
    expect(lifecycle.snapshot(credentials(leaseId))).toMatchObject({ activeTotal: 0, safeToRestart: true })
    expect(lifecycle.snapshot(credentials(leaseId, 'wrong-operation'))).toMatchObject({ safeToRestart: false })
    expect(lifecycle.snapshot(credentials(leaseId, 'operation-1', `${nonce}x`))).toMatchObject({ safeToRestart: false })
  })

  it('never expiry-opens a committed gate and rejects an unauthorized successor', () => {
    const fixtureState = fixture()
    const source = new MaintenanceLifecycle(fixtureState.options)
    const leaseId = source.beginDrain(crossBootRequest())
    fixtureState.setNow(Date.parse('2036-07-23T12:00:00.000Z'))
    fixtureState.setIdentity('boot-unauthorized', 'generation-unknown')

    const candidate = new MaintenanceLifecycle(fixtureState.options)
    expect(candidate.snapshot(credentials(leaseId))).toMatchObject({
      state: 'draining', admissionsOpen: false, safeToRestart: false,
      operation: { carriedAcrossBoot: true, expiresAt: null },
    })
    expect(() => candidate.acquire('openai_query')).toThrowError(/committed maintenance/i)
    expect(() => candidate.adoptDrain({
      serverInstanceId: 'instance-a', bootId: 'boot-unauthorized', generationId: 'generation-unknown', operationId: 'operation-1',
    }, credentials(leaseId))).toThrowError(/not an authorized successor/i)
  })

  it('requires candidate adoption and exact current identity before release', () => {
    const fixtureState = fixture()
    const source = new MaintenanceLifecycle(fixtureState.options)
    const leaseId = source.beginDrain(crossBootRequest())
    fixtureState.setIdentity('boot-b', 'generation-b')
    const candidate = new MaintenanceLifecycle(fixtureState.options)
    const candidateIdentity = {
      serverInstanceId: 'instance-a', bootId: 'boot-b', generationId: 'generation-b', operationId: 'operation-1',
    }

    expect(() => candidate.adoptDrain(candidateIdentity, credentials(leaseId, 'wrong-operation'))).toThrowError(/credentials/i)
    expect(() => candidate.adoptDrain(candidateIdentity, credentials('wrong-lease'))).toThrowError(/credentials/i)
    expect(() => candidate.adoptDrain(
      candidateIdentity,
      credentials(leaseId, 'operation-1', 'wrong_nonce_that_is_long_enough_1234567890'),
    )).toThrowError(/credentials/i)
    expect(() => candidate.releaseDrain(candidateIdentity, credentials(leaseId))).toThrowError(/postcondition/i)
    candidate.adoptDrain(candidateIdentity, credentials(leaseId))
    expect(candidate.snapshot(credentials(leaseId))).toMatchObject({
      admissionsOpen: false,
      operation: {
        nonceSha256,
        adoptedSuccessor: { bootId: 'boot-b', generationId: 'generation-b' },
      },
      restartProof: { candidateAdopted: true, candidateIdentityMatches: true },
    })
    expect(() => candidate.releaseDrain(candidateIdentity, credentials(leaseId, 'wrong-operation'))).toThrowError(/credentials/i)
    expect(() => candidate.releaseDrain(candidateIdentity, credentials('wrong-lease'))).toThrowError(/credentials/i)
    expect(() => candidate.releaseDrain(
      candidateIdentity,
      credentials(leaseId, 'operation-1', 'wrong_nonce_that_is_long_enough_1234567890'),
    )).toThrowError(/credentials/i)
    candidate.releaseDrain(candidateIdentity, credentials(leaseId))
    expect(candidate.snapshot()).toMatchObject({ state: 'accepting', admissionsOpen: true })
  })

  it('permits a pre-authorized rollback boot to replace a failed candidate adoption', () => {
    const fixtureState = fixture()
    const source = new MaintenanceLifecycle(fixtureState.options)
    const leaseId = source.beginDrain(crossBootRequest({ operationKind: 'server_rollback' }))
    fixtureState.setIdentity('boot-new', 'generation-b')
    const failedCandidate = new MaintenanceLifecycle(fixtureState.options)
    failedCandidate.adoptDrain({
      serverInstanceId: 'instance-a', bootId: 'boot-new', generationId: 'generation-b', operationId: 'operation-1',
    }, credentials(leaseId))

    fixtureState.setIdentity('boot-rollback', 'generation-a')
    const rollback = new MaintenanceLifecycle(fixtureState.options)
    rollback.adoptDrain({
      serverInstanceId: 'instance-a', bootId: 'boot-rollback', generationId: 'generation-a', operationId: 'operation-1',
    }, credentials(leaseId))
    expect(rollback.snapshot(credentials(leaseId)).operation?.adoptedSuccessor).toMatchObject({
      bootId: 'boot-rollback', generationId: 'generation-a',
    })
    rollback.releaseDrain({
      serverInstanceId: 'instance-a', bootId: 'boot-rollback', generationId: 'generation-a', operationId: 'operation-1',
    }, credentials(leaseId))
    expect(rollback.snapshot().admissionsOpen).toBe(true)
  })

  it('keeps a committed stop closed until the next Start adopts and releases it', () => {
    const fixtureState = fixture()
    const source = new MaintenanceLifecycle(fixtureState.options)
    const operationId = 'stop-operation'
    const leaseId = source.beginDrain(crossBootRequest({
      operationId,
      operationKind: 'server_stop',
      authorizedSuccessorGenerations: ['generation-a'],
    }))
    expect(source.snapshot(credentials(leaseId, operationId))).toMatchObject({ safeToRestart: true })

    fixtureState.setIdentity('boot-after-start', 'generation-a')
    const started = new MaintenanceLifecycle(fixtureState.options)
    expect(started.snapshot(credentials(leaseId, operationId))).toMatchObject({
      state: 'draining', admissionsOpen: false,
      operation: { operationKind: 'server_stop', carriedAcrossBoot: true, adoptedSuccessor: null },
    })

    const startedIdentity = {
      serverInstanceId: 'instance-a',
      bootId: 'boot-after-start',
      generationId: 'generation-a',
      operationId,
    }
    started.adoptDrain(startedIdentity, credentials(leaseId, operationId))
    expect(started.snapshot(credentials(leaseId, operationId))).toMatchObject({
      admissionsOpen: false,
      operation: { adoptedSuccessor: { bootId: 'boot-after-start', generationId: 'generation-a' } },
    })
    started.releaseDrain(startedIdentity, credentials(leaseId, operationId))
    expect(started.snapshot()).toMatchObject({ state: 'accepting', admissionsOpen: true })
  })

  it('expiry-opens an ordinary lease only on its original boot', () => {
    const sourceState = fixture()
    const source = new MaintenanceLifecycle(sourceState.options)
    source.beginDrain(crossBootRequest({
      operationId: 'same-boot-op',
      operationKind: 'same_boot_maintenance',
      scope: 'same_boot',
      postcondition: 'same_boot_idle',
      authorizedSuccessorGenerations: ['generation-a'],
      ttlMs: 30_000,
    }))
    sourceState.setNow(Date.parse('2026-07-23T12:00:31.000Z'))
    expect(source.snapshot()).toMatchObject({ state: 'accepting', admissionsOpen: true })

    const rebootState = fixture()
    new MaintenanceLifecycle(rebootState.options).beginDrain(crossBootRequest({
      operationId: 'orphaned-same-boot',
      operationKind: 'same_boot_maintenance',
      scope: 'same_boot',
      postcondition: 'same_boot_idle',
      authorizedSuccessorGenerations: ['generation-a'],
      ttlMs: 30_000,
    }))
    rebootState.setIdentity('boot-b', 'generation-a')
    rebootState.setNow(Date.parse('2026-07-23T12:00:31.000Z'))
    expect(new MaintenanceLifecycle(rebootState.options).snapshot()).toMatchObject({
      state: 'draining', admissionsOpen: false, operation: { carriedAcrossBoot: true },
    })
  })

  it('decodes corrupt, legacy, invalid, and unknown schemas into typed fail-closed states', () => {
    for (const [name, value, expected] of [
      ['corrupt', '{not-json', 'blocked_corrupt_json'],
      ['legacy', JSON.stringify({ version: 1, expiresAt: '2000-01-01T00:00:00.000Z' }), 'blocked_legacy_v1'],
      ['invalid', JSON.stringify({ version: 2, operationId: 'incomplete' }), 'blocked_invalid_schema'],
      ['unknown', JSON.stringify({ version: 99 }), 'blocked_unknown_schema'],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `cos-maintenance-${name}-`))
      roots.push(root)
      const path = join(root, 'maintenance-drain.json')
      writeFileSync(path, value, { mode: 0o600 })
      const lifecycle = new MaintenanceLifecycle({
        path,
        bootId: () => 'boot-a',
        serverInstanceId: () => 'instance-a',
        generationId: () => 'generation-a',
        managed: () => true,
      })
      expect(lifecycle.snapshot()).toMatchObject({ state: expected, admissionsOpen: false })
      expect(() => lifecycle.acquire('one_shot_transcription')).toThrowError(/committed maintenance/i)
    }
  })
})
