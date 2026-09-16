import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PEER_ACCEPTANCE_BACKDATE_MS,
  PEER_ACCEPTANCE_READ_SLACK_BYTES,
  PEER_INBOX_PROTOCOL,
  PEER_VERIFY_POLL_MS,
  SUSPECT_TTL_MS,
  __resetPeerInboxSuspects,
  deliverOverPeerInbox,
  peerAcceptanceIn,
  peerAcceptanceMarker,
  peerInboxFrames,
  selectPeerInbox,
  sendOverPeerSocket,
  type PeerInboxRecord,
  type PeerInboxDeps,
  type PeerSendError,
  type TranscriptRowLike,
} from './session-peer-inbox'

// The registry as it actually read on this Mac at 13:04 on 2026-09-16, trimmed to the
// fields this module uses. Both surfaces are here on purpose: the whole claim of this
// slice is that a Desktop tab and an iTerm session are the same target.
const SESSION = '7ff6893b-c323-49a5-8149-a21c59ed1e2f'
const OTHER = 'd7033980-1111-4222-8333-444444444444'

function record(over: Partial<PeerInboxRecord> = {}): PeerInboxRecord {
  return {
    pid: 82615,
    sessionId: SESSION,
    socketPath: '/tmp/cc-socks/82615.sock',
    peerProtocol: PEER_INBOX_PROTOCOL,
    entrypoint: 'cli',
    status: 'busy',
    ...over,
  }
}

function enqueueRow(content: string, at: string): TranscriptRowLike {
  // The shape Claude Code writes the instant it accepts a message, copied from this
  // session's own transcript (row at 2026-09-16T05:24:17.622Z).
  return { type: 'queue-operation', operation: 'enqueue', timestamp: at, sessionId: SESSION, content }
}

function userRow(text: string, at: string): TranscriptRowLike {
  return { type: 'user', timestamp: at, sessionId: SESSION, message: { role: 'user', content: [{ type: 'text', text }] } }
}

describe('selectPeerInbox', () => {
  it('matches the FULL session id and never a prefix', () => {
    const rows = [record({ sessionId: SESSION })]
    expect(selectPeerInbox(SESSION, rows)?.pid).toBe(82615)
    // The 8-char form the wire uses elsewhere must not resolve here: a prefix can name
    // two sessions, and the pin exists to remove exactly that ambiguity.
    expect(selectPeerInbox(SESSION.slice(0, 8), rows)).toBeNull()
    expect(selectPeerInbox('', rows)).toBeNull()
    expect(selectPeerInbox(OTHER, rows)).toBeNull()
  })

  it('needs a socket path and a real pid', () => {
    expect(selectPeerInbox(SESSION, [record({ socketPath: null })])).toBeNull()
    expect(selectPeerInbox(SESSION, [record({ socketPath: '' })])).toBeNull()
    expect(selectPeerInbox(SESSION, [record({ pid: 0 })])).toBeNull()
  })

  it('skips a COS-spawned child sharing the id, and refuses when that is all there is', () => {
    const child = record({ pid: 99001, socketPath: '/tmp/cc-socks/99001.sock' })
    const window = record({ pid: 82615 })
    const cosOwned = (pid: number): boolean => pid === 99001
    // The child has the higher pid, so a naive "newest wins" would pick it.
    expect(selectPeerInbox(SESSION, [window, child], cosOwned)?.pid).toBe(82615)
    // And with only our own child alive there is no window to paint: fall back.
    expect(selectPeerInbox(SESSION, [child], cosOwned)).toBeNull()
  })

  it('takes the newest window when the user has two on one session', () => {
    expect(selectPeerInbox(SESSION, [record({ pid: 100 }), record({ pid: 900 }), record({ pid: 500 })])?.pid).toBe(900)
  })

  it('treats a Desktop tab and a terminal identically', () => {
    const desktop = record({ pid: 55443, entrypoint: 'claude-desktop', socketPath: '/tmp/cc-socks/55443.sock' })
    expect(selectPeerInbox(SESSION, [desktop])?.entrypoint).toBe('claude-desktop')
    expect(selectPeerInbox(SESSION, [record({ entrypoint: 'cli' })])?.entrypoint).toBe('cli')
  })
})

