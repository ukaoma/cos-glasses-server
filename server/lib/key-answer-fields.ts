// Key lanes K1, P11 (plan v4 3.1): the additive fields a keyed answer carries on its `done` event,
// at the top level where the app reads them: `lane`, `credential` (kind, ref, profile id, never a
// secret), `profile`, and `usd` (already top level in the bridge metadata). A subscription answer
// has no `keyLane` in its metadata, so this returns {} and the payload is byte-identical.
import type { AnswerKeyFields } from './key-relay-contract.js'

export function keyAnswerDoneFields(metadata: { keyLane?: AnswerKeyFields } | undefined): Record<string, unknown> {
  const keyLane = metadata?.keyLane
  if (!keyLane) return {}
  return { lane: keyLane.lane, credential: keyLane.credential, profile: keyLane.credential.profileId }
}
