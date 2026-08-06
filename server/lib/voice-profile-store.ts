// Durability and integrity for voice-profiles.json.
//
// This file is the single most irreplaceable artifact the server owns: on this
// box it holds 79 profiles / 1,317 embeddings / ~7.8 MB, accumulated over months
// of training that cannot be re-derived once the source audio has aged out. It
// was being written with three raw `writeFileSync` calls and read with an
// unguarded `JSON.parse`, so one crash, disk-full, or iCloud-sync mid-write
// would take all of it and every subsequent read would throw.
//
// Everything here is a pure function over an explicit path so it can be tested
// by execution rather than by asserting on source text. speaker-embeddings.ts
// delegates to it and keeps the sherpa-onnx manager in sync.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { durableAtomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'

export interface VoiceProfile {
  name: string
  /** One row per enrolled sample. Parallel to `sources`, index for index. */
  embeddings: number[][]
  /** Provenance: 'manual' | 'fireflies' | 'g2-training' | 'auto:<sessionId>' | … */
  sources?: string[]
}

export interface ProfileStore {
  profiles: VoiceProfile[]
}

/** What normalization had to fix. All non-zero counts are worth logging: they
 *  mean the file on disk had drifted from its own invariants. */
export interface StoreRepairs {
  /** `sources` was missing, short, or long relative to `embeddings`. */
  sourcesRealigned: number
  /** A null/non-string slot inside `sources` (observed in the live store). */
  sourcesCoerced: number
  /** Embedding rows that were not arrays of finite numbers — unusable. */
  embeddingsDropped: number
  /** Rows whose length differs from the profile's modal dimension. Kept on
   *  disk, but excluded from centroids: sherpa compares by cosine, and a
   *  short row silently produces NaN across the whole averaged vector. */
  dimensionMismatch: number
  /** Entries with no usable name, or duplicate names collapsed. */
  profilesDropped: number
}

export function emptyRepairs(): StoreRepairs {
  return {
    sourcesRealigned: 0,
    sourcesCoerced: 0,
    embeddingsDropped: 0,
    dimensionMismatch: 0,
    profilesDropped: 0,
  }
}

export function hasRepairs(r: StoreRepairs): boolean {
  return r.sourcesRealigned > 0 || r.sourcesCoerced > 0 || r.embeddingsDropped > 0
    || r.dimensionMismatch > 0 || r.profilesDropped > 0
}

export function describeRepairs(r: StoreRepairs): string {
  const parts: string[] = []
  if (r.profilesDropped) parts.push(`${r.profilesDropped} unusable profile(s)`)
  if (r.embeddingsDropped) parts.push(`${r.embeddingsDropped} unusable embedding row(s)`)
  if (r.sourcesRealigned) parts.push(`${r.sourcesRealigned} profile(s) with misaligned sources[]`)
  if (r.sourcesCoerced) parts.push(`${r.sourcesCoerced} null/non-string source slot(s)`)
  if (r.dimensionMismatch) parts.push(`${r.dimensionMismatch} wrong-dimension embedding(s) excluded from centroids`)
  return parts.join(', ')
}

const UNKNOWN_SOURCE = 'unknown'

function isUsableEmbedding(row: unknown): row is number[] {
  return Array.isArray(row) && row.length > 0 && row.every(v => typeof v === 'number' && Number.isFinite(v))
}

/** The dimension the majority of a profile's rows agree on.
 *
 *  Not `embeddings[0].length`: if row 0 happens to be the corrupt one, every
 *  other row becomes the "mismatch" and the profile is emptied. */
export function modalDimension(embeddings: number[][]): number {
  const counts = new Map<number, number>()
  for (const row of embeddings) counts.set(row.length, (counts.get(row.length) ?? 0) + 1)
  let best = 0, bestCount = -1
  for (const [dim, count] of counts) {
    // Tie-break toward the larger dimension: a truncated row is the likelier
    // corruption than a systematically longer one.
    if (count > bestCount || (count === bestCount && dim > best)) { best = dim; bestCount = count }
  }
  return best
}

