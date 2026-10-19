// Key lanes K1 P3 (plan v4 sections 4.4, 7.1, 7.2): the Lane B Claude child environment and the
// checks a keyed Claude turn passes before anything is spawned.
//
// Lane B runs the user's Claude Code CLI with the full harness, but pointed at the loopback relay
// (P2) instead of the subscription. The child never sees a real key: it gets a turn nonce that
// works only on 127.0.0.1, only during the turn, only under the cap.
//
// HARD RULE (zero impact without a key): nothing here runs unless a caller passes a key profile.
// Importing this module reads no file, opens no socket and starts no timer.
import { keyLanesActive } from './key-lanes.js'
import { getPublicKey } from './key-store.js'
import { claudeSettingsRefusal } from './claude-settings-guard.js'
import { KEY_LANE_CHILD_ENV, RELAY_BASE_PATHS } from './key-relay-contract.js'
import type { KeyKind, KeyProfile, KeyRelay } from './key-relay-contract.js'

/**
 * Provider-credential names a Lane B child never inherits (plan 7.2). Every other name (PATH,
 * HOME, COS_API_TOKEN, MCP and hook settings) is kept, unlike dictationChildEnv, which strips
 * every *API_KEY and rewrites PATH.
 */
export const LANE_B_STRIPPED_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENROUTER_API_KEY',
]
/** Plus every `ANTHROPIC_DEFAULT_<TIER>_MODEL`, whatever the tier is called. */
export const LANE_B_STRIPPED_PATTERN = /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/

export function isLaneBStrippedName(name: string): boolean {
  return LANE_B_STRIPPED_NAMES.includes(name) || LANE_B_STRIPPED_PATTERN.test(name)
}

/** Plan 4.4: every model name the CLI may read is the profile slug. ANTHROPIC_MODEL is never set: the slug goes on `--model`. */
export const LANE_B_CLAUDE_MODEL_NAMES: readonly string[] = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
]
/** Plan 4.6: the child retries a 429 or 5xx twice; the relay never retries itself. */
export const LANE_B_CLAUDE_MAX_RETRIES = '2'

/** The names applyLaneBClaudeEnv sets. With LANE_B_STRIPPED_NAMES this is the whole A-vs-B difference. */
export const LANE_B_CLAUDE_ADDED_NAMES: readonly string[] = [
  KEY_LANE_CHILD_ENV.claudeBaseUrl,
  KEY_LANE_CHILD_ENV.claudeToken,
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_MAX_RETRIES',
  ...LANE_B_CLAUDE_MODEL_NAMES,
  KEY_LANE_CHILD_ENV.profileMarker,
]

const LOOPBACK_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}$/

/** A copy of `base` minus the provider-credential names. `base` is never written. */
export function laneBBaseEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const name of Object.keys(env)) {
    if (isLaneBStrippedName(name)) delete env[name]
  }
  return env
}

export interface LaneBClaudeEnvSpec {
  /** The relay's `http://127.0.0.1:<port>` for this boot. */
  origin: string
  nonce: string
  /** The profile's model slug. */
  slug: string
  profileId: string
}

/**
 * Point a child env object (a copy, never process.env) at the relay. Strips the credential
 * names, then sets the relay base URL, the nonce as the Bearer, an empty API key, the retry
 * count, every model name to the slug and the profile marker. Agent teams stay off (stripped,
 * never re-added). Throws on a non-loopback origin: the relay only ever listens on 127.0.0.1.
 */
export function applyLaneBClaudeEnv(env: NodeJS.ProcessEnv, spec: LaneBClaudeEnvSpec): void {
  if (env === process.env) throw new Error('lane-b-env: refusing to write process.env')
  if (!LOOPBACK_ORIGIN_RE.test(spec.origin)) throw new Error('lane-b-env: the relay origin is not loopback')
  if (!spec.nonce || !spec.slug || !spec.profileId) throw new Error('lane-b-env: incomplete spec')
  for (const name of Object.keys(env)) {
    if (isLaneBStrippedName(name)) delete env[name]
  }
  env[KEY_LANE_CHILD_ENV.claudeBaseUrl] = spec.origin + RELAY_BASE_PATHS.claude
  env[KEY_LANE_CHILD_ENV.claudeToken] = spec.nonce
  env.ANTHROPIC_API_KEY = ''
  env.CLAUDE_CODE_MAX_RETRIES = LANE_B_CLAUDE_MAX_RETRIES
  for (const name of LANE_B_CLAUDE_MODEL_NAMES) env[name] = spec.slug
  env[KEY_LANE_CHILD_ENV.profileMarker] = spec.profileId
}

// ── The relay seam ──────────────────────────────────────────────────────────
// P2 owns the relay; this package consumes only the KeyRelay contract. P11 wires the real one
// in index.ts (`registerLaneBRelay(() => getKeyRelay())` or similar). Unregistered, every keyed
// turn is refused before spawn: there is no fallback to the subscription.

type RelayResolver = () => KeyRelay | Promise<KeyRelay>
let relayResolver: RelayResolver | null = null

export function registerLaneBRelay(resolver: RelayResolver | null): void {
  relayResolver = resolver
}

export function laneBRelayRegistered(): boolean {
  return relayResolver !== null
}

export async function laneBRelay(): Promise<KeyRelay> {
  if (!relayResolver) throw new Error('lane-b-env: no key relay registered')
  return await relayResolver()
}

// ── Lens copy ───────────────────────────────────────────────────────────────
// P8 (key-notices.ts) is the single source of key-lane strings; until it lands these are the plan
// 11.3 lines verbatim. No em dashes, no arrows, no sign-in wording.
export const LANE_B_COPY = {
  lanesOff: 'Key lanes are off. Pick a model.',
  profileOff: (label: string) => `Key profile ${label} is off. Pick a model.`,
  wrongEngine: (label: string) => `Key profile ${label} is not a Claude profile. Pick a model.`,
  keyMissing: (label: string) => `The key for profile ${label} is not saved on this Mac. Fix it in COS Control.`,
  scheduled: 'Key profiles cannot run scheduled briefs.',
  relayUnavailable: 'Your key could not start this turn. Your plan was not used.',
} as const

export type LaneBClaudePreflight = { ok: true; keyKind: KeyKind } | { ok: false; message: string }

/**
 * Everything a keyed Claude turn must pass before it touches history, the run ledger or a
 * process (plan 7.1, 7.2). Fails closed: any refusal ends the turn with its lens line and the
 * subscription is never used instead.
 */
export function laneBClaudePreflight(input: {
  profile: KeyProfile
  dispatch: boolean
  cwd: string
  home?: string
}): LaneBClaudePreflight {
  const { profile } = input
  if (!keyLanesActive()) return { ok: false, message: LANE_B_COPY.lanesOff }
  if (profile.engine !== 'claude') return { ok: false, message: LANE_B_COPY.wrongEngine(profile.label) }
  if (!profile.enabled) return { ok: false, message: LANE_B_COPY.profileOff(profile.label) }
  if (input.dispatch) return { ok: false, message: LANE_B_COPY.scheduled }
  const key = getPublicKey(profile.keyRef)
  if (!key) return { ok: false, message: LANE_B_COPY.keyMissing(profile.label) }
  const settings = claudeSettingsRefusal({ cwd: input.cwd, home: input.home })
  if (settings) return { ok: false, message: settings.message }
  if (!laneBRelayRegistered()) return { ok: false, message: LANE_B_COPY.relayUnavailable }
  return { ok: true, keyKind: key.kind }
}
