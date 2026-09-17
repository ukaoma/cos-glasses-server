// Delivering a queued turn INTO the running Claude session, instead of only into
// its transcript (6.49.0).
//
// THE PROBLEM THIS SOLVES. A Continue from the glasses reaches the session by
// spawning `claude -p --resume <id>`, which appends the turn and its reply to the
// session file and exits. That is correct and it is durable, but the window Miles
// left open -- a Desktop tab, or a `claude` running in iTerm -- read that file when
// it opened and never reads it again, so the turn he sent from the lens is invisible
// at the desk until he resumes the session. Two of his Continues on 2026-09-15 landed
// exactly that way: delivered, answered, and not painted anywhere he was looking.
//
// WHAT CLAUDE CODE ACTUALLY OFFERS. Every live session publishes an inbox in its
// registry record (`~/.claude/sessions/<pid>.json`): `messagingSocketPath`,
// `peerProtocol`, `peerFeatures`. The wire format is not reverse-engineered here --
// Claude Code documents it in its own help text, which is where these two lines come
// from verbatim:
//
//     { echo '{"type":"auth","token":"'"$CLAUDE_CODE_MESSAGING_TOKEN"'"}';
//       echo '{"type":"user","message":{"role":"user","content":"hello"}}'; } | socat - UNIX-CONNECT:<sock>
//
// Line-delimited JSON, one connection per message. Measured on this Mac
// (2026-09-16 13:10, throwaway session `ec2e55b0` in a scratch cwd): the message
// landed as a real user turn, the idle session woke, answered in about three
// seconds, and the terminal it was running in painted the whole exchange. That is
// the continuity this module is for.
//
// ONE MECHANISM, BOTH SURFACES. The registry census that afternoon showed ten live
// records -- `claude-desktop`, `cli` and `sdk-cli` -- carrying the SAME fields and
// the same `peerProtocol: 1`. Claude Code does not distinguish a Desktop tab from a
// terminal for messaging, so neither does this file. There is no Desktop branch and
// no iTerm branch to drift apart.
//
// AUTH IS OPTIONAL, AND THAT IS A REASON FOR THE PIN, NOT AGAINST IT. A canary with
// a deliberately wrong token still delivered; Claude Code says so itself ("peers will
// send unauthenticated (accepted: auth is optional on this platform)"). So the token
// is sent when the key file is readable -- forward-compatible if that ever tightens --
// and its absence is not a failure. What actually protects the delivery is the
// `session_id` pin: the receiver drops any frame whose `session_id` is not its own
// (`[uds-messaging] Dropping ... message: session_id mismatch`). Pids are recycled by
// the OS and a socket path is just a pid; the pin is what stops a turn meant for a
// dead session landing in whatever now owns that number. Every frame carries it, and
// selection matches the FULL session id -- never the 8-char prefix the wire uses
// elsewhere, because a prefix is exactly the ambiguity the pin exists to remove.
//
// A SEND IS NOT A DELIVERY. Writing bytes into a socket proves nothing: the receiver
// may drop the frame on the pin, hold it behind its own permission policy, or be
// shutting down. So this module reports `delivered` only when the session's own
// transcript shows it accepted the message. Claude Code writes a `queue-operation`
// row with `operation: 'enqueue'` and the verbatim content the instant it accepts one
// -- before the turn runs -- so acceptance is provable in milliseconds even when the
// session is mid-turn and will not answer for minutes. Anything else is `unverified`,
// and unverified falls back to the spawn path that works today.
//
// FAILS TOWARD THE PATH THAT ALREADY WORKS. Every refusal in this file -- flag off,
// no record, no socket, unknown protocol, connect error, write error, no acceptance
// row -- returns `ok: false` with a reason, and the caller spawns the resume child
// exactly as 6.48.2 does. This module can only ever make delivery BETTER; it has no
// branch that can make it worse.

import { connect } from 'node:net'

/** The only protocol this file knows how to speak. Anything else falls back. */
export const PEER_INBOX_PROTOCOL = 1

/** How long to wait for the connection itself. A live socket accepts immediately;
 *  a stale path fails with ENOENT/ECONNREFUSED in microseconds. */
export const PEER_CONNECT_TIMEOUT_MS = 1_500

