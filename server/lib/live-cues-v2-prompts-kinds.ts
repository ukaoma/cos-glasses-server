// 6.86.0: the writer rules for a meeting armed with the extended kinds (decision, promise, followUp beside reinforce and
// challenge). Hand-written, so it lives beside the GENERATED live-cues-v2-prompts.ts and never inside it: v2 and v3 stay
// byte-identical to what the dev and held-out replays measured, and every meeting without the extended kinds (every
// glasses meeting today) still runs them.
//
// v4 is v3 with three segments swapped: rule 3 (the kinds), rule 4 (a record of what the room settled is allowed to say
// what the room said) and the kind list in the schema line. Nothing else changes: one cue, at most 200 characters, the
// same evidence rules, the same null. The swap throws when v3 no longer holds a segment, so a regenerated v3 fails the
// suite (live-cues-v2-kinds.test.ts) instead of silently shipping v3 under the v4 label.
//
// Not replay-measured. It runs only for meetings that opted in (Mac recordings in COS Control), whose cues are rated in
// Control like every other cue.

import { CUE_WRITER_SYSTEM_V3 } from './live-cues-v2-prompts.js'

export const V3_RULE_3 = '3. Two kinds. reinforce: they are on track; name the evidence and the next step. challenge: the flaw, the missing piece, or the contradiction.\n'
  + '   Check previousCues: do not only criticize, and never repeat a previous cue. No empty praise.\n'
export const V4_RULE_3 = '3. Five kinds. reinforce: they are on track; name the evidence and the next step. challenge: the flaw, the missing piece, or the contradiction.\n'
  + '   decision: the room just settled something; say what was decided. promise: someone took something on; say who owes what (rule 2 decides whether you may name them), and when only if a date was said.\n'
  + '   followUp: something the room must come back to; name it and what is still open. suggestedKind is a hint; pick the kind that fits the window.\n'
  + '   Check previousCues: do not only criticize, never repeat a previous cue, and never record the same decision or promise twice. No empty praise.\n'

export const V3_RULE_4 = '4. Add something the room has not said: the missing owner, deadline or criterion, a risk, a contradiction, or a past decision from memory.\n'
  + '   If the cue would only restate what was just said, output null.\n'
export const V4_RULE_4 = '4. A reinforce or challenge cue must add something the room has not said: the missing owner, deadline or criterion, a risk, a contradiction, or a past decision from memory.\n'
  + '   If it would only restate what was just said, output null. A decision, promise or followUp records what the room settled, took on or left open, in a few plain words.\n'

export const V3_SCHEMA_KIND = '"kind":"reinforce|challenge"'
export const V4_SCHEMA_KIND = '"kind":"reinforce|challenge|decision|promise|followUp"'

function swap(text: string, from: string, to: string): string {
  const at = text.indexOf(from)
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error('live cues v4: the v3 writer rules changed; rebuild v4 from the new v3')
  return text.slice(0, at) + to + text.slice(at + from.length)
}

/** Writer v4: v3 plus the decision, promise and followUp kinds. */
export const CUE_WRITER_SYSTEM_V4 = swap(swap(swap(CUE_WRITER_SYSTEM_V3, V3_RULE_3, V4_RULE_3), V3_RULE_4, V4_RULE_4), V3_SCHEMA_KIND, V4_SCHEMA_KIND)
