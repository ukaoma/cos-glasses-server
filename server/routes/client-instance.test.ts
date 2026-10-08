import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLIENT_INSTANCE_AWAKE_MS, CLIENT_INSTANCE_CAPTURE_LIVE_MS, GLASSES_UPLOAD_MAX_BACKOFF_MS, GLASSES_UPLOAD_TIMEOUT_MS, CLIENT_INSTANCE_GRACE_GAP_MS, CLIENT_INSTANCE_LIVE_MS, CLIENT_INSTANCE_WORD_HOLD_MS, CLIENT_INSTANCE_MAX_FUTURE_BOOT_MS, CLIENT_INSTANCE_RECLAIM_MS, CLIENT_INSTANCE_TICK_MS, CLIENT_INSTANCE_MAX_TAGGED, ClientChunkLedger, NO_CAPTURE, arbitrateClientInstance, parseClientInstanceClaim, parseInstanceTag, type CaptureEvidence } from '../lib/client-instance-claim.js'
import { createClientInstanceRouter, deviceKey, isMeetingChunkPost } from './client-instance.js'
import type { ClientInstanceOwner } from '../lib/client-instance-claim.js'

const T0 = 1_789_744_000_000
const older = { id: 'mu707t9p-ai9g', bootAt: T0 - 5_000_000, version: '6.9.507', recording: false }
const newer = { id: 'mu73csa5-lgxq', bootAt: T0, version: '6.9.507', recording: false }

describe('the client-instance referee (6.50.3)', () => {
  it('the newest live boot owns the ring; an older copy yields until the owner goes quiet', () => {
    let r = arbitrateClientInstance(null, older, T0)
    expect(r.verdict).toBe('owner')
    r = arbitrateClientInstance(r.owner, newer, T0 + 1_000)
    expect(r).toMatchObject({ verdict: 'owner', took: true })
    // The 2026-09-18 zombie posts: it yields.
    r = arbitrateClientInstance(r.owner, older, T0 + 15_000)
    expect(r.verdict).toBe('yield')
    expect(r.owner.id).toBe(newer.id)
    // The newer copy keeps posting: still the owner.
    r = arbitrateClientInstance(r.owner, newer, T0 + 16_000)
    expect(r.verdict).toBe('owner')
    // 6.52.3: past the live edge the older STILL yields (a locked phone is quiet for 45 s).
    // Only after CLIENT_INSTANCE_RECLAIM_MS, and only while it has itself been claiming, does it take over.
    const quiet = T0 + 16_000
    expect(arbitrateClientInstance(r.owner, older, quiet + CLIENT_INSTANCE_LIVE_MS + 1, NO_CAPTURE, quiet + CLIENT_INSTANCE_LIVE_MS + 1 - CLIENT_INSTANCE_TICK_MS).verdict).toBe('yield')
    expect(arbitrateClientInstance(r.owner, older, quiet + CLIENT_INSTANCE_RECLAIM_MS, NO_CAPTURE, quiet + CLIENT_INSTANCE_RECLAIM_MS - CLIENT_INSTANCE_TICK_MS).verdict).toBe('yield')
    const back = arbitrateClientInstance(r.owner, older, quiet + CLIENT_INSTANCE_RECLAIM_MS + 1, NO_CAPTURE, quiet + CLIENT_INSTANCE_RECLAIM_MS + 1 - CLIENT_INSTANCE_TICK_MS)
    expect(back).toMatchObject({ verdict: 'owner', took: true })
    expect(back.owner.id).toBe(older.id)
  })

  it('6.52.3: the 2026-09-20 zombie: a copy that slept with the phone never takes the ring on waking', () => {
    const owner = arbitrateClientInstance(null, newer, T0).owner
    const wake = T0 + 8 * 60 * 60_000
    // Both copies were suspended overnight. The zombie's own last claim is hours old.
    expect(arbitrateClientInstance(owner, older, wake, NO_CAPTURE, T0 + 5_000).verdict).toBe('yield')
    // Never seen at all: the same.
    expect(arbitrateClientInstance(owner, older, wake, NO_CAPTURE, undefined).verdict).toBe('yield')
    // Right at the awake edge it counts; one ms past, it does not.
    expect(arbitrateClientInstance(owner, older, wake, NO_CAPTURE, wake - CLIENT_INSTANCE_AWAKE_MS).verdict).toBe('owner')
    expect(arbitrateClientInstance(owner, older, wake, NO_CAPTURE, wake - CLIENT_INSTANCE_AWAKE_MS - 1).verdict).toBe('yield')
    // A NEWER boot still takes at once, however quiet it was (reopening COS is the fix for a dead copy).
    const newest = { ...newer, id: 'mu7newest-boot', bootAt: newer.bootAt + 1 }
    expect(arbitrateClientInstance(owner, newest, wake, NO_CAPTURE, undefined)).toMatchObject({ verdict: 'owner', took: true })
  })

  it('two boots in the same millisecond: exactly one owns', () => {
    const a = { id: 'aaaa-0001', bootAt: T0, version: '', recording: false }
    const b = { id: 'bbbb-0001', bootAt: T0, version: '', recording: false }
    const first = arbitrateClientInstance(null, a, T0)
    const second = arbitrateClientInstance(first.owner, b, T0 + 1)
    const third = arbitrateClientInstance(second.owner, a, T0 + 2)
    expect([second.verdict, third.verdict].sort()).toEqual(['owner', 'yield'])
    expect(second.owner.id).toBe('bbbb-0001')
  })

  it('rejects anything but a well-formed claim', () => {
    expect(parseClientInstanceClaim(null)).toBeNull()
    expect(parseClientInstanceClaim({ id: 'x', bootAt: 1 })).toBeNull()
    expect(parseClientInstanceClaim({ id: 'mu707t9p-ai9g', bootAt: 'x' })).toBeNull()
    expect(parseClientInstanceClaim({ id: 'mu707t9p-ai9g', bootAt: -1 })).toBeNull()
    expect(parseClientInstanceClaim({ id: '../etc-passwd', bootAt: 1 })).toBeNull()
    expect(parseClientInstanceClaim({ id: 'mu707t9p-ai9g', bootAt: 1, version: 'v'.repeat(99) })?.version).toHaveLength(32)
  })
})

