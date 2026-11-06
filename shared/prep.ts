/**
 * Prep v1.1 (server 6.99.19, protocol 1): notes and files added before a call, a prep run from them, and an explicit
 * bind that carries them into the live meeting and its saved notes. Contract: PREP_CONTRACT_v1_2026-11-06.md, with its
 * "v1.1 amendments" section (which wins where they differ).
 *
 * Identity rule: a draft is NEVER matched to a meeting by its title or time. `occurrence` is filled only when a client
 * (or a future calendar bridge) supplies provider, calendarId, eventId or externalId, and startsAt; its key only FINDS a
 * draft. Files reach a meeting only through POST /prep/drafts/:id/bind with that meeting's sessionId.
 *
 * Types, pure validators and the Web Crypto client job id only: no node imports, so a browser bundle can share it.
 *
 * Routes (all under /api, X-Cos-Token, Cache-Control: no-store; writes answer 503 {error:'maintenance'} while a
 * maintenance drain is closing admissions). Every mutation requires the header X-COS-Expected-Server-Instance
 * (v1.1 #19): missing is 428 {error:'server_instance_required'}, a different server is 409
 * {error:'server_instance_mismatch'}. A body serverInstanceId is also checked when sent. Every JSON response, errors
 * included, carries the top-level `serverInstanceId`; the original-bytes route sends it as X-COS-Server-Instance.
 * - POST   /prep/drafts {clientDraftId,title?,startsAt?,occurrence?} -> 201 {draft} (200 and the same draft on a repeat)
 * - GET    /prep/drafts?occurrence=&state=active&limit=20 -> {drafts}, newest first
 * - GET    /prep/drafts/:id -> {draft}
 * - PATCH  /prep/drafts/:id {revision,title?,startsAt?,steer?,occurrence?} -> {draft}; stale -> 409 {error:'revision_conflict',draft}
 * - POST   /prep/drafts/:id/files {operationId,revision,media:[{id,name?,sourceRef?,sha256}]} -> {draft}; over 10 -> 413
 *          {error:'prep_file_limit'}; a copy whose sha256 differs -> 409 {error:'media_hash_mismatch'} with nothing written
 * - DELETE /prep/drafts/:id/files/:fileId?revision=N -> {draft}
 * - GET    /prep/drafts/:id/files/:fileId -> original bytes; GET .../text -> {text} ('' for a held or unread file)
 * - POST   /prep/drafts/:id/run {clientRequestId,revision,model?,effort?,continue?} -> 202 {job,run,draft}
 * - GET    /prep/drafts/:id/runs/:clientRequestId -> 200 {run,job} once admitted; 202 {run} while its admission is in
 *          flight; 404 {error:'run_not_accepted', run?} when no job exists for it and none is being admitted (a
 *          'submitting' run left by a restart: send the same run again); 503 {error:'run_status_unknown'} when the
 *          job lookup failed
 * - POST   /prep/drafts/:id/bind {revision,sessionId,surface,serverInstanceId?} -> {draft,files}
 * - DELETE /prep/drafts/:id/bind/:sessionId -> {draft}
 * - GET    /prep/by-session/:sessionId -> {snapshots: PrepSessionSnapshot[]} (frozen per bind, never the latest draft)
 * - GET    /prep/suggest?sessionId=&startedAt=<ms> -> {drafts} (suggestions only, never a bind)
 *
 * Replay before CAS (v1.1 #3): a repeat of a create (clientDraftId), files call (operationId), run (clientRequestId) or
 * bind (sessionId + revision) returns the original result without checking revision. A repeat with a different body is
 * 409 {error:'request_reused'}.
 */

export const PREP_PROTOCOL = 1 as const

export const PREP_LIMITS = Object.freeze({
  /** Files per draft, counting every file not removed. */
  maxFiles: 10,
  steerChars: 4_000,
  titleChars: 300,
  /** Extracted text kept per file, in UTF-8 bytes (the phone Meeting Ask file cap). Also the answer kept on a run. */
  fileTextBytes: 100_000,
  activeDrafts: 300,
  /** The whole Prep store: drafts, originals, extracted text and run prompts. */
  storeBytes: 1024 * 1024 * 1024,
  /** The durable query job prompt limit (QUERY_JOB_LIMITS.promptChars). */
  promptChars: 48_000,
  listLimit: 50,
  /** Meeting Ask's limits for one meeting's files (MeetingAskStore.putFiles), checked before a bind writes. */
  meetingFiles: 100,
  meetingTextBytes: 500_000,
})

