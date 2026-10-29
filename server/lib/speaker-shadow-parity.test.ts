// Parity with the research tool on REAL meetings. Off by default (skipped): the inputs are
// a private meeting's labels and voice embeddings and must never enter this public repo.
//
//   COS_SPEAKER_SHADOW_PARITY_DIR=~/cos-release-candidates/server-6.95.0-speaker-shadow/parity \
//     npx vitest run server/lib/speaker-shadow-parity.test.ts
//
// The directory holds, per meeting <name>: <name>-inputs.json (segs, sources, the CLI's
// native segments and embeddings, exactly what round3/propose.py fed hybrid.decide),
// <name>-decide.json (hybrid.decide's own output plus the unrounded outlier distances, as
// Python repr) and <name>-proposals.json (the round-3 proposals.json, verbatim).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHADOW_SAMPLE_RATE, buildShadowProposals, decide, nativeTurns, type ShadowSegment } from './speaker-shadow-decide.js'
import { round3View } from './__fixtures__/speaker-shadow/round3-view.js'

const dir = process.env.COS_SPEAKER_SHADOW_PARITY_DIR?.trim()
const meetings = dir && existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('-inputs.json')).map(n => n.replace(/-inputs\.json$/, '')) : []

describe.skipIf(!meetings.length)('speaker shadow parity with round 3 (private fixtures)', () => {
  for (const name of meetings) {
    describe(name, () => {
      const inputs = JSON.parse(readFileSync(join(dir!, `${name}-inputs.json`), 'utf8'))
      const pyDecide = JSON.parse(readFileSync(join(dir!, `${name}-decide.json`), 'utf8'))
      const round3 = JSON.parse(readFileSync(join(dir!, `${name}-proposals.json`), 'utf8'))
      const segs = inputs.segs as ShadowSegment[]
      const { turns, clipped } = nativeTurns(inputs.native, inputs.total / SHADOW_SAMPLE_RATE)
      const D = decide(segs, inputs.total, turns, inputs.embeddings)
      const P = buildShadowProposals(D, segs, inputs.sources, turns)

      it('reproduces every per-voice gate value and reason string', () => {
        expect(clipped).toBe(pyDecide.clipped)
        expect([...D.rows.keys()]).toEqual(Object.keys(pyDecide.rows))
        for (const [voice, row] of D.rows) {
          const py = pyDecide.rows[voice]
          expect({ voice, seconds: row.seconds, coveredFraction: row.coveredFraction, topCluster: row.topCluster, majority: row.majority, fragmentEmbeddings: row.fragmentEmbeddings, otherClusterMembers: row.otherClusterMembers, eligible: row.eligible, reasons: row.reasons })
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

      it('reproduces the embedding attribution, groups, merges and rejections', () => {
        expect(D.items.map(x => x.voice)).toEqual(pyDecide.itemVoices)
        expect(D.items.map(x => x.outputCluster)).toEqual(pyDecide.itemOut)
        expect([D.agree, D.withOut, D.items.length]).toEqual([pyDecide.agree, pyDecide.withOut, pyDecide.items])
        expect(D.groups).toEqual(pyDecide.groups)
        expect(D.rejected).toEqual(pyDecide.rejected)
        expect(Object.fromEntries(D.remap)).toEqual(pyDecide.remap)
        expect([D.proposed, D.accepted, D.voiceBefore, D.voiceAfter]).toEqual([pyDecide.proposed, pyDecide.accepted, pyDecide.voiceBefore, pyDecide.voiceAfter])
      })

      it('reproduces the round-3 proposals.json report', () => {
        expect(round3View(P)).toEqual(round3View(round3))
        expect(P.accepted.length + P.rejected.length + P.untouched.length).toBeGreaterThan(0)
      })
    })
  }
})
