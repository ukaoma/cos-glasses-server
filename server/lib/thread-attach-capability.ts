// Does this server offer Continue at all, and for what?
//
// The Continue/Fork affordance is a UI decision that has to be made BEFORE any
// thread is named, so COS Control and the phone cannot discover it the way they
// discover everything else about a thread — by asking
// /api/agent-sessions/:provider/:threadId/attachability. When the feature is off
// the two write routes are not registered at all, so a client that reaches for
// them gets a bare 404 with no reason and no copy, which is indistinguishable
// from a typo, a proxy, or a dead server. This module is what a client reads
// instead, once, up front.
//
// ---------------------------------------------------------------- the rule
//
// ABSENT MEANS DISABLED. NEVER ENABLED.
//
// These fields did not exist before this build. Every client older than it will
// read `undefined` from all three, and `undefined` MUST resolve to off — the same
// fail-closed posture as the rest of Continue Original Agent Thread, for the same
// reason: a client that guesses "the field is missing, so probably fine" offers a
// Continue button that writes into a real human's conversation, and the cost of
// guessing the other way is one Fork.
//
// That rule cannot be enforced by the wire format, because absence is exactly what
// an old client sees and an old client cannot be changed. So it is enforced by
// `readThreadAttachCapability`, which is the ONLY sanctioned way to interpret this
// surface, and by the test that feeds it a genuine older-shaped /api/health body
// and requires all three answers to come back off.
//
// `supported` exists solely to make the two OFFs distinguishable. Without it,
// "this server has never heard of Continue" and "this server can Continue but the
// user has not switched it on" are the same empty answer, and a client cannot tell
// a user to flip a setting that may not exist. It is a compile-time constant: this
// build has the code. Whether the routes are reachable is `enabled`.
//
// ------------------------------------------------------------ anti-drift
//
// `enabled` reads `threadAttachEnabled()` — the SAME function
// routes/agent-session-bindings.ts calls to decide whether to register the two
// POST routes. Not a second copy of `process.env.COS_THREAD_ATTACH_ENABLED === '1'`.
// A copy is how this surface comes to advertise a write path that 404s, and the
// repo already carries that lesson one import above the call site in
// routes/health.ts: MEDIA_CHUNKED_UPLOAD_ENABLED is imported from the route that
// owns the endpoints "so it cannot drift from whether they are actually
// registered."
//
// `providers` is sourced from BINDABLE_PROVIDERS for the same reason. Cursor must
// not appear (plan 2.5 makes it Fork-only), and the way to guarantee that is to
// read the list that `isBindableProvider` — the check the attach route itself
// applies — is built from, rather than restating two names here and hoping.
//
// ------------------------------------------------- why providers empties out
//
// When the gate is off, `providers` is `[]` rather than the list this build could
// drive if it were on. A client that reads only `threadAttachProviders` and never
// looks at `threadAttachEnabled` is then still correct. Every field independently
// resolves to "no" when the answer is no; there is no combination of fields a
// careless reader can pick that yields a Continue button pointing at an
// unregistered route.
//
// The cost is that a disabled server cannot tell an operator WHICH providers it
// would support. That is a settings-copy problem, and `supported: true` is enough
// to say "this build can do it, turn it on."

import {
  BINDABLE_PROVIDERS,
  isBindableProvider,
  type BindableProvider,
} from './agent-session-binding-store.js'
import { threadAttachEnabled } from '../routes/agent-session-bindings.js'

/**
 * This build has the feature compiled in.
 *
 * A constant, not a probe. There is no configuration under which the code is
 * absent from a build that contains this file; the reachable/unreachable question
 * is `enabled`. It is published so that `undefined` (an older server) and `false`
 * (this build, switched off) are different answers on the wire.
 */
export const THREAD_ATTACH_SUPPORTED = true

