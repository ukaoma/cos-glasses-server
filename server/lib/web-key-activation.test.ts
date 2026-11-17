import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebKeyActivation, canonicalPhoneDevice, parseAuthorityOn, registerWebKeyActivation, webKeyActivationHealthField } from './web-key-activation.js'
import { WebKeyRegistry } from './web-key-registry.js'
import { canonicalBytes } from './web-key-envelope.js'
import { SELF_DNS, anchoredEntry, anchorRegistrationBody, p256, seedRegistry, signB64, type TestKey } from './__fixtures__/web-key-kit.js'

let dir: string, clock: number, anchor: TestKey, registry: WebKeyRegistry, activation: WebKeyActivation
let env: NodeJS.ProcessEnv, name: string | null
const device = '100.101.102.103'
const file = () => join(dir, 'web-keys.json')
const off = vi.fn()
function reopen(): void {
  registry = new WebKeyRegistry(file(), join(dir, 'audit.jsonl'), () => clock)
  activation = new WebKeyActivation({ registry, selfDnsName: () => name, env: () => env, now: () => clock, onOff: off })
}
function challenge(): string {
  const r = activation.challenge(device)
  if (!r.ok) throw new Error(r.reason)
  return r.statement
}
function accept(statement = challenge()): string {
  expect(activation.accept(statement, signB64(anchor, Buffer.from(statement, 'base64url')))).toEqual({ ok: true })
  activation.armAtBoot()
  return statement
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'web-activation-')); clock = 1_786_000_000_000; anchor = p256()
  name = SELF_DNS; env = { COS_WEB_KEY_AUTHORITY: '1', COS_WEB_KEY_DEVICES: device }; off.mockClear()
  seedRegistry(file(), anchor, [anchoredEntry(anchor, p256())]); reopen()
})
afterEach(() => { registerWebKeyActivation(null); rmSync(dir, { recursive: true, force: true }) })

