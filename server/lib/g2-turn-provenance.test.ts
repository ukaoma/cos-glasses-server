import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeG2Turn,
  footerApplies,
  g2TurnFooter,
  G2TurnLedger,
  G2TurnProvenance,
  isOwnAddress,
  normalizeTurnText,
  stripG2TurnFooter,
  turnTextSha256,
  TURN_CARRY_TTL_MS,
  QUEUED_ORIGIN_TTL_MS,
  WEB_UNVOUCHED_REASON,
  attachmentsDigest,
  sealMatches,
  type OriginVerdict,
  type OriginRequest,
  type OwnAddressView,
} from './g2-turn-provenance.js'
import { pairedInstanceFrom } from '../routes/client-instance.js'
import { turnAttachmentManifest, type TurnAttachmentStore } from './session-turn-attachments.js'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { ClientInstanceOwner } from './client-instance-claim.js'

const PHONE = '100.81.195.27'
const MAC_TS = '100.108.149.114'
const INSTANCE = 'muytwk3t-lafw'
const NOW = 1_790_000_000_000

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function tmp(): string {
  const r = mkdtempSync(join(tmpdir(), 'g2-turn-'))
  roots.push(r)
  return r
}

const VIEW: OwnAddressView = {
  addresses: new Set(['127.0.0.1', '::1', '192.168.1.204', MAC_TS, '192.168.64.1']),
  // 192.168.64.0/24, the bridge100 subnet measured on this Mac.
  bridgeSubnets: [[((192 << 24) >>> 0) + (168 << 16) + (64 << 8), 0xffffff00]],
}

function provenance(over: Partial<ConstructorParameters<typeof G2TurnProvenance>[0]> = {}) {
  let now = NOW
  let token = 0
  const p = new G2TurnProvenance({
    ledger: new G2TurnLedger(join(tmp(), 'g2-turn-ledger.jsonl')),
    pairedInstance: device => (device === PHONE ? INSTANCE : null),
    ownAddresses: () => VIEW,
    now: () => now,
    randomToken: () => `tok${++token}`,
    ...over,
  })
  return { p, advance: (ms: number) => { now += ms } }
}

function req(remote: string | undefined, headers: Record<string, string> = {}): OriginRequest {
  return { socket: remote === undefined ? null : { remoteAddress: remote }, headers }
}
const G2_HEADERS = { 'x-cos-client-instance': INSTANCE, 'x-cos-client': 'glasses' }

describe('normalization and hashing', () => {
  it('trims and collapses ASCII whitespace runs to one space', () => {
    expect(normalizeTurnText('  hello \n\t  world \r\n')).toBe('hello world')
    expect(turnTextSha256('  hello \n\t world  ')).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
  })
  it('leaves non-ASCII whitespace alone, so the Python verifier hashes the same bytes', () => {
    // JS `\s` would collapse U+00A0 and U+FEFF; Python `\s` disagrees on U+FEFF. Spelled out instead.
    expect(normalizeTurnText('a b﻿c')).toBe('a b﻿c')
  })
})