/** How long to wait for the session's transcript to show acceptance.
 *
 *  THE ACCEPTANCE WINDOW, NOT THE REPLY WINDOW. The enqueue row is written when the
 *  message is taken, not when the turn finishes, and the measured latency for that
 *  row was under a second on an idle session (257 ms on the first device delivery).
 *  Four seconds leaves room for a session busy at its own bookkeeping and still
 *  sits inside the phone's 10 s request budget with the gate, the head read and a
 *  1.5 s connect in front of it. THE ONE SOURCE: the turn route passes this same
 *  constant (6.49.1; it used to carry its own 4 s while this file defaulted to 6 s,
 *  and a QA mutation deleting the route's field went unnoticed). */
export const PEER_VERIFY_TIMEOUT_MS = 4_000

/** Transcript poll interval while waiting for acceptance. */
export const PEER_VERIFY_POLL_MS = 250

/** Rows older than this before the send cannot be evidence of it.
 *
 *  The transcript's ISO stamps and our clock are the SAME clock (one Mac, one
 *  kernel), so this is not skew cover. It is the width of the window in which a
 *  prompt typed at the desk with the same first 120 characters would be mistaken for
 *  ours, traded against a row stamped a beat before our `now()` by a writer that
 *  timestamps before it appends. Two seconds keeps the second and makes the first
 *  need a same-words prompt inside two seconds of the lens send. */
export const PEER_ACCEPTANCE_BACKDATE_MS = 2_000

/** Enough of the prompt to identify the row without depending on the whole of it
 *  surviving verbatim (a long paste may be elided in some writers). */
export const PEER_MARKER_CHARS = 120

/** Bytes read PAST the transcript's size at send time when looking for acceptance.
 *
 *  The acceptance rows are small and land within a second of the send, but the rows
 *  written AFTER them are not: a single tool result can be over a megabyte (18 rows
 *  above 256 KiB in one real session, max 1.1 MB), and a fixed tail read would lose
 *  the evidence behind one of them on the memo's re-check. So the caller notes the
 *  file size before the send and every read covers from there to the end, plus this
 *  slack for a row already mid-write at the moment of the size read. */
export const PEER_ACCEPTANCE_READ_SLACK_BYTES = 64 * 1024

/** One live session as the registry describes it. */
export interface PeerInboxRecord {
  pid: number
  /** FULL session id. A prefix is never enough here; see the header. */
  sessionId: string
  socketPath: string | null
  peerProtocol: number | null
  entrypoint: string | null
  status: string | null
  /** Epoch ms the process started (registry `startedAt`), for the newest-window rule (6.49.1). */
  startedAt?: number | null
}

export type PeerDeliveryReason =
  | 'delivered'
  | 'disabled'
  | 'not_claude'
  | 'no_record'
  | 'protocol_unsupported'
  | 'connect_failed'
  | 'write_failed'
  | 'unverified'
  | 'suspect_expired'

/** How the transcript proved it. `enqueue` is the fast path; `user_row` covers a
 *  session that admitted the turn straight into a running turn. */
export type PeerAcceptanceKind = 'enqueue' | 'user_row'

export interface PeerDeliveryResult {
  ok: boolean
  reason: PeerDeliveryReason
  /** Null unless `ok`. */
  verifiedBy: PeerAcceptanceKind | null
  /** Wall clock from first connect attempt to verdict, for the health row. */
  elapsedMs: number
  /** The pid the frame was addressed to, for the audit line. Null when none was chosen. */
  pid: number | null
}

/**
 * Which live record, if any, should receive this turn.
 *
 * FULL-ID EQUALITY, AND THE NON-COS RECORD WINS. A COS-spawned resume child
 * registers under the SAME session id as the tab it resumed (6.48.1 found this the
 * hard way), so an id can name two live processes: the user's window and a child of
 * ours. Delivering into our own short-lived child would paint nothing and race the
 * child's own exit, so a record whose pid the ownership store claims is skipped
 * whenever another record is available -- and skipped entirely rather than preferred,
 * because a turn delivered to a process that is about to exit is worse than one that
 * falls back to a fresh child.
 */
