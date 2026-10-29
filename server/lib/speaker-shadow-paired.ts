/** Paired G2/Mac diagnostics only. No remap, identity proof, meeting write or training. */
import { checkSpeakerName } from './speaker-name.js'
import { SHADOW_GATES, SHADOW_SAMPLE_RATE, isShadowVoiceLabel, type ShadowAccepted, type ShadowSegment, type ShadowTurn, type ShadowVoiceEntry } from './speaker-shadow-decide.js'

export const PAIRED_SHADOW_GATES = Object.freeze({ nameAllSpeechFraction: 0.8, nameSupportSeconds: 30, shortMinSeconds: 5, shortMaxSeconds: 15, shortAnchorRatio: 1.1 })
export type ShadowPairAlignment =
  | { status: 'qualified'; evidenceId: string; offsetMs: number; maxErrorMs: number }
  | { status: 'unpaired' | 'ambiguous' | 'time_only' }
export interface ShadowG2Chunk { speaker: string; elapsed: number; audioDurationMs?: number; durationMs?: number }
export interface ShadowG2Recording { startTime: string | number; chunks: readonly ShadowG2Chunk[] }
export interface PairedShadowInput {
  macStartTime: string | number
  totalSamples: number
  segments: readonly ShadowSegment[]
  regularTurns: readonly ShadowTurn[]
  /** Final accepted groups only; rejected/co-located voices must not be added here. */
  acceptedGroups: readonly ShadowAccepted[]
  /** Existing acoustic rows, including rejected short fragments. Never recomputed from names. */
  voiceEvidence: readonly ShadowVoiceEntry[]
  g2?: ShadowG2Recording
  alignment: ShadowPairAlignment
}
export interface PairedNameSupport { name: string; seconds: number; fractionOfAllSpeech: number; fractionOfKnownName: number }
export interface PairedShadowAgreement {
  allSpeechSeconds: number
  knownNameSeconds: number
  unknownOrUnpairedSeconds: number
  conflictingG2Seconds: number
  productionConflictSeconds: number
  nativeUncoveredSeconds: number
  nativeConflictSeconds: number
  wrongClusterSeconds: number
  names: PairedNameSupport[]
  diagnosticTopName: string | null
  diagnosticAllSpeechGate: boolean
}
export interface PairedShadowGroup extends PairedShadowAgreement {
  cluster: string
  voices: string[]
  candidateName: string | null
  reasons: string[]
}
export interface PairedShadowVoice extends PairedShadowAgreement { voice: string; cluster: string | null }
export interface PairedShadowSpan { startSample: number; endSample: number; cluster: string; candidateName: string }
export interface PairedShadowShortCandidate { voice: string; cluster: string; candidateName: string; seconds: number }
export interface PairedShadowReport {
  mode: 'provisional_shadow_only'
  alignmentStatus: ShadowPairAlignment['status']
  candidateNominationAllowed: boolean
  accuracyClaim: false
  humanTruthClaim: false
  warnings: string[]
  groups: PairedShadowGroup[]
  voices: PairedShadowVoice[]
  extCandidates: PairedShadowSpan[]
  shortCandidates: PairedShadowShortCandidate[]
  shortWithheld: Array<{ voice: string; reasons: string[] }>
}

/** A plausible saved G2 name is still a machine label, never human ground truth. */
export function isPairedShadowName(label: string): boolean {
  const name = label.trim().replace(/\s+/gu, ' ')
  if (/^(?:ext|unknown|mu|me|speaker(?:[\s_-]*(?:\d+|n))?|voice(?:[\s_-]*(?:\d+|n))?)$/iu.test(name)) return false
  return checkSpeakerName(name).ok
}

