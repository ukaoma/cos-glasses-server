// Key lanes (K1, plan v4 sections 4, 8, 12): the FROZEN contract between P1 (foundation), P2 (the
// loopback metering relay), P3 (Lane B Claude), P4 (Lane B Codex), P5 (Lane C direct) and P11.
//
// Types and inert constants only. Nothing here reads a file, opens a socket, starts a timer or
// touches process.env, so importing it changes nothing for a server with key lanes off.
// Changing a name or a shape here after P1 lands needs every consumer package to agree.

// ── Credentials ──────────────────────────────────────────────────────────────

/** What a saved key is (plan D2). `openai-compatible` is a custom URL, Mac only. */
export type KeyKind = 'openrouter' | 'anthropic' | 'openai' | 'openai-compatible'
export const KEY_KINDS: readonly KeyKind[] = ['openrouter', 'anthropic', 'openai', 'openai-compatible']

/** A key's stable handle: `key_` plus 12 lowercase hex. Never derived from the secret. */
export type KeyRef = string
export const KEY_REF_RE = /^key_[0-9a-f]{12}$/

/**
 * What any route, log, health field, diagnostic or ledger may say about a key. The secret never
 * leaves `key-store.ts` except through `readKeySecretForRelay`, which only P2 and P5 call.
 */
export interface PublicKeyRecord {
  ref: KeyRef
  kind: KeyKind
  /** Last four characters of the secret, for "the key ending 1a2b". */
  last4: string
  /** Daily cap in USD for this key (plan 4.5, D11 default 1.00). */
  capUsd: number
  savedAt: string
  validatedAt?: string
  /** `openai-compatible` only: the base URL the key was saved for. */
  baseUrl?: string
}

// ── Lanes and answers ────────────────────────────────────────────────────────

/** Lane A is the user's subscription CLI; B runs the CLI harness on a key; C calls the key direct. */
export type AnswerLane = 'subscription' | 'key' | 'direct'
/** The lanes that spend a key. Token-audit `lane` takes only these. */
export type KeyLane = Exclude<AnswerLane, 'subscription'>

/** Additive answer fields (plan 3.1). Present only on keyed answers, omitted (never null) otherwise. */
export interface AnswerKeyFields {
  lane: KeyLane
  credential: { kind: KeyKind; ref: KeyRef; profileId: string }
}

/**
 * Token-audit fields (plan 3.1, 6.3). Record keys are exactly `profile`, `lane`, `credentialKind`
 * and `usd`; each is written only when set, so a Lane A row is byte-identical to 6.79.0.
 */
export interface TokenAuditKeyFields {
  profile?: string
  lane?: KeyLane
  credentialKind?: KeyKind
  usd?: number
}

// ── Profiles ─────────────────────────────────────────────────────────────────

/** Which harness a profile runs. `claude` and `codex` are Lane B (through the relay); `direct` is Lane C. */
export type KeyProfileEngine = 'claude' | 'codex' | 'direct'
/** Timeout tier for a Lane B Claude profile (plan 7.1): the subscription tier whose budgets it borrows. */
export type KeyProfileTimeoutTier = 'opus' | 'fable' | 'sonnet' | 'haiku'

export interface KeyProfile {
  /** `^[a-z0-9][a-z0-9-]{0,31}$` (shared/key-preference.ts KEY_PROFILE_ID_RE). */
  id: string
  label: string
  keyRef: KeyRef
  engine: KeyProfileEngine
  /** The provider model id or OpenRouter slug, e.g. `anthropic/claude-sonnet-5.5`. */
  model: string
  enabled: boolean
  timeoutTier: KeyProfileTimeoutTier
  /** Plan 9.4: offer this profile on `/v1` as `cos-key-<id>`. Default false. */
  offerOnV1: boolean
  /** Plan D7: Lane C tools for this profile. Default false; never on by default for a remote endpoint. */
  directTools: boolean
  createdAt: string
  updatedAt: string
}

/** What `/api/models` publishes as `keyProfiles` while lanes are active (enabled profiles only). */
export interface PublicKeyProfileOption {
  id: string
  label: string
  engine: KeyProfileEngine
  model: string
  keyKind: KeyKind
  timeoutTier: KeyProfileTimeoutTier
}

// ── Relay (P2 implements; P3, P4 consume) ────────────────────────────────────

export type RelayEngine = 'claude' | 'codex'

/** Plan 4.2. The relay listens on `127.0.0.1:<ephemeral>` only; never 3141, 3143 or 0.0.0.0. */
export const RELAY_PATHS = {
  anthropicMessages: '/relay/a/v1/messages',
  anthropicCountTokens: '/relay/a/v1/messages/count_tokens',
  openaiResponses: '/relay/o/v1/responses',
  health: '/relay/health',
} as const
/** Base path a child is pointed at: Claude `ANTHROPIC_BASE_URL=<origin>/relay/a`, Codex `<origin>/relay/o/v1`. */
export const RELAY_BASE_PATHS = { claude: '/relay/a', codex: '/relay/o/v1' } as const

/** Plan 4.2 upstreams, by key kind. */
export const RELAY_UPSTREAMS = {
  openrouterMessages: 'https://openrouter.ai/api/v1/messages',
  anthropicMessages: 'https://api.anthropic.com/v1/messages',
  openrouterResponses: 'https://openrouter.ai/api/v1/responses',
  openaiResponses: 'https://api.openai.com/v1/responses',
} as const