export function selectPeerInbox(
  sessionId: string,
  records: readonly PeerInboxRecord[],
  isCosOwnedPid: (pid: number) => boolean = () => false,
): PeerInboxRecord | null {
  const id = String(sessionId || '').trim()
  if (id.length === 0) return null
  const matches = records.filter(r =>
    r.sessionId === id
    && typeof r.socketPath === 'string'
    && r.socketPath.length > 0
    && Number.isInteger(r.pid)
    && r.pid > 0)
  if (matches.length === 0) return null
  const theirs = matches.filter(r => !isCosOwnedPid(r.pid))
  const pool = theirs.length > 0 ? theirs : []
  if (pool.length === 0) return null
  // Newest record wins when the user somehow has two windows on one session: the one
  // started most recently is the one they are looking at. BY START TIME, not pid
  // (6.49.1): macOS recycles pids, and this Mac's counter wrapped twice in one day
  // (registry on 2026-09-16: 82615 started before 45962 before 10487). A record with
  // no start time sorts last, then by pid as before.
  const chosen = [...pool].sort((a, b) => {
    const sa = typeof a.startedAt === 'number' && Number.isFinite(a.startedAt) ? a.startedAt : -1
    const sb = typeof b.startedAt === 'number' && Number.isFinite(b.startedAt) ? b.startedAt : -1
    return sb !== sa ? sb - sa : b.pid - a.pid
  })[0]
  return chosen ?? null
}

/**
 * The two lines that go on the wire, in order.
 *
 * The auth line is omitted entirely when no token was readable, rather than sent
 * empty: an empty token is a failed auth attempt, and a missing one is the
 * unauthenticated path Claude Code documents as acceptable.
 */
export function peerInboxFrames(sessionId: string, prompt: string, token: string | null): string[] {
  const frames: string[] = []
  if (typeof token === 'string' && token.length > 0) {
    frames.push(JSON.stringify({ type: 'auth', token }))
  }
  frames.push(JSON.stringify({
    type: 'user',
    session_id: sessionId,
    message: { role: 'user', content: prompt },
  }))
  return frames
}

/** The identifying slice of the prompt, as it will appear in the transcript row. */
export function peerAcceptanceMarker(prompt: string): string {
  return String(prompt ?? '').slice(0, PEER_MARKER_CHARS)
}

/**
 * A send whose acceptance was never seen.
 *
 * NEVER RESENT, NEVER SPAWNED OVER, until it expires. A frame that was written but not
 * verified is in one of four places: dropped by the receiver, held behind its
 * permission policy, lost with a dying process, or accepted with the transcript row
 * still on its way. Three of those must not get a second copy, and the fourth turns
 * into `delivered` on the next look. So the caller refuses the turn as retryable, and
 * when the retry reaches this module (the route's occupancy gate runs first, so a
 * session busy with the turn we sent answers `native_thread_working` until it is
 * done) the transcript is checked from the ORIGINAL send time AND from the file size
 * at the original send (a late row counts, however much was written after it),
 * nothing is written to the socket again, and only once the memo is older than
 * `SUSPECT_TTL_MS` does the turn go to the spawn path -- the one place a duplicate
 * remains possible, and it is named in the health row when it does.
 */
export const SUSPECT_TTL_MS = 60_000

interface SuspectSend { marker: string; sentAtMs: number; sizeAtSend: number | null }
const suspects = new Map<string, SuspectSend>()

function suspectKey(sessionId: string, marker: string): string {
  return `${sessionId}\u0000${marker}`
}

/** Test seam. */
export function __resetPeerInboxSuspects(): void {
  suspects.clear()
}

/** One transcript row, reduced to what acceptance needs. */
export interface TranscriptRowLike {
  type?: unknown
  operation?: unknown
  content?: unknown
  message?: unknown
  timestamp?: unknown
  sessionId?: unknown
}

function rowText(row: TranscriptRowLike): string {
  if (typeof row.content === 'string') return row.content
  const message = row.message
  if (message && typeof message === 'object') {
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string')
          ? (part as { text: string }).text
          : '')
        .join(' ')
    }
  }
  return ''
}

function rowTimeMs(row: TranscriptRowLike): number | null {
  if (typeof row.timestamp !== 'string') return null
  const ms = Date.parse(row.timestamp)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Did these rows accept our message?
 *
 * PURE, so the contract can drive it over recorded rows. An `enqueue` row is the
 * proof Claude Code writes the moment it takes a message; a `user` row carrying the
 * same text is the same proof one step later. Rows that predate the send cannot be
 * evidence of it -- without that clause a retry of the same prompt would "verify"
 * against the previous delivery's own row and report a send that never happened.
 */
export function peerAcceptanceIn(
  rows: readonly TranscriptRowLike[],
  marker: string,
  sentAtMs: number,
): PeerAcceptanceKind | null {
  if (!marker) return null
  const floor = sentAtMs - PEER_ACCEPTANCE_BACKDATE_MS
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    const at = rowTimeMs(row)
    if (at !== null && at < floor) continue
    if (!rowText(row).includes(marker)) continue
    if (row.type === 'queue-operation' && row.operation === 'enqueue') return 'enqueue'
    if (row.type === 'user') return 'user_row'
  }
  return null
}

