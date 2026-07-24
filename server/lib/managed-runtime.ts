export const MANAGED_RUNTIME_CONTRACT_VERSION = 2

export interface ManagedRuntimeCapability {
  status: boolean
  restartWhisper: boolean
  restartServer: boolean
  maintenanceDrain: boolean
  lifecycleProof: boolean
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
    // Whisper lifecycle is private to the local controller. It is never
    // exposed as a network-reachable mutation capability.
    restartWhisper: false,
    // Server restart is performed by the trusted local helper through launchd,
    // never by an HTTP endpoint. This flag tells clients that managed recovery
    // exists without widening the network attack surface.
    restartServer: managed,
    maintenanceDrain: managed,
    lifecycleProof: managed,
    managed,
    contractVersion: MANAGED_RUNTIME_CONTRACT_VERSION,
  }
}

export function managedServerVersion(): string | null {
  const value = process.env.COS_SERVER_VERSION?.trim()
  return value || null
}

/** Deployment generation expected by the trusted local controller. */
export function getServerGenerationId(): string | null {
  const explicit = process.env.COS_SERVER_GENERATION_ID?.trim()
  return explicit && /^[A-Za-z0-9._:-]{1,160}$/.test(explicit) ? explicit : null
}