describe('peerInboxFrames', () => {
  it('is the two lines Claude Code documents, with the session pinned', () => {
    const frames = peerInboxFrames(SESSION, 'hello', 'a'.repeat(32))
    expect(frames).toHaveLength(2)
    expect(JSON.parse(frames[0])).toEqual({ type: 'auth', token: 'a'.repeat(32) })
    expect(JSON.parse(frames[1])).toEqual({
      type: 'user',
      session_id: SESSION,
      message: { role: 'user', content: 'hello' },
    })
  })

  it('omits the auth line entirely when no token is readable', () => {
    // Auth is optional on this platform (proven 2026-09-16: a wrong token still
    // delivered), and an EMPTY token is a failed auth rather than no auth.
    const frames = peerInboxFrames(SESSION, 'hello', null)
    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0]).type).toBe('user')
    expect(peerInboxFrames(SESSION, 'hello', '')).toHaveLength(1)
  })

  it('pins the session on the message frame, not only on the connection', () => {
    // Deleting `session_id` here is the mutation that makes a recycled pid able to
    // receive someone else's turn: the receiver's own check is what catches it.
    expect(JSON.parse(peerInboxFrames(SESSION, 'x', null)[0]).session_id).toBe(SESSION)
  })
})

describe('peerAcceptanceIn', () => {
  const sentAt = Date.parse('2026-09-16T05:24:17.000Z')
  const marker = peerAcceptanceMarker('Update our gotcos.com/docs. Remove all of the artifacts and random things I have noted here.')

  it('takes the enqueue row as proof', () => {
    const rows = [enqueueRow(marker, '2026-09-16T05:24:17.622Z')]
    expect(peerAcceptanceIn(rows, marker, sentAt)).toBe('enqueue')
  })

  it('takes a user row carrying the same text', () => {
    expect(peerAcceptanceIn([userRow(`${marker} and more`, '2026-09-16T05:24:19.676Z')], marker, sentAt)).toBe('user_row')
  })

  it('refuses a row that predates the send', () => {
    // Without the floor a retry of the same prompt verifies against the PREVIOUS
    // delivery's row and reports a send that never happened.
    const stale = [enqueueRow(marker, '2026-09-16T05:00:00.000Z')]
    expect(peerAcceptanceIn(stale, marker, sentAt)).toBeNull()
  })

  it('the floor is exactly two seconds before the send', () => {
    // Pinned at the boundary AND as a literal: QA moved the constant to ten minutes
    // and nothing failed, and a boundary derived from the import moves with it. Two
    // seconds is a product choice (the window in which a same-words desk prompt could
    // be mistaken for ours), so the literal is the assertion.
    expect(PEER_ACCEPTANCE_BACKDATE_MS).toBe(2_000)
    const at = (ms: number) => new Date(sentAt - 2_000 + ms).toISOString()
    expect(peerAcceptanceIn([enqueueRow(marker, at(-1))], marker, sentAt)).toBeNull()
    expect(peerAcceptanceIn([enqueueRow(marker, at(0))], marker, sentAt)).toBe('enqueue')
    expect(peerAcceptanceIn([enqueueRow(marker, at(+1))], marker, sentAt)).toBe('enqueue')
  })

  it('ignores rows that do not carry the text, and an empty marker', () => {
    expect(peerAcceptanceIn([enqueueRow('something else', '2026-09-16T05:24:18.000Z')], marker, sentAt)).toBeNull()
    expect(peerAcceptanceIn([enqueueRow(marker, '2026-09-16T05:24:18.000Z')], '', sentAt)).toBeNull()
    expect(peerAcceptanceIn([], marker, sentAt)).toBeNull()
  })

  it('does not accept an assistant row that quotes the prompt back', () => {
    const assistant: TranscriptRowLike = {
      type: 'assistant', timestamp: '2026-09-16T05:24:20.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: `You asked: ${marker}` }] },
    }
    expect(peerAcceptanceIn([assistant], marker, sentAt)).toBeNull()
  })
})