/** Plan 4.3 nonce limits. */
export const RELAY_LIMITS = {
  nonceBytes: 32,
  inFlightPerNonce: 8,
  bodyCapBytes: 20 * 1024 * 1024,
  /** Nonce lives until child close plus this. */
  childCloseGraceMs: 5_000,
  /** ...or the tier's wall max plus this, whichever comes first. */
  wallMaxGraceMs: 60_000,
  /** Logs show at most this many leading characters of a nonce. */
  nonceLogChars: 4,
} as const

/** Plan 4.3 binding. One nonce per turn, memory only. */
export interface RelayNonceBinding {
  keyRef: KeyRef
  profileId: string
  turnId: string
  sessionId: string
  engine: RelayEngine
  /** The profile slug. Plan 4.4: equal forwards, a Claude id or alias is rewritten to it, anything else is 400. */
  allowedModel: string
}

export type RelayRevokeReason =
  | 'child_close'
  | 'cancel'
  | 'steer_abort'
  | 'breaker_open'
  | 'remove_all'
  | 'lanes_inactive'
  | 'expired'

export interface RelayTurnHandle {
  /** The secret the child presents. Never logged beyond RELAY_LIMITS.nonceLogChars. */
  nonce: string
  /** `http://127.0.0.1:<port>` for this boot. */
  origin: string
  /** Called by the bridge on child close; the relay keeps the nonce for childCloseGraceMs. */
  childClosed(): void
  revoke(reason: RelayRevokeReason): void
}

export interface RelayIssueOptions {
  /** The tier's wall max for this turn (plan 4.3 lifetime). */
  wallMaxMs: number
}

/** P2's relay. Started lazily by the first keyed turn; closed when keyLanesActive() turns false. */
export interface KeyRelay {
  issueTurn(binding: RelayNonceBinding, options: RelayIssueOptions): Promise<RelayTurnHandle>
  revokeTurn(turnId: string, reason: RelayRevokeReason): void
  revokeAll(reason: RelayRevokeReason): void
  /** The listener's port, or null when no listener is open. */
  port(): number | null
  close(): Promise<void>
}

/** Plan 4.4 model policy outcome. */
export type RelayModelAction = 'forward' | 'rewrite' | 'reject'

/** Plan 4.6 mapping, one value per row. */
export type RelayFailureKind =
  | 'cap_refused'
  | 'key_rejected'
  | 'out_of_credit'
  | 'model_gone'
  | 'rate_limited'
  | 'upstream_error'
  | 'network_error'
  | 'model_not_allowed'

/** Only these count toward the breaker (plan 4.6). */
export type BreakerCountedFailure = Extract<RelayFailureKind, 'key_rejected' | 'out_of_credit' | 'model_gone'>
export type BreakerScope = 'key' | 'profile'
export interface BreakerState {
  open: boolean
  failures: number
  openedAt?: string
  reopensAt?: string
}
export const BREAKER_LIMITS = { failures: 3, openMs: 60 * 60 * 1000 } as const

// ── Meter and ledger (P2) ────────────────────────────────────────────────────

export type KeyLedgerKind = 'reserve' | 'settle' | 'reconcile'

/** One row of `data/key-ledger.jsonl` (0600, atomic append). Never a secret, never a nonce. */
export interface KeyLedgerRow {
  ts: string
  keyRef: KeyRef
  profile: string
  lane: KeyLane
  turnId: string
  generationId?: string
  tokens: { input: number; output: number }
  usd: number
  kind: KeyLedgerKind
}

export interface KeyMeter {
  /** Reserve before forwarding; false means refuse with the cap line. */
  reserve(input: { keyRef: KeyRef; turnId: string; estimateUsd: number }): { ok: true; reservationId: string } | { ok: false; spentTodayUsd: number; capUsd: number }
  settle(input: { reservationId: string; usd: number; tokens: { input: number; output: number }; generationId?: string }): void
  spentTodayUsd(keyRef: KeyRef): number
}

// ── Child environment names (P3, P4) ─────────────────────────────────────────

export const KEY_LANE_CHILD_ENV = {
  /** Claude: the nonce, as a Bearer. */
  claudeToken: 'ANTHROPIC_AUTH_TOKEN',
  claudeBaseUrl: 'ANTHROPIC_BASE_URL',
  /** Codex: the nonce, named by `env_key` in the generated config. */
  codexToken: 'COS_RELAY_TOKEN',
  /** Marks a keyed child for hooks and the MU child_env() scrub (plan 6.2, 7.3). */
  profileMarker: 'COS_KEY_PROFILE',
} as const

// ── Status and lifecycle seams (P1 calls; P2, P3, P6 register) ───────────────

/** P2 and P3 answer these for `GET /api/key-lanes/status`. P1 defaults: 0, closed, []. */
export interface KeyLanesStatusProvider {
  spentTodayUsd?(keyRef: KeyRef): number
  breaker?(keyRef: KeyRef): BreakerState
  keyedSessionIds?(): string[]
}

/** Why key lanes stopped being active. Hooks revoke nonces, close the relay, clear bindings. */
export type KeyLanesInactiveReason = 'disabled' | 'remove_all' | 'no_enabled_profile'
export type KeyLanesInactiveHook = (reason: KeyLanesInactiveReason) => void | Promise<void>

/** `GET /api/key-lanes/status` body. */
export interface KeyLanesStatusBody {
  enabled: boolean
  active: boolean
  keys: Array<{ ref: KeyRef; kind: KeyKind; last4: string; capUsd: number; spentTodayUsd: number; breaker: BreakerState }>
  profiles: KeyProfile[]
  keyedSessionIds: string[]
}

/** `details.keyLanes` on `/api/health` (public), present only while enabled. Booleans only. */
export interface KeyLanesHealthDetail {
  enabled: true
  active: boolean
}