/** Bring a parsed store back to its invariants, reporting every change.
 *
 *  Deliberately conservative: rows that are merely the wrong DIMENSION are kept
 *  on disk and only excluded from centroid math, because they may be a
 *  recoverable model change rather than corruption. Only rows that cannot be
 *  numbers at all are dropped. */
export function normalizeProfileStore(raw: unknown): { store: ProfileStore; repairs: StoreRepairs } {
  const repairs = emptyRepairs()
  const rawProfiles = (raw as ProfileStore | null)?.profiles
  if (!Array.isArray(rawProfiles)) return { store: { profiles: [] }, repairs }

  const byName = new Map<string, VoiceProfile>()
  for (const candidate of rawProfiles) {
    const name = typeof (candidate as VoiceProfile)?.name === 'string'
      ? (candidate as VoiceProfile).name.trim()
      : ''
    if (!name) { repairs.profilesDropped++; continue }

    const rawEmbeddings = Array.isArray((candidate as VoiceProfile).embeddings)
      ? (candidate as VoiceProfile).embeddings as unknown[]
      : []
    const rawSources = Array.isArray((candidate as VoiceProfile).sources)
      ? (candidate as VoiceProfile).sources as unknown[]
      : null

    // Walk both arrays together so dropping row i also drops source i — the
    // exact coupling `embeddings.shift()` + `sources?.shift()` used to break.
    const embeddings: number[][] = []
    const sources: string[] = []
    for (let i = 0; i < rawEmbeddings.length; i++) {
      const row = rawEmbeddings[i]
      if (!isUsableEmbedding(row)) { repairs.embeddingsDropped++; continue }
      embeddings.push(row)
      const source = rawSources?.[i]
      if (typeof source === 'string' && source.length > 0) {
        sources.push(source)
      } else {
        // Missing (sources shorter than embeddings) or a null/non-string slot.
        if (rawSources && i < rawSources.length) repairs.sourcesCoerced++
        sources.push(UNKNOWN_SOURCE)
      }
    }

    const wasMisaligned = rawSources === null
      ? embeddings.length > 0
      : rawSources.length !== rawEmbeddings.length
    if (wasMisaligned) repairs.sourcesRealigned++

    const dim = modalDimension(embeddings)
    for (const row of embeddings) if (row.length !== dim) repairs.dimensionMismatch++

    const existing = byName.get(name)
    if (existing) {
      // Duplicate profile names cannot both be registered in the manager (one
      // vector per name), so the later rows would be invisible. Merge instead.
      repairs.profilesDropped++
      existing.embeddings.push(...embeddings)
      existing.sources!.push(...sources)
      continue
    }
    byName.set(name, { name, embeddings, sources })
  }

  return { store: { profiles: [...byName.values()] }, repairs }
}

export type StoreLoad = {
  store: ProfileStore
  repairs: StoreRepairs
  /** 'missing' is normal on a fresh install. 'corrupt' means the previous file
   *  was quarantined and the training in it is GONE unless a backup is used. */
  status: 'ok' | 'missing' | 'corrupt'
  quarantinedAs?: string
  /** Set when `status: 'corrupt'` and a backup was successfully substituted. */
  recoveredFromBackup?: string
}

export function backupDirFor(storePath: string): string {
  return join(dirname(storePath), `${basename(storePath, '.json')}.backups`)
}

/** Newest first. */
export function listProfileStoreBackups(storePath: string): string[] {
  const dir = backupDirFor(storePath)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => resolve(dir, f))
      .map(p => ({ p, mtime: safeMtime(p) }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(entry => entry.p)
  } catch { return [] }
}

function safeMtime(path: string): number {
  try { return statSync(path).mtimeMs } catch { return 0 }
}

function safeSize(path: string): number {
  try { return statSync(path).size } catch { return 0 }
}

export const PROFILE_STORE_BACKUP_KEEP = 5
/** Don't copy 7.8 MB on every enroll; one snapshot per hour bounds the churn
 *  while still guaranteeing a recent restore point. */
export const PROFILE_STORE_BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000