export interface PeerInboxDeps {
  /** Live registry records. The caller owns the read so this file stays pure of paths. */
  records: () => readonly PeerInboxRecord[] | Promise<readonly PeerInboxRecord[]>
  /** The session's peer token, or null when unreadable. Absence is not a failure. */
  token: (record: PeerInboxRecord) => string | null | Promise<string | null>
  /** The tail of the session's transcript, newest last. `minBytes`, when given, is
   *  how far back the read must reach (the bytes appended since the send plus slack);
   *  the reader may read more, never less. */
  transcriptTail: (sessionId: string, minBytes?: number) => readonly TranscriptRowLike[] | Promise<readonly TranscriptRowLike[]>
  /** The transcript's size in bytes right now, or null when unknown. Optional: without
   *  it every read is the reader's default tail. */
  transcriptSize?: (sessionId: string) => number | null | Promise<number | null>
  /** Pids COS itself spawned, so a resume child never receives the turn meant for the window. */
  isCosOwnedPid?: (pid: number) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Test seam. The real one opens the unix socket. */
  send?: (socketPath: string, frames: readonly string[]) => Promise<void>
  log?: (level: 'info' | 'warn', event: string, detail: Record<string, unknown>) => void
}

export interface PeerInboxRequest {
  provider: string
  sessionId: string
  prompt: string
  enabled: boolean
  verifyTimeoutMs?: number
  /** The client's idempotency key for this draft (6.49.1). When given, the suspect memo
   *  is keyed by it, so two drafts sharing their first 120 characters cannot collide and
   *  the same words under a NEW key are a new send, not a retry. The marker is still
   *  what is searched for in the transcript. */
  clientTurnId?: string
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Where a send failed. Before `connect` fired nothing was written, whatever the code. */
export type PeerSendPhase = 'connect' | 'write'

/** A rejection from `sendOverPeerSocket`, tagged with the phase it failed in. */
export interface PeerSendError extends Error {
  phase: PeerSendPhase
  code?: string
}

function tagPhase(error: Error, phase: PeerSendPhase): PeerSendError {
  const tagged = error as PeerSendError
  tagged.phase = phase
  return tagged
}

/** Open the socket, write the frames, close. Rejects on anything that is not a clean
 *  write, and every rejection carries `phase`: `connect` means no byte left this
 *  process (a missing path, a refused or hung socket, a file that is not a socket, a
 *  permission refusal), `write` means some may have. */
export function sendOverPeerSocket(socketPath: string, frames: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let phase: PeerSendPhase = 'connect'
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* already gone */ }
      if (error) reject(tagPhase(error, phase))
      else resolve()
    }
    const socket = connect(socketPath)
    const timer = setTimeout(() => finish(new Error('connect_timeout')), PEER_CONNECT_TIMEOUT_MS)
    timer.unref?.()
    socket.on('error', error => { clearTimeout(timer); finish(error instanceof Error ? error : new Error('socket_error')) })
    socket.on('connect', () => {
      clearTimeout(timer)
      phase = 'write'
      try {
        // One write, so a half-written pair cannot leave an auth line without its
        // message on a connection the receiver closes for silence.
        socket.write(frames.map(line => `${line}\n`).join(''), error => {
          if (error) { finish(error); return }
          // The receiver reads to end-of-line and acts; nothing is written back on
          // this protocol, so the send is complete once the bytes are flushed.
          socket.end()
          finish()
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error('write_failed'))
      }
    })
  })
}

/**
 * Try to put this turn into the running session. Never throws.
 *
 * The caller treats `ok: false` as "use the spawn path", which is what 6.48.2 does
 * today for every turn, so a false here costs nothing that was not already the cost.
 */
