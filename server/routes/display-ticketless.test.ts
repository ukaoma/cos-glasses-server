import express from 'express'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetDisplayBusForTests, emitDisplay, type DisplayEvent } from '../lib/display-bus.js'
import { mintDisplayTicket, DISPLAY_TICKET_TTL_SECONDS } from '../lib/display-ticket.js'
import { __resetDisplayStreamLogForTests, displayRouter } from './display.js'

/**
 * EXECUTION tests against a real router and a real socket. Source-shape matching
 * cannot observe what actually reaches a subscriber, and what reaches a ticketless
 * subscriber is the whole security property.
 */

const TOKEN = 'ticketless-suite-token'
let server: Server | null = null
let previousToken: string | undefined

async function startServer(): Promise<string> {
  const app = express()
  app.use('/api', displayRouter)
  server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server!.address()
  if (!address || typeof address === 'string') throw new Error('test listener unavailable')
  return `http://127.0.0.1:${address.port}`
}

/**
 * One harness for every block below.
 *
 * `closeAllConnections()` is not tidiness. `server.close()` otherwise waits for
 * undici's pooled sockets to hit their 4s keep-alive timeout, and that 4s lands
 * INSIDE the test's own budget — a test doing real work plus a 4s teardown sits
 * right on the 5s default and flakes. Dropping the sockets makes teardown immediate.
 */
function useDisplayStreamHarness(): void {
  beforeEach(() => {
    previousToken = process.env.COS_API_TOKEN
    process.env.COS_API_TOKEN = TOKEN
    __resetDisplayBusForTests()
    __resetDisplayStreamLogForTests()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (previousToken === undefined) delete process.env.COS_API_TOKEN
    else process.env.COS_API_TOKEN = previousToken
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = null
  })
}

/** Connect, let the server settle, emit, then read whatever actually arrived. */
async function collect(
  url: string,
  emit: () => void,
  headers: Record<string, string> = {},
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3_000)
  try {
    const response = await fetch(url, { signal: controller.signal, headers })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    // Drain the handshake first so the subscriber is registered before we emit.
    const first = await reader.read()
    if (!first.done) text += decoder.decode(first.value, { stream: true })
    emit()
    const deadline = Date.now() + 900
    while (Date.now() < deadline) {
      const race = await Promise.race([
        reader.read(),
        new Promise<null>(r => setTimeout(() => r(null), 250)),
      ])
      if (!race) break
      if (race.done) break
      text += decoder.decode(race.value, { stream: true })
    }
    await reader.cancel().catch(() => {})
    return text
  } finally {
    clearTimeout(timeout)
  }
}

/** Connect, read only the handshake, disconnect. Used where the SUBSCRIBE is the
 *  event under test and nothing needs to be emitted afterwards. */
async function touch(url: string): Promise<void> {
  const response = await fetch(url)
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  await reader.read()
  await reader.cancel().catch(() => {})
}

/**
 * Every union member that is NOT on the ticketless allowlist. All TEN must be proven
 * suppressed — an allowlist that is never adversarially probed is decoration.
 *
 * `recording_start` is in this list, not the allowlist, and that is a decision:
 * a missing `stop` leaves the lens asserting something false (a burning recording
 * indicator with no recording), while a missing `start` leaves it showing nothing,
 * which is what the ticketless contract promises anyway. `start` is also a live
 * presence signal, and no server-side emitter for it exists as of 6.42.0. See the
 * TICKETLESS_PROJECTIONS block in display.ts.
 */
// EXHAUSTIVE BY CONSTRUCTION. A `Record` keyed on the union fails to COMPILE when
// a twelfth DisplayEvent type is added, which is the only way this list stays
// honest: a hand-written array typed `DisplayEvent['type']` gives membership, not
// coverage, and a new type would be safely withheld at runtime while never being
// probed here (QA, 2026-09-01). `recording_stop` is the one allowlisted member;
// its own tests below use the production-shaped fixture.
const FIXTURE_BY_TYPE: Record<DisplayEvent['type'], Record<string, unknown>> = {
  transcript_chunk: { text: 'CANARY_TRANSCRIPT', speaker: 'MU', sessionId: 's1' },
  prompt_transcript: { text: 'CANARY_PROMPT' },
  chunk: { text: 'CANARY_CHUNK' },
  done: { text: 'CANARY_DONE' },
  session_restore: { sessionId: 'CANARY_SESSION' },
  coaching_nudge: { text: 'CANARY_NUDGE' },
  start: { model: 'CANARY_MODEL', sessionId: 's1' },
  tool_status: { message: 'CANARY_TOOL' },
  error: { error: 'CANARY_ERROR' },
  recording_start: { sessionId: 'CANARY_START_SESSION', title: 'CANARY_START_TITLE' },
  recording_stop: { sessionId: 'CANARY_STOP_SESSION', filename: 'CANARY_STOP_FILE.md', durationMin: 1, domain: 'x' },
}
const ALLOWLISTED: ReadonlySet<DisplayEvent['type']> = new Set(['recording_stop'])
const CONTENT_TYPES: Array<{ type: DisplayEvent['type']; data: Record<string, unknown> }> =
  (Object.keys(FIXTURE_BY_TYPE) as Array<DisplayEvent['type']>)
    .filter(type => !ALLOWLISTED.has(type))
    .map(type => ({ type, data: FIXTURE_BY_TYPE[type] }))

