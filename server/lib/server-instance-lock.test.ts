import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireServerInstanceLock,
  ServerInstanceActiveError,
  UnsafeServerLockError,
} from './server-instance-lock.js'

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'cos-lock-test-')); roots.push(value); return value }
afterEach(() => roots.splice(0).forEach(value => rmSync(value, { recursive: true, force: true })))

describe('server instance lock', () => {
  it('rejects a live owner before mutable server startup', () => {
    const lockDir = join(root(), 'server.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 123, startedAt: 'now', entrypoint: 'test' }))
    expect(() => acquireServerInstanceLock({ lockDir, pid: 456, isPidAlive: pid => pid === 123 }))
      .toThrow(ServerInstanceActiveError)
  })

  it('reclaims a dead owner and releases only its own lock', () => {
    const lockDir = join(root(), 'server.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 123, startedAt: 'old', entrypoint: 'test' }))
    const lock = acquireServerInstanceLock({ lockDir, pid: 456, now: () => Date.now() + 10_000, isPidAlive: () => false })
    expect(lock.pid).toBe(456)
    lock.release()
    const next = acquireServerInstanceLock({ lockDir, pid: 789, isPidAlive: () => false })
    next.release()
  })

  it('fails closed when the lock path is a symlink', () => {
    const base = root()
    const target = join(base, 'target')
    const lockDir = join(base, 'server.lock')
    mkdirSync(target)
    symlinkSync(target, lockDir)
    expect(() => acquireServerInstanceLock({ lockDir, isPidAlive: () => false }))
      .toThrow(UnsafeServerLockError)
  })
})
