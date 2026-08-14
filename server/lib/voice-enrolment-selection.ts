// WHICH embeddings from a meeting may become training data for one person.
//
// Two independent filters, both pure over Float32Array[] so they are testable by
// execution rather than by reading them:
//
//   dominantCoherentCluster  — does this bag of chunks sound like ONE person?
//   greedyDiversitySelect    — of the ones that do, which 20 span the most range?
//
// THE PROBLEM THE FIRST ONE SOLVES. `Ext` is not a person. `identifySpeaker`
// returns 'Ext' for every voice that falls below its accept threshold, so a
// meeting with five unrecognised people produces ONE 'Ext' label covering all
// five. voice-directory.ts says it outright: "Ext/Unidentified clusters are
// meeting-local, not people."
//
// Measured on session `meeting_1786628481833_eagkaz` (2026-08-13): 115 'Ext'
// embeddings, 1,770 pairwise cosines, MEDIAN 0.170, and 98% of them below 0.55 —
// the identifier's own accept threshold. Enrolling that bucket wholesale under a
// name a human typed writes several strangers into one profile, permanently and
// silently, and the profile then matches all of them forever.
//
// So the rule is: enrol the DOMINANT COHERENT GROUP and report what was left
// behind, rather than enrolling everything and reporting success.

import { MERGE_SIMILARITY_FLOOR, rawCosineSimilarity } from './speaker-embeddings.js'

/**
 * Two chunks are the same voice only above this cosine.
 *
 * Aliased from the already-exported `MERGE_SIMILARITY_FLOOR` rather than written
 * as a literal, because that constant IS `SEARCH_THRESHOLD` (speaker-embeddings.ts)
 * — the threshold `identifySpeaker` itself uses to accept a match. Deriving it
 * means the gate cannot drift away from the identifier it is second-guessing; a
 * hardcoded 0.55 here would silently disagree the day that value is tuned.
 */
export const VOICE_COHERENCE_FLOOR = MERGE_SIMILARITY_FLOOR

/** How many samples one correction may add to a profile. */
export const MAX_ENROL_PER_CORRECTION = 20

export interface CoherentCluster {
  /** Indices into the input array, ascending. EMPTY when nothing coheres. */
  members: number[]
  /** Index the cluster formed around, or -1 when there is no cluster. */
  seed: number
}

/**
 * The largest group of embeddings that plausibly share one voice.
 *
 * MUTUALLY COHERENT, not merely star-shaped, and not connected components.
 * The distinction is the whole safety property:
 *
 *   components  A~B and B~C admits C alongside A even when A and C are nothing
 *               alike. Two people merge through anyone who sounds like both.
 *   star        every member within `floor` of one seed. Better, but a seed
 *               sitting between two voices still admits both — measured: with
 *               a=[1,0], b=[1,1], c=[0,1], b agrees with a AND c while a and c
 *               are orthogonal, so the star around b is the whole crowd.
 *   mutual      every PAIR within `floor`. Cannot admit two voices at once.
 *
 * Built as a seed star and then refined: repeatedly drop the member with the
 * most internal disagreements (ties to the one with the lowest mean similarity,
 * then the highest index) until every pair clears the floor. Greedy rather than
 * a true maximum clique, which is NP-hard — greedy errs toward a SMALLER group,
 * and under-enrolling is the safe direction when the alternative is writing a
 * stranger into someone's profile permanently.
 *
 * A LONE candidate is returned as its own cluster: one chunk cannot contradict
 * itself, and refusing it would mean a short correction never trains anything.
 * But a bag of MANY mutually dissimilar embeddings returns EMPTY — the seed with
 * the most agreement still has none, so picking one of them would be choosing an
 * arbitrary stranger out of a crowd, which is precisely the failure this exists
 * to stop. The caller reports that as `clusterSkipped === attempted`.
 *
 * Ties on seed choice break by mean similarity to the agreeing set, then by
 * lowest index, so the result is deterministic for a given input.
 */
