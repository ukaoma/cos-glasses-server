import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

let initializedId: string | null = null

export function defaultServerInstanceIdPath(): string {
  return process.env.COS_SERVER_INSTANCE_ID_PATH
    ?? join(homedir(), '.cos-glasses', 'server-instance-id')
}

/**
 * Initialize only after every required listener binds. A failed or half-bound
 * process must not mint an identity that a client later trusts as healthy.
 */
export function initializeServerInstanceId(path = defaultServerInstanceIdPath()): string {
  if (initializedId) return initializedId

  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (UUID_RE.test(existing)) {
      chmodSync(path, 0o600)
      initializedId = existing
      return existing
    }
  } catch {
    // Missing or invalid state is replaced atomically below.
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const id = randomUUID()
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(tmp, `${id}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
  initializedId = id
  return id
}

export function getServerInstanceId(): string | null {
  return initializedId
}

export function __resetServerInstanceIdForTests(): void {
  initializedId = null
}
