// The property under test is REPLAY REJECTION ACROSS A RESTART, and almost
// everything else here exists to support it.
//
// The bug this store prevents is not visible in a single process. It needs: attach,
// queue a prompt on the phone, detach, let the binding be reaped, attach the same
// target again, and only THEN submit the queued row. If the epoch floor lives in
// memory (or is read off the current binding), the second attach mints epoch 1 again
// and the stale row matches exactly. So the tests below restart the registry from the
// real file rather than reusing an instance — an in-process-only test cannot observe
// the defect at all.
//
// FIXTURE NOTE, and it is not cosmetic. Production writes to `~/.cos-glasses/data`,
// a DOT directory. A bare `mkdtemp` root structurally cannot contain a dot component,
// and this repo has already shipped a bug that only manifests on a dot path (Express
// `sendFile` refusing every audio route on a default install while every test stayed
// green on `/var/folders/...`). Every fixture here therefore nests the store inside a
// real `.cos-glasses/data` directory so the temp path can express the production one.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AgentSessionBindingRegistry,
  parseTargetKey,
  type BindingRegistryOptions,
  type CreateBindingRequest,
  MAX_TURNS_PER_BINDING,
} from './agent-session-binding-registry.js'
import { targetKey } from './agent-session-binding-store.js'

const THREAD = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const OTHER = '019fc80a-cc79-7921-8541-298e71695afd'
const THIRD = '7f3e1a20-9b44-4c6d-8e12-0a5b6c7d8e9f'
const KEY = targetKey('claude', THREAD)
const T0 = 1_786_845_785_997
const TTL = 15 * 60 * 1000
const HOUR = 60 * 60 * 1000

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

let root = ''
let dataHome = ''
let storePath = ''
let warnings: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-binding-registry-'))
  // The production data root is a dot directory. Reproduce that shape exactly.
  dataHome = join(root, '.cos-glasses', 'data')
  mkdirSync(dataHome, { recursive: true, mode: 0o700 })
  storePath = join(dataHome, 'agent-session-bindings.json')
  warnings = []
})