/**
 * The REAL production payload, field for field.
 *
 * Both emitters — routes/meeting.ts:658 (durable save) and :1971 (orphan recovery) —
 * send exactly these four keys, and `filename` is built by meeting-store.ts
 * `filenameStem()` straight out of the transcript-derived meeting TITLE. A fixture
 * that emitted `{ sessionId }` alone could not reproduce the leak, so it would have
 * been green while production broadcast the title of every meeting.
 */
const PRODUCTION_RECORDING_STOP: Record<string, unknown> = {
  sessionId: 'sess-abc123',
  filename: '2026-08-31_Q3_Budget_Cuts_Layoffs_1a2b3c4d.md',
  durationMin: 47,
  domain: 'quilt',
}
const TITLE_CANARY = 'Q3_Budget_Cuts_Layoffs'

describe('ticketless display-stream subscribers receive no content', () => {
  useDisplayStreamHarness()

  it.each(CONTENT_TYPES)('suppresses $type for a ticketless subscriber', async ({ type, data }) => {
    const base = await startServer()
    const body = await collect(`${base}/api/display-stream`, () => {
      emitDisplay({ type, data } as DisplayEvent)
    })
    expect(body).toContain('event: ready')
    expect(body).not.toContain(`event: ${type}`)
    for (const value of Object.values(data)) {
      if (typeof value === 'string' && value.startsWith('CANARY')) {
        expect(body).not.toContain(value)
      }
    }
  })

  it.each(CONTENT_TYPES)('DELIVERS $type to a ticketed subscriber', async ({ type, data }) => {
    const base = await startServer()
    const ticket = mintDisplayTicket(TOKEN)
    const body = await collect(`${base}/api/display-stream/${ticket}`, () => {
      emitDisplay({ type, data } as DisplayEvent)
    })
    expect(body).toContain(`event: ${type}`)
  })

  it('never serves the replay buffer to a ticketless subscriber', async () => {
    const base = await startServer()
    // Five buffered events exist BEFORE the subscriber connects. This is the
    // retroactive-dump case: worse than the live tap, because it is history.
    for (let i = 0; i < 5; i++) {
      emitDisplay({ type: 'transcript_chunk', data: { text: `REPLAY_CANARY_${i}`, speaker: 'MU' } } as DisplayEvent)
    }
    const body = await collect(`${base}/api/display-stream`, () => {})
    expect(body).toContain('event: ready')
    expect(body).not.toContain('event: transcript_chunk')
    expect(body).not.toContain('REPLAY_CANARY')
  })

  it('serves the replay buffer to a ticketed subscriber', async () => {
    const base = await startServer()
    for (let i = 0; i < 3; i++) {
      emitDisplay({ type: 'transcript_chunk', data: { text: `REPLAY_OK_${i}`, speaker: 'MU' } } as DisplayEvent)
    }
    const ticket = mintDisplayTicket(TOKEN)
    const body = await collect(`${base}/api/display-stream/${ticket}`, () => {})
    expect(body).toContain('REPLAY_OK_0')
  })

  it('degrades an INVALID ticket to ticketless rather than rejecting it', async () => {
    const base = await startServer()
    // A client whose ticket expired mid-reconnect must keep its transport, or it
    // enters the retry loop this whole design exists to avoid.
    const body = await collect(`${base}/api/display-stream/1780000000.${'a'.repeat(64)}`, () => {
      emitDisplay({ type: 'transcript_chunk', data: { text: 'CANARY_EXPIRED', speaker: 'MU' } } as DisplayEvent)
    })
    expect(body).toContain('event: ready')
    expect(body).not.toContain('CANARY_EXPIRED')
  })
})

/**
 * The lifecycle marker is the ONE thing a ticketless subscriber receives, so it is
 * the one place a content leak can hide behind an allowlist that "passed".
 */