/**
 * Load the store, quarantining a corrupt file and falling back to the newest
 * usable backup rather than silently starting from zero profiles.
 *
 * Starting empty is the dangerous default here: the very next `saveProfileStore`
 * would durably persist that empty store over the only remaining copy.
 */
export function loadVoiceProfileStore(storePath: string): StoreLoad {
  const result = loadJsonOrQuarantine<unknown>(storePath)
  if (result.status === 'missing') {
    return { store: { profiles: [] }, repairs: emptyRepairs(), status: 'missing' }
  }
  if (result.status === 'ok') {
    const { store, repairs } = normalizeProfileStore(result.data)
    return { store, repairs, status: 'ok' }
  }

  for (const backup of listProfileStoreBackups(storePath)) {
    const restored = loadJsonOrQuarantine<unknown>(backup)
    if (restored.status !== 'ok') continue
    const { store, repairs } = normalizeProfileStore(restored.data)
    if (store.profiles.length === 0) continue
    return {
      store,
      repairs,
      status: 'corrupt',
      quarantinedAs: result.quarantinedAs,
      recoveredFromBackup: backup,
    }
  }
  return {
    store: { profiles: [] },
    repairs: emptyRepairs(),
    status: 'corrupt',
    quarantinedAs: result.quarantinedAs,
  }
}

/** Snapshot the current file before it is overwritten, then prune old copies. */
export function backupProfileStore(
  storePath: string,
  options: { nowMs?: number; force?: boolean; keep?: number; minIntervalMs?: number } = {},
): string | null {
  if (!existsSync(storePath)) return null
  if (safeSize(storePath) === 0) return null

  const now = options.nowMs ?? Date.now()
  const keep = options.keep ?? PROFILE_STORE_BACKUP_KEEP
  const minInterval = options.minIntervalMs ?? PROFILE_STORE_BACKUP_MIN_INTERVAL_MS
  const existing = listProfileStoreBackups(storePath)
  if (!options.force && existing.length > 0 && now - safeMtime(existing[0]) < minInterval) return null

  const dir = backupDirFor(storePath)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
    const target = join(dir, `${basename(storePath, '.json')}.${stamp}.json`)
    // Copy through the durable writer so a backup can never itself be torn.
    const raw = loadJsonOrQuarantine<unknown>(storePath)
    if (raw.status !== 'ok') return null
    durableAtomicWriteFileSync(target, JSON.stringify(raw.data), { mode: 0o600 })
    for (const stale of listProfileStoreBackups(storePath).slice(keep)) {
      try { unlinkSync(stale) } catch { /* pruning is best effort */ }
    }
    return target
  } catch {
    // A failed backup must never block the write it precedes.
    return null
  }
}

/**
 * Persist the store atomically, after taking a rotating backup.
 *
 * Refuses to write an empty store over a populated file. That is the shape of
 * every catastrophic loss here — a failed load returning `{profiles: []}`, then
 * a routine save committing it — and no legitimate caller needs it. Callers
 * that really mean it (a full reset) pass `allowEmpty`.
 */
export function saveVoiceProfileStore(
  storePath: string,
  store: ProfileStore,
  options: { allowEmpty?: boolean; nowMs?: number } = {},
): { written: boolean; backup: string | null; refusedReason?: string } {
  if (store.profiles.length === 0 && !options.allowEmpty) {
    const current = loadJsonOrQuarantine<ProfileStore>(storePath)
    if (current.status === 'ok' && (current.data?.profiles?.length ?? 0) > 0) {
      return {
        written: false,
        backup: null,
        refusedReason: `refusing to overwrite ${current.data.profiles.length} stored profile(s) with an empty store`,
      }
    }
  }

  const backup = backupProfileStore(storePath, { nowMs: options.nowMs })
  mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 })
  durableAtomicWriteFileSync(storePath, JSON.stringify(store, null, 2), { mode: 0o600 })
  return { written: true, backup }
}

