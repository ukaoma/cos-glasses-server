import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DropRouter } from './drop-router.js'
import { openDropService } from '../routes/drops.js'
import { lazyDropService } from '../routes/drops.js'
import { fakeWriters, scriptedDecisionClient } from './__fixtures__/drop-fixtures.js'
import { createDropP2Boot } from './drop-p2-boot.js'
import { createDropP2Runtime } from './drop-p2-runtime.js'
import type { DropService } from './drop-service.js'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()) })

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'drop-p2-boot-'))
  const flag = { on: false }
  let opened: DropService | null = null
  const service = lazyDropService(() => {
    opened = openDropService(part => join(root, part), { router: new DropRouter({ client: scriptedDecisionClient(), enabled: () => true }), writers: fakeWriters(), timezone: () => 'America/Chicago' })
    return opened
  })
  let made = 0
  const boot = createDropP2Boot({
    enabled: () => flag.on, service: () => flag.on ? service() : null, pingRoot: join(root, 'pings'),
    make: (stores, pingState) => { made++; return createDropP2Runtime({ ...stores, pingState, timezone: () => 'America/Chicago' }) },
  })
  cleanups.push(() => { boot.stop(); (opened as DropService | null)?.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, flag, boot, made: () => made, service }
}

describe('Drop it P2 boot', () => {
  it('off: opens nothing and writes nothing', () => {
    const r = rig()
    r.boot.start()
    expect(r.boot.runtime()).toBeNull()
    for (const dir of ['drops', 'inbox', 'pings']) expect(existsSync(join(r.root, dir))).toBe(false)
  })

  it('on: starts once on the same stores; off again: stops and releases its state', () => {
    const r = rig()
    r.flag.on = true
    const first = r.boot.check()
    expect(first).not.toBeNull()
    expect(r.boot.check()).toBe(first)
    expect(r.made()).toBe(1)
    expect(existsSync(join(r.root, 'pings'))).toBe(true)
    r.flag.on = false
    expect(r.boot.check()).toBeNull()
    expect(r.boot.runtime()).toBeNull()
    // Its writer lock was released: on again opens a fresh runtime without a lock error.
    r.flag.on = true
    expect(r.boot.check()).not.toBeNull()
    expect(r.made()).toBe(2)
  })

  it('a ping store that cannot open leaves the pings off and never throws', () => {
    const r = rig()
    r.flag.on = true
    const broken = createDropP2Boot({ enabled: () => true, service: r.service, pingRoot: join(r.root, 'pings'), make: () => { throw new Error('no') } })
    expect(broken.check()).toBeNull()
    expect(broken.runtime()).toBeNull()
    // Its ping state was closed on the way out, so a working boot can take the writer lock.
    expect(r.boot.check()).not.toBeNull()
    const throwing = createDropP2Boot({ enabled: () => { throw new Error('settings unreadable') }, service: () => null, pingRoot: join(r.root, 'pings'), make: () => { throw new Error('no') } })
    expect(throwing.check()).toBeNull()
  })
})
