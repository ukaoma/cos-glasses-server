import { afterEach, describe, expect, it } from 'vitest'
import { managedRuntimeCapability, managedServerVersion } from './managed-runtime.js'

afterEach(() => {
  delete process.env.COS_MANAGED
  delete process.env.COS_SERVER_VERSION
})

describe('managed runtime contract', () => {
  it('fails closed for the existing interactive server path', () => {
    expect(managedRuntimeCapability()).toEqual({
      status: false,
      restartWhisper: false,
      restartServer: false,
      managed: false,
      contractVersion: 1,
    })
    expect(managedServerVersion()).toBeNull()
  })

  it('advertises local service-manager recovery without adding a restart endpoint', () => {
    process.env.COS_MANAGED = '1'
    process.env.COS_SERVER_VERSION = '6.13.0'
    expect(managedRuntimeCapability()).toEqual({
      status: true,
      restartWhisper: true,
      restartServer: true,
      managed: true,
      contractVersion: 1,
    })
    expect(managedServerVersion()).toBe('6.13.0')
  })
})
