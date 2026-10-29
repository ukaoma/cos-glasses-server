// Research-base parity plus independent Wave-1 anchor-gate parity on REAL meetings.
// Off by default (skipped): the inputs are
// a private meeting's labels and voice embeddings and must never enter this public repo.
//
//   COS_SPEAKER_SHADOW_PARITY_DIR=~/cos-release-candidates/speaker-shadow-wave1-20261029/integration/private-parity \
//     npx vitest run server/lib/speaker-shadow-parity.test.ts
//
// The directory holds, per meeting <name>: <name>-inputs.json (segs, sources, the CLI's
// native segments and embeddings, exactly what round3/propose.py fed hybrid.decide),
// <name>-decide.json (hybrid.decide's own output plus the unrounded outlier distances, as
// Python repr), <name>-proposals.json (round3, verbatim), and <name>-anchor-gate.json
// from __fixtures__/speaker-shadow/python_anchor_gate.py over those SAME inputs.
// Generate the new anchor-gate references in a private copy; never overwrite the
// historical decide/proposals files or put private inputs in this repository.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHADOW_SAMPLE_RATE, buildShadowProposals, decide, nativeTurns, type ShadowSegment } from './speaker-shadow-decide.js'

const dir = process.env.COS_SPEAKER_SHADOW_PARITY_DIR?.trim()
const meetings = dir && existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('-inputs.json')).map(n => n.replace(/-inputs\.json$/, '')) : []

describe.skipIf(!meetings.length)('speaker shadow research and Wave-1 parity (private fixtures)', () => {
  for (const name of meetings) {
    describe(name, () => {
      const inputs = JSON.parse(readFileSync(join(dir!, `${name}-inputs.json`), 'utf8'))
      const pyDecide = JSON.parse(readFileSync(join(dir!, `${name}-decide.json`), 'utf8'))
      const round3 = JSON.parse(readFileSync(join(dir!, `${name}-proposals.json`), 'utf8'))
      const anchorGate = JSON.parse(readFileSync(join(dir!, `${name}-anchor-gate.json`), 'utf8'))
      const segs = inputs.segs as ShadowSegment[]
      // A meeting exported without segment sources is compared on everything but listen pointers.
      const hasSources = Array.isArray(inputs.sources)
      const sources = hasSources ? inputs.sources : segs.map(([lo]) => ({ chunkIndex: 0, start: 0, end: 0, abs: lo / SHADOW_SAMPLE_RATE }))
      const { turns, clipped } = nativeTurns(inputs.native, inputs.total / SHADOW_SAMPLE_RATE)
      const D = decide(segs, inputs.total, turns, inputs.embeddings)
      const P = buildShadowProposals(D, segs, sources, turns)

      it('reproduces every per-voice gate value and reason string', () => {
        expect(clipped).toBe(pyDecide.clipped)
        expect([...D.rows.keys()]).toEqual(Object.keys(pyDecide.rows))
        for (const [voice, row] of D.rows) {
          const py = pyDecide.rows[voice]
          const baseReasons = row.reasons.filter(reason => !reason.startsWith('(d) '))
          expect({ voice, seconds: row.seconds, coveredFraction: row.coveredFraction, topCluster: row.topCluster, majority: row.majority, fragmentEmbeddings: row.fragmentEmbeddings, otherClusterMembers: row.otherClusterMembers, eligible: !baseReasons.length, reasons: baseReasons })
            .toEqual({ voice, seconds: py.seconds, coveredFraction: py.coveredFraction, topCluster: py.topCluster, majority: py.majority, fragmentEmbeddings: py.fragmentEmbeddings, otherClusterMembers: py.otherClusterMembers, eligible: py.eligible, reasons: py.reasons })
          const o = row.outlier
          if ('reason' in o) expect({ pass: o.pass, reason: o.reason }).toEqual(py.outlier)
          else expect({ pass: o.pass, fragmentCentroidDistance: o.fragmentCentroidDistance, clusterP95Distance: o.clusterP95Distance }).toEqual(py.outlier)
        }
      })

      it('reproduces the unrounded outlier distances bit for bit', () => {
        let compared = 0
        for (const [voice, row] of D.rows) {
          const raw = pyDecide.rawOutlier[voice]
          if (!raw) { expect('reason' in row.outlier).toBe(true); continue }
          expect('raw' in row.outlier).toBe(true)
          if ('raw' in row.outlier) {
            expect(Object.is(row.outlier.raw.distance, Number(raw.d))).toBe(true)
            expect(Object.is(row.outlier.raw.p95, Number(raw.thr))).toBe(true)
            compared++
          }
        }
        expect(compared).toBeGreaterThan(5)
      })

      it('preserves attribution and reproduces the independently gated groups, merges and rejections', () => {
        expect(D.items.map(x => x.voice)).toEqual(pyDecide.itemVoices)
        expect(D.items.map(x => x.outputCluster)).toEqual(pyDecide.itemOut)
        expect([D.agree, D.withOut, D.items.length]).toEqual([pyDecide.agree, pyDecide.withOut, pyDecide.items])
        for (const [voice, row] of D.rows) {
          const reference = anchorGate.rows[voice]
          expect({ pass: row.anchorRatioPass, eligible: row.eligible, reasons: row.reasons })
            .toEqual({ pass: reference.anchorRatioPass, eligible: reference.eligible, reasons: reference.reasons })
          if (reference.anchorRatio === null) expect(row.anchorRatio).toBeNull()
          else expect(row.anchorRatio).toBeCloseTo(reference.anchorRatio, 11)
        }
        expect(D.groups).toEqual(anchorGate.groups)
        expect(D.rejected).toEqual(anchorGate.rejected)
        expect(Object.fromEntries(D.remap)).toEqual(anchorGate.remap)
        expect([D.proposed, D.accepted, D.voiceBefore, D.voiceAfter]).toEqual([pyDecide.proposed, anchorGate.accepted, pyDecide.voiceBefore, anchorGate.voiceAfter])
      })

      it('keeps historical report measurements while applying the new merge gate', () => {
        const historical = new Map<string, any>([...round3.accepted.flatMap((g: any) => g.voices), ...round3.rejected].map((v: any) => [v.voice, v]))
        for (const entry of [...P.accepted.flatMap(g => g.voices), ...P.rejected]) {
          const previous = historical.get(entry.voice)
          expect(previous).toBeDefined()
          for (const key of ['seconds', 'coveredFraction', 'topCluster', 'majority', 'outlierPass', 'outlierDistance', 'outlierP95', 'outlierNote']) {
            expect(entry[key as keyof typeof entry]).toEqual(previous[key])
          }
          expect(entry.eligible).toBe(anchorGate.rows[entry.voice].eligible)
        }
        expect([P.productionVoices, P.voicesAfter, P.acceptedMerges]).toEqual([anchorGate.voiceBefore, anchorGate.voiceAfter, anchorGate.accepted])
        expect(P.accepted.length + P.rejected.length + P.untouched.length).toBeGreaterThan(0)
      })
    })
  }
})
