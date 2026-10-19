// Key lanes K1, package P6 (plan v4 sections 5.2 and 9.4): how a model preference that names a
// key profile is routed, refused or ignored. One module so every Accept site resolves a profile
// the same way and every refusal reads the same on the lens.
//
//   resolveKeyProfileTurn   `profile:<id>` to a runnable turn, or a lens line saying why not.
//                           Never a silent subscription turn: an unknown, disabled or keyless
//                           profile, or key lanes switched off, is a refusal.
//   registerKeyProfileEngine The seam P3 (claude), P4 (codex) and P5 (direct) register their
//                           keyed runner into. With no runner for an engine, the turn is refused.
//   profileSteerProvider    What a profile-bound job looks like to the steer gate (claude-steer
//                           returns `profile_session`; this decides which engine that means).
//   v1KeyProfileFor         `/v1` `cos-key-<id>` to a profile offered there, or a refusal.
//
// HARD RULE: nothing here runs for a preference that is not a well formed `profile:<id>` or
// `cos-key-<id>`. Every caller checks that syntax first (a pure string test, no file read), so a
// server with no profile takes exactly the 6.79.0 path. Importing this module reads no file,
// opens no socket and starts no timer. It imports only types from conversation.ts, so a test that
// loads it does not load the session store.
import type { CallOptions, StreamCallbacks } from './claude-bridge.js'
import type { ModelImageInput } from './model-image-input.js'
import type { KeyKind, KeyProfile, KeyProfileEngine } from './key-relay-contract.js'
import type { QueryProvider } from './claude-steer.js'
import { keyLanesActive } from './key-lanes.js'
import { KEY_LANE_REFUSAL_COPY } from './key-notices.js'
import { getProfile, listProfiles } from './key-profiles.js'
import { getPublicKey } from './key-store.js'
import type { KeyProfileBinding, PromptReference } from './conversation.js'
import { normalizeModelPreference } from '../../shared/model-preference.js'
import { isProfilePreference, profilePreference } from '../../shared/key-preference.js'

/** A profile that may run now: lanes active, the profile enabled, its key saved. */
export interface KeyProfileTurn {
  binding: KeyProfileBinding
  profile: KeyProfile
  keyKind: KeyKind
}

export type KeyProfileRefusalCode = 'key_profile_off' | 'key_profile_unavailable'

export type KeyProfileResolution =
  | { ok: true; turn: KeyProfileTurn }
  | { ok: false; code: KeyProfileRefusalCode; message: string }

// ── Lens copy (plan 11.3 "Profile off", 5.2 rejects). No em dashes, no arrows, one line each. ──

/** Plan 5.2 and 11.3: the one refusal for a profile that cannot run (missing, disabled, no key, lanes off). */
export function keyProfileOffLine(label: string): string {
  return KEY_LANE_REFUSAL_COPY.profileOff(label)
}
/** No runner is registered for the profile's engine on this build. */
export function keyProfileUnavailableLine(label: string): string {
  return KEY_LANE_REFUSAL_COPY.profileUnavailable(label)
}
/** Plan 9.4: a `cos-key-<id>` that is not an active profile with "Offer on /v1" on. */
export const KEY_PROFILE_V1_NOT_OFFERED = KEY_LANE_REFUSAL_COPY.v1NotOffered

function labelFor(id: string, profile: KeyProfile | undefined): string {
  return profile?.label?.trim() || id
}

/**
 * Resolve `profile:<id>`. Lanes off, an unknown id, a disabled profile or a profile whose key
 * was removed all refuse with the same line (the user's fix is the same: pick a model).
 */
export function resolveKeyProfileTurn(id: string): KeyProfileResolution {
  // Read only for its label when lanes are off: a stale binding still names the profile.
  const profile = getProfile(id)
  const off = (): KeyProfileResolution => ({ ok: false, code: 'key_profile_off', message: keyProfileOffLine(labelFor(id, profile)) })
  if (!keyLanesActive()) return off()
  if (!profile || !profile.enabled) return off()
  const key = getPublicKey(profile.keyRef)
  if (!key) return off()
  return { ok: true, turn: { binding: profilePreference(profile.id) as KeyProfileBinding, profile, keyKind: key.kind } }
}