it('raw env and a mature registered anchor never activate; status leaves legacy registry bytes alone', () => {
  const before = readFileSync(file(), 'utf8')
  expect(registry.anchorMature()).toBe(true); expect(activation.enabled()).toBe(false)
  expect(activation.status()).toEqual({ activationProtocol: 'cos-web-authority-on/1', activationEpoch: 0, activationAccepted: false })
  expect(readFileSync(file(), 'utf8')).toBe(before)
})
it('fresh signed challenge binds all disclosures; acceptance only becomes effective with exact env and survives reboot after exp', () => {
  env.COS_WEB_KEY_AUTHORITY = '0'
  const s = accept(); const value = parseAuthorityOn(s)!.value
  expect(value).toMatchObject({ v: 'cos-web-authority-on/1', action: 'on', publicName: SELF_DNS, origin: `https://${SELF_DNS}:3144`, device, epoch: 0, iat: clock / 1000, exp: clock / 1000 + 120 })
  expect(value.nonce).toHaveLength(43); expect(value.aud).toBe(registry.aud(SELF_DNS)); expect(value.anchorSpkiSha256).toBe(registry.anchor()!.spkiSha256)
  expect(activation.accepted()).toBe(true); expect(activation.enabled()).toBe(false)
  env.COS_WEB_KEY_AUTHORITY = '1'; expect(activation.enabled()).toBe(false)
  reopen(); expect(activation.armAtBoot()).toBe(true)
  clock += 86400_000; reopen(); activation.armAtBoot(); expect(activation.enabled()).toBe(true)
  expect(activation.enabled('other.tail00000a.ts.net')).toBe(false)
})
it.each(['', `${device},100.64.0.2`, `${device} `, '100.64.0.2'])('exact device env rejects %s', value => {
  accept(); env.COS_WEB_KEY_DEVICES = value; expect(activation.enabled()).toBe(false)
})
it.each(['100.063.0.1', '100.128.0.1', '100.64.256.1', '100.64.0.01', '::ffff:100.64.0.1', '192.168.1.2', '100.64.0.1,100.64.0.2'])('rejects noncanonical/non-tailnet device %s', value => {
  expect(canonicalPhoneDevice(value)).toBe(false); expect(activation.challenge(value).ok).toBe(false)
})
it('accept requires a live stored challenge, not merely valid signed bytes; duplicate and replaced challenges refuse', () => {
  const s = challenge(); const sig = signB64(anchor, Buffer.from(s, 'base64url'))
  const next = challenge(); expect(next).not.toBe(s); expect(activation.accept(s, sig).ok).toBe(false)
  accept(next); expect(activation.accept(next, signB64(anchor, Buffer.from(next, 'base64url'))).ok).toBe(false)
})
it('expired and future acceptance refuse; fresh valid signature cannot fix name/anchor drift', () => {
  const s = challenge(); const sig = signB64(anchor, Buffer.from(s, 'base64url'))
  clock += 121000; expect(activation.accept(s, sig)).toMatchObject({ reason: 'activation_expired' })
  clock -= 122000; expect(activation.accept(s, sig)).toMatchObject({ reason: 'activation_expired' })
  clock += 1000; name = 'renamed.tail00000a.ts.net'; expect(activation.accept(s, sig)).toMatchObject({ reason: 'activation_context_changed' })
})
it('wrong signature and noncanonical bytes refuse, and cannot consume a valid pending challenge', () => {
  const s = challenge(); expect(activation.accept(s, signB64(p256(), Buffer.from(s, 'base64url'))).ok).toBe(false)
  const changed = Buffer.from(JSON.stringify(parseAuthorityOn(s)!.value, null, 2)).toString('base64url')
  expect(parseAuthorityOn(changed)).toBeNull(); expect(activation.accept(changed, signB64(anchor, Buffer.from(changed, 'base64url'))).ok).toBe(false)
  accept(s)
})
it.each(['anchorSpkiSha256', 'aud', 'origin', 'publicName', 'device', 'epoch', 'nonce', 'iat', 'exp', 'action', 'v'])('a signed mutation of %s cannot accept a different server challenge', key => {
  const s = challenge(); const value = { ...parseAuthorityOn(s)!.value } as Record<string, unknown>
  value[key] = typeof value[key] === 'number' ? Number(value[key]) + 1 : `${value[key]}x`
  const changed = canonicalBytes(value)!.toString('base64url')
  expect(activation.accept(changed, signB64(anchor, Buffer.from(changed, 'base64url'))).ok).toBe(false)
})
it('Off after a lost acceptance reply revokes keys, clears pending/grant and advances both epochs atomically; old signed acceptance cannot import', () => {
  const s = accept(); const sig = signB64(anchor, Buffer.from(s, 'base64url')); challenge()
  const beforeKey = registry.epoch(), beforeActivation = registry.activationEpoch()
  expect(activation.off()).toEqual({ ok: true }); expect(off).toHaveBeenCalledTimes(1)
  const raw = JSON.parse(readFileSync(file(), 'utf8'))
  expect(raw.activation).toEqual({ v: 1, epoch: beforeActivation + 1, pending: null, grant: null })
  expect(raw.epoch).toBe(beforeKey + 1); expect(raw.entries.every((e: { revokedAt?: number }) => e.revokedAt === clock)).toBe(true)
  reopen(); activation.armAtBoot(); expect(activation.enabled()).toBe(false); expect(activation.accept(s, sig).ok).toBe(false)
})
it('ordinary revokeAll preserves accepted activation; replacing anchor invalidates it', () => {
  accept(); const epoch = registry.activationEpoch(); registry.revokeAll('control')
  expect(activation.enabled()).toBe(true); expect(registry.activationEpoch()).toBe(epoch)
  expect(registry.registerAnchor(anchorRegistrationBody(p256(), clock), 'control').ok).toBe(true)
  expect(registry.activationEpoch()).toBe(epoch + 1); expect(activation.enabled()).toBe(false)
})
it('changed name, missing name or young anchor fail closed', () => {
  accept(); name = null; expect(activation.enabled()).toBe(false); name = 'other.tail00000a.ts.net'; expect(activation.enabled()).toBe(false)
  name = SELF_DNS; registry.registerAnchor(anchorRegistrationBody(anchor, clock), 'control'); expect(activation.enabled()).toBe(false)
})
it.each(['missing', 'invalid JSON', 'bad activation', 'grant without consumed challenge', 'wrong epoch', 'wrong consumed nonce', 'bad signature', 'symlink'])('persisted %s fails closed', mode => {
  accept(); const raw = JSON.parse(readFileSync(file(), 'utf8'))
  if (mode === 'missing') rmSync(file())
  else if (mode === 'invalid JSON') writeFileSync(file(), '{')
  else if (mode === 'symlink') { const target = join(dir, 'other.json'); writeFileSync(target, JSON.stringify(raw)); rmSync(file()); symlinkSync(target, file()) }
  else {
    if (mode === 'bad activation') raw.activation = { v: 1 }
    if (mode === 'grant without consumed challenge') delete raw.activation.grant.consumedNonce
    if (mode === 'wrong epoch') raw.activation.epoch++
    if (mode === 'wrong consumed nonce') raw.activation.grant.consumedNonce = 'B'.repeat(43)
    if (mode === 'bad signature') raw.activation.grant.signature = 'A'.repeat(86)
    writeFileSync(file(), JSON.stringify(raw))
  }
  reopen(); activation.armAtBoot(); expect(activation.enabled()).toBe(false)
})
it('failed durable Off closes in memory and never acknowledges success', () => {
  accept(); rmSync(dir, { recursive: true }); writeFileSync(dir, 'blocked')
  expect(activation.off()).toMatchObject({ ok: false, reason: 'registry_write_failed' }); expect(activation.enabled()).toBe(false); expect(off).toHaveBeenCalledTimes(1)
  rmSync(dir)
})

