import express from 'express'
import { readFileSync, readdirSync } from 'node:fs'
import type { Server } from 'node:http'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  readThreadAttachCapability,
  threadAttachCapability,
  threadAttachHealthFields,
} from './thread-attach-capability.js'
import { healthRouter } from '../routes/health.js'

// Every assertion here is written as the question a CLIENT asks, because the
// failure this surface exists to prevent is a client offering Continue when it
// should offer Fork. Asserting "providers came back empty" would pin the bug as
// correct if empty ever came to mean permissive; asserting "may I continue
// Claude" cannot.
function mayContinue(payload: unknown, provider: string): boolean {
  const capability = readThreadAttachCapability(payload)
  return capability.enabled && (capability.providers as readonly string[]).includes(provider)
}

/**
 * A real /api/health body from a server built BEFORE these fields existed.
 *
 * Trimmed from the live payload rather than invented: an empty object would make
 * this test pass for the wrong reason, since the property that matters is that a
 * genuinely populated, entirely valid response still yields off on all three.
 */
const OLDER_HEALTH_PAYLOAD = {
  status: 'ok',
  mode: 'cos',
  server: 'ok',
  server_version: '6.27.4',
  uptime_seconds: 4210,
  features: {
    claude: true,
    codex: true,
    cursor: true,
    whisper: true,
    durableQueryJobs: true,
    liveCues: false,
  },
  readiness: { status: 'ready', admissions: 'open', whisper: 'ready' },
  capabilities: {
    cliDebug: { schemaVersion: 1, providers: { claude: true, codex: true, cursor: true } },
    recovery: { managed: true, contractVersion: 2 },
  },
} as const

const ENV_KEY = 'COS_THREAD_ATTACH_ENABLED'
const priorEnv = process.env[ENV_KEY]

function setGateEnv(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = value
}

afterEach(() => setGateEnv(priorEnv))

describe('what the server publishes', () => {
  it('offers nothing continuable while the gate is off', () => {
    const capability = threadAttachCapability(() => false)
    const payload = threadAttachHealthFields(capability)

    // The point of emptying `providers` rather than listing what this build COULD
    // drive: a client that never reads `enabled` is still correct.
    expect(mayContinue(payload, 'claude')).toBe(false)
    expect(mayContinue(payload, 'codex')).toBe(false)
    expect(payload.threadAttachProviders).toEqual([])
    expect(payload.threadAttachEnabled).toBe(false)
  })

  it('offers Claude and Codex once the gate is on', () => {
    const payload = threadAttachHealthFields(threadAttachCapability(() => true))

    expect(mayContinue(payload, 'claude')).toBe(true)
    expect(mayContinue(payload, 'codex')).toBe(true)
  })

  it('never offers Cursor as continuable, gate on or off', () => {
    // Plan 2.5: Cursor is Fork-only. A Continue offered for it would have no code
    // path behind it — `isBindableProvider` rejects it at the attach route.
    for (const gate of [() => true, () => false]) {
      expect(mayContinue(threadAttachHealthFields(threadAttachCapability(gate)), 'cursor')).toBe(false)
    }
  })

  it('stays distinguishable from a server that has never heard of Continue', () => {
    // Both are "no Continue right now". Only `supported` tells an operator whether
    // there is a setting to flip, which is the entire reason the field exists.
    const disabled = threadAttachHealthFields(threadAttachCapability(() => false))
    expect(readThreadAttachCapability(disabled).supported).toBe(true)
    expect(readThreadAttachCapability(OLDER_HEALTH_PAYLOAD).supported).toBe(false)
  })

  it('treats a gate that throws as off rather than propagating', () => {
    const payload = threadAttachHealthFields(threadAttachCapability(() => {
      throw new Error('gate exploded')
    }))
    expect(mayContinue(payload, 'claude')).toBe(false)
  })

  it('treats a truthy non-boolean gate answer as off', () => {
    const payload = threadAttachHealthFields(
      threadAttachCapability((() => 1) as unknown as () => boolean),
    )
    expect(mayContinue(payload, 'claude')).toBe(false)
  })
})

describe('the default gate is the one that registers the write routes', () => {
  // Without this, every test above could pass against a default of `() => true`
  // and the published field would have no relationship to the env var at all.
  it('is off for every value except exactly "1"', () => {
    for (const value of [undefined, '', '0', 'true', 'TRUE', 'yes', ' 1', '1 ']) {
      setGateEnv(value)
      expect(threadAttachCapability().enabled).toBe(false)
    }
  })

  it('is on for exactly "1"', () => {
    setGateEnv('1')
    expect(mayContinue(threadAttachHealthFields(threadAttachCapability()), 'claude')).toBe(true)
  })
})

