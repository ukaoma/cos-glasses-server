// G-off (plan v3.1 section 3): with COS_QUEUE_RECONCILE, COS_PIN_BOOT_REAP, COS_QUEUE_RESEND and
// COS_SESSION_STEER all '0', every queue file, registry file, route body, drain and reap result
// and the provider `act` object this release touches is BYTE-IDENTICAL to 6.77.0 (aa87c9d).
//
// HOW THE GOLDEN WAS MADE. `__fixtures__/pi-durable-flags-off/scenario.ts` imports no server
// module; it receives them. The same file was run once against the aa87c9d worktree (its own
// modules and its own express, aliased in a scratch vitest project, flags '0', a fresh data
// home) and its output saved as `golden-6.77.0.json`. This test runs the identical scenario
// against this tree and compares the serialized result as one string. Any byte that differs
// fails, with the first differing key named.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const FIXTURE = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cos-flags-off-'))
  process.env.COS_DATA_DIR = join(dir, 'data')
  return { dir }
})
import express from 'express'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runFlagsOffScenario } from './__fixtures__/pi-durable-flags-off/scenario.js'
import { createThreadTurnQueueRouter, drainThread } from '../routes/thread-turn-queue.js'
import { queuePath, readQueue, writeQueue } from './thread-turn-queue-store.js'
import { createAgentSessionBindingsRouter } from '../routes/agent-session-bindings.js'
import { AgentSessionBindingRegistry } from './agent-session-binding-registry.js'
import { targetKey } from './agent-session-binding-store.js'
import { providerActs } from './provider-actions.js'

const FLAGS = ['COS_QUEUE_RECONCILE', 'COS_PIN_BOOT_REAP', 'COS_QUEUE_RESEND', 'COS_SESSION_STEER'] as const
const saved: Record<string, string | undefined> = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]))
beforeAll(() => { for (const k of FLAGS) process.env[k] = '0' })
afterAll(() => {
  for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  rmSync(FIXTURE.dir, { recursive: true, force: true })
})

describe('G-off: every P3 flag off is byte-identical to 6.77.0 (aa87c9d)', () => {
  it('queue files, registry file, route bodies, drain and reap results, act', async () => {
    const home = join(FIXTURE.dir, '.cos-glasses', 'data')
    mkdirSync(home, { recursive: true })
    const out = await runFlagsOffScenario({
      express, createThreadTurnQueueRouter, drainThread, readQueue, writeQueue, queuePath,
      createAgentSessionBindingsRouter, AgentSessionBindingRegistry, targetKey, providerActs,
      readFileSync: readFileSync as (path: string, enc: 'utf8') => string,
    }, join(home, 'agent-session-bindings.json'))
    const golden = readFileSync(new URL('./__fixtures__/pi-durable-flags-off/golden-6.77.0.json', import.meta.url), 'utf8')
    const actual = `${JSON.stringify(out, null, 2)}\n`
    if (actual !== golden) {
      const want = JSON.parse(golden) as Record<string, unknown>
      const first = Object.keys(want).find(k => JSON.stringify(want[k]) !== JSON.stringify(out[k])) ?? Object.keys(out).find(k => !(k in want))
      expect.soft(first, 'first differing key').toBeUndefined()
      if (first) expect(out[first]).toEqual(want[first])
    }
    expect(actual).toBe(golden)
    expect(Object.keys(out)).toHaveLength(Object.keys(JSON.parse(golden)).length)
  }, 30_000)
})