it('raw-Off boot durably invalidates a prior accepted grant but never writes an old inactive registry', () => {
  const before = readFileSync(file(), 'utf8'); env.COS_WEB_KEY_AUTHORITY = '0'; activation.reconcileOffAtBoot(); expect(readFileSync(file(), 'utf8')).toBe(before)
  const s = accept(); activation.reconcileOffAtBoot(); reopen(); env.COS_WEB_KEY_AUTHORITY = '1'
  expect(activation.enabled()).toBe(false); expect(activation.accept(s, signB64(anchor, Buffer.from(s, 'base64url'))).ok).toBe(false)
})

it('health advertises only the same effective grant and drops immediately on Off despite raw env1', () => {
  registerWebKeyActivation(activation); expect(webKeyActivationHealthField()).toEqual({})
  accept(); expect(webKeyActivationHealthField()).toEqual({ webKeySigner: 1 })
  activation.off(); expect(env.COS_WEB_KEY_AUTHORITY).toBe('1'); expect(webKeyActivationHealthField()).toEqual({})
})

it('bounded boot miss never rearms from a deferred name; new accepted grant needs a new process boot', () => {
  accept(); reopen(); name = null; expect(activation.armAtBoot()).toBe(false)
  name = SELF_DNS; expect(activation.accepted()).toBe(true); expect(activation.enabled()).toBe(false); expect(activation.armAtBoot()).toBe(false)
  reopen(); expect(activation.armAtBoot()).toBe(true)
  activation.off(); const next = challenge(); expect(activation.accept(next, signB64(anchor, Buffer.from(next, 'base64url')))).toEqual({ ok: true }); expect(activation.enabled()).toBe(false)
  reopen(); expect(activation.armAtBoot()).toBe(true)
})

it('closing planned authority surfaces cannot silently rearm when a renamed name returns', () => {
  accept(); expect(activation.enabled()).toBe(true)
  name = 'renamed.tail00000a.ts.net'; expect(activation.enabled()).toBe(false); activation.disarm()
  name = SELF_DNS; expect(activation.accepted()).toBe(true); expect(activation.enabled()).toBe(false); expect(activation.armAtBoot()).toBe(false)
})

describe('7.0.53: the bounded boot wait for the name (X1 option i)', () => {
  it('bootWaitWanted needs authority on, a grant for this device and a mature anchor, never the name', () => {
    expect(activation.bootWaitWanted()).toBe(false)   // no grant yet
    accept(); reopen(); name = null
    expect(activation.bootWaitWanted()).toBe(true)
    env = { COS_WEB_KEY_DEVICES: device }; expect(activation.bootWaitWanted()).toBe(false)
    env = { COS_WEB_KEY_AUTHORITY: '1', COS_WEB_KEY_DEVICES: '100.101.102.104' }; expect(activation.bootWaitWanted()).toBe(false)
  })
  it('no wait without a mature anchor, without an anchor, or when the registry throws (mutants W3, W4, W5)', () => {
    accept(); reopen(); name = null
    expect(activation.bootWaitWanted()).toBe(true)
    const mature = vi.spyOn(registry, 'anchorMature').mockReturnValue(false)
    expect(activation.bootWaitWanted()).toBe(false)
    mature.mockRestore()
    const none = vi.spyOn(registry, 'anchor').mockReturnValue(null)
    vi.spyOn(registry, 'anchorMature').mockReturnValue(true)
    expect(activation.bootWaitWanted()).toBe(false)
    none.mockRestore()
    vi.spyOn(registry, 'activationState').mockImplementation(() => { throw new Error('registry unreadable') })
    expect(activation.bootWaitWanted()).toBe(false)
    vi.restoreAllMocks()
  })
  it('a name that arrives inside the wait arms; one that never comes leaves it off and status says why and how long', () => {
    accept(); reopen(); name = null
    activation.noteBootWait(14_000)
    expect(activation.armAtBoot()).toBe(false)
    expect(activation.status().bootArm).toEqual({ armed: false, reason: 'tailnet_name_unknown_at_boot', waitedMs: 14_000 })
    name = SELF_DNS; expect(activation.armAtBoot()).toBe(false)   // still one-shot: a name after the window never arms
    reopen(); name = SELF_DNS; activation.noteBootWait(3_000)
    expect(activation.armAtBoot()).toBe(true)
    expect(activation.status().bootArm).toEqual({ armed: true, reason: null, waitedMs: 3_000 })
  })
  it('not configured: no wait wanted, and the reason says so', () => {
    reopen(); env = {}
    expect(activation.armAtBoot()).toBe(false)
    expect(activation.status().bootArm).toEqual({ armed: false, reason: 'not_configured', waitedMs: null })
  })
})
