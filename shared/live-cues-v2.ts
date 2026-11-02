/**
 * Live cues v2 wire contract (server 6.75 candidate, companion 6.10.641 candidate; optional capability fields since 6.76.2).
 * Additive to v1: old clients keep receiving `coaching_nudge` and ignore the new named event.
 * The companion keeps a byte-identical copy at src/lib/live-cues-v2-contract.ts.
 * 6.86.0 widens CueKind (additive for every meeting that did not opt in; see CueKind). A companion that has not taken this
 * copy keeps validating the two legacy kinds, which is safe because it is never sent anything else.
 */
export const LIVE_CUES_V2_PROTOCOL = 2 as const
export const CUE_HEADLINE_MAX = 64
export const CUE_DETAIL_MAX = 220
export const CUE_FEEDBACK_REASON_MAX = 200

/** 6.86.0: three more kinds for COS Control's live meeting view. A meeting gets them only when its armer opts in (a Mac
 *  recording, or POST /live-cues/start with `kinds: 'extended'`). Every other meeting keeps the two legacy kinds, so a
 *  companion that validates `kind` against reinforce | challenge never sees a cue it would drop. Readers must treat any
 *  kind they do not know as a plain cue, never as an error. */
export type CueKind = 'reinforce' | 'challenge' | 'decision' | 'promise' | 'followUp'
export const LEGACY_CUE_KINDS = ['reinforce', 'challenge'] as const
export const CUE_KINDS = ['reinforce', 'challenge', 'decision', 'promise', 'followUp'] as const
export type CueKindSet = 'legacy' | 'extended'
export function isCueKind(value: unknown): value is CueKind {
  return typeof value === 'string' && (CUE_KINDS as readonly string[]).includes(value)
}
/** The legacy kind a v1 reader is shown for any kind (the `coaching_nudge` twin and the stop answer's `nudges`). */
export function legacyCueKind(kind: CueKind): 'reinforce' | 'challenge' {
  return kind === 'reinforce' || kind === 'decision' || kind === 'promise' ? 'reinforce' : 'challenge'
}

/** Live cues v3: general cues carry one kind of their own, `insight` (a short public fact with its source). It is separate from
 *  CUE_KINDS on purpose: CUE_KINDS decides what a meeting may receive and what health advertises, and the three arrays above
 *  and legacyCueKind do not know it. Only an extended (Mac) meeting ever gets one; a legacy meeting never does, and an insight
 *  never has a v1 `coaching_nudge` twin. */
export const GENERAL_CUE_KINDS = ['insight'] as const
export type GeneralCueKind = typeof GENERAL_CUE_KINDS[number]
/** Any kind a cue row (the log, a verdict, an extended meeting's stream) may carry. */
export function isLogCueKind(value: unknown): value is CueKind | GeneralCueKind {
  return isCueKind(value) || (typeof value === 'string' && (GENERAL_CUE_KINDS as readonly string[]).includes(value))
}

/** What a cue source is: a past meeting, a COS memory, a file attached to this meeting, or a public web page. */
export const CUE_SOURCE_KINDS = ['meeting', 'memory', 'file', 'web'] as const
export type CueSourceKind = typeof CUE_SOURCE_KINDS[number]
/** A past meeting the cue drew on (0 to 2 per cue). Live cues v3 adds an optional kind and at most ONE locator matching it:
 *  meeting `recordId` (when known), memory `memoryId`, file `fileId`, web `url` (https only, and required for a web source).
 *  Older readers ignore them. */
export interface CueSourceRef { id: string; date: string; title: string; kind?: CueSourceKind; recordId?: string; memoryId?: string; fileId?: string; url?: string }
/** The locator field each source kind uses. */
export const CUE_SOURCE_LOCATOR = { meeting: 'recordId', memory: 'memoryId', file: 'fileId', web: 'url' } as const
/** Are the optional kind and locator of a source well formed: a known kind, no locator without it, at most one, and it matches
 *  the kind. A web url must be https (the server also checks it is a public address before it writes a row). */
export function isCueSourceExtras(source: CueSourceRef): boolean {
  const locators = (['recordId', 'memoryId', 'fileId', 'url'] as const).filter(k => source[k] !== undefined)
  if (source.kind === undefined) return locators.length === 0
  if (!(CUE_SOURCE_KINDS as readonly string[]).includes(source.kind)) return false
  if (locators.length > 1) return false
  if (source.kind === 'web' && source.url === undefined) return false
  if (locators.length === 1 && locators[0] !== CUE_SOURCE_LOCATOR[source.kind]) return false
  const value = locators.length === 1 ? source[locators[0]] : undefined
  if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > 2048)) return false
  return source.url === undefined || source.url.startsWith('https://')
}