describe('the footer', () => {
  it('is one trailing line, stripped back to the words it vouches for', () => {
    const { p } = provenance()
    const verdict = p.originOf(req(PHONE, G2_HEADERS))
    const sent = p.footed('keep going on the parser\n\n', 'ct-g2-00000001', verdict)
    expect(sent).toBe(`keep going on the parser\n${g2TurnFooter('ct-g2-00000001')}`)
    expect(sent.split('\n')).toHaveLength(2)
    const back = stripG2TurnFooter(sent)
    expect(back.turnId).toBe('ct-g2-00000001')
    expect(turnTextSha256(back.text)).toBe(turnTextSha256('keep going on the parser'))
  })
  it('is added only for a VOUCHED turn the app says came from the glasses or the phone', () => {
    const { p } = provenance()
    for (const [remote, headers, applies] of [
      [PHONE, G2_HEADERS, true],
      [PHONE, { ...G2_HEADERS, 'x-cos-client': 'phone' }, true],
      [PHONE, { 'x-cos-client-instance': INSTANCE }, false],
      [PHONE, { ...G2_HEADERS, 'x-cos-client': 'desk' }, false],
      // QA 6.99.29 5b: an unverified glasses turn (not the ring owner's address) carries no footer.
      ['100.90.1.2', G2_HEADERS, false],
      [PHONE, { ...G2_HEADERS, 'x-cos-client-instance': 'abcdefgh-zzzz' }, false],
    ] as const) {
      const verdict = p.originOf(req(remote, headers))
      expect(footerApplies(verdict), JSON.stringify(headers)).toBe(applies)
      expect(p.footed('x y', 'ct-g2-00000002', verdict) === 'x y', JSON.stringify(headers)).toBe(!applies)
    }
  })
  it('never foots a web turn, even one whose verdict claims it is vouched', () => {
    const web: OriginVerdict = { origin: { remote: PHONE, loopback: false, ownAddress: false, clientInstance: null, client: 'web', tokenPresented: false, webSession: true }, verifiedOrigin: true }
    expect(footerApplies(web)).toBe(false)
    expect(provenance().p.footed('x y', 'ct-web-00000001', web)).toBe('x y')
  })
  it('never foots a local turn, whatever it says it is', () => {
    const { p } = provenance()
    const verdict = p.originOf(req('127.0.0.1', G2_HEADERS))
    expect(verdict.origin.client).toBe('local')
    expect(p.footed('x y', 'ct-g2-00000003', verdict)).toBe('x y')
  })
  it('is not added under an id the verifier could not parse', () => {
    const { p } = provenance()
    expect(p.footed('x', 'bad id', p.originOf(req(PHONE, G2_HEADERS)))).toBe('x')
  })
})