type Row = readonly [number, number, string]
type Counts = Map<string, number>
interface Stats { all: number; known: number; unknown: number; conflict: number; production: number; uncovered: number; nativeConflict: number; wrong: number; names: Counts }
const stats = (): Stats => ({ all: 0, known: 0, unknown: 0, conflict: 0, production: 0, uncovered: 0, nativeConflict: 0, wrong: 0, names: new Map() })
const add = (map: Counts, key: string, amount: number) => { const n = (map.get(key) ?? 0) + amount; if (n) map.set(key, n); else map.delete(key) }
const epoch = (value: string | number): number => typeof value === 'number' ? value : Date.parse(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const SR = SHADOW_SAMPLE_RATE

function accumulate(s: Stats, amount: number, production: Counts, native: Counts, g2: Counts, cluster: string | null): void {
  s.all += amount
  const name = g2.size === 1 ? [...g2.keys()][0] : null
  if (g2.size > 1) s.conflict += amount
  else if (name && isPairedShadowName(name)) s.known += amount
  else s.unknown += amount
  if (production.size > 1) s.production += amount
  if (!native.size) s.uncovered += amount
  else if (native.size > 1) s.nativeConflict += amount
  else if (cluster !== null && !native.has(cluster)) s.wrong += amount
  if (production.size === 1 && native.size === 1 && cluster !== null && native.has(cluster) && name && g2.size === 1 && isPairedShadowName(name)) add(s.names, name, amount)
}

function agreement(s: Stats): PairedShadowAgreement {
  const names = [...s.names].map(([name, n]) => ({ name, seconds: n / SR, fractionOfAllSpeech: s.all ? n / s.all : 0, fractionOfKnownName: s.known ? n / s.known : 0 }))
    .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name))
  const best = names[0]
  const unique = !!best && (!names[1] || names[1].seconds !== best.seconds)
  return { allSpeechSeconds: s.all / SR, knownNameSeconds: s.known / SR, unknownOrUnpairedSeconds: s.unknown / SR, conflictingG2Seconds: s.conflict / SR,
    productionConflictSeconds: s.production / SR, nativeUncoveredSeconds: s.uncovered / SR, nativeConflictSeconds: s.nativeConflict / SR, wrongClusterSeconds: s.wrong / SR,
    names, diagnosticTopName: unique ? best.name : null,
    diagnosticAllSpeechGate: unique && best.fractionOfAllSpeech >= PAIRED_SHADOW_GATES.nameAllSpeechFraction && best.seconds >= PAIRED_SHADOW_GATES.nameSupportSeconds }
}

/**
 * Sweep half-open sample intervals once. Duplicate same-label rows union; different
 * simultaneous labels withhold votes. Every group/voice denominator includes its
 * unknown, uncovered and conflicting time, so named-only percentages cannot qualify it.
 * offsetMs adds to the G2 wall clock. Only caller-qualified alignment enables nominations;
 * timestamp coincidence alone is diagnostic. maxErrorMs erodes G2 vote intervals.
 */