// ── Engine seam (P3, P4, P5 register) ────────────────────────────────────────

/**
 * A keyed runner. Same arguments as the subscription bridges, plus the resolved turn. Contract:
 *   - call exactly one of callbacks.onDone / callbacks.onError (model-router's session run lock
 *     releases on that terminal callback);
 *   - stamp conversation exchanges with `turn.binding` (conversation accepts it by syntax);
 *   - the `model` it passes to onStart / onDone is ignored for linkage and display: callers read
 *     the binding from the `onKeyProfileTurn` callback below instead;
 *   - honor `options.steer` when present (only a `claude` engine profile is ever offered one).
 */
export type KeyProfileEngineRunner = (
  query: string,
  sessionId: string,
  callbacks: StreamCallbacks,
  turn: KeyProfileTurn,
  images?: ModelImageInput[],
  reference?: PromptReference,
  globalMsgNum?: number,
  options?: CallOptions,
) => Promise<string>

const engines = new Map<KeyProfileEngine, KeyProfileEngineRunner>()

/** Named by engine, so a re-registration replaces rather than stacks. */
export function registerKeyProfileEngine(engine: KeyProfileEngine, runner: KeyProfileEngineRunner): void {
  engines.set(engine, runner)
}

export function keyProfileEngineRunner(engine: KeyProfileEngine): KeyProfileEngineRunner | undefined {
  return engines.get(engine)
}

/** Tests only. */
export function __resetKeyProfileEnginesForTests(): void {
  engines.clear()
}

/**
 * Optional callback a caller of callModelStreaming may add. model-router calls it once, before
 * the keyed runner starts, and never for a subscription turn. The durable runtime and the SSE
 * route use it to report the binding (not the runner's tier) as the turn's model.
 */
export interface KeyProfileTurnCallbacks {
  onKeyProfileTurn?: (turn: KeyProfileTurn) => void
}

// ── Linkage and steer ────────────────────────────────────────────────────────

export type KeyProfileLinkageProvider = 'claude' | 'codex' | undefined

/** The job linkage provider for an engine. Direct (Lane C) has no CLI session; it is omitted. */
export function linkageProviderForEngine(engine: KeyProfileEngine): KeyProfileLinkageProvider {
  if (engine === 'claude') return 'claude'
  if (engine === 'codex') return 'codex'
  return undefined
}

/**
 * claude-steer's guard returned `profile_session`. Steerable (`claude`) only for an active,
 * enabled Lane B Claude profile; anything else answers with a provider the coordinator never
 * steers, so a Codex or direct profile, or a profile that would be refused, is `unsupported`.
 */
export function profileSteerProvider(id: string): QueryProvider {
  const resolved = resolveKeyProfileTurn(id)
  return resolved.ok && resolved.turn.profile.engine === 'claude' ? 'claude' : 'codex'
}

// ── /v1 (plan 9.4) ───────────────────────────────────────────────────────────

/** Profiles `/v1` offers: lanes active, enabled, "Offer on /v1" on, key saved. Empty when inactive. */
export function v1OfferedProfiles(): KeyProfile[] {
  if (!keyLanesActive()) return []
  return listProfiles().filter(p => p.enabled && p.offerOnV1 && getPublicKey(p.keyRef) !== undefined)
}

/** The offered profile for a `cos-key-<id>` id, or undefined (the route refuses it). */
export function v1OfferedProfile(id: string): KeyProfile | undefined {
  return v1OfferedProfiles().find(p => p.id === id)
}

// ── COS_G2_DEFAULT_MODEL (plan 5.2: closed) ──────────────────────────────────

let envProfileWarned = false

/** A profile id in COS_G2_DEFAULT_MODEL is ignored, with ONE warning per boot. Returns the closed default. */
export function closedEnvDefaultModel(raw: string | undefined = process.env.COS_G2_DEFAULT_MODEL) {
  if (!envProfileWarned && isProfilePreference(raw?.trim())) {
    envProfileWarned = true
    console.warn('[key-lanes] COS_G2_DEFAULT_MODEL names a key profile; ignored. Pick a profile from the picker instead.')
  }
  return normalizeModelPreference(raw)
}

/** Tests only. */
export function __resetEnvProfileWarningForTests(): void {
  envProfileWarned = false
}