describe('deliverOverPeerInbox', () => {
  beforeEach(() => __resetPeerInboxSuspects())
  function deps(over: Partial<PeerInboxDeps> = {}): PeerInboxDeps {
    return {
      records: () => [record()],
      token: () => null,
      transcriptTail: () => [enqueueRow(peerAcceptanceMarker('ship it'), new Date().toISOString())],
      now: () => Date.now(),
      sleep: async () => {},
      send: async () => {},
      ...over,
    }
  }
  const req = { provider: 'claude', sessionId: SESSION, prompt: 'ship it', enabled: true }

  it('reports delivered only with an acceptance row', async () => {
    const sent: string[][] = []
    const result = await deliverOverPeerInbox(req, deps({ send: async (_p, frames) => { sent.push([...frames]) } }))
    expect(result).toMatchObject({ ok: true, reason: 'delivered', verifiedBy: 'enqueue', pid: 82615 })
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0][0]).session_id).toBe(SESSION)
  })

  it('is unverified, NOT delivered, when the transcript never shows the message', async () => {
    // The whole safety property: bytes on a socket are not a delivery.
    let t = 0
    const result = await deliverOverPeerInbox(
      { ...req, verifyTimeoutMs: 1_000 },
      deps({ transcriptTail: () => [], now: () => (t += PEER_VERIFY_POLL_MS), sleep: async () => {} }),
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unverified')
    expect(result.verifiedBy).toBeNull()
  })

  it('falls back on a stale socket rather than throwing', async () => {
    const enoent = Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' })
    const result = await deliverOverPeerInbox(req, deps({ send: async () => { throw enoent } }))
    expect(result).toMatchObject({ ok: false, reason: 'connect_failed' })
  })

  it('classifies a write failure apart from a connect failure', async () => {
    const result = await deliverOverPeerInbox(req, deps({ send: async () => { throw new Error('EPIPE') } }))
    expect(result.reason).toBe('write_failed')
  })

  it('6.49.1: anything that failed BEFORE connect is nothing sent, whatever its code', async () => {
    // `connect_timeout` (no code), ENOTSOCK, EACCES: the timer and the socket error
    // all fire before `connect`, so no byte left. QA found these held as suspects for
    // the whole SUSPECT_TTL_MS with the spawn path blocked behind them.
    for (const message of ['connect_timeout', 'connect ENOTSOCK', 'connect EACCES']) {
      __resetPeerInboxSuspects()
      const error = Object.assign(new Error(message), { phase: 'connect' as const })
      const result = await deliverOverPeerInbox(req, deps({ transcriptTail: () => [], send: async () => { throw error } }))
      expect(result.reason, message).toBe('connect_failed')
      // No memo: the next attempt sends again rather than answering `unverified`.
      let sends = 0
      expect((await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 0 }, deps({ transcriptTail: () => [], send: async () => { sends += 1 } }))).reason).toBe('unverified')
      expect(sends).toBe(1)
    }
    __resetPeerInboxSuspects()
    const late = Object.assign(new Error('EPIPE'), { phase: 'write' as const })
    expect((await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 0 }, deps({ transcriptTail: () => [], send: async () => { throw late } }))).reason).toBe('write_failed')
  })

  it('6.49.1: reads the transcript from its size at the send, however much lands after', async () => {
    // The threat is the rows written AFTER acceptance: one tool result can exceed a
    // megabyte, and a fixed 256 KiB tail lost the enqueue row behind it on the retry.
    const asked: Array<number | undefined> = []
    let size = 1_000
    const marker = peerAcceptanceMarker('ship it')
    const d = deps({
      transcriptSize: () => size,
      // 5 MB of tool output lands between the send and the first look.
      send: async () => { size = 5_000_000 },
      transcriptTail: (_id, minBytes) => {
        asked.push(minBytes)
        // The acceptance row is visible only when the read reaches back far enough.
        return typeof minBytes === 'number' && minBytes >= size - 1_000 ? [enqueueRow(marker, new Date().toISOString())] : []
      },
    })
    const result = await deliverOverPeerInbox(req, d)
    expect(result).toMatchObject({ ok: true, reason: 'delivered', verifiedBy: 'enqueue' })
    expect(asked[0]).toBe(5_000_000 - 1_000 + PEER_ACCEPTANCE_READ_SLACK_BYTES)
  })

  it('6.49.1: the memo re-check reads from the ORIGINAL send size too', async () => {
    const asked: Array<number | undefined> = []
    let size = 2_000
    let t = 0
    const marker = peerAcceptanceMarker('ship it')
    let rows: TranscriptRowLike[] = []
    const d = deps({
      transcriptSize: () => size,
      transcriptTail: (_id, minBytes) => { asked.push(minBytes); return rows },
      now: () => t,
    })
    expect((await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 0 }, d)).reason).toBe('unverified')
    size = 3_000_000
    rows = [enqueueRow(marker, new Date(1).toISOString())]
    t = 10
    expect((await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 0 }, d)).reason).toBe('delivered')
    expect(asked.at(-1)).toBe(3_000_000 - 2_000 + PEER_ACCEPTANCE_READ_SLACK_BYTES)
  })

  it('6.49.1: without a size reader every read is the plain tail', async () => {
    const asked: Array<number | undefined> = []
    const d = deps({ transcriptTail: (_id, minBytes) => { asked.push(minBytes); return [] } })
    await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 0 }, d)
    expect(asked).toEqual([undefined])
  })

  it('refuses when the flag is off, for a non-Claude provider, and with no live record', async () => {
    expect((await deliverOverPeerInbox({ ...req, enabled: false }, deps())).reason).toBe('disabled')
    expect((await deliverOverPeerInbox({ ...req, provider: 'codex' }, deps())).reason).toBe('not_claude')
    expect((await deliverOverPeerInbox(req, deps({ records: () => [] }))).reason).toBe('no_record')
  })

  it('refuses a protocol it does not speak instead of guessing at the frames', async () => {
    const result = await deliverOverPeerInbox(req, deps({ records: () => [record({ peerProtocol: 2 })] }))
    expect(result).toMatchObject({ ok: false, reason: 'protocol_unsupported' })
  })

  it('never sends when it refuses', async () => {
    let sends = 0
    const count = { send: async () => { sends += 1 } }
    await deliverOverPeerInbox({ ...req, enabled: false }, deps(count))
    await deliverOverPeerInbox({ ...req, provider: 'cursor' }, deps(count))
    await deliverOverPeerInbox(req, deps({ ...count, records: () => [] }))
    await deliverOverPeerInbox(req, deps({ ...count, records: () => [record({ peerProtocol: 7 })] }))
    expect(sends).toBe(0)
  })

  it('survives a registry read or transcript read that throws', async () => {
    const thrown = await deliverOverPeerInbox(req, deps({ records: () => { throw new Error('registry gone') } }))
    expect(thrown).toMatchObject({ ok: false, reason: 'no_record' })
    let t = 0
    const tail = await deliverOverPeerInbox(
      { ...req, verifyTimeoutMs: 500 },
      deps({ transcriptTail: () => { throw new Error('unreadable') }, now: () => (t += 250) }),
    )
    expect(tail).toMatchObject({ ok: false, reason: 'unverified' })
  })

  it('sends the token when one is readable', async () => {
    let frames: string[] = []
    await deliverOverPeerInbox(req, deps({ token: () => 'b'.repeat(32), send: async (_p, f) => { frames = [...f] } }))
    expect(frames).toHaveLength(2)
    expect(JSON.parse(frames[0]).type).toBe('auth')
  })

  describe('a send that was never verified', () => {
    it('is never written to the socket twice, and turns into delivered when the row arrives late', async () => {
      let t = 1_000_000
      let sends = 0
      let rows: TranscriptRowLike[] = []
      const d = deps({
        transcriptTail: () => rows,
        now: () => (t += 100),
        send: async () => { sends += 1 },
      })
      const first = await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 500 }, d)
      expect(first.reason).toBe('unverified')
      expect(sends).toBe(1)
      // The retry: still no row. Nothing is sent again.
      const second = await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 500 }, d)
      expect(second.reason).toBe('unverified')
      expect(sends).toBe(1)
      // The row lands, stamped at the ORIGINAL send time, and the retry comes well after
      // the backdate allowance -- so a memo that checked from its own clock would miss
      // it. The retry sees it without sending.
      rows = [enqueueRow(peerAcceptanceMarker('ship it'), new Date(1_000_300).toISOString())]
      t += 30_000
      const third = await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 500 }, d)
      expect(third).toMatchObject({ ok: true, reason: 'delivered', verifiedBy: 'enqueue' })
      expect(sends).toBe(1)
      // And the memo is spent: a fresh identical prompt is a fresh send.
      rows = [enqueueRow(peerAcceptanceMarker('ship it'), new Date(t + 50).toISOString())]
      const fourth = await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 500 }, d)
      expect(fourth.ok).toBe(true)
      expect(sends).toBe(2)
    })

    it('hands the turn to the spawn path only after the memo expires', async () => {
      // A clock the test moves by hand; the verify loop's own sleep does not touch it,
      // so the memo's age is exactly what the test says it is.
      let t = 5_000_000
      let sends = 0
      const d = deps({ transcriptTail: () => [], now: () => t, sleep: async () => {}, send: async () => { sends += 1 } })
      expect((await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 0 }, d)).reason).toBe('unverified')
      t += SUSPECT_TTL_MS - 1
      expect((await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 0 }, d)).reason).toBe('unverified')
      t += 2
      const expired = await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 0 }, d)
      expect(expired.reason).toBe('suspect_expired')
      expect(sends).toBe(1)
      // The memo is gone: the next attempt is a new send.
      expect((await deliverOverPeerInbox({ ...req, verifyTimeoutMs: 0 }, d)).reason).toBe('unverified')
      expect(sends).toBe(2)
    })

    it('treats a write failure as a suspect, and a connect failure as nothing sent', async () => {
      let sends = 0
      // No acceptance row anywhere: the only way the retry can say delivered is a resend.
      const epipe = deps({ transcriptTail: () => [], send: async () => { sends += 1; throw new Error('EPIPE') } })
      expect((await deliverOverPeerInbox(req, epipe)).reason).toBe('write_failed')
      expect((await deliverOverPeerInbox(req, epipe)).reason).toBe('unverified')
      expect(sends).toBe(1)
      __resetPeerInboxSuspects()
      const refused = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })
      const dead = deps({ transcriptTail: () => [], send: async () => { sends += 1; throw refused } })
      expect((await deliverOverPeerInbox(req, dead)).reason).toBe('connect_failed')
      expect((await deliverOverPeerInbox(req, dead)).reason).toBe('connect_failed')
      expect(sends).toBe(3)
    })
  })
})