export function evaluatePairedSpeakerShadow(input: PairedShadowInput): PairedShadowReport {
  if (!Number.isSafeInteger(input.totalSamples) || input.totalSamples <= 0 || input.totalSamples > 4 * 3600 * SR) throw new Error('invalid paired shadow timeline')
  if (input.segments.length + input.regularTurns.length + (input.g2?.chunks.length ?? 0) > 100_000) throw new Error('paired shadow interval budget exceeded')
  const warnings = new Set<string>()
  let safe = true
  const macStart = epoch(input.macStartTime)
  if (!finite(macStart)) { warnings.add('invalid Mac startTime'); safe = false }
  const align = input.alignment
  let qualified = align.status === 'qualified' && !!align.evidenceId.trim() && finite(align.offsetMs) && finite(align.maxErrorMs) && align.maxErrorMs >= 0
  if (align.status === 'qualified' && !qualified) { warnings.add('invalid qualified alignment evidence'); safe = false }
  if (align.status !== 'qualified') warnings.add(`${align.status}: time alignment is uncertain; diagnostic only`)
  // Time-only still reports wall-clock overlap; it cannot transfer names.
  const offset = qualified && align.status === 'qualified' ? align.offsetMs : 0
  const erosion = qualified && align.status === 'qualified' ? Math.ceil(align.maxErrorMs * SR / 1000) : 0
  const production: Row[] = [], native: Row[] = [], paired: Row[] = []
  const clip = (rows: Row[], lo: number, hi: number, label: string, source: string) => {
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi <= lo || typeof label !== 'string' || !label.trim()) { warnings.add(`invalid ${source} interval`); safe = false; return }
    const a = Math.max(0, lo), b = Math.min(input.totalSamples, hi)
    if (a < b) rows.push([a, b, label.trim().replace(/\s+/gu, ' ')])
  }
  for (const [lo, hi, label] of input.segments) clip(production, lo, hi, label, 'production')
  for (const turn of input.regularTurns) clip(native, Math.round(turn.start * SR), Math.round(turn.end * SR), turn.speaker, 'native')
  if (!input.g2) { warnings.add('no paired G2 recording'); qualified = false }
  else {
    const g2Start = epoch(input.g2.startTime)
    if (!finite(g2Start)) { warnings.add('invalid G2 startTime'); safe = false }
    for (const chunk of input.g2.chunks) {
      const duration = chunk.audioDurationMs ?? chunk.durationMs
      if (!finite(chunk.elapsed) || chunk.elapsed < 0 || !finite(duration) || duration <= 0 || (chunk.audioDurationMs !== undefined && chunk.durationMs !== undefined && chunk.audioDurationMs !== chunk.durationMs)) {
        warnings.add('invalid or conflicting G2 elapsed/duration'); safe = false; continue
      }
      const lo = Math.round((g2Start - macStart + offset + chunk.elapsed) * SR / 1000) + erosion
      const hi = Math.round((g2Start - macStart + offset + chunk.elapsed + duration) * SR / 1000) - erosion
      // Entire interval inside alignment uncertainty contributes no name support.
      if (hi <= lo && finite(lo) && finite(hi)) continue
      clip(paired, lo, hi, chunk.speaker, 'G2')
    }
  }
  const groups = new Map<string, { voices: string[]; stats: Stats }>()
  const groupOfVoice = new Map<string, string>()
  for (const group of input.acceptedGroups) {
    const voices = [group.keepLabel, ...group.merge]
    if (!group.cluster || groups.has(group.cluster) || new Set(voices).size !== voices.length || voices.some(v => !isShadowVoiceLabel(v) || groupOfVoice.has(v))) throw new Error('ambiguous accepted paired group')
    groups.set(group.cluster, { voices, stats: stats() })
    for (const voice of voices) groupOfVoice.set(voice, group.cluster)
  }
  const evidence = new Map<string, ShadowVoiceEntry>()
  for (const row of input.voiceEvidence) {
    if (evidence.has(row.voice)) throw new Error('duplicate paired voice evidence')
    evidence.set(row.voice, row)
  }
  const byVoice = new Map<string, Stats>()
  for (const [, , label] of production) if (isShadowVoiceLabel(label) && !byVoice.has(label)) byVoice.set(label, stats())
  type Event = { at: number; kind: number; label: string; delta: number }
  const events: Event[] = []
  for (const [kind, rows] of [production, native, paired].entries()) for (const [lo, hi, label] of rows) {
    events.push({ at: lo, kind, label, delta: 1 }, { at: hi, kind, label, delta: -1 })
  }
  events.sort((a, b) => a.at - b.at)
  const active = [new Map<string, number>(), new Map<string, number>(), new Map<string, number>()]
  const ext: Array<{ lo: number; hi: number; cluster: string; name: string }> = []
  for (let i = 0; i < events.length;) {
    const at = events[i].at
    while (i < events.length && events[i].at === at) { const event = events[i++]; add(active[event.kind], event.label, event.delta) }
    const end = events[i]?.at
    if (end === undefined || end <= at) continue
    const touched = new Set<string>()
    for (const voice of active[0].keys()) {
      const s = byVoice.get(voice)
      if (s) accumulate(s, end - at, active[0], active[1], active[2], evidence.get(voice)?.topCluster ?? groupOfVoice.get(voice) ?? null)
      const group = groupOfVoice.get(voice)
      if (group) touched.add(group)
    }
    for (const cluster of touched) accumulate(groups.get(cluster)!.stats, end - at, active[0], active[1], active[2], cluster)
    if (active[0].size === 1 && active[0].has('Ext') && active[1].size === 1 && active[2].size === 1) {
      const cluster = [...active[1].keys()][0], name = [...active[2].keys()][0]
      if (groups.has(cluster) && isPairedShadowName(name)) ext.push({ lo: at, hi: end, cluster, name })
    }
  }
  const allow = qualified && safe
  const groupRows: PairedShadowGroup[] = [...groups].map(([cluster, group]) => {
    const result = agreement(group.stats), reasons: string[] = []
    if (!allow) reasons.push('paired alignment is not qualified')
    if (!result.diagnosticAllSpeechGate) reasons.push('name requires 80% of ALL group speech and at least 30s support')
    return { ...result, cluster, voices: group.voices, candidateName: allow && result.diagnosticAllSpeechGate ? result.diagnosticTopName : null, reasons }
  })
  const named = new Map(groupRows.filter(g => g.candidateName).map(g => [g.cluster, g.candidateName!]))
  const voices = [...byVoice].map(([voice, s]) => ({ ...agreement(s), voice, cluster: evidence.get(voice)?.topCluster ?? groupOfVoice.get(voice) ?? null }))
  const extCandidates: PairedShadowSpan[] = []
  if (allow) for (const span of ext) if (named.get(span.cluster) === span.name) {
    const previous = extCandidates.at(-1)
    if (previous && previous.endSample === span.lo && previous.cluster === span.cluster && previous.candidateName === span.name) previous.endSample = span.hi
    else extCandidates.push({ startSample: span.lo, endSample: span.hi, cluster: span.cluster, candidateName: span.name })
  }
  const shortCandidates: PairedShadowShortCandidate[] = [], shortWithheld: PairedShadowReport['shortWithheld'] = []
  for (const voice of voices) {
    if (voice.allSpeechSeconds < PAIRED_SHADOW_GATES.shortMinSeconds || voice.allSpeechSeconds > PAIRED_SHADOW_GATES.shortMaxSeconds) continue
    const row = evidence.get(voice.voice), reasons: string[] = []
    if (!allow) reasons.push('paired alignment is not qualified')
    if (!row || !finite(row.seconds) || Math.abs(row.seconds - voice.allSpeechSeconds) > 1 / SR) reasons.push('missing or inconsistent acoustic evidence')
    if (!row || !finite(row.majority) || row.majority < SHADOW_GATES.majority) reasons.push('acoustic majority below 0.8')
    if (!row || !finite(row.coveredFraction) || row.coveredFraction < SHADOW_GATES.minCoveredFraction) reasons.push('acoustic coverage below 0.5')
    if (!row?.outlierPass) reasons.push('acoustic outlier check failed')
    if (!row || !finite(row.anchorRatioPostHoc) || row.anchorRatioPostHoc < 0 || row.anchorRatioPostHoc > PAIRED_SHADOW_GATES.shortAnchorRatio) reasons.push('anchor ratio unavailable or above 1.1')
    const name = voice.cluster ? named.get(voice.cluster) : undefined
    const support = voice.names.find(n => n.name === name)
    if (!name || !support || support.fractionOfAllSpeech < PAIRED_SHADOW_GATES.nameAllSpeechFraction || voice.diagnosticTopName !== name) reasons.push('fragment and group lack same-time G2 name agreement')
    if (reasons.length) shortWithheld.push({ voice: voice.voice, reasons })
    else shortCandidates.push({ voice: voice.voice, cluster: voice.cluster!, candidateName: name!, seconds: voice.allSpeechSeconds })
  }
  return { mode: 'provisional_shadow_only', alignmentStatus: align.status, candidateNominationAllowed: allow, accuracyClaim: false, humanTruthClaim: false,
    warnings: [...warnings], groups: groupRows, voices, extCandidates, shortCandidates, shortWithheld }
}