export function dominantCoherentCluster(
  embeddings: Float32Array[],
  floor: number = VOICE_COHERENCE_FLOOR,
): CoherentCluster {
  const n = embeddings.length
  if (n === 0) return { members: [], seed: -1 }
  if (n === 1) return { members: [0], seed: 0 }

  // Full pairwise matrix once: the refinement below reads it repeatedly, and
  // recomputing a 192-dim cosine inside that loop is the difference between
  // microseconds and seconds on a long meeting.
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    sim[i][i] = 1
    for (let j = i + 1; j < n; j++) {
      const s = rawCosineSimilarity(embeddings[i], embeddings[j])
      sim[i][j] = s
      sim[j][i] = s
    }
  }

  let bestSeed = -1
  let bestAgree: number[] = []
  let bestMean = -Infinity
  for (let i = 0; i < n; i++) {
    const agree: number[] = []
    let sum = 0
    for (let j = 0; j < n; j++) {
      if (i !== j && sim[i][j] >= floor) { agree.push(j); sum += sim[i][j] }
    }
    const meanSim = agree.length > 0 ? sum / agree.length : -Infinity
    if (agree.length > bestAgree.length || (agree.length === bestAgree.length && meanSim > bestMean)) {
      bestSeed = i
      bestAgree = agree
      bestMean = meanSim
    }
  }

  // Nothing agreed with anything. There is no dominant voice here, only a crowd.
  if (bestSeed === -1 || bestAgree.length === 0) return { members: [], seed: -1 }

  let members = [bestSeed, ...bestAgree].sort((a, b) => a - b)
  for (;;) {
    let worst = -1, worstConflicts = 0, worstMean = Infinity
    for (const m of members) {
      let conflicts = 0, sum = 0
      for (const other of members) {
        if (m === other) continue
        if (sim[m][other] < floor) conflicts++
        sum += sim[m][other]
      }
      const meanSim = members.length > 1 ? sum / (members.length - 1) : 1
      if (conflicts > worstConflicts || (conflicts === worstConflicts && conflicts > 0 && meanSim <= worstMean)) {
        worst = m; worstConflicts = conflicts; worstMean = meanSim
      }
    }
    if (worstConflicts === 0) break
    members = members.filter(m => m !== worst)
    // The seed itself can be the outlier — a voice sitting between two others is
    // exactly the member that has to go for the rest to be mutually coherent.
    if (members.length <= 1) break
  }

  // A refinement that ate everything but one member left no evidence of a shared
  // voice, only the last survivor of a crowd. Same verdict as no cluster at all.
  if (members.length < 2) return { members: [], seed: -1 }

  // The seed may have been pruned; report the member that best represents what
  // survived, so `seed` always names a row that is actually in the cluster.
  let seed = members[0], seedMean = -Infinity
  for (const m of members) {
    let sum = 0
    for (const other of members) if (m !== other) sum += sim[m][other]
    const meanSim = sum / (members.length - 1)
    if (meanSim > seedMean) { seed = m; seedMean = meanSim }
  }
  return { members, seed }
}

/**
 * Pick the N most acoustically diverse embeddings — greedy max-min-distance.
 *
 * Moved here VERBATIM from routes/voice.ts, where it was a private function used
 * by POST /api/voice/enroll-ext. It was copied rather than shared once already
 * (voice-profile-store.ts `selectDiverseIndices` is the same algorithm over
 * number[][], with a different return ORDER); this module is now the home for the
 * Float32Array form so the relabel path and the ext-audio path cannot drift.
 *
 * Bounding the count is not cosmetic. Every `enrollEmbedding` does
 * loadProfileStore -> persistProfile -> invalidateProfileCache, so the next
 * iteration re-reads and re-parses the whole store — ~41 ms per cycle against a
 * live 7.9 MB / 77-profile file, before the fsync'd write. At 109 chunks that
 * blocks the event loop past COS Control's 30 s helper timeout, and the user is
 * told "Server stopped" for a correction that actually applied.
 */
export function greedyDiversitySelect(embeddings: Float32Array[], maxN: number): Float32Array[] {
  if (embeddings.length <= maxN) return embeddings

  // Find the most dissimilar pair as seeds
  let maxDist = -1, seedA = 0, seedB = 1
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const dist = 1 - rawCosineSimilarity(embeddings[i], embeddings[j])
      if (dist > maxDist) { maxDist = dist; seedA = i; seedB = j }
    }
  }

  const selected = new Set([seedA, seedB])
  while (selected.size < maxN) {
    let bestIdx = -1, bestMinDist = -1
    for (let i = 0; i < embeddings.length; i++) {
      if (selected.has(i)) continue
      let minDist = Infinity
      for (const s of selected) {
        const dist = 1 - rawCosineSimilarity(embeddings[i], embeddings[s])
        if (dist < minDist) minDist = dist
      }
      if (minDist > bestMinDist) { bestMinDist = minDist; bestIdx = i }
    }
    if (bestIdx === -1) break
    selected.add(bestIdx)
  }

  return [...selected].map(i => embeddings[i])
}