export async function deliverOverPeerInbox(
  request: PeerInboxRequest,
  deps: PeerInboxDeps,
): Promise<PeerDeliveryResult> {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? defaultSleep
  const send = deps.send ?? sendOverPeerSocket
  const log = deps.log ?? (() => {})
  const startedAt = now()
  const done = (ok: boolean, reason: PeerDeliveryReason, verifiedBy: PeerAcceptanceKind | null, pid: number | null): PeerDeliveryResult => {
    const result: PeerDeliveryResult = { ok, reason, verifiedBy, elapsedMs: Math.max(0, now() - startedAt), pid }
    log(ok ? 'info' : 'warn', 'peer_inbox.delivery', { ...result, session: request.sessionId.slice(0, 8) })
    return result
  }

  if (!request.enabled) return done(false, 'disabled', null, null)
  // Codex and Cursor sessions have no Claude Code inbox. They are not a failure here,
  // they are simply not this transport's business.
  if (request.provider !== 'claude') return done(false, 'not_claude', null, null)
  if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) return done(false, 'no_record', null, null)

  let records: readonly PeerInboxRecord[]
  try {
    records = await deps.records()
  } catch {
    return done(false, 'no_record', null, null)
  }
  const target = selectPeerInbox(request.sessionId, records, deps.isCosOwnedPid)
  if (!target) return done(false, 'no_record', null, null)
  // An unknown protocol is refused rather than attempted: the frames below are the
  // ones protocol 1 documents, and guessing at a successor is how a turn gets eaten.
  if (target.peerProtocol !== null && target.peerProtocol !== PEER_INBOX_PROTOCOL) {
    return done(false, 'protocol_unsupported', null, target.pid)
  }

  const marker = peerAcceptanceMarker(request.prompt)
  const key = suspectKey(request.sessionId, request.clientTurnId ? `id:${request.clientTurnId}` : marker)

  // A retry of a send that was never verified: look before writing anything.
  const suspect = suspects.get(key)
  if (suspect) {
    const rows = await readSince(request.sessionId, suspect.sizeAtSend)
    const seen = peerAcceptanceIn(rows, marker, suspect.sentAtMs)
    if (seen) {
      suspects.delete(key)
      return done(true, 'delivered', seen, target.pid)
    }
    if (now() - suspect.sentAtMs < SUSPECT_TTL_MS) return done(false, 'unverified', null, target.pid)
    suspects.delete(key)
    return done(false, 'suspect_expired', null, target.pid)
  }

  let token: string | null = null
  try { token = await deps.token(target) } catch { token = null }

  // The file size BEFORE the frame goes out, so every later read can start there.
  let sizeAtSend: number | null = null
  try { sizeAtSend = (await deps.transcriptSize?.(request.sessionId)) ?? null } catch { sizeAtSend = null }
  const sentAt = now()
  try {
    await send(target.socketPath!, peerInboxFrames(target.sessionId, request.prompt, token))
  } catch (error) {
    const phase = (error as Partial<PeerSendError> | undefined)?.phase
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    // Before `connect` fired nothing was written: a stale path (ENOENT), a dead
    // listener (ECONNREFUSED), a hung one (connect_timeout), a file that is not a
    // socket, a permission refusal. All ordinary, all mean "spawn the child" now. A
    // failure AFTER connect may have written a partial frame, so it is a suspect.
    // (The code check stays for a `send` seam that does not tag the phase.)
    if (phase === 'connect' || code === 'ENOENT' || code === 'ECONNREFUSED') return done(false, 'connect_failed', null, target.pid)
    suspects.set(key, { marker, sentAtMs: sentAt, sizeAtSend })
    return done(false, 'write_failed', null, target.pid)
  }

  const deadline = sentAt + Math.max(0, request.verifyTimeoutMs ?? PEER_VERIFY_TIMEOUT_MS)
  for (;;) {
    const rows = await readSince(request.sessionId, sizeAtSend)
    const seen = peerAcceptanceIn(rows, marker, sentAt)
    if (seen) return done(true, 'delivered', seen, target.pid)
    if (now() >= deadline) break
    await sleep(PEER_VERIFY_POLL_MS)
  }
  suspects.set(key, { marker, sentAtMs: sentAt, sizeAtSend })
  return done(false, 'unverified', null, target.pid)

  /** The rows appended since the send (plus the reader's own default tail). Never throws. */
  async function readSince(sessionId: string, since: number | null): Promise<readonly TranscriptRowLike[]> {
    let minBytes: number | undefined
    if (since !== null) {
      try {
        const size = (await deps.transcriptSize?.(sessionId)) ?? null
        if (size !== null && size >= since) minBytes = size - since + PEER_ACCEPTANCE_READ_SLACK_BYTES
      } catch { minBytes = undefined }
    }
    try { return await deps.transcriptTail(sessionId, minBytes) } catch { return [] }
  }
}
