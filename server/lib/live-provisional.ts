// 6.86.0: the newest provisional (grey) line of a live meeting, for COS Control's live meeting view.
//
// The preview route (POST /transcribe-stream/preview) already turns the still-open phrase into fast provisional text and
// hands it to the client that posted the audio. Control reads the meeting from the active-session file and does not post
// the glasses audio, so it never saw that text. This keeps ONE entry per live meeting, the newest preview, in memory only,
// and GET /transcribe-stream/provisional serves it. The canonical chunk that settles the same index removes it.
//
// Why memory and a route, not a field in active-sessions/<id>.json:
//   - that file is the 4-hour crash-recovery record. Anything written there outlives a crash; this text must not outlive
//     the live session, so it never touches disk;
//   - the file is written with fsync before each chunk is acknowledged. Writing it again per preview would add a durable
//     write on the recording path, and churn the stamp Control uses to skip unchanged reads.
//
// Never logged: this module has no console call, and the route answers only to an authenticated client. Bounded: at most
// LIVE_PROVISIONAL_LIMITS.maxSessions meetings, the last maxChars characters, and an entry older than ttlMs reads as none.

export const LIVE_PROVISIONAL_LIMITS = {
  /** The last characters (code points) of the preview are kept: the newest words are the ones still changing. */
  maxChars: 600,
  maxSessions: 8,
  /** A preview not replaced or settled within this long reads as none (the phone stopped posting, a stuck chunk). */
  ttlMs: 30_000,
} as const

export interface LiveProvisional {
  chunkIndex: number
  previewGen: number
  text: string
  model: string
  /** Epoch ms when the server stored it. */
  at: number
}

export class LiveProvisionalStore {
  private readonly entries = new Map<string, LiveProvisional>()
  constructor(private readonly now: () => number = Date.now) {}

  /** Keeps `entry` when it is newer than the one held: a later chunk, or the same chunk with a later previewGen. A
   *  preview that arrives after its chunk settled is refused by the caller (settledThrough), never stored here. */
  record(sessionId: string, entry: Omit<LiveProvisional, 'at'>): boolean {
    const text = Array.from(entry.text.replace(/\s+/g, ' ').trim()).slice(-LIVE_PROVISIONAL_LIMITS.maxChars).join('')
    if (!text) return false
    const held = this.entries.get(sessionId)
    if (held && !this.expired(held) && (entry.chunkIndex < held.chunkIndex || (entry.chunkIndex === held.chunkIndex && entry.previewGen <= held.previewGen))) return false
    this.entries.delete(sessionId)                      // re-insert, so Map order is oldest first for eviction
    this.entries.set(sessionId, { chunkIndex: entry.chunkIndex, previewGen: entry.previewGen, text, model: entry.model, at: this.now() })
    for (const [id, e] of this.entries) if (this.expired(e)) this.entries.delete(id)
    while (this.entries.size > LIVE_PROVISIONAL_LIMITS.maxSessions) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return true
  }

  /** The canonical answer for `chunkIndex` landed (text, silence or a drop): a preview for it or an earlier chunk goes. */
  settle(sessionId: string, chunkIndex: number): void {
    const held = this.entries.get(sessionId)
    if (held && held.chunkIndex <= chunkIndex) this.entries.delete(sessionId)
  }

  /** The meeting closed (saved, discarded, expired, quarantined). */
  clear(sessionId: string): void { this.entries.delete(sessionId) }

  read(sessionId: string): LiveProvisional | null {
    const held = this.entries.get(sessionId)
    if (!held) return null
    if (this.expired(held)) { this.entries.delete(sessionId); return null }
    return { ...held }
  }

  size(): number { return this.entries.size }

  private expired(e: LiveProvisional): boolean { return this.now() - e.at > LIVE_PROVISIONAL_LIMITS.ttlMs }
}

let store: LiveProvisionalStore | null = null
export function liveProvisional(): LiveProvisionalStore { return (store ??= new LiveProvisionalStore()) }

/** 6.86.0: what /api/health and /api/models publish as `capabilities.liveMeeting`, so COS Control gates the live meeting
 *  view by capability, never by a status code. Constants only (health is public). An older server omits the key.
 *  - macLiveCues: POST /api/mac-recording/start takes `liveCues: true` and answers `liveCues: {armed, ...}`.
 *  - provisional: GET <route>?sessionId= serves the newest preview of a live meeting.
 *  - chunkLevels (6.87.0): the active-session record keeps `chunkLevels[{i, level, speechSec}]` (lib/chunk-levels.ts). */
export function liveMeetingCapability(): { protocol: 1; macLiveCues: true; provisional: { route: string; maxChars: number; ttlMs: number }; chunkLevels: true } {
  return { protocol: 1, macLiveCues: true, provisional: { route: '/api/transcribe-stream/provisional', maxChars: LIVE_PROVISIONAL_LIMITS.maxChars, ttlMs: LIVE_PROVISIONAL_LIMITS.ttlMs }, chunkLevels: true }
}