/** Drop the oldest sample, keeping `embeddings` and `sources` in lockstep.
 *
 *  The old inline form was `embeddings.shift()` followed by `sources?.shift()`,
 *  which silently skipped the second half whenever `sources` was undefined and
 *  desynchronised provenance from that point on — permanently, since every
 *  later push appended to both. */
export function dropOldestEmbedding(profile: VoiceProfile): { droppedSource: string | null } {
  if (profile.embeddings.length === 0) return { droppedSource: null }
  profile.embeddings.shift()
  if (!Array.isArray(profile.sources)) profile.sources = []
  // Re-align first so a short sources[] cannot shift the wrong provenance off.
  while (profile.sources.length < profile.embeddings.length + 1) profile.sources.push(UNKNOWN_SOURCE)
  const droppedSource = profile.sources.shift() ?? null
  profile.sources.length = profile.embeddings.length
  return { droppedSource }
}

/** Append a sample to both arrays together. */
export function appendEmbedding(profile: VoiceProfile, embedding: number[], source: string): void {
  if (!Array.isArray(profile.sources)) profile.sources = []
  while (profile.sources.length < profile.embeddings.length) profile.sources.push(UNKNOWN_SOURCE)
  profile.embeddings.push(embedding)
  profile.sources.push(source)
}

/** Remove every sample whose provenance matches, e.g. one poisoned session.
 *  Returns the number removed so a retraction can be reported rather than
 *  assumed. */
export function removeEmbeddingsBySource(
  profile: VoiceProfile,
  predicate: (source: string) => boolean,
): number {
  if (!Array.isArray(profile.sources)) profile.sources = []
  while (profile.sources.length < profile.embeddings.length) profile.sources.push(UNKNOWN_SOURCE)
  const keptEmbeddings: number[][] = []
  const keptSources: string[] = []
  let removed = 0
  for (let i = 0; i < profile.embeddings.length; i++) {
    if (predicate(profile.sources[i] ?? UNKNOWN_SOURCE)) { removed++; continue }
    keptEmbeddings.push(profile.embeddings[i])
    keptSources.push(profile.sources[i] ?? UNKNOWN_SOURCE)
  }
  profile.embeddings = keptEmbeddings
  profile.sources = keptSources
  return removed
}

/** Cosine similarity between two raw rows. Local so this module stays free of
 *  the sherpa runtime and can be unit-tested without a 26 MB model. */
export function rowCosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

/** L2-normalized mean of the rows that share the modal dimension. */
export function profileCentroid(embeddings: number[][]): number[] {
  const dim = modalDimension(embeddings)
  if (dim === 0) return []
  const usable = embeddings.filter(row => row.length === dim)
  if (usable.length === 0) return []
  const c = new Array<number>(dim).fill(0)
  for (const row of usable) for (let i = 0; i < dim; i++) c[i] += row[i]
  for (let i = 0; i < dim; i++) c[i] /= usable.length
  const norm = Math.sqrt(c.reduce((sum, v) => sum + v * v, 0))
  return norm > 0 ? c.map(v => v / norm) : c
}

/** How close two profiles' centroids are. This is the number a merge must be
 *  justified by: names are not evidence, and `Miles Mallard` / `Manoj Kumar`
 *  are different humans who would merge happily on a name heuristic. */
export function profileSimilarity(a: VoiceProfile, b: VoiceProfile): number {
  return rowCosine(profileCentroid(a.embeddings), profileCentroid(b.embeddings))
}

/** Pick the N most acoustically diverse samples, carrying provenance along.
 *
 *  A merge routinely produces more samples than the per-speaker cap (two
 *  capped profiles make 40 against a cap of 20), and which 20 survive matters:
 *  taking the first N would keep one profile's acoustic conditions and discard
 *  the other's, which is the opposite of what merging is for. Greedy
 *  max-min-distance keeps the spread.
 *
 *  Returns indices so the caller can slice embeddings and sources together. */
