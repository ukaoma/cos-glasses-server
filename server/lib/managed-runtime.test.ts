import { afterEach, describe, expect, it } from 'vitest'
import { getServerGenerationId, managedRuntimeCapability, managedServerVersion } from './managed-runtime.js'

afterEach(() => {
  delete process.env.COS_MANAGED
  delete process.env.COS_SERVER_VERSION
  delete process.env.COS_SERVER_GENERATION_ID
})

describe('managed runtime contract', () => {
  it('fails closed for the existing interactive server path', () => {
    expect(managedRuntimeCapability()).toEqual({
      status: false,
      restartWhisper: false,
      restartServer: false,
      maintenanceDrain: false,
      lifecycleProof: false,
      managed: false,
      contractVersion: 2,
    })
    expect(managedServerVersion()).toBeNull()
  })

  it('advertises local service-manager recovery without adding a restart endpoint', () => {
    process.env.COS_MANAGED = '1'
    process.env.COS_SERVER_VERSION = '6.13.0'
    expect(managedRuntimeCapability()).toEqual({
      status: true,
      restartWhisper: false,
      restartServer: true,
      maintenanceDrain: true,
      lifecycleProof: true,
      managed: true,
      contractVersion: 2,
    })
    expect(managedServerVersion()).toBe('6.13.0')
    expect(getServerGenerationId()).toBeNull()
    process.env.COS_SERVER_GENERATION_ID = 'deploy-2026-07-23'
    expect(getServerGenerationId()).toBe('deploy-2026-07-23')
  })

  it('never substitutes a package version for deployment identity', () => {
    process.env.COS_MANAGED = '1'
    process.env.COS_SERVER_VERSION = '6.13.0'
    expect(getServerGenerationId()).toBeNull()
    process.env.COS_SERVER_GENERATION_ID = '../unsafe'
    expect(getServerGenerationId()).toBeNull()
  })
})
