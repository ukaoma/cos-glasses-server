// Speaker shadow mode (6.95.0): the readable per-meeting report Miles checks by ear.
//
// A port of round3/propose.py `render()`: "N voices would become M", every accepted merge
// with its seconds, gate values and two or three listen pointers (file, time, text),
// every rejection with its reasons, and the named labels sharing a cluster as a hint
// ("this group also holds 65 s labelled ..."). Pure: it returns text, and the runner
// writes it under <data>/speaker-shadow/reports/. It proposes; it never applies anything.

import { join } from 'node:path'
import { SHADOW_GATES, type ShadowProposals, type ShadowVoiceEntry } from './speaker-shadow-decide.js'
import { PY_SPACE_CLASS, pyFixed } from './speaker-shadow-numeric.js'

export interface ShadowReportInput {
  title: string
  sessionId: string
  proposals: ShadowProposals
  facts: { minutes: number; originals: number; verifiedAgainstSidecar: number; unhashedOriginals: number; unhashedWithText: number[]; humanProtectedVoices: string[] }
  /** Where the chunk WAVs are, so each pointer names a file Miles can play. */
  audioDir: string
  /** The original chunk text by raw chunk index (the first 140 characters are quoted). */
  chunkText: ReadonlyMap<number, string>
}

const STRIP = new RegExp(`^${PY_SPACE_CLASS}+|${PY_SPACE_CLASS}+$`, 'gu')
const quote = (text: string | undefined) => Array.from((text ?? '').replace(STRIP, '')).slice(0, 140).join('')
const chunkFile = (dir: string, index: number) => join(dir, `chunk_${String(index).padStart(4, '0')}.wav`)
const HEADER = ['| Voice | Speech | Covered | Top cluster, majority | Outlier check | Anchor ratio (post-hoc) |', '|---|---:|---:|---|---|---|']

/** propose.py fmt_voice. */
export function shadowVoiceRow(m: ShadowVoiceEntry): string {
  const o = m.outlierPass && m.outlierDistance !== null
    ? `outlier ${pyFixed(m.outlierDistance, 3)} ≤ p95 ${pyFixed(m.outlierP95!, 3)}`
    : m.outlierDistance !== null ? `outlier ${pyFixed(m.outlierDistance, 3)} > p95 ${pyFixed(m.outlierP95!, 3)}` : `outlier: ${m.outlierNote}`
  const ar = m.anchorRatioPostHoc === null ? '—' : `${pyFixed(m.anchorRatioPostHoc, 2)}x${m.anchorRatioPostHoc > SHADOW_GATES.anchorRatioPostHoc ? ' (above 1.5x)' : ''}`
  return `| ${m.voice} | ${pyFixed(m.seconds, 1)} s | ${pyFixed(100 * m.coveredFraction, 0)}% | ${m.topCluster ?? 'None'} ${pyFixed(m.majority, 2)} | ${o} | ${ar} |`
}

function listenLines(m: ShadowVoiceEntry, input: ShadowReportInput): string[] {
  return m.listen.map(p => `  - ${m.voice}: \`${chunkFile(input.audioDir, p.chunkIndex)}\` ${pyFixed(p.inFileStart, 1)} to ${pyFixed(p.inFileEnd, 1)} s (call time ${p.callTime}) "${quote(input.chunkText.get(p.chunkIndex))}"`)
}