/** SSE named event `coaching_nudge_v2` (emitted BEFORE its v1 `coaching_nudge` twin), and the rows of GET /api/live-cues/status?sessionId=. */
export interface LiveCueV2 {
  protocol: 2
  cueId: string
  sessionId: string
  /** <= 64 chars: the lens footer line. */
  headline: string
  /** <= 220 chars: the full cue, shown on tap and in the phone Cues sheet. */
  detail: string
  /** An extended (Mac) meeting may also receive `insight` (live cues v3); a legacy meeting never does. */
  kind: CueKind | GeneralCueKind
  sources: CueSourceRef[]
  /** Admission probability from the gate, 0 to 1. */
  gate: number
  createdAt: number
  model: string
}

/** v1 `coaching_nudge` as the v2 engine emits it for old clients (headline only). */
export interface LiveCueV1Compat { nudge: string; type: 'reinforce' | 'challenge'; priority: 2; cueId: string; sessionId: string; protocol: 2 }

/** `reason` when unavailable: master_flag_off, api_key_in_env, decision_invalid_provider, decision_not_configured (no key
 *  for the selected decision provider; jev_not_configured when Jev was chosen and only a SubQ key exists), claude_not_found,
 *  budget_exhausted, jev_cap_reached, jev_breaker_open, decision_cap_reached, decision_breaker_open (the last two for SubQ).
 *  Server 6.76.2 adds two optional fields; older servers omit them. `memory`: where past notes come from (cue_memory.py,
 *  the owner's own COS notes and meetings, or nothing). `decisionProvider`: which classifier runs the gate and the judge. */
export type LiveCuesV2MemorySource = 'cue_memory' | 'notes' | 'none'
export interface LiveCuesV2Capability { available: boolean; reason?: string; protocol: 2; model: string; memory?: LiveCuesV2MemorySource; decisionProvider?: 'jev' | 'subq' }

/** Why cues are not coming for this meeting. `active` means evaluations are running normally (silence is a choice). */
export type LiveCuesV2SessionState = 'active' | 'paused' | 'ended' | 'stopped'
export type LiveCuesV2StopReason = 'breaker_open' | 'meeting_cap' | 'budget_exhausted' | 'jev_cap_reached' | 'jev_breaker_open' | 'jev_not_configured'
  | 'decision_cap_reached' | 'decision_breaker_open' | 'decision_not_configured' | 'decision_invalid_provider'

export interface LiveCuesV2SessionStatus {
  sessionId: string
  state: LiveCuesV2SessionState
  /** Present when state is `stopped`. */
  reason?: LiveCuesV2StopReason
  paused: boolean
  ended: boolean
  /** The pause request sequence the server last applied (0 when none). */
  pauseSeq: number
  cues: LiveCueV2[]
  evaluations: number
  writerCalls: number
}

/** GET /api/live-cues/status?sessionId=X (v2 server). Without sessionId the v1 array shape is unchanged. */
export interface LiveCuesV2StatusResponse { protocol: 2; enabled: boolean; session: LiveCuesV2SessionStatus | null }

/** POST /api/live-cues/pause -> { ok, paused, applied, pauseSeq }. `seq` is a per-meeting counter from the phone; the server
 *  ignores a request whose seq is not newer than the last applied one (applied: false) so out-of-order posts cannot win. */
export interface LiveCuesPauseRequest { sessionId: string; paused: boolean; seq?: number }
/** POST /api/live-cues/feedback */
export interface LiveCuesFeedbackRequest { sessionId: string; cueId: string; vote: 'up' | 'down'; reason?: string }

export function isLiveCueV2(value: unknown): value is LiveCueV2 {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.protocol === 2 && typeof v.cueId === 'string' && v.cueId.length > 0 && typeof v.sessionId === 'string'
    && typeof v.headline === 'string' && v.headline.length > 0 && v.headline.length <= CUE_HEADLINE_MAX
    && typeof v.detail === 'string' && v.detail.length > 0 && v.detail.length <= CUE_DETAIL_MAX
    && isLogCueKind(v.kind)
    && Array.isArray(v.sources) && v.sources.length <= 2
    && v.sources.every(s => !!s && typeof (s as CueSourceRef).id === 'string' && typeof (s as CueSourceRef).date === 'string' && typeof (s as CueSourceRef).title === 'string'
      && isCueSourceExtras(s as CueSourceRef))
    && typeof v.gate === 'number' && typeof v.createdAt === 'number' && typeof v.model === 'string'
}