describe('POST /api/client-instance/claim', () => {
  let server: Server | null = null
  let base = ''
  let clock = T0
  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createClientInstanceRouter(() => clock))
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
    const addr = server!.address()
    base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
  })
  afterAll(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) })
  const post = async (body: unknown) => {
    const res = await fetch(`${base}/api/client-instance/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as any }
  }

  it('answers each copy owner or yield, keeping state across requests', async () => {
    expect((await post(older)).body.verdict).toBe('owner')
    clock += 1_000
    expect((await post(newer)).body).toMatchObject({ verdict: 'owner', owner: { id: newer.id } })
    clock += 14_000
    const z = await post(older)
    expect(z.status).toBe(200)
    expect(z.body).toMatchObject({ verdict: 'yield', owner: { id: newer.id } })
  })

  it('check answers without taking, even when the owner looks quiet', async () => {
    clock += 1_000
    expect((await post(newer)).body.verdict).toBe('owner')
    // The older copy keeps checking every tick while the owner goes quiet.
    expect((await post({ ...older, check: true })).body.verdict).toBe('yield')
    clock += CLIENT_INSTANCE_LIVE_MS + 1
    // 6.52.3: 45 s quiet is not enough (a locked phone).
    expect((await post({ ...older, check: true })).body.verdict).toBe('yield')
    // Past the reclaim window, still claiming every tick: the check says owner, without taking.
    while (clock <= T0 + 1_000 + CLIENT_INSTANCE_RECLAIM_MS) { clock += CLIENT_INSTANCE_TICK_MS; await post({ ...older, check: true }) }
    clock += CLIENT_INSTANCE_TICK_MS
    const checked = await post({ ...older, check: true })
    expect(checked.body).toMatchObject({ verdict: 'owner', check: true, owner: { id: newer.id } })
    // It did not take: the newer copy's next post is still the owner, the older still yields.
    expect((await post(newer)).body).toMatchObject({ verdict: 'owner', owner: { id: newer.id } })
    expect((await post({ ...older, check: true })).body.verdict).toBe('yield')
  })

  it('6.52.3 over HTTP: a copy that has not claimed for a tick cannot take a quiet ring; the next tick, it can', async () => {
    clock += 1_000
    expect((await post(newer)).body.verdict).toBe('owner')
    expect((await post({ ...older, check: true })).body.verdict).toBe('yield')
    // Both slept. The zombie's first claim on waking: refused, whatever the owner's silence.
    clock += CLIENT_INSTANCE_RECLAIM_MS + 60_000
    expect((await post(older)).body).toMatchObject({ verdict: 'yield', owner: { id: newer.id } })
    // A tick later, still nothing from the newer copy: it is dead, and the older takes over.
    clock += CLIENT_INSTANCE_TICK_MS
    expect((await post(older)).body).toMatchObject({ verdict: 'owner', owner: { id: older.id } })
  })

  it('a malformed claim is a 400 and changes nothing', async () => {
    expect((await post({ id: 'nope' })).status).toBe(400)
    expect((await post(newer)).body.verdict).toBe('owner')
  })
})

describe('mounting', () => {
  it('the referee is mounted AFTER the API token check and is not a public path', async () => {
    const { readFileSync } = await import('node:fs')
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const auth = index.indexOf("app.use('/api', requireApiToken(API_TOKEN))")
    // G2 authority Tier 1: the owner map is shared with the turn provenance.
    const mount = index.indexOf("app.use('/api', createClientInstanceRouter({ owners: clientInstanceOwners }))")
    // The provenance endpoint sits behind the same gate.
    expect(auth).toBeLessThan(index.indexOf("app.use('/api', createG2TurnsRouter({ provenance: g2Provenance }))"))
    // It notes each meeting chunk on the way past, so it must see them before the chunk route answers.
    const chunks = index.indexOf("app.use('/api', transcribeStreamRouter)")
    expect(auth).toBeGreaterThan(-1)
    expect(mount).toBeGreaterThan(-1)
    expect(chunks).toBeGreaterThan(-1)
    expect(auth).toBeLessThan(mount)
    expect(mount).toBeLessThan(chunks)
    const auth2 = readFileSync(new URL('../lib/api-auth.ts', import.meta.url), 'utf8')
    expect(auth2).not.toContain("'/client-instance")
    expect(auth2).not.toContain('g2-turns')
  })
})

describe('6.50.4: the ring never moves in a way that stops the only recording', () => {
  const rec = (o: Partial<CaptureEvidence>): CaptureEvidence => ({ ...NO_CAPTURE, ...o })
  /** 6.58.1 tests: the owner keeps claiming `recording` every tick from its seenAt up to `until`, as a live copy does. */
  const keepClaiming = (owner: ClientInstanceOwner, until: number, evidence: CaptureEvidence = NO_CAPTURE): ClientInstanceOwner => {
    let o = owner
    for (let t = o.seenAt + CLIENT_INSTANCE_TICK_MS; t <= until; t += CLIENT_INSTANCE_TICK_MS) o = arbitrateClientInstance(o, parseClientInstanceClaim({ id: o.id, bootAt: o.bootAt, recording: true }, t)!, t, evidence).owner
    return o
  }

  it('while the owner records, the ring stays, however quiet its claims; after, the newer copy takes it', () => {
    const r = arbitrateClientInstance(null, older, T0)
    // The 08:15 case: the phone page goes blank mid-meeting, Miles reopens COS.
    const held = arbitrateClientInstance(r.owner, newer, T0 + 1_000, rec({ owner: true }))
    expect(held).toMatchObject({ verdict: 'yield', took: false })
    expect(held.owner.id).toBe(older.id)
    // Hidden or locked, the recording copy's claims lapse; its chunks follow the audio.
    expect(arbitrateClientInstance(held.owner, newer, T0 + 10 * CLIENT_INSTANCE_LIVE_MS, rec({ owner: true })).verdict).toBe('yield')
    // Meeting stopped: the newer copy takes the ring on its next claim.
    expect(arbitrateClientInstance(held.owner, newer, T0 + 10 * CLIENT_INSTANCE_LIVE_MS + 1, NO_CAPTURE)).toMatchObject({ verdict: 'owner', took: true })
  })

  it('QA round 2: a dead owner is never pinned by the chunks of the copy that replaced it', () => {
    // A owned the ring and died a second ago. C booted offline, recorded, and reconnects.
    const a = arbitrateClientInstance(null, older, T0).owner
    expect(arbitrateClientInstance(a, newer, T0 + 1_000, rec({ claimant: true }))).toMatchObject({ verdict: 'owner', took: true })
    // The recorder takes even from a NEWER owner that is not recording, while that owner still claims.
    const n = arbitrateClientInstance(null, newer, T0).owner
    expect(arbitrateClientInstance(n, older, T0 + 1_000, rec({ claimant: true }))).toMatchObject({ verdict: 'owner', took: true })
  })

  it('QA round 3: after an outage the recording copy\'s uploads lag, and its own word reclaims the ring', () => {
    // A records (hidden); B was reopened. An outage: B reclaimed the ring offline and, back
    // online, took it on the Mac, because A's chunks were still in the uploader's backoff.
    const b = arbitrateClientInstance(null, newer, T0).owner
    // A's next claim says it records; no chunk has arrived yet. It must not be told to stop.
    const a = arbitrateClientInstance(b, { ...older, recording: true }, T0 + 1_000, NO_CAPTURE)
    expect(a).toMatchObject({ verdict: 'owner', took: true })
    // And now B waits: the owner's own word holds the ring while it keeps claiming.
    expect(arbitrateClientInstance(a.owner, newer, T0 + 1_000 + CLIENT_INSTANCE_LIVE_MS, NO_CAPTURE).verdict).toBe('yield')
    expect(arbitrateClientInstance(a.owner, newer, T0 + 1_001 + CLIENT_INSTANCE_LIVE_MS, NO_CAPTURE)).toMatchObject({ verdict: 'owner', took: true })
  })

  it('the owner\'s recording flag follows its latest claim', () => {
    const on = arbitrateClientInstance(null, { ...older, recording: true }, T0).owner
    expect(arbitrateClientInstance(on, newer, T0 + 1_000, NO_CAPTURE).verdict).toBe('yield')
    const off = arbitrateClientInstance(on, { ...older, recording: false }, T0 + 2_000, NO_CAPTURE).owner
    expect(off.recording).toBe(false)
    expect(arbitrateClientInstance(off, newer, T0 + 3_000, NO_CAPTURE)).toMatchObject({ verdict: 'owner', took: true })
    expect(parseClientInstanceClaim({ id: older.id, bootAt: 1, recording: true })?.recording).toBe(true)
    expect(parseClientInstanceClaim({ id: older.id, bootAt: 1, recording: 'yes' })?.recording).toBe(false)
    expect(parseClientInstanceClaim({ id: older.id, bootAt: 1 })?.recording).toBe(false)
  })

  it('both copies record (a duplicate): the owner keeps the ring and the claimant is told to stop', () => {
    const a = arbitrateClientInstance(null, older, T0).owner
    expect(arbitrateClientInstance(a, newer, T0 + 1_000, rec({ owner: true, claimant: true }))).toMatchObject({ verdict: 'yield', took: false })
    // The same when both only SAY so (their uploads lag), and when the owner's chunks are untagged.
    const said = arbitrateClientInstance(null, { ...older, recording: true }, T0).owner
    expect(arbitrateClientInstance(said, { ...newer, recording: true }, T0 + 1_000, NO_CAPTURE).verdict).toBe('yield')
    expect(arbitrateClientInstance(a, newer, T0 + 1_000, rec({ untagged: true, claimant: true })).verdict).toBe('yield')
  })

  it('6.58.1: an owner that says it is not recording is believed over its trailing chunks, while it claims', () => {
    const on = arbitrateClientInstance(null, parseClientInstanceClaim({ ...older, recording: true }, T0)!, T0).owner
    const off = arbitrateClientInstance(on, parseClientInstanceClaim({ ...older, recording: false }, T0 + 12_000)!, T0 + 12_000).owner
    const trailing = rec({ owner: true, ownerChunkAt: T0 + 14_000 })
    // A recording newcomer takes at once, and a newer copy that is not recording takes as a newer boot does.
    expect(arbitrateClientInstance(off, { ...newer, recording: true }, T0 + 29_000, trailing)).toMatchObject({ verdict: 'owner', took: true })
    expect(arbitrateClientInstance(off, newer, T0 + 29_000, trailing)).toMatchObject({ verdict: 'owner', took: true })
    // Once its word is stale its chunks are proof again (QA round 2: a start announcement is one
    // claim with a 1.5 s deadline, chunks get 30 s; the Mac may never have heard the start).
    const later = rec({ owner: true, ownerChunkAt: T0 + 12_000 + CLIENT_INSTANCE_LIVE_MS })
    expect(arbitrateClientInstance(off, { ...newer, recording: true }, T0 + 12_000 + CLIENT_INSTANCE_LIVE_MS, later).verdict).toBe('owner')
    expect(arbitrateClientInstance(off, { ...newer, recording: true }, T0 + 12_001 + CLIENT_INSTANCE_LIVE_MS, later).verdict).toBe('yield')
    // A copy that never reports the field (before 6.9.510) keeps the 6.50.4 rule: its chunks hold.
    const silent = arbitrateClientInstance(null, parseClientInstanceClaim({ id: older.id, bootAt: older.bootAt }, T0)!, T0).owner
    expect(silent.recordingReported).toBe(false)
    expect(arbitrateClientInstance(silent, { ...newer, recording: true }, T0 + 1_000, trailing).verdict).toBe('yield')
    // Whether the owner reports the field follows its LATEST claim.
    const spoke = arbitrateClientInstance(silent, parseClientInstanceClaim({ ...older, recording: false }, T0 + 2_000)!, T0 + 2_000).owner
    expect(spoke.recordingReported).toBe(true)
    expect(arbitrateClientInstance(spoke, { ...newer, recording: true }, T0 + 3_000, trailing).verdict).toBe('owner')
  })

  it('6.58.1: the owner\'s word alone holds for CLIENT_INSTANCE_WORD_HOLD_MS after its newest proof, then a recording newcomer takes', () => {
    const say = (recording: boolean, at: number) => parseClientInstanceClaim({ ...older, recording }, at)!
    // The recording starts: its claims alone hold before any chunk has landed.
    let a = arbitrateClientInstance(null, say(true, T0), T0).owner
    expect(a.recordingSince).toBe(T0)
    for (let t = T0 + CLIENT_INSTANCE_TICK_MS; t <= T0 + CLIENT_INSTANCE_WORD_HOLD_MS; t += CLIENT_INSTANCE_TICK_MS) a = arbitrateClientInstance(a, say(true, t), t).owner
    // Refreshing does not restart the clock.
    expect(a.recordingSince).toBe(T0)
    expect(a.graceAt).toBeUndefined()
    const b = { ...newer, recording: true }
    expect(arbitrateClientInstance(a, b, T0 + CLIENT_INSTANCE_WORD_HOLD_MS).verdict).toBe('yield')
    expect(arbitrateClientInstance(a, b, T0 + CLIENT_INSTANCE_WORD_HOLD_MS + 1)).toMatchObject({ verdict: 'owner', took: true })
    // Its newest chunk is proof too: WORD_HOLD after a chunk 60 s in.
    const chunk = rec({ ownerChunkAt: T0 + 60_000 })
    const still = keepClaiming(a, T0 + 60_000 + CLIENT_INSTANCE_WORD_HOLD_MS, chunk)
    expect(still.graceAt).toBeUndefined()
    expect(arbitrateClientInstance(still, b, T0 + 60_000 + CLIENT_INSTANCE_WORD_HOLD_MS, chunk).verdict).toBe('yield')
    expect(arbitrateClientInstance(still, b, T0 + 60_001 + CLIENT_INSTANCE_WORD_HOLD_MS, chunk).verdict).toBe('owner')
    // A newer copy that is NOT recording also stops waiting: the owner is no longer proven to record.
    expect(arbitrateClientInstance(a, newer, T0 + CLIENT_INSTANCE_WORD_HOLD_MS + 1)).toMatchObject({ verdict: 'owner', took: true })
    // A recording that stops and starts again starts a new clock.
    const stopped = arbitrateClientInstance(a, say(false, T0 + 200_000), T0 + 200_000).owner
    expect(stopped.recordingSince).toBeUndefined()
    const again = arbitrateClientInstance(stopped, say(true, T0 + 210_000), T0 + 210_000).owner
    expect(again.recordingSince).toBe(T0 + 210_000)
    const running = keepClaiming(again, T0 + 210_000 + CLIENT_INSTANCE_WORD_HOLD_MS)
    expect(running.recordingSince).toBe(T0 + 210_000)
    expect(arbitrateClientInstance(running, b, T0 + 210_000 + CLIENT_INSTANCE_WORD_HOLD_MS).verdict).toBe('yield')
    expect(arbitrateClientInstance(running, b, T0 + 210_001 + CLIENT_INSTANCE_WORD_HOLD_MS).verdict).toBe('owner')
  })

  it('6.58.1: after a gap in its claims the owner gets one grace for its uploads, and another only after a chunk of its own', () => {
    const say = (at: number) => parseClientInstanceClaim({ ...older, recording: true }, at)!
    let a = arbitrateClientInstance(null, say(T0), T0).owner
    // An outage: the claims stop for longer than CLIENT_INSTANCE_GRACE_GAP_MS; the last chunk came before it.
    const back = T0 + 5 * 60_000
    const lastChunk = rec({ ownerChunkAt: T0 + 5_000 })
    // Exactly the gap edge is no gap.
    expect(arbitrateClientInstance(a, say(T0 + CLIENT_INSTANCE_GRACE_GAP_MS), T0 + CLIENT_INSTANCE_GRACE_GAP_MS, lastChunk).owner.graceAt).toBeUndefined()
    a = arbitrateClientInstance(a, say(back), back, lastChunk).owner
    expect(a.graceAt).toBe(back)
    const b = { ...newer, recording: true }
    const held = keepClaiming(a, back + CLIENT_INSTANCE_WORD_HOLD_MS, lastChunk)
    expect(held.graceAt).toBe(back)
    expect(arbitrateClientInstance(held, b, back + CLIENT_INSTANCE_WORD_HOLD_MS, lastChunk).verdict).toBe('yield')
    expect(arbitrateClientInstance(held, b, back + CLIENT_INSTANCE_WORD_HOLD_MS + 1, lastChunk).verdict).toBe('owner')
    // The 2026-09-29 zombie: throttled timers, gap after gap, and never a chunk. No second grace.
    const back2 = back + CLIENT_INSTANCE_WORD_HOLD_MS + 10_000
    const again = arbitrateClientInstance(a, say(back2), back2, lastChunk).owner
    expect(again.graceAt).toBe(back)
    expect(arbitrateClientInstance(again, b, back2 + 1_000, lastChunk)).toMatchObject({ verdict: 'owner', took: true })
    // A real recorder whose chunks resumed after the grace gets the next one.
    const resumed = rec({ ownerChunkAt: back + 30_000 })
    expect(arbitrateClientInstance(a, say(back2), back2, resumed).owner.graceAt).toBe(back2)
    // A copy that stopped recording keeps no grace.
    expect(arbitrateClientInstance(a, parseClientInstanceClaim({ ...older, recording: false }, back2)!, back2, resumed).owner.graceAt).toBeUndefined()
  })

  it('6.58.1 (QA): a claimant that says it is not recording never takes the ring on its own trailing or replayed chunks', () => {
    const b = arbitrateClientInstance(null, newer, T0).owner
    const saysOff = parseClientInstanceClaim({ ...older, recording: false }, T0 + 5_000)!
    const ownChunk = rec({ claimant: true, claimantChunkAt: T0 + 4_000 })
    expect(arbitrateClientInstance(b, saysOff, T0 + 5_000, ownChunk)).toMatchObject({ verdict: 'yield', took: false })
    // Unreported (before 6.9.510), its chunks still speak for it, as in 6.50.4 (QA round 2).
    expect(arbitrateClientInstance(b, { ...older, recording: false }, T0 + 5_000, ownChunk)).toMatchObject({ verdict: 'owner', took: true })
  })

  it('6.58.1 (QA): a copy with nothing to show cannot take the ring back by saying `recording`; its word needs the same proof as an owner\'s', () => {
    const b = arbitrateClientInstance(null, newer, T0 + 400_000).owner
    // Its word began at T0 and its last proof is older than CLIENT_INSTANCE_WORD_HOLD_MS.
    const stale = { recording: true, recordingReported: true, recordingSince: T0, seenAt: T0 + 399_000 }
    const claim = parseClientInstanceClaim({ ...older, recording: true }, T0 + 400_000)!
    expect(arbitrateClientInstance(b, claim, T0 + 400_000, NO_CAPTURE, T0 + 399_000, stale)).toMatchObject({ verdict: 'yield', took: false })
    // With a chunk of its own inside the hold, it takes as before.
    expect(arbitrateClientInstance(b, claim, T0 + 400_000, rec({ claimantChunkAt: T0 + 300_000 }), T0 + 399_000, stale)).toMatchObject({ verdict: 'owner', took: true })
    // And the word it keeps is the old one: taking does not restart its clock.
    expect(arbitrateClientInstance(b, claim, T0 + 400_000, rec({ claimantChunkAt: T0 + 300_000 }), T0 + 399_000, stale).owner.recordingSince).toBe(T0)
  })

  it('6.58.1: the hold covers one failed upload plus the longest backoff, with a backoff to spare', () => {
    expect(CLIENT_INSTANCE_WORD_HOLD_MS).toBe(GLASSES_UPLOAD_TIMEOUT_MS + 2 * GLASSES_UPLOAD_MAX_BACKOFF_MS)
    expect(CLIENT_INSTANCE_WORD_HOLD_MS - (GLASSES_UPLOAD_TIMEOUT_MS + GLASSES_UPLOAD_MAX_BACKOFF_MS)).toBeGreaterThanOrEqual(GLASSES_UPLOAD_MAX_BACKOFF_MS)
  })

  it('untagged chunks (glasses 6.9.507/508) hold only for an owner that still claims', () => {
    const a = arbitrateClientInstance(null, older, T0).owner
    expect(arbitrateClientInstance(a, newer, T0 + CLIENT_INSTANCE_LIVE_MS, rec({ untagged: true })).verdict).toBe('yield')
    expect(arbitrateClientInstance(a, newer, T0 + CLIENT_INSTANCE_LIVE_MS + 1, rec({ untagged: true }))).toMatchObject({ verdict: 'owner', took: true })
  })

  it('the ledger: a copy\'s own chunks by id, untagged ones by device, each live for the capture window', () => {
    const l = new ClientChunkLedger()
    l.note('100.1.1.1', older.id, T0)
    l.note('100.1.1.1', null, T0)
    const at = (dt: number) => l.evidence('100.1.1.1', older.id, newer.id, T0 + dt)
    expect(at(CLIENT_INSTANCE_CAPTURE_LIVE_MS - 1)).toEqual({ owner: true, claimant: false, untagged: true, ownerChunkAt: T0 })
    // 6.58.1: past the window the chunk no longer proves capture, but its time is still known.
    expect(at(CLIENT_INSTANCE_CAPTURE_LIVE_MS)).toEqual({ ...NO_CAPTURE, ownerChunkAt: T0 })
    expect(l.evidence('100.1.1.1', newer.id, older.id, T0)).toEqual({ owner: false, claimant: true, untagged: true, claimantChunkAt: T0 })
    // Untagged chunks are this device's only.
    expect(l.evidence('100.2.2.2', older.id, newer.id, T0).untagged).toBe(false)
    // Bounded: the least recently seen copy is forgotten.
    for (let i = 0; i < CLIENT_INSTANCE_MAX_TAGGED; i++) l.note('100.1.1.1', `c${i}-x`, T0)
    expect(l.evidence('100.1.1.1', older.id, 'c0-x', T0)).toMatchObject({ owner: false, claimant: true })
  })

  it('what counts as a meeting chunk, and a tag', () => {
    expect(isMeetingChunkPost('POST', '/transcribe-stream')).toBe(true)
    expect(isMeetingChunkPost('POST', '/transcribe-stream/offline-sessions/abc/chunks')).toBe(true)
    expect(isMeetingChunkPost('POST', '/transcribe-stream/preview')).toBe(false)
    expect(isMeetingChunkPost('POST', '/transcribe-stream/candidates')).toBe(false)
    expect(isMeetingChunkPost('GET', '/transcribe-stream')).toBe(false)
    expect(parseInstanceTag(older.id)).toBe(older.id)
    expect(parseInstanceTag('Bad Id')).toBeNull()
    expect(parseInstanceTag([older.id])).toBeNull()
  })

  it('refuses a boot time more than an hour past the server clock', () => {
    expect(parseClientInstanceClaim({ id: 'mu707t9p-ai9g', bootAt: T0 + CLIENT_INSTANCE_MAX_FUTURE_BOOT_MS + 1 }, T0)).toBeNull()
    expect(parseClientInstanceClaim({ id: 'mu707t9p-ai9g', bootAt: T0 + CLIENT_INSTANCE_MAX_FUTURE_BOOT_MS }, T0)).not.toBeNull()
  })

  it('an IPv4-mapped address and its IPv4 form are one device', () => {
    expect(deviceKey('::ffff:100.64.1.2')).toBe('100.64.1.2')
    expect(deviceKey('100.64.1.2')).toBe('100.64.1.2')
    expect(deviceKey(undefined)).toBe('unknown')
  })

  describe('over HTTP, with chunk routes mounted behind the referee as in index.ts', () => {
    let server: Server | null = null
    let port = 0
    let clock = T0
    beforeAll(async () => {
      const app = express()
      app.use(express.json())
      app.use('/api', createClientInstanceRouter({ now: () => clock }))
      app.post('/api/transcribe-stream', (_req, res) => { res.json({ ok: true }) })
      app.post('/api/transcribe-stream/preview', (_req, res) => { res.json({ ok: true }) })
      app.post('/api/transcribe-stream/offline-sessions/:id/chunks', (_req, res) => { res.json({ ok: true }) })
      await new Promise<void>(resolve => { server = app.listen(0, '::', () => resolve()) })
      const addr = server!.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
    })
    afterAll(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) })
    const post = async (host: string, body: unknown) => {
      const res = await fetch(`http://${host}:${port}/api/client-instance/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() as any }
    }
    const chunk = async (path: string, instance?: string) => {
      const q = instance ? `${path.includes('?') ? '&' : '?'}clientInstance=${instance}` : ''
      const res = await fetch(`http://127.0.0.1:${port}/api${path}${q}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(8) })
      expect(res.status).toBe(200)
    }
    /** Each case starts with nothing live and the previous owner long gone. */
    const fresh = () => { clock += 10 * CLIENT_INSTANCE_LIVE_MS }
    // 6.9.509 tagged its chunks but sent no `recording` field (6.9.510 added it). 6.58.1 treats an
    // explicit `recording: false` from a claiming owner as a statement, so the fixture omits it.
    const copy = (id: string, dt: number) => ({ id, bootAt: clock + dt, version: '6.9.509' })

    it('the owner\'s own chunks hold the ring; the answer says so', async () => {
      fresh()
      const a = copy('aaaa0001-live', 0), b = copy('bbbb0001-live', 1_000)
      expect((await post('127.0.0.1', a)).body.verdict).toBe('owner')
      await chunk('/transcribe-stream?sessionId=s1&chunkIndex=0', a.id)
      clock += 5_000
      expect((await post('127.0.0.1', b)).body).toMatchObject({ verdict: 'yield', captureLive: true, owner: { id: a.id } })
      clock += CLIENT_INSTANCE_CAPTURE_LIVE_MS
      expect((await post('127.0.0.1', b)).body).toMatchObject({ verdict: 'owner', captureLive: false })
    })

    it('QA round 2: reopened offline, the new copy\'s own chunks land first and its claim is not told to stop', async () => {
      fresh()
      const dead = copy('dead0002-gone', 0), c = copy('cccc0002-recd', 1_000)
      expect((await post('127.0.0.1', dead)).body.verdict).toBe('owner')
      clock += 2_000
      await chunk('/transcribe-stream?sessionId=s2&chunkIndex=40', c.id)
      expect((await post('127.0.0.1', c)).body).toMatchObject({ verdict: 'owner', owner: { id: c.id }, captureLive: false })
    })

    it('QA round 3 over HTTP: a recording copy whose uploads lag takes the ring back by saying so', async () => {
      fresh()
      const a = copy('aaaa0006-hide', 0), b = copy('bbbb0006-open', 1_000)
      expect((await post('127.0.0.1', b)).body.verdict).toBe('owner')
      expect((await post('127.0.0.1', { ...a, recording: true })).body).toMatchObject({ verdict: 'owner', owner: { id: a.id } })
      expect((await post('127.0.0.1', b)).body).toMatchObject({ verdict: 'yield', captureLive: true, owner: { id: a.id } })
    })

    it('an iPhone offline chunk replayed, tagged, holds for its copy', async () => {
      fresh()
      const a = copy('aaaa0003-offl', 0), b = copy('bbbb0003-offl', 1_000)
      expect((await post('127.0.0.1', a)).body.verdict).toBe('owner')
      await chunk('/transcribe-stream/offline-sessions/abc/chunks', a.id)
      expect((await post('127.0.0.1', b)).body).toMatchObject({ verdict: 'yield', captureLive: true })
    })

    it('untagged chunks hold only while the owner still claims; the preview is not a chunk', async () => {
      fresh()
      const a = copy('aaaa0004-untg', 0), b = copy('bbbb0004-untg', 1_000)
      expect((await post('127.0.0.1', a)).body.verdict).toBe('owner')
      await chunk('/transcribe-stream/preview')
      expect((await post('127.0.0.1', { ...b, check: true })).body).toMatchObject({ verdict: 'owner', captureLive: false })
      await chunk('/transcribe-stream?sessionId=s4&chunkIndex=0')
      expect((await post('127.0.0.1', b)).body).toMatchObject({ verdict: 'yield', captureLive: true })
      clock += CLIENT_INSTANCE_LIVE_MS + 1
      await chunk('/transcribe-stream?sessionId=s4&chunkIndex=9')
      expect((await post('127.0.0.1', b)).body).toMatchObject({ verdict: 'owner', owner: { id: b.id } })
    })

    it('another device keeps its own owner and cannot take this one', async () => {
      fresh()
      const a = copy('aaaa0005-phone', 0), sim = copy('zzzz9999-sim1', 5_000)
      expect((await post('127.0.0.1', a)).body.verdict).toBe('owner')
      // ::1 is a different device from 127.0.0.1: a simulator on the Mac, say.
      expect((await post('[::1]', sim)).body).toMatchObject({ verdict: 'owner', owner: { id: sim.id } })
      // The phone's owner is untouched.
      expect((await post('127.0.0.1', { ...copy('bbbb0005-phone', -1_000), check: true })).body).toMatchObject({ verdict: 'yield', owner: { id: a.id } })
    })

    it('6.58.1 over HTTP: the 2026-09-29 zombie; the copy whose audio stopped says so, and the new recording keeps the ring', async () => {
      fresh()
      const a = { ...copy('mumnr7cf-zomb', 0), version: '6.9.560' }, b = { ...copy('mumnx78m-new1', 60_000), version: '6.9.560' }
      expect((await post('127.0.0.1', { ...a, recording: true })).body.verdict).toBe('owner')
      await chunk('/transcribe-stream?sessionId=m1&chunkIndex=16', a.id)
      // 07:38:31: twelve seconds without a frame, the probe alive and the glasses connected; A says so at once.
      clock += 12_000
      expect((await post('127.0.0.1', { ...a, recording: false })).body).toMatchObject({ verdict: 'owner', owner: { id: a.id } })
      // Its last committed chunk is still uploading.
      clock += 2_000
      await chunk('/transcribe-stream?sessionId=m1&chunkIndex=17', a.id)
      // 07:38:48: B starts the meeting. Before 6.58.1 A's trailing chunk made B stop within a second.
      clock += 15_000
      expect((await post('127.0.0.1', { ...b, recording: true })).body).toMatchObject({ verdict: 'owner', owner: { id: b.id }, captureLive: false })
      // A's next claim is told to yield, and that B is recording, so A stops.
      clock += 5_000
      expect((await post('127.0.0.1', { ...a, recording: true })).body).toMatchObject({ verdict: 'yield', captureLive: true, owner: { id: b.id } })
    })

    it('6.58.1 over HTTP: an older copy that never stops saying `recording` holds for CLIENT_INSTANCE_WORD_HOLD_MS after its last chunk', async () => {
      fresh()
      const a = { ...copy('aaaa0007-old1', 0), version: '6.9.558' }, b = { ...copy('bbbb0007-new1', 1_000), version: '6.9.558' }
      expect((await post('127.0.0.1', { ...a, recording: true })).body.verdict).toBe('owner')
      await chunk('/transcribe-stream?sessionId=m2&chunkIndex=3', a.id)
      const lastChunk = clock
      // A keeps claiming every tick with its word, and no chunk arrives again.
      while (clock + CLIENT_INSTANCE_TICK_MS <= lastChunk + CLIENT_INSTANCE_WORD_HOLD_MS) {
        clock += CLIENT_INSTANCE_TICK_MS
        expect((await post('127.0.0.1', { ...a, recording: true })).body.verdict).toBe('owner')
      }
      clock = lastChunk + CLIENT_INSTANCE_WORD_HOLD_MS
      expect((await post('127.0.0.1', { ...b, recording: true, check: true })).body).toMatchObject({ verdict: 'yield', captureLive: true })
      clock += 1
      expect((await post('127.0.0.1', { ...b, recording: true })).body).toMatchObject({ verdict: 'owner', owner: { id: b.id }, captureLive: false })
    })

    it('6.58.1 (QA) over HTTP: a silent 6.9.538 copy and an idle newer copy for 20 minutes; the ring moves once and never comes back', async () => {
      fresh()
      const start = clock
      const a = { ...copy('aaaa0008-zomb', 0), version: '6.9.538' }, b = { ...copy('bbbb0008-idle', 1_000), version: '6.9.538' }
      expect((await post('127.0.0.1', { ...a, recording: true })).body.verdict).toBe('owner')
      await chunk('/transcribe-stream?sessionId=m3&chunkIndex=0', a.id)
      const owners: string[] = []
      for (let s = 30; s <= 1_200; s += 30) {
        clock = start + s * 1_000
        // The zombie's throttled timers: a claim every 60 s, always `recording`, never a chunk.
        if (s % 60 === 0) owners.push((await post('127.0.0.1', { ...a, recording: true })).body.owner.id)
        owners.push((await post('127.0.0.1', { ...b, recording: false })).body.owner.id)
      }
      const changes = owners.filter((id, i) => i > 0 && id !== owners[i - 1]).length
      expect(owners[0]).toBe(a.id)
      expect(owners.at(-1)).toBe(b.id)
      expect(changes).toBe(1)
    })

    it('6.58.1 over HTTP: a real recorder on the worst upload cadence keeps the ring from an idle newer copy', async () => {
      fresh()
      const start = clock
      const a = { ...copy('aaaa0009-slow', 0), version: '6.9.538' }, b = { ...copy('bbbb0009-idle', 1_000), version: '6.9.538' }
      expect((await post('127.0.0.1', { ...a, recording: true })).body.verdict).toBe('owner')
      const cycle = GLASSES_UPLOAD_TIMEOUT_MS + GLASSES_UPLOAD_MAX_BACKOFF_MS
      for (let ms = 0; ms <= 10 * 60_000; ms += CLIENT_INSTANCE_TICK_MS) {
        clock = start + ms
        if (ms % cycle === 0) await chunk('/transcribe-stream?sessionId=m4&chunkIndex=1', a.id)
        expect((await post('127.0.0.1', { ...a, recording: true })).body.verdict).toBe('owner')
        expect((await post('127.0.0.1', { ...b, recording: false })).body).toMatchObject({ verdict: 'yield', captureLive: true })
      }
    })

    it('6.58.1 (QA round 2) over HTTP: a start the Mac never heard; the old `false` does not outlive the chunks, and the second copy waits', async () => {
      fresh()
      const a = { ...copy('aaaa0010-lost', 0), version: '6.9.560' }, b = { ...copy('bbbb0010-late', 1_000), version: '6.9.560' }
      // A said `false` before the meeting; its start claim and the ticks after it time out.
      expect((await post('127.0.0.1', { ...a, recording: false })).body.verdict).toBe('owner')
      for (let s = 6; s <= 120; s += 6) {
        clock += 6_000
        await chunk('/transcribe-stream?sessionId=m5&chunkIndex=' + s, a.id)
      }
      expect((await post('127.0.0.1', { ...b, recording: true })).body).toMatchObject({ verdict: 'yield', captureLive: true, owner: { id: a.id } })
    })

    it('a future boot time is a 400', async () => {
      expect((await post('127.0.0.1', { ...newer, id: 'fut00000-0001', bootAt: clock + 2 * CLIENT_INSTANCE_MAX_FUTURE_BOOT_MS })).status).toBe(400)
    })
  })
})