describe('recording_stop is projected, not passed through', () => {
  useDisplayStreamHarness()

  it('withholds the transcript-derived meeting title from a ticketless subscriber', async () => {
    const base = await startServer()
    const body = await collect(`${base}/api/display-stream`, () => {
      emitDisplay({ type: 'recording_stop', data: PRODUCTION_RECORDING_STOP } as DisplayEvent)
    })
    // The marker itself still arrives — that is why it is allowlisted at all.
    expect(body).toContain('event: recording_stop')
    expect(body).toContain('sess-abc123')
    // `durationMin` is deliberately kept: the lens renders `Meeting saved — ${n}m`
    // from this frame, and stripping it painted a literal "undefinedm" on the
    // glasses. A duration is a scalar that discloses nothing about content.
    expect(body).toContain('durationMin')
    expect(body).toContain('47')
    // Everything the FILENAME discloses must still be gone: the transcript-derived
    // title, the file it names, and the business domain.
    expect(body).not.toContain(TITLE_CANARY)
    expect(body).not.toContain('2026-08-31_Q3_Budget_Cuts_Layoffs_1a2b3c4d.md')
    expect(body).not.toContain('filename')
    expect(body).not.toContain('quilt')
  })

  it('delivers the whole production payload to a ticketed subscriber', async () => {
    const base = await startServer()
    const ticket = mintDisplayTicket(TOKEN)
    const body = await collect(`${base}/api/display-stream/${ticket}`, () => {
      emitDisplay({ type: 'recording_stop', data: PRODUCTION_RECORDING_STOP } as DisplayEvent)
    })
    expect(body).toContain('event: recording_stop')
    expect(body).toContain(TITLE_CANARY)
    expect(body).toContain('durationMin')
    expect(body).toContain('quilt')
  })
})

/**
 * Without this field a degraded stream is INDISTINGUISHABLE from a healthy one: the
 * client sets displayBusConnected = true off a byte-identical handshake and never
 * re-mints, so an expired ticket is unrecoverable until the app is relaunched.
 */
describe('ready advertises whether content is authorized', () => {
  useDisplayStreamHarness()

  it('reports contentAuthorized:false to a ticketless subscriber', async () => {
    const base = await startServer()
    const body = await collect(`${base}/api/display-stream`, () => {})
    expect(body).toContain('event: ready')
    expect(body).toContain('"contentAuthorized":false')
  })

  it('reports contentAuthorized:true to a ticketed subscriber', async () => {
    const base = await startServer()
    const body = await collect(`${base}/api/display-stream/${mintDisplayTicket(TOKEN)}`, () => {})
    expect(body).toContain('event: ready')
    expect(body).toContain('"contentAuthorized":true')
  })

  it('reports contentAuthorized:false when the ticket is expired', async () => {
    const base = await startServer()
    const body = await collect(`${base}/api/display-stream/1780000000.${'a'.repeat(64)}`, () => {})
    expect(body).toContain('"contentAuthorized":false')
  })
})

/**
 * A ticket exists only because EventSource cannot set headers. Every fetch-based
 * consumer can, so requiring them to mint would suppress content for callers that are
 * already fully authenticated and would permanently pollute the adoption counter.
 */
describe('X-Cos-Token header is equivalent authorization', () => {
  useDisplayStreamHarness()

  it('delivers content on the ticketless path when the token header is valid', async () => {
    const base = await startServer()
    const body = await collect(
      `${base}/api/display-stream`,
      () => emitDisplay({ type: 'transcript_chunk', data: { text: 'HEADER_OK', speaker: 'MU' } } as DisplayEvent),
      { 'x-cos-token': TOKEN },
    )
    expect(body).toContain('"contentAuthorized":true')
    expect(body).toContain('HEADER_OK')
  })

  it('stays ticketless when the token header is wrong', async () => {
    const base = await startServer()
    const body = await collect(
      `${base}/api/display-stream`,
      () => emitDisplay({ type: 'transcript_chunk', data: { text: 'HEADER_BAD', speaker: 'MU' } } as DisplayEvent),
      { 'x-cos-token': `${TOKEN}-wrong` },
    )
    expect(body).toContain('"contentAuthorized":false')
    expect(body).not.toContain('HEADER_BAD')
  })

  it('rescues a subscriber whose ticket expired but who can still send a header', async () => {
    const base = await startServer()
    const body = await collect(
      `${base}/api/display-stream/1780000000.${'a'.repeat(64)}`,
      () => emitDisplay({ type: 'transcript_chunk', data: { text: 'HEADER_RESCUE', speaker: 'MU' } } as DisplayEvent),
      { 'x-cos-token': TOKEN },
    )
    expect(body).toContain('"contentAuthorized":true')
    expect(body).toContain('HEADER_RESCUE')
  })
})

