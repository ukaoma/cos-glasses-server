# Mac speaker continuity and live names: qualification contract

This candidate is not a qualified release until the receipts below pass on its
final source snapshot. G2 is optional evaluation evidence, never an identity
input. Existing profiles use 192-dimensional ERes2Net embeddings; the separate
256-dimensional shadow clustering replay must not be scored as profile matching.

## Required behavior

- Retain a call-wide acoustic identity over long speaker absences, without
  recycling numbers or treating an overlapping crop as an independent witness.
- Require two disjoint original observations before projecting an identity.
  Dependent half-window embeddings check purity and never provide extra votes.
- Match names only against the complete frozen existing profile cohort, at the
  existing similarity and runner-up margin. Do not enroll or train profiles.
- Persist evidence and revision before exposing a complete replacement of live
  labels. A later confuser, changed source, correction or invalid state must
  withdraw stale claims, including on already-displayed transcript rows.
- Preserve transcript words, ordering, timestamps, audio and all human edits.
- Keep transcription cleanup, cloud fallback, and both cue implementations off
  in isolated qualification. Do not enable other feature flags to make this work.

## Accuracy gates

1. Replay the complete canonical eligible-window universe of the human-corrected
   October 27 call, with evaluator truth separated from matching inputs. The known
   Gina recurrence must share a final identity and reduce actual fragmentation;
   zero final and transient cross-person merges are required. Record unprojected
   speech and false negatives, not just surviving positive groups.
2. Test late confusers, similar voices, mixed windows, duplicated audio, source
   drift, profile/model changes, restarts, namespace exhaustion and permutations.
   Withholding uncertain names is required; a smaller voice count is insufficient.
3. Replay complete October 28/29 source audio with pinned local native models and
   pre/post source hashes. Keep anonymous-clustering and 192d profile-matching
   metrics separate. G2 machine labels are a comparison, not human ground truth.
4. Measure time to first supported identity/name and later label revisions.
   Current long-window extraction cannot promise immediate labels for every short
   turn. Publish measured coverage and latency before selecting defaults.

## Integration and repair gates

- Focused behavioral tests, planted defects, full TypeScript, and a frozen final
  server regression run. Control must prove replacement/withdrawal behavior and
  retain legacy transport behavior on the released 0.5.352 base.
- All native work is local, bounded, silent, one owned child at a time, and pauses
  for a new recording. No live restart or canonical repair while recording.
- Repairs begin on immutable copies. Only qualified exact spans may change; retain
  before/after images, model/profile/audio hashes and a recoverable transaction.
  Recheck current canonical bytes and correction history before application.
- An already named/protected span is not permission to propagate that name to an
  entire acoustic cluster. Failed or pending saves are excluded from label repair.
- Validate both local and operations copies, text/time invariants, read-side proof
  acceptance and rollback. Report each call as repaired, partly repaired or
  withheld. Never describe a preview or cached calculation as a completed repair.
