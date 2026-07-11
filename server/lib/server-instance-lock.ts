import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

interface LockOwner { pid: number; startedAt: string; entrypoint: string }

export interface ServerInstanceLockOptions {
  lockDir?: string
  pid?: number
  now?: () => number
  isPidAlive?: (pid: number) => boolean
}

export interface ServerInstanceLock { lockDir: string; pid: number; release: () => void }

export class ServerInstanceActiveError extends Error {
  readonly ownerPid: number | null
  constructor(lockDir: string, ownerPid: number | null) {
    super(ownerPid
      ? `COS Glasses server is already running as PID ${ownerPid} (${lockDir}).`
      : `COS Glasses server startup is already in progress (${lockDir}).`)
    this.name = 'ServerInstanceActiveError'
    this.ownerPid = ownerPid
  }
}

export class UnsafeServerLockError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsafeServerLockError' }
}

const OWNER_FILE = 'owner.json'
const RECLAIM_DIR = '.reclaim'
const INCOMPLETE_GRACE_MS = 5_000
const STALE_RECLAIM_MS = 30_000

function defaultLockDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return join(tmpdir(), `cos-glasses-server-${uid}.lock`)
}

function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error: any) {
    if (error?.code === 'EPERM') return true
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(lockDir, OWNER_FILE), 'utf8')) as Partial<LockOwner>
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) return null
    return { pid: Number(value.pid), startedAt: String(value.startedAt ?? ''), entrypoint: String(value.entrypoint ?? '') }
  } catch { return null }
}

function claimStaleLock(lockDir: string, now: number): boolean {
  const reclaimDir = join(lockDir, RECLAIM_DIR)
  try { mkdirSync(reclaimDir, { mode: 0o700 }); return true } catch (error: any) {
    if (error?.code === 'ENOENT') return false
    if (error?.code !== 'EEXIST') throw error
    try {
      if (now - statSync(reclaimDir).mtimeMs > STALE_RECLAIM_MS) {
        rmSync(reclaimDir, { recursive: true, force: true })
        mkdirSync(reclaimDir, { mode: 0o700 })
        return true
      }
    } catch (retryError: any) {
      if (retryError?.code === 'ENOENT') return false
      throw retryError
    }
    return false
  }
}

export function acquireServerInstanceLock(options: ServerInstanceLockOptions = {}): ServerInstanceLock {
  const lockDir = options.lockDir ?? process.env.COS_SERVER_LOCK_DIR ?? defaultLockDir()
  const pid = options.pid ?? process.pid
  const now = options.now ?? Date.now
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive

  for (let attempt = 0; attempt < 5; attempt++) {
    try { mkdirSync(lockDir, { mode: 0o700 }) } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      const lockStat = lstatSync(lockDir)
      if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
        throw new UnsafeServerLockError(`Refusing unsafe COS server lock path: ${lockDir}`)
      }
      const owner = readOwner(lockDir)
      if (owner && isPidAlive(owner.pid)) throw new ServerInstanceActiveError(lockDir, owner.pid)
      if (!owner && now() - lockStat.mtimeMs <= INCOMPLETE_GRACE_MS) {
        throw new ServerInstanceActiveError(lockDir, null)
      }
      if (!claimStaleLock(lockDir, now())) continue
      const currentOwner = readOwner(lockDir)
      if (currentOwner && isPidAlive(currentOwner.pid)) {
        rmSync(join(lockDir, RECLAIM_DIR), { recursive: true, force: true })
        throw new ServerInstanceActiveError(lockDir, currentOwner.pid)
      }
      rmSync(lockDir, { recursive: true, force: true })
      continue
    }

    const owner: LockOwner = {
      pid,
      startedAt: new Date(now()).toISOString(),
      entrypoint: process.env.COS_ENTRYPOINT ?? 'server/index.ts',
    }
    writeFileSync(join(lockDir, OWNER_FILE), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    let released = false
    return {
      lockDir,
      pid,
      release: () => {
        if (released) return
        released = true
        if (readOwner(lockDir)?.pid === pid) rmSync(lockDir, { recursive: true, force: true })
      },
    }
  }
  throw new ServerInstanceActiveError(lockDir, readOwner(lockDir)?.pid ?? null)
}