describe('sendOverPeerSocket against a real unix socket', () => {
  // Every other test injects `send`. This is the one place the wire itself is asserted.
  let dir = ''
  let server: Server | null = null
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cos-peer-')) })
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    server = null
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes exactly the two NDJSON lines, newline-terminated, then closes', async () => {
    const path = join(dir, 'p.sock')
    const received: Buffer[] = []
    const closed = new Promise<void>(resolve => {
      server = createServer(socket => {
        socket.on('data', chunk => received.push(chunk))
        socket.on('close', () => resolve())
      })
    })
    await new Promise<void>(resolve => server!.listen(path, resolve))
    const frames = peerInboxFrames(SESSION, 'hello there', 'tok')
    await sendOverPeerSocket(path, frames)
    await closed
    expect(Buffer.concat(received).toString('utf-8')).toBe(`${frames[0]}\n${frames[1]}\n`)
  })

  it('tags a missing path and a non-socket as the connect phase', async () => {
    const missing = await sendOverPeerSocket(join(dir, 'gone.sock'), ['{}']).catch(e => e as PeerSendError)
    expect(missing).toMatchObject({ phase: 'connect', code: 'ENOENT' })
    const file = join(dir, 'file.sock')
    writeFileSync(file, '')
    const notsock = await sendOverPeerSocket(file, ['{}']).catch(e => e as PeerSendError)
    expect(notsock).toMatchObject({ phase: 'connect' })
    expect(typeof (notsock as PeerSendError).code).toBe('string')
  })
})