/** Readable paired-recording diagnostics. All labels here remain provisional. */
export function renderPairedSpeakerShadow(report: PairedShadowReport): string {
  const esc = (value: string) => value.replace(/[|\r\n]/gu, ' ').replace(/[*`<>]/gu, '')
  const seconds = (n: number) => `${n.toFixed(1)} s`
  const lines = ['## Paired G2 diagnostics', '',
    `Alignment: **${report.alignmentStatus}**. ${report.candidateNominationAllowed ? 'Provisional shadow nominations are allowed.' : 'Nominations withheld; overlap statistics are diagnostic only.'}`,
    'Saved G2 names are machine labels. This comparison makes no accuracy or human-truth claim.', '',
    '| Cluster | All group speech | Unique known-name time | Top name support / all speech | Top name support / known-name time | Name nomination |',
    '|---|---:|---:|---|---|---|']
  for (const group of report.groups) {
    const best = group.names[0]
    const support = best ? `${esc(best.name)}: ${seconds(best.seconds)}` : 'None'
    lines.push(`| ${esc(group.cluster)} | ${seconds(group.allSpeechSeconds)} | ${seconds(group.knownNameSeconds)} | ${support}; ${((best?.fractionOfAllSpeech ?? 0) * 100).toFixed(1)}% | ${((best?.fractionOfKnownName ?? 0) * 100).toFixed(1)}% | ${group.candidateName ? esc(group.candidateName) + ' (provisional)' : 'Withheld'} |`)
  }
  lines.push('', 'Name support requires at least 80% of ALL group speech and 30 seconds. Known-name percentages alone cannot qualify a name.', '',
    '| Voice | All speech | Known-name time | Top name / all speech | Production conflict | Native conflict / uncovered |',
    '|---|---:|---:|---|---:|---|')
  for (const voice of report.voices) {
    const best = voice.names[0]
    lines.push(`| ${esc(voice.voice)} | ${seconds(voice.allSpeechSeconds)} | ${seconds(voice.knownNameSeconds)} | ${best ? `${esc(best.name)} ${((best.fractionOfAllSpeech) * 100).toFixed(1)}%` : 'None'} | ${seconds(voice.productionConflictSeconds)} | ${seconds(voice.nativeConflictSeconds)} / ${seconds(voice.nativeUncoveredSeconds)} |`)
  }
  lines.push('', `Ext span nominations: ${report.extCandidates.length}. Short-fragment nominations: ${report.shortCandidates.length}. These lists do not change labels or remaps.`)
  for (const group of report.groups) if (group.reasons.length) lines.push(`- ${esc(group.cluster)}: ${group.reasons.map(esc).join('; ')}.`)
  for (const row of report.shortWithheld) lines.push(`- ${esc(row.voice)} short fragment withheld: ${row.reasons.map(esc).join('; ')}.`)
  for (const warning of report.warnings) lines.push(`- ${esc(warning)}.`)
  return lines.join('\n') + '\n'
}