export function selectDiverseIndices(embeddings: number[][], maxN: number): number[] {
  if (embeddings.length <= maxN) return embeddings.map((_, i) => i)

  // Seed with the two most dissimilar rows.
  let worstPair = Number.POSITIVE_INFINITY, seedA = 0, seedB = 1
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const sim = rowCosine(embeddings[i], embeddings[j])
      if (sim < worstPair) { worstPair = sim; seedA = i; seedB = j }
    }
  }
  const chosen = [seedA, seedB]
  const taken = new Set(chosen)
  while (chosen.length < maxN) {
    let best = -1, bestMinDist = -Infinity
    for (let i = 0; i < embeddings.length; i++) {
      if (taken.has(i)) continue
      let minDist = Infinity
      for (const c of chosen) {
        const dist = 1 - rowCosine(embeddings[i], embeddings[c])
        if (dist < minDist) minDist = dist
      }
      if (minDist > bestMinDist) { bestMinDist = minDist; best = i }
    }
    if (best === -1) break
    chosen.push(best)
    taken.add(best)
  }
  // Ascending so the surviving order still reflects enrollment order.
  return chosen.sort((x, y) => x - y)
}

export interface MergeOutcome {
  /** Centroid cosine between the target and each source, before merging. */
  similarity: Record<string, number>
  samplesBefore: number
  samplesAfter: number
  /** Samples discarded by the cap, not by the merge itself. */
  droppedToCap: number
  mergedFrom: string[]
  missing: string[]
}

/**
 * Fold one or more profiles into another.
 *
 * Provenance is deliberately PRESERVED rather than restamped `merged:*`: the
 * per-source retraction path is what makes a poisoned `auto:<sessionId>` sample
 * removable later, and overwriting it to record a bookkeeping event would trade
 * a useful fact for a useless one.
 */
export function mergeProfilesInStore(
  store: ProfileStore,
  into: string,
  from: string[],
  options: { cap?: number } = {},
): MergeOutcome {
  const cap = options.cap ?? 20
  const target = store.profiles.find(p => p.name === into)
  const outcome: MergeOutcome = {
    similarity: {},
    samplesBefore: target?.embeddings.length ?? 0,
    samplesAfter: target?.embeddings.length ?? 0,
    droppedToCap: 0,
    mergedFrom: [],
    missing: [],
  }
  if (!target) {
    outcome.missing = [into, ...from]
    return outcome
  }

  const embeddings = [...target.embeddings]
  const sources = [...(target.sources ?? [])]
  while (sources.length < embeddings.length) sources.push(UNKNOWN_SOURCE)

  for (const name of from) {
    if (name === into) continue
    const source = store.profiles.find(p => p.name === name)
    if (!source) { outcome.missing.push(name); continue }
    outcome.similarity[name] = profileSimilarity(target, source)
    const sourceSources = [...(source.sources ?? [])]
    while (sourceSources.length < source.embeddings.length) sourceSources.push(UNKNOWN_SOURCE)
    for (let i = 0; i < source.embeddings.length; i++) {
      embeddings.push(source.embeddings[i])
      sources.push(sourceSources[i] ?? UNKNOWN_SOURCE)
    }
    outcome.mergedFrom.push(name)
  }

  if (outcome.mergedFrom.length === 0) return outcome

  const keep = selectDiverseIndices(embeddings, cap)
  outcome.droppedToCap = embeddings.length - keep.length
  target.embeddings = keep.map(i => embeddings[i])
  target.sources = keep.map(i => sources[i])
  outcome.samplesAfter = target.embeddings.length

  const removed = new Set(outcome.mergedFrom)
  store.profiles = store.profiles.filter(p => !removed.has(p.name))
  return outcome
}

/** Delete a person's profile outright. Returns what was removed so the caller
 *  can report a per-store count instead of a bare success. */
export function deleteProfileFromStore(
  store: ProfileStore,
  name: string,
): { removedProfiles: number; removedEmbeddings: number } {
  let removedProfiles = 0
  let removedEmbeddings = 0
  store.profiles = store.profiles.filter(profile => {
    if (profile.name !== name) return true
    removedProfiles++
    removedEmbeddings += profile.embeddings.length
    return false
  })
  return { removedProfiles, removedEmbeddings }
}