/** GET /api/health -> capabilities.prep (health adds `serverInstanceId`). Absent on an older server: "Prep me" stays a plain Ask. */
export const PREP_CAPABILITY = Object.freeze({ protocol: PREP_PROTOCOL, maxFiles: PREP_LIMITS.maxFiles, steerChars: PREP_LIMITS.steerChars, bind: true, suggest: true })

export type PrepProvider = 'eventkit' | 'm365' | 'google'
export type PrepSurface = 'web' | 'control' | 'phone' | 'g2'
export type PrepFileKind = 'document' | 'image' | 'text' | 'other'
export type PrepFileStatus = 'ready' | 'unsupported' | 'failed' | 'secret-held' | 'removed'

export interface PrepOccurrence {
  /**
   * "occ:v2:" + hex sha256("occ:v2:" + provider + "|" + account + "|" + calendarId + "|" + (eventId or "") + "|" +
   * (externalId or "") + "|" + startsAt as exact UTC ISO, e.g. 2026-11-06T22:00:00.000Z). No quantization: distinct
   * occurrences never share a key. Lookup only; it never binds.
   */
  key: string
  provider: PrepProvider
  /** The calendar account (an email or provider account id), or null when the provider has none. */
  account: string | null
  calendarId: string
  eventId: string | null
  externalId: string | null
  startsAt: string
  endsAt: string | null
}

export interface PrepFile {
  id: string
  /** The /api/media id it was copied from: one draft never holds the same media twice. */
  mediaId: string
  name: string
  mime: string
  bytes: number
  /**
   * sha256 (lowercase hex) of the bytes the Prep store keeps for this file, which are the bytes /api/media stored.
   * For documents and plain text (and a video /api/media has not compressed) those are exactly the bytes the client
   * uploaded, so this equals uploadSha256 and the add was refused unless they matched. For images /api/media keeps a
   * re-encoded JPEG (original-normalized.jpg), so this is the hash of that JPEG and differs from uploadSha256.
   */
  sha256: string
  /**
   * The sha256 the client sent in POST files: the hash of the bytes it sent to /api/media. Checked against the copy
   * where /api/media keeps bytes verbatim (409 media_hash_mismatch otherwise). Where /api/media re-encodes (images, a
   * compressed video) the upload's bytes no longer exist on the server, so the copy is checked against the media
   * store's own hash of what it stored instead, and this value is kept as the client's statement.
   */
  uploadSha256: string
  addedAt: string
  kind: PrepFileKind
  status: PrepFileStatus
  notice?: string
  textChars: number
  source: 'upload' | 'control-local'
  /** Control's opaque local source id, echoed back, never interpreted. */
  sourceRef?: string
}

/** One files call, kept so a repeat of its operationId replays (v1.1 #14). */
export interface PrepFileOperation {
  operationId: string
  fingerprint: string
  fileIds: string[]
  at: string
}

/**
 * One run, frozen when it was asked (v1.1 #7). `state` is 'submitting' from the moment the prompt is saved until the
 * job is admitted ('accepted'), or 'failed' when the admission refused it. Once the job ends, its status and answer
 * (up to 100 KB) are copied here, so saved review outlives job retention.
 */
export interface PrepRun {
  clientRequestId: string
  clientJobId: string
  jobId: string | null
  sessionId: string | null
  draftRevision: number
  createdAt: string
  state: 'submitting' | 'accepted' | 'failed'
  /** sha256 of the canonical request minus volatile fields (revision, serverInstanceId). */
  fingerprint: string
  promptSha256: string
  steerSha256: string
  files: Array<{ id: string; sha256: string }>
  model?: string
  effort?: string
  continue?: boolean
  error?: string
  /** Copied from the job once it is terminal (optional per v1.1 #22; absent means read the job, or it is gone). */
  status?: string
  answer?: string
  answerTruncated?: boolean
  settledAt?: string
}

/**
 * What one bind adopted, frozen (v1.1 #21), exactly {draftRevision, steer, files}. `revision` is the Meeting Ask copy
 * revision (prep_<draftId>_<fileId> in the meeting); `sha256` is PrepFile.sha256. A re-bind is a new snapshot.
 */
export interface PrepBindingSnapshot {
  draftRevision: number
  steer: string
  files: Array<{ id: string; name: string; revision: string; sha256: string }>
}

/**
 * One row of GET /prep/by-session/:sessionId -> {serverInstanceId, snapshots}: a binding's frozen snapshot plus the
 * title and start frozen with it. Never the latest draft, so an edit after a bind cannot rewrite what the meeting used.
 */
export interface PrepSessionSnapshot extends PrepBindingSnapshot {
  draftId: string
  sessionId: string
  title: string
  startsAt: string | null
  surface: PrepSurface
  state: 'applying' | 'applied'
  boundAt: string
  removedAt?: string
}