describe('reading a payload from any server', () => {
  it('reads an older server, which omits all three fields, as OFF', () => {
    // THE rule. An older server cannot be changed, so absence has to resolve to
    // off on the reading side or not at all.
    expect(mayContinue(OLDER_HEALTH_PAYLOAD, 'claude')).toBe(false)
    expect(mayContinue(OLDER_HEALTH_PAYLOAD, 'codex')).toBe(false)
    expect(readThreadAttachCapability(OLDER_HEALTH_PAYLOAD)).toEqual({
      supported: false,
      enabled: false,
      providers: [],
      forkSupported: false,
    })
  })

  it('reads enabled without supported as OFF', () => {
    // Self-contradictory: nothing that knows about Continue omits `supported`.
    expect(mayContinue({ threadAttachEnabled: true, threadAttachProviders: ['claude'] }, 'claude')).toBe(false)
  })

  it('reads supported without enabled as OFF', () => {
    expect(mayContinue({ threadAttachSupported: true, threadAttachProviders: ['claude'] }, 'claude')).toBe(false)
  })

  it('drops providers advertised alongside a disabled gate', () => {
    expect(readThreadAttachCapability({
      threadAttachSupported: true,
      threadAttachEnabled: false,
      threadAttachProviders: ['claude', 'codex'],
    }).providers).toEqual([])
  })

  it('requires a boolean enabled, not a truthy stand-in', () => {
    for (const value of ['true', 1, 'yes', {}, []]) {
      expect(mayContinue({
        threadAttachSupported: true,
        threadAttachEnabled: value,
        threadAttachProviders: ['claude'],
      }, 'claude')).toBe(false)
    }
  })

  it('requires a boolean supported, not a truthy stand-in', () => {
    // Added because the mutation pass proved nothing reached this guard: a proxy
    // or a hand-rolled payload stringifying `true` would otherwise be read as a
    // server that knows what Continue is, and `enabled` hangs off `supported`.
    for (const value of ['true', 1, 'yes', {}, []]) {
      const capability = readThreadAttachCapability({
        threadAttachSupported: value,
        threadAttachEnabled: true,
        threadAttachProviders: ['claude'],
      })
      expect(capability.supported).toBe(false)
      expect(capability.enabled).toBe(false)
      expect(capability.providers).toEqual([])
    }
  })

  it('ignores a provider this build has no code path for', () => {
    const capability = readThreadAttachCapability({
      threadAttachSupported: true,
      threadAttachEnabled: true,
      threadAttachProviders: ['claude', 'cursor', 'gemini', 42, null, { provider: 'codex' }],
    })
    // A newer server naming a fourth provider must not make an older client offer
    // a Continue it cannot perform.
    expect(capability.providers).toEqual(['claude'])
  })

  it('does not repeat a provider a payload lists twice', () => {
    expect(readThreadAttachCapability({
      threadAttachSupported: true,
      threadAttachEnabled: true,
      threadAttachProviders: ['claude', 'claude', 'codex'],
    }).providers).toEqual(['claude', 'codex'])
  })

  it('reads a non-array providers field as none', () => {
    for (const raw of ['claude', null, 42, { claude: true }]) {
      expect(mayContinue({
        threadAttachSupported: true,
        threadAttachEnabled: true,
        threadAttachProviders: raw,
      }, 'claude')).toBe(false)
    }
  })

  it('reads a payload that is not an object as OFF', () => {
    for (const payload of [null, undefined, 'ok', 42, true]) {
      expect(readThreadAttachCapability(payload)).toEqual({
        supported: false,
        enabled: false,
        providers: [],
        forkSupported: false,
      })
    }
  })

  it('reads an array carrying the fields as OFF', () => {
    // The reader takes `unknown` from any caller, not only from JSON.parse, so an
    // array with properties hung off it is reachable. A list is not a health body.
    const arrayPayload: unknown[] & Record<string, unknown> = [] as never
    arrayPayload.threadAttachSupported = true
    arrayPayload.threadAttachEnabled = true
    arrayPayload.threadAttachProviders = ['claude']
    expect(mayContinue(arrayPayload, 'claude')).toBe(false)
  })
})