describe('what a request can prove about its origin', () => {
  it('verifies only a non-local address naming the ring owner for that address', () => {
    const { p } = provenance()
    expect(p.originOf(req(PHONE, G2_HEADERS))).toEqual({
      origin: { remote: PHONE, loopback: false, ownAddress: false, clientInstance: INSTANCE, client: 'glasses', tokenPresented: false, webSession: false },
      verifiedOrigin: true,
      reason: null,
      judgedAt: NOW,
    })
    expect(p.originOf(req(`::ffff:${PHONE}`, G2_HEADERS)).verifiedOrigin).toBe(true)
  })
  it.each([
    ['IPv4 loopback', '127.0.0.1'],
    ['mapped loopback', '::ffff:127.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['127/8', '127.5.6.7'],
  ])('refuses %s', (_label, remote) => {
    const { p } = provenance({ pairedInstance: () => INSTANCE })
    const v = p.originOf(req(remote, G2_HEADERS))
    expect(v.origin.loopback).toBe(true)
    expect(v.origin.client).toBe('local')
    expect(v.verifiedOrigin).toBe(false)
  })
  it.each([
    ['the LAN address', '192.168.1.204'],
    ['the Tailscale address', MAC_TS],
    ['a container on the VM bridge', '192.168.64.2'],
    ['IPv4 link-local', '169.254.10.20'],
    ['IPv6 link-local', 'fe80::1c2b:3aff:fe00:1%bridge100'],
  ])("refuses this Mac's own address: %s", (_label, remote) => {
    const { p } = provenance({ pairedInstance: () => INSTANCE })
    const v = p.originOf(req(remote, G2_HEADERS))
    expect(v.origin.ownAddress).toBe(true)
    expect(v.origin.client).toBe('local')
    expect(v.verifiedOrigin).toBe(false)
  })
  it('fails closed when the interface list cannot be read', () => {
    const { p } = provenance({ ownAddresses: () => { throw new Error('EPERM') } })
    const v = p.originOf(req(PHONE, G2_HEADERS))
    expect(v.origin.ownAddress).toBe(true)
    expect(v.verifiedOrigin).toBe(false)
  })
  it('refuses an unknown, wrong, malformed or absent instance', () => {
    const { p } = provenance()
    expect(p.originOf(req(PHONE, { ...G2_HEADERS, 'x-cos-client-instance': 'abcdefgh-zzzz' })).verifiedOrigin).toBe(false)
    const malformed = p.originOf(req(PHONE, { ...G2_HEADERS, 'x-cos-client-instance': 'NOT VALID' }))
    expect(malformed.origin.clientInstance).toBeNull()
    expect(malformed.verifiedOrigin).toBe(false)
    expect(p.originOf(req(PHONE, { 'x-cos-client': 'glasses' })).verifiedOrigin).toBe(false)
    // Another device's owner does not vouch for this one.
    expect(p.originOf(req('100.90.1.2', G2_HEADERS)).verifiedOrigin).toBe(false)
  })
  it('refuses when the referee throws, or has no owner for the address', () => {
    expect(provenance({ pairedInstance: () => { throw new Error('x') } }).p.originOf(req(PHONE, G2_HEADERS)).verifiedOrigin).toBe(false)
    expect(provenance({ pairedInstance: () => null }).p.originOf(req(PHONE, G2_HEADERS)).verifiedOrigin).toBe(false)
  })
  it('says unknown, and verifies nothing, without a socket address', () => {
    const v = provenance({ pairedInstance: () => INSTANCE }).p.originOf(req(undefined, G2_HEADERS))
    expect(v.origin).toMatchObject({ remote: 'unknown', client: 'unknown' })
    expect(v.verifiedOrigin).toBe(false)
  })
  it('never reads X-Forwarded-For', () => {
    const v = provenance().p.originOf(req('127.0.0.1', { ...G2_HEADERS, 'x-forwarded-for': PHONE }))
    expect(v.origin.remote).toBe('127.0.0.1')
    expect(v.verifiedOrigin).toBe(false)
  })
  it('names why a verdict is not vouched', () => {
    const { p } = provenance()
    expect(p.originOf(req('127.0.0.1', G2_HEADERS)).reason).toBe('local_socket')
    expect(p.originOf(req(MAC_TS, G2_HEADERS)).reason).toBe('local_socket')
    expect(p.originOf(req(undefined, G2_HEADERS)).reason).toBe('unknown_socket')
    expect(p.originOf(req(PHONE, { 'x-cos-client': 'glasses' })).reason).toBe('no_client_instance')
    expect(p.originOf(req('100.90.1.2', G2_HEADERS)).reason).toBe('not_ring_owner')
  })
  it('a full web cookie path from another device is labelled web, recorded, and NEVER vouched', () => {
    const { p } = provenance({ webSession: () => true })
    const v = p.originOf(req(PHONE, {}))
    expect(v).toMatchObject({ verifiedOrigin: false, reason: WEB_UNVOUCHED_REASON, origin: { client: 'web', webSession: true, tokenPresented: false } })
    // A G2 instance header on a cookie request does not make it a G2 turn.
    expect(p.originOf(req(PHONE, G2_HEADERS))).toMatchObject({ verifiedOrigin: false, origin: { client: 'web' } })
    const rec = p.record({ turnId: 'ct-web-00000002', prompt: 'x', verdict: v, provider: 'claude', sessionId: 's', via: 'live' })
    expect(rec).toMatchObject({ originKind: 'web', verifiedOrigin: false, reason: WEB_UNVOUCHED_REASON })
    // The G2 rule is untouched when a token is shown: the web check is not even asked.
    expect(p.originOf(req(PHONE, { ...G2_HEADERS, 'x-cos-token': 't' }))).toMatchObject({ verifiedOrigin: true, origin: { client: 'glasses', webSession: false } })
  })
  it('labels the client by its own word, which never verifies on its own', () => {
    const { p } = provenance({ pairedInstance: () => null })
    expect(p.originOf(req(PHONE, { 'x-cos-client': 'phone' })).origin.client).toBe('phone')
    expect(p.originOf(req(PHONE, {})).origin.client).toBe('unknown')
    expect(p.originOf(req(PHONE, { 'x-cos-client': 'phone' })).verifiedOrigin).toBe(false)
  })
})

describe('isOwnAddress', () => {
  it('matches exact addresses, bridge subnets and link-local only', () => {
    expect(isOwnAddress('192.168.64.200', VIEW)).toBe(true)
    expect(isOwnAddress('192.168.65.2', VIEW)).toBe(false)
    expect(isOwnAddress('192.168.1.50', VIEW)).toBe(false)
    expect(isOwnAddress(PHONE, VIEW)).toBe(false)
  })
})

describe('pairedInstanceFrom (the referee, shared)', () => {
  const owner = (seenAt: number): ClientInstanceOwner => ({ id: INSTANCE, bootAt: 1, version: '6.10.617', recording: false, seenAt })
  it('answers the owner of the device only while it claimed within the window', () => {
    const owners = new Map([[PHONE, owner(NOW - 1_000)]])
    expect(pairedInstanceFrom(owners, PHONE, NOW, 60_000)).toBe(INSTANCE)
    expect(pairedInstanceFrom(owners, `::ffff:${PHONE}`, NOW, 60_000)).toBe(INSTANCE)
    expect(pairedInstanceFrom(owners, PHONE, NOW + 60_000, 60_000)).toBeNull()
    expect(pairedInstanceFrom(owners, '100.90.1.2', NOW, 60_000)).toBeNull()
  })
})

describe('the ledger', () => {
  it('appends one JSON line per record and finds it sealed', async () => {
    const { p } = provenance()
    const verdict = p.originOf(req(PHONE, G2_HEADERS))
    const rec = p.record({ turnId: 'ct-g2-00000010', prompt: ' hello  world ', verdict, provider: 'claude', sessionId: 'sid-1', via: 'live' })
    expect(rec).toMatchObject({ textSha256: turnTextSha256('hello world'), verifiedOrigin: true, target: { provider: 'claude', sessionId: 'sid-1' }, via: 'live' })
    const found = await p.ledger.find('ct-g2-00000010')
    expect(found?.sealed).toBe(true)
    const answer = await describeG2Turn(p, 'ct-g2-00000010', NOW + 5_000)
    expect(answer).toMatchObject({ found: true, ageMs: 5_000, verifiedOrigin: true, sealed: true })
  })

  it('rotates at the size limit and still finds older records on disk', async () => {
    const dir = tmp()
    const file = join(dir, 'g2-turn-ledger.jsonl')
    const ledger = new G2TurnLedger(file, { rotateBytes: 200 })
    const p = new G2TurnProvenance({ ledger, pairedInstance: () => null, ownAddresses: () => VIEW, now: () => NOW })
    const verdict = p.originOf(req('127.0.0.1'))
    for (let i = 0; i < 6; i += 1) p.record({ turnId: `ct-rot-0000000${i}`, prompt: 'x', verdict, provider: 'claude', sessionId: 's', via: 'spawn' })
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(readFileSync(file, 'utf8').trim().split('\n').every(l => JSON.parse(l).turnId)).toBe(true)
    const reread = new G2TurnLedger(file)
    expect((await reread.find('ct-rot-00000004'))?.sealed).toBe(false)
  })

  it('never vouches for a record it did not write: a forged line, or one from before a restart', async () => {
    const dir = tmp()
    const file = join(dir, 'g2-turn-ledger.jsonl')
    appendFileSync(file, `${JSON.stringify({
      turnId: 'ct-forged-0001', createdAt: new Date(NOW).toISOString(), textSha256: turnTextSha256('rm -rf'),
      origin: { remote: PHONE, loopback: false, ownAddress: false, clientInstance: INSTANCE, client: 'glasses' },
      verifiedOrigin: true, target: { provider: 'claude', sessionId: 's' }, via: 'live',
    })}\n{torn`)
    const p = new G2TurnProvenance({ ledger: new G2TurnLedger(file), pairedInstance: () => INSTANCE, ownAddresses: () => VIEW, now: () => NOW })
    const answer = await describeG2Turn(p, 'ct-forged-0001', NOW)
    expect(answer).toMatchObject({ found: true, sealed: false, verifiedOrigin: false })
    expect(await describeG2Turn(p, 'ct-nothing-0001', NOW)).toBeNull()
  })

  it('keeps a record sealed in memory when the disk write fails', async () => {
    const p = new G2TurnProvenance({ ledger: new G2TurnLedger('/nonexistent-dir/x/g2.jsonl'), pairedInstance: () => INSTANCE, ownAddresses: () => VIEW, now: () => NOW })
    p.record({ turnId: 'ct-mem-00000001', prompt: 'x', verdict: p.originOf(req(PHONE, G2_HEADERS)), provider: 'claude', sessionId: 's', via: 'live' })
    expect(await describeG2Turn(p, 'ct-mem-00000001', NOW)).toMatchObject({ verifiedOrigin: true, sealed: true })
  })
})

describe('a queued turn carries its origin across the loopback hop', () => {
  const turn = { provider: 'claude', threadId: 'sid-1', clientTurnId: 'ct-q-00000001', prompt: 'say it later' }
  it('issues a single-use token for every drain; it carries the parked origin only while the words are unchanged', () => {
    const { p } = provenance()
    // Nothing parked: still a token (the drain's own continuation), carrying no origin.
    const bare = p.issueCarry(turn)
    expect(bare).toBe('tok1')
    expect(p.takeCarry(bare, turn.clientTurnId, turn.prompt)).toEqual({ verdict: null, seal: null })
    const verdict = p.originOf(req(PHONE, G2_HEADERS))
    p.noteQueued(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt, verdict)
    const changed = p.issueCarry({ ...turn, prompt: 'say something else' })
    expect(p.takeCarry(changed, turn.clientTurnId, 'say something else')).toEqual({ verdict: null, seal: null })
    const token = p.issueCarry(turn)
    expect(p.takeCarry(token, turn.clientTurnId, turn.prompt)).toEqual({ verdict, seal: { provider: 'claude', threadId: 'sid-1', attachments: '' } })
    // Spent.
    expect(p.takeCarry(token, turn.clientTurnId, turn.prompt)).toBeNull()
  })
  it('a carry token lives TURN_CARRY_TTL_MS and not a millisecond longer', () => {
    const { p, advance } = provenance()
    p.noteQueued(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt, p.originOf(req(PHONE, G2_HEADERS)))
    const ok = p.issueCarry(turn)
    advance(TURN_CARRY_TTL_MS - 1)
    expect(p.takeCarry(ok, turn.clientTurnId, turn.prompt)?.verdict?.verifiedOrigin).toBe(true)
    const late = p.issueCarry(turn)
    advance(TURN_CARRY_TTL_MS)
    expect(p.takeCarry(late, turn.clientTurnId, turn.prompt)).toBeNull()
  })
  it('a queued origin lapses QUEUED_ORIGIN_TTL_MS after it was judged: the drain then carries none', () => {
    const { p, advance } = provenance()
    p.noteQueued(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt, p.originOf(req(PHONE, G2_HEADERS)))
    advance(QUEUED_ORIGIN_TTL_MS)
    expect(p.queuedVerdict(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt)?.verifiedOrigin).toBe(true)
    advance(1)
    expect(p.queuedVerdict(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt)).toBeNull()
    expect(p.takeCarry(p.issueCarry(turn), turn.clientTurnId, turn.prompt)).toEqual({ verdict: null, seal: null })
  })
  it('noting an old origin again does not restart its clock', () => {
    const { p, advance } = provenance()
    const old = p.originOf(req(PHONE, G2_HEADERS))
    advance(QUEUED_ORIGIN_TTL_MS + 1)
    p.noteQueued(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt, old)
    expect(p.queuedVerdict(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt)).toBeNull()
  })
  it('refuses a token for another turn, other words, an unknown token, or after its TTL', () => {
    const { p, advance } = provenance()
    p.noteQueued(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt, p.originOf(req(PHONE, G2_HEADERS)))
    expect(p.takeCarry(p.issueCarry(turn), 'ct-q-other0001', turn.prompt)).toBeNull()
    expect(p.takeCarry(p.issueCarry(turn), turn.clientTurnId, 'tampered on disk')).toBeNull()
    expect(p.takeCarry('tok-never', turn.clientTurnId, turn.prompt)).toBeNull()
    expect(p.takeCarry(undefined, turn.clientTurnId, turn.prompt)).toBeNull()
    const late = p.issueCarry(turn)
    advance(TURN_CARRY_TTL_MS)
    expect(p.takeCarry(late, turn.clientTurnId, turn.prompt)).toBeNull()
  })
  it('an edit replaces the origin, and a cancel forgets it', () => {
    const { p } = provenance()
    p.noteQueued(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt, p.originOf(req(PHONE, G2_HEADERS)))
    p.noteQueued(turn.provider, turn.threadId, turn.clientTurnId, 'edited at the desk', p.originOf(req('127.0.0.1')))
    expect(p.queuedVerdict(turn.provider, turn.threadId, turn.clientTurnId, 'edited at the desk')?.verifiedOrigin).toBe(false)
    p.forgetQueued(turn.provider, turn.threadId, turn.clientTurnId)
    expect(p.queuedVerdict(turn.provider, turn.threadId, turn.clientTurnId, 'edited at the desk')).toBeNull()
  })
})

describe('turn ids are not reusable (QA 6.99.29)', () => {
  const g2 = () => { const { p, advance } = provenance(); return { p, advance, verdict: p.originOf(req(PHONE, G2_HEADERS)), local: p.originOf(req('127.0.0.1')) } }
  const base = { turnId: 'ct-reuse-0000001', prompt: 'approve it', provider: 'claude', sessionId: 'sid-1', via: 'live' }

  it('a different turn under a held id is refused, and the vouched record stands', async () => {
    const { p, local, verdict } = g2()
    p.record({ ...base, verdict })
    expect(p.reusesTurnId(base.turnId, { prompt: 'other words', verdict: local, provider: 'claude', sessionId: 'sid-1' })).toBe(true)
    expect(p.reusesTurnId(base.turnId, { prompt: base.prompt, verdict: local, provider: 'claude', sessionId: 'sid-1' })).toBe(true)
    expect(p.reusesTurnId(base.turnId, { prompt: base.prompt, verdict, provider: 'claude', sessionId: 'sid-2' })).toBe(true)
    expect(p.record({ ...base, verdict: local })).toBeNull()
    expect(await describeG2Turn(p, base.turnId, NOW)).toMatchObject({ verifiedOrigin: true, via: 'live' })
  })
  it('an identical retry is not reuse, and keeps the first record and its time', async () => {
    const { p, advance, verdict } = g2()
    const first = p.record({ ...base, verdict })
    advance(5_000)
    expect(p.reusesTurnId(base.turnId, { prompt: ' approve  it ', verdict, provider: 'claude', sessionId: 'sid-1' })).toBe(false)
    expect(p.record({ ...base, via: 'spawn', verdict })).toBe(first)
    expect(await describeG2Turn(p, base.turnId, NOW + 5_000)).toMatchObject({ ageMs: 5_000, via: 'live' })
  })
  it('a continuation extends only a record that is still parked, never a delivered one', async () => {
    const { p, verdict, local } = g2()
    p.record({ ...base, via: 'queue', verdict })
    expect(p.reusesTurnId(base.turnId, { prompt: 'words plus files', verdict: local, provider: 'claude', sessionId: 'sid-1' }, { continues: true })).toBe(false)
    expect(p.record({ ...base, prompt: 'words plus files', via: 'drain-live', verdict: local, continues: true })).toMatchObject({ via: 'drain-live' })
    // Delivered now: a second continuation (a row written into the queue file by hand) cannot replace it.
    expect(p.reusesTurnId(base.turnId, { prompt: 'other', verdict: local, provider: 'claude', sessionId: 'sid-1' }, { continues: true })).toBe(true)
    expect(p.record({ ...base, prompt: 'other', via: 'drain-live', verdict: local, continues: true })).toBeNull()
    for (const via of ['queue-edit', 'queue-resend']) {
      const id = `ct-reuse-${via}`
      p.record({ ...base, turnId: id, via, verdict })
      expect(p.record({ ...base, turnId: id, prompt: 'edited', via: 'queue-edit', verdict: local, continues: true })).not.toBeNull()
    }
  })
  it('the ledger itself refuses to replace a held id unless told it continues', async () => {
    const { p, verdict } = g2()
    const rec = p.record({ ...base, verdict })!
    expect(p.ledger.append({ ...rec, verifiedOrigin: false })).toBe(false)
    expect((await p.ledger.find(base.turnId))?.record.verifiedOrigin).toBe(true)
    expect(p.ledger.append({ ...rec, verifiedOrigin: false }, { replace: true })).toBe(true)
  })
  it('a throwing ledger reads as reuse (refuse)', () => {
    const { p, verdict } = g2()
    ;(p.ledger as unknown as { held: () => never }).held = () => { throw new Error('x') }
    expect(p.reusesTurnId(base.turnId, { prompt: 'x', verdict, provider: 'claude', sessionId: 'sid-1' })).toBe(true)
    expect(p.holds(base.turnId)).toBe(true)
  })
})

describe('Send again inherits the original row origin (QA 6.99.29 5a)', () => {
  it('fresh: the original origin; lapsed: unvouched; unknown or another thread: unvouched', () => {
    const { p, advance } = provenance()
    const verdict = p.originOf(req(PHONE, G2_HEADERS))
    p.record({ turnId: 'ct-orig-0000001', prompt: 'x', verdict, provider: 'claude', sessionId: 'sid-1', via: 'queue' })
    advance(60_000)
    expect(p.inheritedVerdict('ct-orig-0000001', 'claude', 'sid-1')).toMatchObject({ verifiedOrigin: true, judgedAt: NOW, origin: { client: 'glasses' } })
    expect(p.inheritedVerdict('ct-orig-0000001', 'claude', 'sid-2')).toMatchObject({ verifiedOrigin: false, reason: 'resend_origin_unknown' })
    expect(p.inheritedVerdict('ct-none-0000001', 'claude', 'sid-1')).toMatchObject({ verifiedOrigin: false, reason: 'resend_origin_unknown', origin: { client: 'unknown' } })
    advance(QUEUED_ORIGIN_TTL_MS)
    expect(p.inheritedVerdict('ct-orig-0000001', 'claude', 'sid-1')).toMatchObject({ verifiedOrigin: false, reason: 'resend_origin_lapsed', origin: { client: 'glasses' } })
  })
  it('an agent-written original stays unvouched, whoever presses Send again', () => {
    const { p } = provenance()
    p.record({ turnId: 'ct-orig-0000002', prompt: 'x', verdict: p.originOf(req('127.0.0.1')), provider: 'claude', sessionId: 'sid-1', via: 'queue' })
    expect(p.inheritedVerdict('ct-orig-0000002', 'claude', 'sid-1')).toMatchObject({ verifiedOrigin: false, origin: { client: 'local' } })
  })
})

describe('the queue seal binds provider, thread and files (Codex audit of e4758a6)', () => {
  const A = { id: 'm_' + 'a'.repeat(24), sha256: 'a'.repeat(64) }
  const B = { id: 'm_' + 'b'.repeat(24), sha256: 'b'.repeat(64) }
  it('the attachment digest changes with any id, any content hash, or the order; none is empty', () => {
    expect(attachmentsDigest([])).toBe('')
    const d = attachmentsDigest([A, B])
    expect(d).toMatch(/^[0-9a-f]{64}$/)
    expect(attachmentsDigest([B, A])).not.toBe(d)
    expect(attachmentsDigest([A])).not.toBe(d)
    expect(attachmentsDigest([A, { ...B, sha256: 'c'.repeat(64) }])).not.toBe(d)
    expect(attachmentsDigest([A, { ...B, id: 'm_' + 'c'.repeat(24) }])).not.toBe(d)
  })
  it('the carry hands back the seal noted with the origin', () => {
    const { p } = provenance()
    const turn = { provider: 'codex', threadId: 'thr-9', clientTurnId: 'ct-seal-0000001', prompt: 'with files' }
    p.noteQueued(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt, p.originOf(req(PHONE, G2_HEADERS)), attachmentsDigest([A]))
    const got = p.takeCarry(p.issueCarry(turn), turn.clientTurnId, turn.prompt)
    expect(got?.seal).toEqual({ provider: 'codex', threadId: 'thr-9', attachments: attachmentsDigest([A]) })
  })
  it('sealMatches compares every part', () => {
    const seal = { provider: 'claude', threadId: 't', attachments: 'x' }
    expect(sealMatches(seal, { ...seal })).toBe(true)
    expect(sealMatches(seal, { ...seal, provider: 'codex' })).toBe(false)
    expect(sealMatches(seal, { ...seal, threadId: 'u' })).toBe(false)
    expect(sealMatches(seal, { ...seal, attachments: 'y' })).toBe(false)
  })
})

describe('turnAttachmentManifest: each id with the hash of the bytes it resolves to', () => {
  const store = (paths: Record<string, string>, over: Partial<TurnAttachmentStore> = {}): TurnAttachmentStore => ({
    resolveUsable(id) { if (!(id in paths)) throw new Error('media_not_found'); return { record: { ref: { id } as never }, path: paths[id] } },
    async associate() {},
    ...over,
  })
  it('hashes the real file at the store path, in order; no ids reads nothing', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'a.jpg'), 'first bytes')
    writeFileSync(join(dir, 'b.jpg'), 'second bytes')
    const sha = (t: string) => createHash('sha256').update(t).digest('hex')
    const out = await turnAttachmentManifest(['m_a', 'm_b'], store({ m_a: join(dir, 'a.jpg'), m_b: join(dir, 'b.jpg') }))
    expect(out).toEqual({ ok: true, manifest: [{ id: 'm_a', sha256: sha('first bytes') }, { id: 'm_b', sha256: sha('second bytes') }] })
    expect(await turnAttachmentManifest([], store({}, { resolveUsable: () => { throw new Error('never asked') } }))).toEqual({ ok: true, manifest: [] })
  })
  it('fails closed on an unknown id, an unreadable file, or a hash that is not one', async () => {
    expect(await turnAttachmentManifest(['m_x'], store({}))).toEqual({ ok: false })
    expect(await turnAttachmentManifest(['m_a'], store({ m_a: join(tmp(), 'missing.jpg') }))).toEqual({ ok: false })
    expect(await turnAttachmentManifest(['m_a'], store({ m_a: '/x' }, { contentSha256: async () => 'nope' }))).toEqual({ ok: false })
  })
})