export interface ThreadAttachCapability {
  /** The build knows what Continue is. False only when read off an older payload. */
  supported: boolean
  /** The write routes are registered and a Continue may be attempted. */
  enabled: boolean
  /**
   * Providers that can be CONTINUED, not merely browsed or forked.
   *
   * Empty whenever `enabled` is false. Cursor is never a member: it is Fork-only.
   */
  providers: BindableProvider[]
  /**
   * Fork is available. NOT gated by `enabled`.
   *
   * Fork creates a new thread and leaves the source byte-identical, so the flag
   * that protects an existing conversation does not apply. Gating it produced an
   * incoherent default: every refusal recommends Fork while the route 404s.
   */
  forkSupported: boolean
}

/**
 * The capability as this server should publish it.
 *
 * @param gate Tests only. Production takes the default, which is the same
 *   function that decides whether the write routes exist. Passing anything else
 *   from production code re-opens the drift this module was written to close.
 */
export function threadAttachCapability(
  gate: () => boolean = threadAttachEnabled,
): ThreadAttachCapability {
  let enabled = false
  try {
    // Anything other than an exact `true` is off. A gate that answers "maybe" is
    // answering no, and a gate that throws has not answered at all.
    enabled = gate() === true
  } catch (error) {
    console.error(
      `[thread-attach-capability] gate threw: ${error instanceof Error ? error.message : error}`,
    )
    enabled = false
  }
  return {
    supported: THREAD_ATTACH_SUPPORTED,
    enabled,
    providers: enabled ? [...BINDABLE_PROVIDERS] : [],
    // NOT gated by `enabled`: fork creates a new thread and leaves the source
    // byte-identical, so the flag protecting an existing conversation does not
    // apply. Gating it made every refusal recommend a route that 404s.
    forkSupported: THREAD_ATTACH_SUPPORTED,
  }
}

/** The three keys as they appear on /api/health and /api/models. */
export interface ThreadAttachHealthFields {
  threadAttachSupported: boolean
  threadAttachEnabled: boolean
  /** Fork is available whenever the build supports it, gate or no gate. */
  threadForkSupported: boolean
  threadAttachProviders: BindableProvider[]
}

/** Flatten the capability onto the health payload's key names. */
export function threadAttachHealthFields(
  capability: ThreadAttachCapability,
): ThreadAttachHealthFields {
  return {
    threadAttachSupported: capability.supported,
    threadAttachEnabled: capability.enabled,
    threadAttachProviders: capability.providers,
    threadForkSupported: capability.forkSupported,
  }
}

/**
 * Interpret a health payload from ANY server, including one that predates these
 * fields entirely.
 *
 * The whole point of this function is the defaults, so read them as the contract:
 *
 *   - a payload that is not an object at all -> everything off
 *   - `threadAttachSupported` anything but exactly `true` -> not supported, and
 *     therefore not enabled, whatever the other two fields say
 *   - `threadAttachEnabled` anything but exactly `true` -> off, so `'true'`, `1`
 *     and `'yes'` from a hand-rolled or proxied payload all fail closed
 *   - `providers` dropped entirely unless enabled, and filtered to names THIS
 *     build can actually drive, so a newer server naming a fourth provider does
 *     not make an older client offer a Continue it cannot perform
 *
 * A payload that contradicts itself — enabled without supported, or providers
 * while disabled — is a defect somewhere, and a defect resolves to refuse.
 */
export function readThreadAttachCapability(payload: unknown): ThreadAttachCapability {
  const row =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null

  const supported = row?.threadAttachSupported === true
  const enabled = supported && row?.threadAttachEnabled === true

  const providers: BindableProvider[] = []
  const raw = row?.threadAttachProviders
  if (enabled && Array.isArray(raw)) {
    for (const entry of raw) {
      // `isBindableProvider` is the attach route's own check. Anything it rejects
      // is a provider this build has no code path for, so offering it would
      // produce a Continue that cannot be honoured.
      if (!isBindableProvider(entry)) continue
      if (providers.includes(entry)) continue
      providers.push(entry)
    }
  }

  // Read off a payload from another server. An older build has no fork route, and
  // its payload carries no such field, so absent must read as NOT supported — the
  // same fail-closed rule the rest of this module runs on.
  const forkSupported = row?.threadForkSupported === true
  return { supported, enabled, providers, forkSupported }
}