/**
 * 413 {error:'file_context_limit', needBytes, haveBytes, needFiles, haveFiles} from a bind, with nothing written.
 * needBytes: UTF-8 text bytes this bind would put in the meeting (the notes and each adopted file).
 * haveBytes: room left, 500,000 minus the text bytes of the meeting's current files that are not this draft's own
 * copies (a bind replaces its own copies). needFiles: the meeting's file count after the bind. haveFiles: 100.
 */
export interface PrepFileContextLimit { error: 'file_context_limit'; needBytes: number; haveBytes: number; needFiles: number; haveFiles: number }

/** A bind is written as 'applying' before the meeting files change and 'applied' after (v1.1 #11). */
export interface PrepBinding {
  sessionId: string
  serverInstanceId: string
  /** The draft revision this bind froze and attached. */
  revision: number
  state: 'applying' | 'applied'
  boundAt: string
  surface: PrepSurface
  /** The Meeting Ask file ids this bind adopted (prep_<draftId>_steer, prep_<draftId>_<fileId>). */
  fileIds: string[]
  snapshot: PrepBindingSnapshot
  /** The draft's title and start when it was bound, frozen with the snapshot. */
  title: string
  startsAt: string | null
  removedAt?: string
}

export interface PrepDraft {
  id: string
  clientDraftId: string
  /** The server that holds this draft (getServerInstanceId()), or null before it has one. */
  serverInstanceId: string | null
  /** CAS revision: +1 on every write. */
  revision: number
  createdAt: string
  updatedAt: string
  title: string
  /** Display only; never used to match a meeting. */
  startsAt: string | null
  occurrence: PrepOccurrence | null
  identity: 'provider' | 'none'
  steer: string
  files: PrepFile[]
  fileOperations: PrepFileOperation[]
  runs: PrepRun[]
  conversation: { sessionId: string | null }
  bindings: PrepBinding[]
  state: 'active' | 'archived'
}

/** "prep_" + 26 lowercase base32 (RFC 4648 alphabet). */
export const PREP_DRAFT_ID = /^prep_[a-z2-7]{26}$/
/** "pf_" + 16 hex. */
export const PREP_FILE_ID = /^pf_[0-9a-f]{16}$/
/** A client-made identity (clientDraftId, clientRequestId, operationId): a lowercase UUID v4. */
export const PREP_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const PREP_PROVIDERS: readonly PrepProvider[] = ['eventkit', 'm365', 'google']
export const PREP_SURFACES: readonly PrepSurface[] = ['web', 'control', 'phone', 'g2']

/** The Meeting Ask file id the steer text takes in a bound meeting. */
export function prepSteerFileId(draftId: string): string { return `prep_${draftId}_steer` }
/** The Meeting Ask file id a Prep file takes in a bound meeting. */
export function prepAdoptedFileId(draftId: string, fileId: string): string { return `prep_${draftId}_${fileId}` }
/** The Meeting Ask file name of the steer text. */
export const PREP_STEER_FILE_NAME = 'Prep notes'

/** The text prefix hashed into a Prep run's clientJobId. */
export const PREP_RUN_JOB_PREFIX = 'prep-run:v1:'

/**
 * The durable query job identity of one Prep run (generation 1), v1.1 #5:
 *
 *   hex  = sha256(UTF-8 of "prep-run:v1:" + draftId + ":" + clientRequestId)
 *   hex[12] = '4'; hex[16] = '89ab'[parseInt(hex[16], 16) & 3]   (UUID v4 version and variant)
 *   id   = hex[0:8]-hex[8:12]-hex[12:16]-hex[16:20]-hex[20:32]
 *
 * A client that lost the 202 can find the job with GET /api/query-jobs/by-client/<id>?generation=1 (or
 * GET /api/prep/drafts/:id/runs/:clientRequestId), and the server finds the same job on a retry instead of submitting
 * a second one. Web Crypto (browsers and Node 20+), so the server, the web client and tests share this function.
 */
export async function prepClientJobId(draftId: string, clientRequestId: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${PREP_RUN_JOB_PREFIX}${draftId}:${clientRequestId}`))
  return uuidV4FromHex([...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''))
}

/** The first 32 hex characters with the UUID v4 version and variant nibbles forced, dashed 8-4-4-4-12. */
export function uuidV4FromHex(hex: string): string {
  const h = hex.slice(0, 32).toLowerCase().split('')
  h[12] = '4'
  h[16] = '89ab'[parseInt(h[16], 16) & 3]
  const s = h.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}