export function renderShadowReport(input: ShadowReportInput): string {
  const P = input.proposals, F = input.facts
  const L: string[] = [
    `# ${input.title}`, '',
    `**${P.productionVoices} voices would become ${P.voicesAfter}.** FluidAudio proposed ${P.proposedMerges} merges; ${P.acceptedMerges} pass every gate, ${P.rejectedMerges} do not. Shadow mode only: nothing was renamed or written.`, '',
    F.unhashedWithText.length
      ? `- Meeting: ${pyFixed(F.minutes, 1)} min, ${F.originals} originals (${F.verifiedAgainstSidecar} verified; ${F.unhashedOriginals} unhashed, of which ${F.unhashedWithText.length} have text: check them).`
      : `- Meeting: ${pyFixed(F.minutes, 1)} min, ${F.originals} originals (${F.verifiedAgainstSidecar} verified against the sidecar hashes; ${F.unhashedOriginals} had no hash, all empty-text).`,
    `- FluidAudio found ${P.fluidAudioClusters} clusters. Labels never merged: ${P.frozenOtherLabels.join(', ') || 'none'}.`,
    '- Gates: majority ≥0.8 of covered speech on one cluster (and ≥50% covered), ≥15 s of speech, embedding centroid inside the cluster spread (p95).',
    '- "Anchor ratio" is an UNVALIDATED extra check (fragment vs the kept voice\'s own spread); it decides nothing. Above 1.5x is worth a listen.',
    '- How to check: play two or three pointers for each voice in a row. Same person? The merge is right.',
    ...(F.humanProtectedVoices.length ? [`- A person already edited chunks holding ${F.humanProtectedVoices.join(', ')}. Those edits outrank any proposal here.`] : []),
    `- Session \`${input.sessionId}\`.`, '',
    '## Accepted proposals', '',
  ]
  if (!P.accepted.length) L.push('None.')
  for (const a of P.accepted) {
    L.push(`### ${a.cluster}: merge ${a.merge.join(', ')} into **${a.keepLabel}**`)
    if (a.otherLabelsInCluster.length) {
      L.push(`Caution: this group also holds ${a.otherLabelsInCluster.map(o => `${pyFixed(o.seconds, 0)} s labelled ${o.label}`).join(', ')}. Those labels stay as they are.`)
    }
    const touched = a.voices.map(m => m.voice).filter(v => F.humanProtectedVoices.includes(v))
    if (touched.length) L.push(`Human edit: ${touched.join(', ')} carries a person's correction on some chunks.`)
    L.push('', ...HEADER, ...a.voices.map(shadowVoiceRow), '', 'Listen:')
    for (const m of a.voices) L.push(...listenLines(m, input))
    L.push('')
  }
  L.push('## Rejected proposals', '')
  const rejected = P.rejected.filter(r => r.wouldJoin)
  if (!rejected.length) L.push('None.')
  for (const r of rejected) {
    L.push(`- **${r.voice}** would have joined ${r.wouldJoin} on ${r.cluster}. Rejected: ${r.reasons.join('; ')}.`)
    L.push('', HEADER[0], HEADER[1], shadowVoiceRow(r), '', ...listenLines(r, input), '')
  }
  L.push('## Untouched voices', '')
  const kept = P.rejected.filter(r => !r.wouldJoin)
  for (const r of kept) {
    const fails = r.eligible ? '' : ` (it also fails: ${r.reasons.filter(x => !x.startsWith('no other')).join('; ')})`
    L.push(`- ${r.voice} (${pyFixed(r.seconds, 1)} s): kept as is; it shares ${r.cluster} with other voices, but none of them passed every gate${fails}.`)
  }
  for (const u of P.untouched) L.push(`- ${u.voice} (${pyFixed(u.seconds, 1)} s): ${u.why}.`)
  if (!kept.length && !P.untouched.length) L.push('None.')
  L.push('')
  return L.join('\n')
}

/** A meeting the run skipped or failed: one short page, so every finished meeting has a report. */
export function renderShadowSkipReport(input: { title: string; sessionId: string; status: 'skipped' | 'failed'; reason: string | null; detail: string | null }): string {
  return [`# ${input.title}`, '', `**No proposals: ${input.status}** (\`${input.reason ?? 'unknown'}\`). ${input.detail ?? ''}`.trimEnd(), '', `- Session \`${input.sessionId}\`. Shadow mode only: nothing was renamed or written.`, ''].join('\n')
}

/** The run's own facts, appended by the runner (it alone knows wall time and memory). */
export function renderShadowRunFacts(input: { rebuildMs: number; nativeMs: number; wallMs: number; peakRssBytes: number | null; osTempDirsLeft: number; sidecarPath: string; pcmSHA256: string; cliTrust: string | null }): string {
  return ['## Run facts', '',
    `- Rebuild ${pyFixed(input.rebuildMs / 1000, 1)} s, diarization ${pyFixed(input.nativeMs / 1000, 1)} s, total ${pyFixed(input.wallMs / 1000, 1)} s. Peak memory ${input.peakRssBytes === null ? 'not sampled' : `${Math.round(input.peakRssBytes / 1048576)} MB`}.`,
    `- fluidaudiocli trust: ${input.cliTrust ?? 'unknown'}. Network denied by sandbox-exec. Empty OS temp dirs left: ${input.osTempDirsLeft}.`,
    `- Sidecar: \`${input.sidecarPath}\`. The timeline WAV was a temporary input and was deleted (PCM SHA ${input.pcmSHA256.slice(0, 12)}…).`, ''].join('\n')
}

/** The report's place: reports/<YYYY-MM-DD>/<title stem>__<session>.md, named like meeting-store names meetings. */
export function shadowReportRelativePath(title: string, sessionId: string, day: string): string {
  const stem = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '').replace(/_{2,}/g, '_').slice(0, 72) || 'Mac_recording'
  const safeDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : 'undated'
  // The whole session id: two meetings can share a title and a long id prefix.
  return join('reports', safeDay, `${stem}__${sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)}.md`)
}