describe('the live /api/health and /api/models surfaces', () => {
  let server: Server | null = null
  let base = ''

  beforeAll(async () => {
    const app = express()
    app.use('/api', healthRouter)
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server!.address()
    base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  })

  it('answers a real client asking whether to show Continue', async () => {
    setGateEnv(undefined)
    const off = await (await fetch(`${base}/api/health`)).json()
    // Read through the same reader a client uses: this is the end-to-end claim,
    // not that three keys happen to be present.
    expect(mayContinue(off, 'claude')).toBe(false)
    expect(readThreadAttachCapability(off).supported).toBe(true)

    setGateEnv('1')
    const on = await (await fetch(`${base}/api/health`)).json()
    expect(mayContinue(on, 'claude')).toBe(true)
    expect(mayContinue(on, 'codex')).toBe(true)
    expect(mayContinue(on, 'cursor')).toBe(false)
  }, 30_000)

  it('publishes the same answer on the surface the companion actually polls', async () => {
    // Main.ts:14176 states outright that /api/health alone is not used for the
    // companion's liveness poll — it reads /api/models. liveCues already paid for
    // this lesson; a capability on one surface only is invisible to the phone.
    setGateEnv('1')
    const health = await (await fetch(`${base}/api/health`)).json()
    const models = await (await fetch(`${base}/api/models`)).json()
    expect(readThreadAttachCapability(models)).toEqual(readThreadAttachCapability(health))
    expect(mayContinue(models, 'claude')).toBe(true)
  }, 30_000)

  it('leaves the existing health contract intact', async () => {
    // Other clients depend on these. Adding fields must not move them.
    const body = await (await fetch(`${base}/api/health`)).json() as any
    expect(body.status).toBe('ok')
    expect(body.features?.g2LensVariant).toBe('png-288x144-v1')
    expect(typeof body.cli_session_available).toBe('boolean')
    expect(body).not.toHaveProperty('cli_session_id')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// The composition root feeds the same answer to the detector (6.33.0)
// ---------------------------------------------------------------------------
//
// THESE TWO ARE SHAPE ASSERTIONS, AND THEY SAY SO. `server/index.ts` cannot be
// imported by a test — it binds ports, spawns whisper and starts timers — so
// what they can pin is the wiring text, not its execution. The behaviour of
// `buildOccupancyProbes` is executed for real in occupancy-probes.test.ts; this
// closes the one seam those tests cannot reach, which is whether the root hands
// it the right answer.
//
// The seam is worth pinning because it is exactly what failed in the field:
// `enabled` came back true off `COS_THREAD_ATTACH_ENABLED` while the detector's
// transcript clock hung off a second key nobody had set, so this capability
// surface advertised a Continue the gate then refused on every thread. One flag
// now decides both halves, and re-splitting them would have to edit this line.

describe('the detector reads the same gate the routes do', () => {
  const serverRoot = resolve(process.cwd(), 'server')

  /**
   * The retired second key, assembled rather than written out.
   *
   * The scan below reads every server source file, and this file is one of
   * them, so a literal here would match itself and the test could never pass.
   * Joining the parts keeps the scan whole-tree with no path exemption, which
   * matters: an exemption is where a re-added key would eventually hide.
   */
  const RETIRED_KEY = ['COS', 'THREAD', 'ATTACH', 'IDLE', 'HOLDER'].join('_')

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'data') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) sourceFiles(full, out)
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.cjs')) out.push(full)
    }
    return out
  }

  it('builds the occupancy probes from threadAttachEnabled()', () => {
    const index = readFileSync(join(serverRoot, 'index.ts'), 'utf8')
    expect(index).toContain(
      'buildOccupancyProbes(cosSpawnedPids, nativeHeadDeps, threadAttachEnabled())',
    )
  })

  it('leaves no second gate key anywhere in the server', () => {
    // Removed, not deprecated-but-honoured, so there is exactly one answer to
    // "is Continue on". An install that still exports the old key in its plist
    // is simply ignored.
    const scanned = sourceFiles(serverRoot)
    // Guard against the scan silently covering nothing, which would make this
    // pass for the wrong reason.
    expect(scanned.length).toBeGreaterThan(100)
    const offenders = scanned.filter(file => readFileSync(file, 'utf8').includes(RETIRED_KEY))
    expect(offenders).toEqual([])
  })
})