afterEach(() => {
  if (dataHome && existsSync(dataHome)) {
    try { chmodSync(dataHome, 0o700) } catch { /* already writable */ }
  }
  if (storePath && existsSync(storePath)) {
    try { chmodSync(storePath, 0o600) } catch { /* already readable */ }
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

function open(options: Partial<BindingRegistryOptions> = {}): AgentSessionBindingRegistry {
  return AgentSessionBindingRegistry.open({
    filePath: storePath,
    onWarn: (message: string) => { warnings.push(message) },
    now: T0,
    ...options,
  })
}

function attachRequest(over: Partial<CreateBindingRequest> = {}): CreateBindingRequest {
  return {
    bindingId: 'bind-1',
    cosSessionId: 'cos-1',
    provider: 'claude',
    nativeThreadId: THREAD,
    workspaceFingerprint: 'wsfp',
    sourceFingerprint: 'srcfp',
    ttlMs: TTL,
    now: T0,
    ...over,
  }
}

/** Attach + activate, which is the only state that may run work. */
function attachLive(reg: AgentSessionBindingRegistry, over: Partial<CreateBindingRequest> = {}) {
  const created = reg.create(attachRequest(over))
  if (!created.binding) throw new Error(`fixture attach rejected: ${created.reason}`)
  const now = over.now ?? T0
  const live = reg.activate(created.binding.bindingId, now)
  if (!live.binding) throw new Error(`fixture activate rejected: ${live.reason}`)
  return live.binding
}

const readStore = (): Record<string, unknown> => JSON.parse(readFileSync(storePath, 'utf-8')) as Record<string, unknown>
const writeStore = (value: unknown) => writeFileSync(storePath, JSON.stringify(value), 'utf-8')

// ---------------------------------------------------------------------------

describe('the durable epoch floor is what makes a queued prompt rejectable', () => {
  it('rejects a prompt from the FIRST attach after the binding was reaped and the target re-attached', () => {
    // The whole feature in one test. A phone can hold five composed prompts that
    // carry no server state; this is the row that outlives everything.
    const first = open()
    attachLive(first)
    const stalePrompt = { bindingId: 'bind-1', epoch: 1, targetKey: KEY }
    expect(first.checkQueuedPrompt(stalePrompt, T0)).toEqual({ ok: true, reason: null })

    expect(first.detach('bind-1', T0 + 60_000).binding?.state).toBe('detached')
    // Reaped: nothing about the first attach survives in the records at all.
    expect(first.reap(T0 + 48 * HOUR).removed).toEqual(['bind-1'])
    expect(first.get('bind-1')).toBeNull()

    // A new process. Everything it knows comes from the file.
    const second = open()
    const reattached = attachLive(second, { now: T0 + 49 * HOUR })
    expect(reattached.epoch).toBe(2)

    // The queued row now names a real, active, correctly-targeted binding — and is
    // still refused, by value, because the epoch moved.
    expect(second.checkQueuedPrompt(stalePrompt, T0 + 49 * HOUR))
      .toEqual({ ok: false, reason: 'stale_epoch' })
  })

  it('never decreases the floor across repeated attach / detach / reap cycles', () => {
    let now = T0
    for (let expected = 1; expected <= 5; expected++) {
      const reg = open({ now })
      const binding = attachLive(reg, { now })
      expect(binding.epoch).toBe(expected)
      // Every earlier attach's queued row stays dead forever, not just for one cycle.
      for (let old = 1; old < expected; old++) {
        expect(reg.checkQueuedPrompt({ bindingId: 'bind-1', epoch: old, targetKey: KEY }, now).reason)
          .toBe('stale_epoch')
      }
      reg.detach('bind-1', now)
      now += 48 * HOUR
      reg.reap(now)
    }
  })

  it('keeps the floor per target, so an unrelated thread still starts at 1', () => {
    const reg = open()
    attachLive(reg)
    reg.detach('bind-1', T0)
    reg.reap(T0 + 48 * HOUR)

    const other = reg.create(attachRequest({ bindingId: 'bind-2', nativeThreadId: OTHER, now: T0 + 48 * HOUR }))
    expect(other.binding?.epoch).toBe(1)
    const same = reg.create(attachRequest({ bindingId: 'bind-3', now: T0 + 48 * HOUR }))
    expect(same.binding?.epoch).toBe(2)
  })

  it('reaping removes the lease but never the floor', () => {
    const reg = open()
    attachLive(reg)
    reg.detach('bind-1', T0)
    reg.reap(T0 + 48 * HOUR)

    const persisted = readStore()
    expect(persisted.records).toEqual([])
    expect(persisted.epochHighWater).toEqual({ [KEY]: 1 })
  })

  it('refuses to let the caller supply the epoch at all', () => {
    // The named failure mode: a caller reading priorEpoch off the current binding.
    // Ignoring it silently would look identical to honoring it, so it is refused.
    const reg = open()
    const withEpoch = { ...attachRequest(), priorEpoch: 99 } as CreateBindingRequest
    expect(reg.create(withEpoch)).toEqual({ binding: null, reason: 'caller_supplied_epoch' })
    expect(reg.get('bind-1')).toBeNull()
    expect(existsSync(storePath)).toBe(false)
  })

  it('reports the floor as null when degraded, never as 0', () => {
    writeFileSync(storePath, '{ not json', 'utf-8')
    const reg = open()
    // 0 would read as "never issued" and is exactly the value that mints epoch 1.
    expect(reg.epochFloor(KEY)).toBeNull()
  })
})

describe('hydration fails closed', () => {
  it('starts fresh only when the file is genuinely absent', () => {
    const reg = open()
    expect(reg.hydration.status).toBe('fresh')
    expect(reg.available()).toBe(true)
    expect(reg.create(attachRequest()).binding?.epoch).toBe(1)
  })

  it('distinguishes "never written" from "ran and found nothing"', () => {
    // Same visible emptiness, different meaning: a `fresh` report on a host that
    // has been attaching for weeks means the data directory moved under it.
    expect(open().hydration.status).toBe('fresh')

    const reg = open()
    attachLive(reg)
    reg.detach('bind-1', T0)
    reg.reap(T0 + 48 * HOUR)

    const reopened = open()
    expect(reopened.hydration.status).toBe('loaded')
    expect(reopened.hydration.loadedBindings).toBe(0)
    expect(reopened.hydration.epochTargets).toBe(1)
  })

  it('refuses every operation when the file is unparseable', () => {
    writeFileSync(storePath, '{"version":1,"records":[', 'utf-8')
    const reg = open()
    expect(reg.hydration.degradedReason).toBe('store_corrupt')
    expect(reg.available()).toBe(false)
    expect(reg.create(attachRequest())).toEqual({ binding: null, reason: 'store_unavailable' })
    expect(reg.checkQueuedPrompt({ bindingId: 'bind-1', epoch: 1, targetKey: KEY }, T0))
      .toEqual({ ok: false, reason: 'store_unavailable' })
    expect(reg.pin('bind-1', 'job-1', T0).reason).toBe('store_unavailable')
    expect(reg.get('bind-1')).toBeNull()
    expect(reg.list()).toEqual([])
    expect(reg.getByTarget(KEY, T0)).toBeNull()
  })

  it('leaves the bad file untouched so a reboot cannot quietly reset the floors', () => {
    // Quarantining (what loadJsonOrQuarantine does) would make the NEXT boot read
    // `fresh` and restart at epoch 1 — a boot loop straight into the replay window.
    const bad = '{"version":1,"epochHighWater":{},"records":'
    writeFileSync(storePath, bad, 'utf-8')

    const first = open()
    expect(first.create(attachRequest()).reason).toBe('store_unavailable')
    expect(readFileSync(storePath, 'utf-8')).toBe(bad)

    const second = open()
    expect(second.hydration.degradedReason).toBe('store_corrupt')
    expect(second.create(attachRequest()).reason).toBe('store_unavailable')
  })

  it.skipIf(isRoot)('treats an unreadable file as its own reason, not as missing', () => {
    // The distinction the repo's own loadJsonOrQuarantine collapses: it returns
    // {status:'missing'} on a read error, which downstream reads as "start empty".
    open().create(attachRequest())
    chmodSync(storePath, 0o000)

    const reg = open()
    expect(reg.hydration.degradedReason).toBe('store_unreadable')
    expect(reg.create(attachRequest({ bindingId: 'bind-9' })).reason).toBe('store_unavailable')
  })

  it('refuses a file written by a newer version rather than clobbering it', () => {
    writeStore({ version: 2, epochHighWater: { [KEY]: 7 }, records: [] })
    const reg = open()
    expect(reg.hydration.degradedReason).toBe('unsupported_version')
    expect(reg.create(attachRequest()).reason).toBe('store_unavailable')
    expect(readStore().epochHighWater).toEqual({ [KEY]: 7 })
  })

  it('refuses the whole ledger if any single epoch value is untrustworthy', () => {
    for (const bad of ['3', 0, -1, 1.5, null, Number.NaN]) {
      writeStore({ version: 1, epochHighWater: { [KEY]: bad }, records: [] })
      const reg = open()
      expect(reg.hydration.degradedReason).toBe('invalid_epoch_ledger')
      expect(reg.create(attachRequest()).reason).toBe('store_unavailable')
    }
  })

  it('refuses a ledger key that no real target could have produced', () => {
    const forged = [
      `claude:${THREAD}`,                    // unprefixed — the aliasable form
      `7:claude:36:${THREAD}`,               // provider length wrong
      `6:claude:35:${THREAD}`,               // id length wrong
      `6:cursor:36:${THREAD}`,               // provider is not bindable
      '6:claude:8:a4b2b4dd',                 // truncated display id
      `6:claude:36:${THREAD.toUpperCase()}`, // wrong case
    ]
    for (const key of forged) {
      writeStore({ version: 1, epochHighWater: { [key]: 3 }, records: [] })
      expect(open().hydration.degradedReason).toBe('invalid_epoch_ledger')
    }
    // The real one hydrates.
    writeStore({ version: 1, epochHighWater: { [KEY]: 3 }, records: [] })
    expect(open().hydration.status).toBe('loaded')
    expect(open().create(attachRequest()).binding?.epoch).toBe(4)
  })

  it('drops a malformed record but keeps its floor, so no replay window opens', () => {
    // A dropped record loses a lease (fails closed: every prompt naming it gets
    // unknown_binding) without lowering any epoch. That is why the ledger is stored
    // separately instead of being derived from the records.
    const reg = open()
    attachLive(reg)
    const raw = readStore()
    const records = raw.records as Array<{ binding: Record<string, unknown> }>
    records[0]!.binding.epoch = 'seven'
    writeStore(raw)

    const reopened = open()
    expect(reopened.hydration.status).toBe('loaded')
    expect(reopened.hydration.droppedRecords).toBe(1)
    expect(reopened.get('bind-1')).toBeNull()
    expect(reopened.checkQueuedPrompt({ bindingId: 'bind-1', epoch: 1, targetKey: KEY }, T0).reason)
      .toBe('unknown_binding')
    // The floor is what matters, and it survived.
    expect(reopened.create(attachRequest({ bindingId: 'bind-2' })).binding?.epoch).toBe(2)
  })

  it('folds a surviving record epoch upward when the ledger disagrees with it', () => {
    // The two are written in one commit so they should never diverge — but if they
    // ever do, only the HIGHER value is safe, and taking the ledger's word would
    // hand a re-attach an epoch a queued row already holds.
    const reg = open()
    attachLive(reg)
    const raw = readStore()
    const records = raw.records as Array<{ binding: Record<string, unknown> }>
    records[0]!.binding.epoch = 5
    raw.epochHighWater = { [KEY]: 1 }
    writeStore(raw)

    const reopened = open()
    expect(reopened.epochFloor(KEY)).toBe(5)
    reopened.detach('bind-1', T0)
    expect(reopened.create(attachRequest({ bindingId: 'bind-2' })).binding?.epoch).toBe(6)
  })

  it('drops a record whose stored target key disagrees with its own provider and thread', () => {
    // The key is derived. A stored key that names a different target would give the
    // record ownership of a thread it does not describe.
    const reg = open()
    attachLive(reg)
    const raw = readStore()
    const records = raw.records as Array<{ binding: Record<string, unknown> }>
    records[0]!.binding.targetKey = targetKey('claude', OTHER)
    writeStore(raw)

    const reopened = open()
    expect(reopened.hydration.droppedRecords).toBe(1)
    expect(reopened.getByTarget(targetKey('claude', OTHER), T0)).toBeNull()
  })

  it('degrades when two live bindings claim one target', () => {
    const reg = open()
    attachLive(reg)
    const raw = readStore()
    const records = raw.records as Array<Record<string, unknown>>
    const clone = JSON.parse(JSON.stringify(records[0])) as { binding: Record<string, unknown> }
    clone.binding.bindingId = 'bind-clone'
    records.push(clone)
    writeStore(raw)

    const reopened = open()
    expect(reopened.hydration.degradedReason).toBe('duplicate_target')
    expect(reopened.create(attachRequest({ bindingId: 'bind-3' })).reason).toBe('store_unavailable')
  })

  it('rebuilds the target index from disk, not just from this process', () => {
    const reg = open()
    attachLive(reg)
    const reopened = open()
    expect(reopened.getByTarget(KEY, T0)?.bindingId).toBe('bind-1')
    expect(reopened.create(attachRequest({ bindingId: 'bind-2' })).reason).toBe('target_busy')
  })

  it('restores pins across a restart so a running job keeps its lease', () => {
    const reg = open()
    attachLive(reg)
    expect(reg.pin('bind-1', 'job-a', T0).binding?.pinnedJobs).toEqual(['job-a'])

    const reopened = open()
    expect(reopened.get('bind-1')?.pinnedJobs).toEqual(['job-a'])
    // Still unexpirable a year later, because the pin survived.
    expect(reopened.checkQueuedPrompt({ bindingId: 'bind-1', epoch: 1, targetKey: KEY }, T0 + 365 * 24 * HOUR))
      .toEqual({ ok: true, reason: null })
  })
})

describe('a target has at most one live binding', () => {
  it('refuses a second attach while the first is active', () => {
    const reg = open()
    attachLive(reg)
    expect(reg.create(attachRequest({ bindingId: 'bind-2' }))).toEqual({ binding: null, reason: 'target_busy' })
    expect(reg.create(attachRequest({ bindingId: 'bind-2', nativeThreadId: OTHER })).binding?.epoch).toBe(1)
  })

  it('refuses a second attach while the first is DRAINING with a live job', () => {
    // `detaching` is terminal for execution but still has a job writing to the
    // native thread. Letting a second binding in here is the two-writer hazard.
    const reg = open()
    attachLive(reg)
    reg.pin('bind-1', 'job-a', T0)
    expect(reg.beginDetach('bind-1', T0).binding?.state).toBe('detaching')
    expect(reg.create(attachRequest({ bindingId: 'bind-2', now: T0 + 10 })).reason).toBe('target_busy')

    reg.unpin('bind-1', 'job-a', T0 + 20)
    expect(reg.create(attachRequest({ bindingId: 'bind-2', now: T0 + 30 })).binding?.epoch).toBe(2)
  })

  it('frees the target on detach', () => {
    const reg = open()
    attachLive(reg)
    reg.detach('bind-1', T0)
    expect(reg.getByTarget(KEY, T0)).toBeNull()
    expect(reg.create(attachRequest({ bindingId: 'bind-2' })).binding?.epoch).toBe(2)
  })

  it('does not let an expired lease block the target forever, and keeps its reason specific', () => {
    const reg = open()
    attachLive(reg)
    const later = T0 + TTL + 1
    expect(reg.create(attachRequest({ bindingId: 'bind-2', now: later })).binding?.epoch).toBe(2)
    // The dead one is still addressable, so a queued row gets `binding_expired`
    // rather than the useless `unknown_binding`.
    expect(reg.checkQueuedPrompt({ bindingId: 'bind-1', epoch: 1, targetKey: KEY }, later).reason)
      .toBe('binding_expired')
  })

  it('refuses to reuse a bindingId that is still retained', () => {
    const reg = open()
    attachLive(reg)
    reg.detach('bind-1', T0)
    expect(reg.create(attachRequest({ bindingId: 'bind-1' }))).toEqual({ binding: null, reason: 'binding_id_in_use' })
  })
})

describe('validation happens before a value can reach a key or a path', () => {
  it('rejects thread ids that SAFE_ID_RE permits and never mints a ledger entry for one', () => {
    const reg = open()
    for (const bad of ['native:something', 'a/../../etc/passwd', 'abc@host', THREAD.toUpperCase(), 'a4b2b4dd', '']) {
      expect(reg.create(attachRequest({ nativeThreadId: bad })))
        .toEqual({ binding: null, reason: 'invalid_thread_id' })
    }
    // No file at all: a rejected id must not be able to open a namespace.
    expect(existsSync(storePath)).toBe(false)
    expect(reg.list()).toEqual([])
  })

  it('validates identity BEFORE any other check can consume it', () => {
    // Ordering, not just presence. With the ledger full, a missing identity guard
    // does not fail silently — it answers `epoch_ledger_full` for an id that was
    // never legal, having already used that id to compute a target key.
    const reg = open({ maxEpochTargets: 1 })
    attachLive(reg)
    expect(reg.create(attachRequest({ bindingId: 'bind-2', nativeThreadId: 'native:evil' })).reason)
      .toBe('invalid_thread_id')
    expect(reg.create(attachRequest({ bindingId: 'bind-2', provider: 'cursor', nativeThreadId: OTHER })).reason)
      .toBe('invalid_provider')
    expect(reg.create(attachRequest({ bindingId: 'b/../c', nativeThreadId: OTHER })).reason)
      .toBe('invalid_binding_id')
  })

  it('rejects cursor, which is fork-only', () => {
    expect(open().create(attachRequest({ provider: 'cursor' })))
      .toEqual({ binding: null, reason: 'invalid_provider' })
  })

  it('rejects a bindingId shaped to collide inside a marker', () => {
    const reg = open()
    for (const bad of ['', 'a.1.6:claude:36:x', 'b/../c', 'x'.repeat(200)]) {
      expect(reg.create(attachRequest({ bindingId: bad })).reason).toBe('invalid_binding_id')
    }
  })

  it('rejects a job id before it becomes a persisted key', () => {
    const reg = open()
    attachLive(reg)
    for (const bad of ['', '../escape', 'a/b', 'x'.repeat(200), 42, null, undefined]) {
      expect(reg.pin('bind-1', bad, T0)).toEqual({ binding: null, reason: 'invalid_job_id' })
    }
    expect(reg.get('bind-1')?.pinnedJobs).toEqual([])
  })

  it('parseTargetKey is not fooled by the aliasing the length prefix exists to stop', () => {
    expect(parseTargetKey(KEY)).toEqual({ provider: 'claude', threadId: THREAD })
    // The naive `provider + ':' + id` form is ambiguous and must not parse.
    expect(parseTargetKey(`claude:${THREAD}`)).toBeNull()
    expect(parseTargetKey(`6:claude:37:${THREAD}`)).toBeNull()
    expect(parseTargetKey(null)).toBeNull()
    expect(parseTargetKey(`4:xxxx:36:${THREAD}`)).toBeNull()
  })
})

describe('pins outrank the TTL, and leaked pins do not outrank it forever', () => {
  it('never expires or reaps a binding whose pin is still live', () => {
    // Isolated from the leaked-pin bound below by a stale window wider than the
    // window under test, so this asserts only "accepted work outranks the TTL".
    const reg = open({ stalePinMs: 400 * 24 * HOUR })
    attachLive(reg)
    reg.pin('bind-1', 'job-a', T0)
    const far = T0 + 365 * 24 * HOUR
    expect(reg.reap(far)).toEqual({ removed: [], pinsDropped: 0, retained: 1 })
    expect(reg.checkQueuedPrompt({ bindingId: 'bind-1', epoch: 1, targetKey: KEY }, far))
      .toEqual({ ok: true, reason: null })
    expect(reg.getByTarget(KEY, far)?.bindingId).toBe('bind-1')
  })

  it('starts the retention clock at the RELEASE, not at the lapsed TTL', () => {
    // A job that finishes an hour after the lease expired must not have its binding
    // vanish in the same breath — the client draining a queued row a second later
    // needs `binding_expired`, not `unknown_binding`.
    const reg = open({ terminalRetentionMs: 2 * HOUR })
    attachLive(reg)
    reg.pin('bind-1', 'job-a', T0)

    const release = T0 + 10 * HOUR // long past the 15-minute TTL
    reg.unpin('bind-1', 'job-a', release)
    expect(reg.reap(release).removed).toEqual([])
    expect(reg.checkQueuedPrompt({ bindingId: 'bind-1', epoch: 1, targetKey: KEY }, release).reason)
      .toBe('binding_expired')

    expect(reg.reap(release + 3 * HOUR).removed).toEqual(['bind-1'])
  })

  it('refuses detach while pinned, through the store and not just the check', () => {
    const reg = open()
    attachLive(reg)
    reg.pin('bind-1', 'job-a', T0)
    expect(reg.detach('bind-1', T0)).toEqual({ binding: null, reason: 'binding_pinned' })
    expect(reg.get('bind-1')?.pinnedJobs).toEqual(['job-a'])
  })

  it('drops a leaked pin after its bound and gives the TTL back its authority', () => {
    // The known gap the value type names: a job that dies without unpinning makes
    // its binding immortal, and an immortal `active` binding is a TTL that stopped
    // meaning anything. Per-pin ages live in the registry envelope so it can end.
    const reg = open({ stalePinMs: 6 * HOUR, terminalRetentionMs: HOUR })
    attachLive(reg)
    reg.pin('bind-1', 'job-a', T0)

    const stillLive = T0 + 5 * HOUR
    expect(reg.reap(stillLive).pinsDropped).toBe(0)
    expect(reg.checkQueuedPrompt({ bindingId: 'bind-1', epoch: 1, targetKey: KEY }, stillLive).ok).toBe(true)

    const leaked = T0 + 7 * HOUR
    expect(reg.reap(leaked).pinsDropped).toBe(1)
    expect(reg.get('bind-1')?.pinnedJobs).toEqual([])
    // Expiry applies again, so the lease stops driving the desktop thread.
    expect(reg.checkQueuedPrompt({ bindingId: 'bind-1', epoch: 1, targetKey: KEY }, leaked).reason)
      .toBe('binding_expired')
    // And the target becomes attachable again at a HIGHER epoch.
    expect(reg.create(attachRequest({ bindingId: 'bind-2', now: leaked })).binding?.epoch).toBe(2)
  })

  it('keeps a live sibling pin when only one pin has leaked', () => {
    // Force-detaching the whole binding here would kill a lease under a running job,
    // which is worse than a late reap.
    const reg = open({ stalePinMs: 6 * HOUR })
    attachLive(reg)
    reg.pin('bind-1', 'old-job', T0)
    reg.pin('bind-1', 'new-job', T0 + 6 * HOUR)

    const now = T0 + 7 * HOUR
    expect(reg.reap(now).pinsDropped).toBe(1)
    expect(reg.get('bind-1')?.pinnedJobs).toEqual(['new-job'])
    expect(reg.checkQueuedPrompt({ bindingId: 'bind-1', epoch: 1, targetKey: KEY }, now).ok).toBe(true)
  })

  it('refuses to pin an expired or terminal binding back into non-expiry', () => {
    const reg = open()
    attachLive(reg)
    expect(reg.pin('bind-1', 'job-a', T0 + TTL + 1)).toEqual({ binding: null, reason: 'binding_expired' })
    reg.detach('bind-1', T0)
    expect(reg.pin('bind-1', 'job-a', T0)).toEqual({ binding: null, reason: 'terminal_state' })
  })

  it('answers terminal_state, not binding_expired, for a binding that is both', () => {
    // Two independent guards refuse this pin: the explicit terminal check here and
    // the pure `pin()` returning the binding unchanged. Either alone rejects, so a
    // single-guard mutation is invisible in the common case — this pins the ORDER,
    // which is the only place the two are distinguishable, and keeps them honest.
    const reg = open()
    attachLive(reg)
    reg.detach('bind-1', T0)
    expect(reg.pin('bind-1', 'job-a', T0 + TTL + 1))
      .toEqual({ binding: null, reason: 'terminal_state' })
  })

  it('is idempotent on a repeated pin and caps a leaking caller', () => {
    const reg = open({ maxPinsPerBinding: 2 })
    attachLive(reg)
    reg.pin('bind-1', 'job-a', T0)
    expect(reg.pin('bind-1', 'job-a', T0).binding?.pinnedJobs).toEqual(['job-a'])
    reg.pin('bind-1', 'job-b', T0)
    expect(reg.pin('bind-1', 'job-c', T0)).toEqual({ binding: null, reason: 'too_many_pins' })
  })

  it('rejects an unknown binding on every mutator rather than creating one', () => {
    const reg = open()
    for (const result of [
      reg.activate('ghost', T0), reg.detach('ghost', T0), reg.beginDetach('ghost', T0),
      reg.forceDetach('ghost', T0), reg.renew('ghost', TTL, T0), reg.pin('ghost', 'job-a', T0),
      reg.unpin('ghost', 'job-a', T0),
    ]) {
      expect(result).toEqual({ binding: null, reason: 'unknown_binding' })
    }
    expect(existsSync(storePath)).toBe(false)
  })
})

describe('terminal bindings are retained long enough to explain themselves', () => {
  it('answers binding_detached until retention lapses, then unknown_binding', () => {
    const reg = open({ terminalRetentionMs: 2 * HOUR })
    attachLive(reg)
    reg.detach('bind-1', T0)

    const claim = { bindingId: 'bind-1', epoch: 1, targetKey: KEY }
    expect(reg.checkQueuedPrompt(claim, T0 + HOUR).reason).toBe('binding_detached')
    expect(reg.reap(T0 + HOUR).removed).toEqual([])
    expect(reg.reap(T0 + 3 * HOUR).removed).toEqual(['bind-1'])
    expect(reg.checkQueuedPrompt(claim, T0 + 3 * HOUR).reason).toBe('unknown_binding')
  })

  it('does not rewrite the file when a reap has nothing to do', () => {
    const reg = open()
    attachLive(reg)
    const before = readFileSync(storePath, 'utf-8')
    expect(reg.reap(T0 + 60_000)).toEqual({ removed: [], pinsDropped: 0, retained: 1 })
    expect(readFileSync(storePath, 'utf-8')).toBe(before)
  })

  it('refuses to activate a lease that is already dead', () => {
    const reg = open()
    const created = reg.create(attachRequest())
    expect(created.binding?.state).toBe('staging')
    expect(reg.activate('bind-1', T0 + TTL + 1)).toEqual({ binding: null, reason: 'binding_expired' })
    expect(reg.get('bind-1')?.state).toBe('staging')
  })

  it('refuses to resurrect a detached binding through activate', () => {
    const reg = open()
    attachLive(reg)
    reg.detach('bind-1', T0)
    expect(reg.activate('bind-1', T0).reason).toBe('terminal_state')
    expect(reg.get('bind-1')?.state).toBe('detached')
  })
})

describe('concurrent mutation cannot lose a write', () => {
  it('keeps both pins when each caller holds a stale snapshot', () => {
    // The read-modify-write loss this store exists to prevent: two callers compute
    // from the same snapshot and the second overwrites the first. The API takes ids,
    // so there is no snapshot to compute from.
    const reg = open()
    const snapshot = attachLive(reg)
    expect(snapshot.pinnedJobs).toEqual([])

    reg.pin(snapshot.bindingId, 'job-a', T0)
    reg.pin(snapshot.bindingId, 'job-b', T0) // still holding the pre-pin snapshot

    expect(reg.get('bind-1')?.pinnedJobs).toEqual(['job-a', 'job-b'])
    expect(open().get('bind-1')?.pinnedJobs).toEqual(['job-a', 'job-b'])
  })

  it('hands out frozen bindings so a caller cannot mutate one behind the store', () => {
    const reg = open()
    const binding = attachLive(reg)
    expect(() => { (binding as { state: string }).state = 'detached' }).toThrow(TypeError)
    expect(() => { (binding.pinnedJobs as string[]).push('job-x') }).toThrow(TypeError)
    expect(reg.get('bind-1')?.state).toBe('active')
  })

  it('refuses a mutation re-entered from a warn handler, and still completes the outer one', () => {
    let inner: string | null = null
    const reg = AgentSessionBindingRegistry.open({
      filePath: storePath,
      stalePinMs: HOUR,
      terminalRetentionMs: 10 * HOUR,
      now: T0,
      onWarn: message => {
        warnings.push(message)
        if (inner === null && message.includes('leaked pin')) {
          inner = reg.detach('bind-1', T0).reason
        }
      },
    })
    attachLive(reg)
    reg.pin('bind-1', 'job-a', T0)

    const report = reg.reap(T0 + 2 * HOUR)
    expect(inner).toBe('reentrant_mutation')
    expect(report.pinsDropped).toBe(1)
    expect(reg.get('bind-1')?.pinnedJobs).toEqual([])
    // The refused re-entrant detach really did not happen.
    expect(reg.get('bind-1')?.state).toBe('active')
  })
})

describe('a failed write never becomes committed state', () => {
  it.skipIf(isRoot)('leaves memory and disk on the previous state when the write fails', () => {
    const reg = open()
    attachLive(reg)
    const before = readFileSync(storePath, 'utf-8')

    chmodSync(dataHome, 0o500)
    const blocked = reg.pin('bind-1', 'job-a', T0)
    chmodSync(dataHome, 0o700)

    expect(blocked).toEqual({ binding: null, reason: 'persist_failed' })
    // In memory:
    expect(reg.get('bind-1')?.pinnedJobs).toEqual([])
    // And on disk — the atomic write left the old file whole, not truncated.
    expect(readFileSync(storePath, 'utf-8')).toBe(before)
    expect(open().get('bind-1')?.pinnedJobs).toEqual([])
  })

  it.skipIf(isRoot)('does not consume an epoch when the very first attach cannot be persisted', () => {
    chmodSync(dataHome, 0o500)
    const reg = open()
    expect(reg.create(attachRequest())).toEqual({ binding: null, reason: 'persist_failed' })
    chmodSync(dataHome, 0o700)

    expect(existsSync(storePath)).toBe(false)
    expect(reg.create(attachRequest()).binding?.epoch).toBe(1)
  })
})

describe('bounded state refuses rather than evicting a floor', () => {
  it('refuses a new target once the epoch ledger is full', () => {
    // Evicting a floor is the one operation that can silently lower it. There is no
    // safe TTL either — a queued prompt can sit on a phone indefinitely.
    const reg = open({ maxEpochTargets: 1 })
    attachLive(reg)
    expect(reg.create(attachRequest({ bindingId: 'bind-2', nativeThreadId: OTHER })))
      .toEqual({ binding: null, reason: 'epoch_ledger_full' })
    // The floor it already had is untouched, and re-attaching that target still works.
    reg.detach('bind-1', T0)
    expect(reg.create(attachRequest({ bindingId: 'bind-2' })).binding?.epoch).toBe(2)
  })

  it('evicts only dead records to make room, never a live one', () => {
    const reg = open({ maxRetainedBindings: 2 })
    attachLive(reg)
    reg.detach('bind-1', T0) // dead, retained for its reason

    const second = reg.create(attachRequest({ bindingId: 'bind-2', nativeThreadId: OTHER, now: T0 + 10 }))
    expect(second.binding?.epoch).toBe(1)

    // At the cap with one live and one dead: the dead one goes.
    const third = reg.create(attachRequest({ bindingId: 'bind-3', nativeThreadId: THIRD, now: T0 + 20 }))
    expect(third.binding?.epoch).toBe(1)
    expect(reg.get('bind-1')).toBeNull()
    expect(reg.get('bind-2')?.bindingId).toBe('bind-2')
    // Eviction still did not lower the evicted target's floor.
    expect(reg.epochFloor(KEY)).toBe(1)
  })

  it('refuses a new attach when nothing is disposable', () => {
    const reg = open({ maxRetainedBindings: 1 })
    attachLive(reg)
    expect(reg.create(attachRequest({ bindingId: 'bind-2', nativeThreadId: OTHER })))
      .toEqual({ binding: null, reason: 'registry_full' })
    expect(reg.get('bind-1')?.state).toBe('active')
  })
})

describe('the store lives on a dot path in production and must work there', () => {
  it('round-trips through a .cos-glasses data directory', () => {
    expect(storePath).toContain(`${'.'}cos-glasses`)
    const reg = open()
    attachLive(reg)
    expect(existsSync(storePath)).toBe(true)
    expect(open().get('bind-1')?.nativeThreadId).toBe(THREAD)
  })

  it('creates the data directory when it does not exist yet', () => {
    const nested = join(root, '.cos-glasses', 'fresh', 'data', 'agent-session-bindings.json')
    const reg = AgentSessionBindingRegistry.open({ filePath: nested, onWarn: () => {}, now: T0 })
    expect(reg.create(attachRequest()).binding?.epoch).toBe(1)
    expect(existsSync(nested)).toBe(true)
  })
})

describe('markers and lookups delegate to the pure gate rather than re-deciding', () => {
  it('accepts its own marker and rejects it once the binding dies', () => {
    const reg = open()
    attachLive(reg)
    const marker = reg.markerFor('bind-1')!
    expect(reg.verifyBoundTo(marker, 'bind-1', T0)).toEqual({ ok: true, reason: null })
    reg.detach('bind-1', T0)
    expect(reg.verifyBoundTo(marker, 'bind-1', T0)).toEqual({ ok: false, reason: 'binding_detached' })
  })

  it('rejects a marker for a binding this registry does not hold', () => {
    const reg = open()
    attachLive(reg)
    const marker = reg.markerFor('bind-1')!
    expect(reg.verifyBoundTo(marker, 'ghost', T0)).toEqual({ ok: false, reason: 'unknown_binding' })
    expect(reg.markerFor('ghost')).toBeNull()
  })

  it('rejects a malformed queued-prompt claim instead of falling through', () => {
    const reg = open()
    attachLive(reg)
    expect(reg.checkQueuedPrompt({ bindingId: '', epoch: 1, targetKey: KEY }, T0).reason).toBe('unknown_binding')
    expect(reg.checkQueuedPrompt({ bindingId: 'bind-1', epoch: 1, targetKey: '' }, T0).reason)
      .toBe('missing_target_key')
    expect(reg.checkQueuedPrompt({ bindingId: 'bind-1', epoch: 1, targetKey: targetKey('claude', OTHER) }, T0).reason)
      .toBe('target_mismatch')
  })

  it('resolves a target by provider and thread only for a valid pair', () => {
    const reg = open()
    attachLive(reg)
    expect(reg.getByThread('claude', THREAD, T0)?.bindingId).toBe('bind-1')
    expect(reg.getByThread('claude', 'a4b2b4dd', T0)).toBeNull()
    expect(reg.getByThread('cursor', THREAD, T0)).toBeNull()
  })
})

describe('the turn ledger makes a repeated POST safe', () => {
  // COST: measured 2026-08-16 on a disposable thread. Two byte-identical POSTs both
  // returned `completed` and the user's REAL transcript ended up with two copies of
  // the turn. The client cannot distinguish "delivered but the 200 was lost" from
  // "never arrived" - a dropped connection, a backgrounded phone and a proxy timeout
  // all look identical - so retrying is correct client behaviour and the server is
  // the only side that can make it safe.
  const TURN = 'turn-0001-aaaa-bbbb'

  it('replays the first result instead of reporting nothing', () => {
    const reg = open()
    const b = attachLive(reg)
    expect(reg.findTurn(b.bindingId, TURN)).toBeNull()
    reg.recordTurn(b.bindingId, TURN, { outcome: 'completed', turnId: TURN }, T0)
    expect(reg.findTurn(b.bindingId, TURN)?.result).toEqual({ outcome: 'completed', turnId: TURN })
  })

  it('SURVIVES A RESTART, which the process-local fence did not', () => {
    // The binding record, epoch floor and pins were all durable; the one piece of
    // state whose loss writes twice into a conversation was the one that was not.
    const first = open()
    const b = attachLive(first)
    first.recordTurn(b.bindingId, TURN, { outcome: 'completed' }, T0)

    const reopened = open()
    expect(reopened.findTurn(b.bindingId, TURN)?.result).toEqual({ outcome: 'completed' })
  })

  it('keeps the FIRST result and never overwrites it', () => {
    // A repeat must see what the original turn actually did, not a later answer.
    const reg = open()
    const b = attachLive(reg)
    reg.recordTurn(b.bindingId, TURN, { outcome: 'completed' }, T0)
    reg.recordTurn(b.bindingId, TURN, { outcome: 'ambiguous' }, T0 + 1000)
    expect(reg.findTurn(b.bindingId, TURN)?.result).toEqual({ outcome: 'completed' })
  })

  it('keeps turns separate per binding and per turn id', () => {
    const reg = open()
    const a = attachLive(reg)
    const c = attachLive(reg, { bindingId: 'bind-2', nativeThreadId: OTHER })
    reg.recordTurn(a.bindingId, TURN, { which: 'a' }, T0)
    expect(reg.findTurn(c.bindingId, TURN)).toBeNull()
    expect(reg.findTurn(a.bindingId, 'turn-9999-cccc-dddd')).toBeNull()
  })

  it('refuses an unknown binding and a malformed turn id', () => {
    const reg = open()
    const b = attachLive(reg)
    expect(reg.recordTurn('no-such-binding', TURN, { x: 1 }, T0).reason).toBe('unknown_binding')
    for (const bad of ['', 'short', '../../etc', 'has space', 'x'.repeat(200)]) {
      expect(reg.recordTurn(b.bindingId, bad, { x: 1 }, T0).binding).toBeNull()
      expect(reg.findTurn(b.bindingId, bad)).toBeNull()
    }
  })

  it('bounds retention per binding, dropping oldest first', () => {
    // The newest turn is the one a client is most likely to retry, so it must be
    // the last to age out.
    const reg = open()
    const b = attachLive(reg)
    for (let i = 0; i < MAX_TURNS_PER_BINDING + 5; i++) {
      reg.recordTurn(b.bindingId, `turn-${String(i).padStart(4, '0')}-pad-pad`, { i }, T0 + i)
    }
    expect(reg.findTurn(b.bindingId, 'turn-0000-pad-pad')).toBeNull()
    const newest = `turn-${String(MAX_TURNS_PER_BINDING + 4).padStart(4, '0')}-pad-pad`
    expect(reg.findTurn(b.bindingId, newest)).not.toBeNull()
  })

  it('hydrates a store written BEFORE the ledger existed', () => {
    // Backwards compatibility in the direction that matters: an older store simply
    // has no idempotency history yet, which is correct rather than degraded.
    const seed = open()
    const b = attachLive(seed)
    const raw = readStore()
    delete raw.turns
    writeStore(raw)

    const reopened = open()
    expect(reopened.hydration.status).not.toBe('degraded')
    expect(reopened.get(b.bindingId)).not.toBeNull()
    expect(reopened.findTurn(b.bindingId, TURN)).toBeNull()
  })

  it('DROPS a malformed turn row rather than replaying it', () => {
    // A bad `result` would be handed back to a client verbatim as though it were a
    // real terminal answer.
    const seed = open()
    const b = attachLive(seed)
    seed.recordTurn(b.bindingId, TURN, { outcome: 'completed' }, T0)
    const raw = readStore()
    ;(raw.turns as Record<string, unknown>)[b.bindingId] = [
      { turnId: TURN, at: T0 },                      // no result
      { turnId: 'bad id here', result: {}, at: T0 }, // unusable id
      { turnId: 'turn-0002-aaaa-bbbb', result: { ok: true }, at: 'soon' }, // bad clock
      { turnId: 'turn-0003-aaaa-bbbb', result: { ok: true }, at: T0 },     // the good one
    ]
    writeStore(raw)

    const reopened = open()
    expect(reopened.findTurn(b.bindingId, TURN)).toBeNull()
    expect(reopened.findTurn(b.bindingId, 'turn-0002-aaaa-bbbb')).toBeNull()
    expect(reopened.findTurn(b.bindingId, 'turn-0003-aaaa-bbbb')?.result).toEqual({ ok: true })
  })

  it('drops a reaped binding’s turns with it', () => {
    const reg = open()
    const b = attachLive(reg)
    reg.recordTurn(b.bindingId, TURN, { outcome: 'completed' }, T0)
    reg.reap(T0 + 400 * 86_400_000)
    expect(reg.findTurn(b.bindingId, TURN)).toBeNull()
  })
})
