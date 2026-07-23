export const MANAGED_RUNTIME_CONTRACT_VERSION = 1

export interface ManagedRuntimeCapability {
  status: boolean
  restartWhisper: boolean
  restartServer: boolean
  managed: boolean
  contractVersion: number
}

export function isManagedRuntime(): boolean {
  return process.env.COS_MANAGED === '1'
}

export function managedRuntimeCapability(): ManagedRuntimeCapability {
  const managed = isManagedRuntime()
  return {
    status: managed,
    restartWhisper: managed,
    // Server restart is performed by the trusted local helper through launchd,
    // never by an HTTP endpoint. This flag tells clients that managed recovery
    // exists without widening the network attack surface.
    restartServer: managed,
    managed,
    contractVersion: MANAGED_RUNTIME_CONTRACT_VERSION,
  }
}

export function managedServerVersion(): string | null {
  const value = process.env.COS_SERVER_VERSION?.trim()
  return value || null
}
