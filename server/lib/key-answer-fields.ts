// Key lanes K1, P11 (plan v4 3.1): the additive fields a keyed answer carries, at the top level
// where the app reads them: `lane`, `credential` (kind, ref, profile id, never a secret),
// `profile`, and `usd`. On the live `done` event (keyAnswerDoneFields) and on the durable job
// record (keyAnswerJobFields), so a recovered answer shows its cost too. A subscription answer has
// no `keyLane` in its metadata, so both return {} and the payload and the record stay byte-identical.
import type { AnswerKeyFields, KeyKind, KeyLane } from './key-relay-contract.js'
import { KEY_KINDS, KEY_REF_RE } from './key-relay-contract.js'
import { isKeyProfileId } from '../../shared/key-preference.js'

export function keyAnswerDoneFields(metadata: { keyLane?: AnswerKeyFields } | undefined): Record<string, unknown> {
  const keyLane = metadata?.keyLane
  if (!keyLane) return {}
  return { lane: keyLane.lane, credential: keyLane.credential, profile: keyLane.credential.profileId }
}

/** What a durable job record keeps for a keyed answer. */
export interface QueryJobKeyAnswerFields {
  lane?: KeyLane
  credential?: { kind: KeyKind; ref: string; profileId: string }
  profile?: string
  usd?: number
}

/**
 * The validated key fields of a completion or a replayed journal patch, or {} when any part is
 * missing or malformed. Built only from the bridge's metadata on a keyed run.
 */
export function keyAnswerJobFields(input: unknown): QueryJobKeyAnswerFields {
  if (!input || typeof input !== 'object') return {}
  const x = input as { lane?: unknown; credential?: unknown; profile?: unknown; usd?: unknown }
  if (x.lane !== 'key' && x.lane !== 'direct') return {}
  const c = x.credential as { kind?: unknown; ref?: unknown; profileId?: unknown } | undefined
  if (!c || typeof c !== 'object') return {}
  if (!KEY_KINDS.includes(c.kind as KeyKind) || typeof c.ref !== 'string' || !KEY_REF_RE.test(c.ref) || !isKeyProfileId(c.profileId)) return {}
  if (x.profile !== c.profileId) return {}
  const usd = typeof x.usd === 'number' && Number.isFinite(x.usd) && x.usd >= 0 ? Math.round(x.usd * 1e6) / 1e6 : undefined
  return {
    lane: x.lane,
    credential: { kind: c.kind as KeyKind, ref: c.ref, profileId: c.profileId },
    profile: c.profileId,
    ...(usd !== undefined ? { usd } : {}),
  }
}

/** The completion fields a durable runtime passes for a keyed run: done fields plus usd. */
export function keyAnswerCompletionFields(metadata: { keyLane?: AnswerKeyFields; usd?: number } | undefined): QueryJobKeyAnswerFields {
  if (!metadata?.keyLane) return {}
  return keyAnswerJobFields({ ...keyAnswerDoneFields(metadata), usd: metadata.usd })
}