/**
 * replay_gap carries reason, the cursor the CLIENT sent, the watermark already in
 * `ready`, and a buffer boundary. No user content, and withholding it strands the
 * client's replay-reconciliation branch on a dead cursor after a server restart.
 */
describe('replay_gap reaches ticketless subscribers', () => {
  useDisplayStreamHarness()

  it('reports a prior-boot cursor as a typed gap without a ticket', async () => {
    const base = await startServer()
    emitDisplay({ type: 'transcript_chunk', data: { text: 'GAP_CANARY', speaker: 'MU' } } as DisplayEvent)
    const body = await collect(`${base}/api/display-stream?bootId=old-boot&eventId=4`, () => {})
    expect(body).toContain('event: replay_gap')
    expect(body).toContain('"reason":"boot_changed"')
    // The gap notice must not become a back door into the buffer it describes.
    expect(body).not.toContain('GAP_CANARY')
    expect(body).not.toContain('event: transcript_chunk')
  })

  it('reports a cursor ahead of the watermark as a typed gap without a ticket', async () => {
    const base = await startServer()
    const body = await collect(`${base}/api/display-stream?eventId=999`, () => {})
    expect(body).toContain('event: replay_gap')
    expect(body).toContain('"reason":"cursor_ahead"')
  })
})

/**
 * The counter is the point; the per-line volume is not. `retry: 3000` means one
 * client that cannot mint reconnects every three seconds, so an unrate-limited warn
 * writes ~1,200 lines an hour into the launchd log from a single stale install.
 */
describe('ticketless connects are summarized, not logged per connect', () => {
  useDisplayStreamHarness()

  it('emits at most one line for a burst of four ticketless connects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const base = await startServer()
    for (let i = 0; i < 4; i++) {
      await touch(`${base}/api/display-stream`)
    }
    const lines = warn.mock.calls
      .map(call => String(call[0]))
      .filter(line => line.includes('ticketless subscriber'))
    expect(lines).toHaveLength(1)
    // The one line that IS emitted is the first connect. The other three are counted
    // and held for the next interval, which is why this is a summary and not a drop.
    expect(lines[0]).toContain('1 ticketless subscriber(s)')
  })
})


describe('the rejection log names WHY a ticket was refused', () => {
  useDisplayStreamHarness()

  it('distinguishes expired from bad-signature from bare', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const base = await startServer()
    const stale = mintDisplayTicket(TOKEN, Date.now() - (DISPLAY_TICKET_TTL_SECONDS + 5) * 1000)
    const forged = mintDisplayTicket('some-other-token', Date.now())
    await touch(`${base}/api/display-stream/${stale}`)
    await touch(`${base}/api/display-stream/${forged}`)
    await touch(`${base}/api/display-stream`)
    const line = warn.mock.calls.map(c => String(c[0])).find(l => l.includes('ticketless subscriber'))
    expect(line).toBeDefined()
    // The first connect flushes the line, so counts reflect only it; the others
    // are held for the next interval. What matters is the SHAPE of the line.
    expect(line).toMatch(/\d+ expired, \d+ bad-signature, \d+ malformed; \d+ bare/)
  })
})

describe('a projection that throws cannot reach the emitter', () => {
  useDisplayStreamHarness()

  it('survives a recording_stop with a null payload and keeps the subscriber', async () => {
    const base = await startServer()
    const text = await collect(`${base}/api/display-stream`, () => {
      // The projection reads data.sessionId; on null that throws. It must be
      // caught INSIDE the listener, or it propagates through bus.emit() into
      // meeting.ts's save path. transcribe-stream.ts:2164 emits unguarded.
      expect(() => emitDisplay({ type: 'recording_stop', data: null as never })).not.toThrow()
      emitDisplay({ type: 'recording_stop', data: { sessionId: 'AFTER', durationMin: 2, filename: 'x.md', domain: 'd' } })
    })
    expect(text).toContain('event: ready')
    expect(text).toContain('AFTER')
  })
})

describe('the connection probe is not a consumer', () => {
  useDisplayStreamHarness()

  it('an authorized probe=1 connect gets the handshake and no replay', async () => {
    const base = await startServer()
    emitDisplay({ type: 'chunk', data: { text: 'REPLAY_PROBE_CANARY' } })
    const probe = await collect(`${base}/api/display-stream?probe=1`, () => {}, { 'X-Cos-Token': TOKEN })
    expect(probe).toContain('"contentAuthorized":true')
    expect(probe).not.toContain('REPLAY_PROBE_CANARY')
    // Control: the same authorized connect WITHOUT probe=1 does get the buffer.
    const full = await collect(`${base}/api/display-stream`, () => {}, { 'X-Cos-Token': TOKEN })
    expect(full).toContain('REPLAY_PROBE_CANARY')
  })
})
