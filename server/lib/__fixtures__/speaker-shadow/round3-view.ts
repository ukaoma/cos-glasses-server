// One comparable view of a proposal report, from this port's ShadowProposals or from the
// research tool's round3 proposals.json. The only format differences it removes: Python keeps
// co-occurring labels as a dict and listen pointers as file paths with transcript text; the
// server keeps an ordered list and chunk indexes, never text or paths.

const voice = (m: any) => ({
  voice: m.voice, seconds: m.seconds, coveredFraction: m.coveredFraction, topCluster: m.topCluster, majority: m.majority,
  outlierPass: m.outlierPass, outlierDistance: m.outlierDistance, outlierP95: m.outlierP95, outlierNote: m.outlierNote,
  anchorRatioPostHoc: m.anchorRatioPostHoc, eligible: m.eligible, reasons: m.reasons,
  listen: m.listen.map((p: any) => ({ chunkIndex: 'chunkIndex' in p ? p.chunkIndex : Number(/chunk_(\d+)\.wav$/.exec(p.file)![1]), inFileStart: p.inFileStart, inFileEnd: p.inFileEnd, callTime: p.callTime })),
})
const others = (o: any) => Array.isArray(o) ? o.map((x: any) => [x.label, x.seconds]) : Object.entries(o)

export function round3View(report: any) {
  const S = report.summary ?? report
  return {
    summary: {
      productionVoices: S.productionVoices, voicesAfter: S.voicesAfter, proposedMerges: S.proposedMerges, acceptedMerges: S.acceptedMerges,
      rejectedMerges: S.rejectedMerges, fluidAudioClusters: S.fluidAudioClusters, frozenOtherLabels: S.frozenOtherLabels,
      embeddingClusterAgreement: S.embeddingClusterAgreement,
    },
    accepted: report.accepted.map((a: any) => ({ cluster: a.cluster, keepLabel: a.keepLabel, merge: a.merge, voices: a.voices.map(voice), others: others(a.otherLabelsInCluster) })),
    rejected: report.rejected.map((r: any) => ({ cluster: r.cluster, wouldJoin: r.wouldJoin, ...voice(r), others: others(r.otherLabelsInCluster) })),
    untouched: report.untouched,
  }
}
