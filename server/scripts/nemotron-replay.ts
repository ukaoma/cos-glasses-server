// 6.61.0 real-data replay. READ-ONLY against the meeting store: every input is a
// clone (`cp -c`) under a scratch directory, COS_DATA_DIR points at that scratch
// copy (so the voiceprint's calibration log never touches the live store), and
// COS_NEMOTRON_MODELS points at a scratch symlink directory. Not shipped.
//
// For each meeting it runs:
//   1. the LIVE path, chunk by chunk, exactly as processStreamChunk does: start
//      Nemotron (real CLI, 1.5 s budget, lane of 2), block on the whole-chunk
//      voiceprint, run Whisper on the chunk through a private whisper-server with
//      the live server's arguments (the "whisper load"), await Nemotron, name the
//      tracks with the real voiceprint;
//   2. the FINAL pass over the whole meeting, on a sidecar copy carrying the live
//      replay's segments (what 6.61.0 would have stored).
//
// Usage: node --import tsx/esm server/scripts/nemotron-replay.ts <scratch> <whisperUrl|none> <sessionId>...
// The scratch dir must hold <sessionId>/{audio/, meeting.md, meeting.g2-chunks.json} and data/voice-profiles.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [scratch, whisperUrl, ...sessionIds] = process.argv.slice(2)
if (!scratch || !whisperUrl || sessionIds.length === 0) throw new Error('usage: nemotron-replay.ts <scratch> <whisperUrl|none> <sessionId>...')
process.env.COS_DATA_DIR = join(scratch, 'data')
process.env.COS_DIARIZER = 'nemotron'

const { initSpeakerEmbeddings, identifySpeaker } = await import('../lib/speaker-embeddings.js')
const { NemotronLiveRuntime, resolveLiveLabels } = await import('../lib/nemotron-live.js')
const { runNemotronFinalPass, buildMeetingTimeline, batchWordToTimeline } = await import('../lib/nemotron-final.js')
const { isUnattributed } = await import('../lib/meeting-speaker-review.js')

if (!initSpeakerEmbeddings()) throw new Error('voiceprint model did not load')
const LIVE_LOG = '/Users/ukaoma/Library/Logs/COS Glasses/server.log'
const liveChunkCount = (): number => {
  try {
    const tail = readFileSync(LIVE_LOG).subarray(-400_000).toString('utf8')
    return (tail.match(/\[perf\] TOTAL request/g) ?? []).length
  } catch { return -1 }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const logLines: string[] = []
const runtime = new NemotronLiveRuntime({ log: line => logLines.push(line) })
await runtime.startWarmup()
console.log(`warm: ${JSON.stringify(runtime.snapshot().warm)}`)

const percentile = (values: number[], p: number) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}
const isName = (label: unknown): label is string => typeof label === 'string' && !isUnattributed(label)

async function whisper(wav: Buffer): Promise<number> {
  if (whisperUrl === 'none') return 0
  const started = performance.now()
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav')
  form.append('response_format', 'json')
  form.append('suppress_non_speech', 'true')
  const response = await fetch(`${whisperUrl}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) })
  await response.text()
  return performance.now() - started
}

const report: Record<string, unknown>[] = []
for (const sessionId of sessionIds) {
  const dir = join(scratch, sessionId)
  const sidecarPath = join(dir, 'meeting.g2-chunks.json')
  const meetingPath = join(dir, 'meeting.md')
  const audioDir = join(dir, 'audio')
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
  const entries = sidecar.chunkEntries as Array<{ chunkIndex: number; chunk: Record<string, any> }>
  const original = new Map(entries.map(e => [e.chunkIndex, { speaker: e.chunk.speaker as string, similarity: Number(e.chunk.similarity) || 0 }]))

  // ── 1. live, chunk by chunk ──
  // NEMOTRON_REPLAY_FINAL_ONLY=1 reuses the live rows of an earlier run (live-rows.json)
  // and re-runs only the final pass, on a fresh copy of the store's sidecar and markdown.
  const finalOnly = process.env.NEMOTRON_REPLAY_FINAL_ONLY === '1'
  const live: Array<Record<string, any>> = finalOnly ? JSON.parse(readFileSync(join(dir, 'live-rows.json'), 'utf8')) : []
  if (finalOnly) {
    const byIndex = new Map(live.map(row => [row.chunkIndex, row]))
    for (const entry of entries) {
      const row = byIndex.get(entry.chunkIndex)
      if (!row) continue
      if (row.segments) entry.chunk.segments = row.segments
      if (row.fallback) entry.chunk.diarizer = { engine: 'voiceprint', fallback: row.fallback }
      else if (row.segments) entry.chunk.diarizer = { engine: 'nemotron' }
      entry.chunk.speaker = row.speaker
      entry.chunk.similarity = row.similarity
    }
  }
  let paused = 0
  for (const entry of finalOnly ? [] : entries) {
    const chunk = entry.chunk
    if (typeof chunk.text !== 'string' || !chunk.text.trim()) continue
    const wavPath = join(audioDir, `chunk_${String(entry.chunkIndex).padStart(4, '0')}.wav`)
    if (!existsSync(wavPath)) continue
    // Yield the GPU to a meeting that starts while this runs.
    const before = liveChunkCount()
    await sleep(0)
    if (liveChunkCount() !== before) { paused++; await sleep(10_000) }
    const audio = readFileSync(wavPath)
    const t0 = performance.now()
    const diarize = runtime.diarize(wavPath)
    // The live server blocks on the whole-chunk voiceprint here (identifyChunkSpeaker).
    const tv = performance.now()
    identifySpeaker(audio)
    const voiceprintMs = performance.now() - tv
    const whisperMs = await whisper(audio)
    const whisperDone = performance.now()
    const labels = await resolveLiveLabels({
      diarize,
      startedAt: t0,
      text: chunk.text,
      words: Array.isArray(chunk.words) && chunk.words.length ? chunk.words : undefined,
      audio,
      voiceprint: original.get(entry.chunkIndex)!,
      clientSpeaker: 'MU',
      identify: wav => {
        const named = identifySpeaker(wav)
        return named ? { speaker: named.speaker, similarity: named.similarity } : null
      },
    })
    const done = performance.now()
    if (labels.record) runtime.record({ sessionId, chunkIndex: entry.chunkIndex }, labels.record)
    live.push({
      chunkIndex: entry.chunkIndex,
      stored: original.get(entry.chunkIndex),
      speaker: labels.speaker,
      similarity: labels.similarity,
      segments: labels.segments ?? null,
      fallback: labels.diarizer?.fallback ?? null,
      nemotronMs: labels.diarizer?.ms ?? null,
      whisperMs: Math.round(whisperMs),
      voiceprintMs: Math.round(voiceprintMs),
      // What the chunk response waits on beyond Whisper: Nemotron's tail plus track naming.
      addedMs: Math.round(done - whisperDone),
      totalMs: Math.round(done - t0),
    })
    // 6.61.0 would have stored these on the chunk.
    if (labels.segments) chunk.segments = labels.segments
    if (labels.diarizer) chunk.diarizer = labels.diarizer
    chunk.speaker = labels.speaker
    chunk.similarity = labels.similarity
  }
  for (const list of [sidecar.chunks as any[]]) {
    // Keep `chunks` in step with chunkEntries (same text order).
    const textEntries = entries.filter(e => typeof e.chunk.text === 'string' && e.chunk.text.trim())
    if (list.length === textEntries.length) textEntries.forEach((e, i) => { list[i] = e.chunk })
  }
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2))

  const nemo = live.filter(row => row.segments)
  const segCounts = nemo.map(row => row.segments.length)
  const twoSpeakers = nemo.filter(row => new Set(row.segments.map((s: any) => s.speaker)).size >= 2)
  const hi = live.filter(row => row.stored.similarity >= 0.65 && isName(row.stored.speaker))
  const hiNemo = hi.filter(row => row.segments)
  const liveAgree = hi.filter(row => row.speaker === row.stored.speaker).length
  const wordAgree = (rows: any[]) => {
    let total = 0, same = 0
    for (const row of rows) for (const s of row.segments) {
      const n = s.text.split(/\s+/).filter(Boolean).length
      total += n
      if (s.speaker === row.stored.speaker) same += n
    }
    return total ? same / total : null
  }
  const fallbacks: Record<string, number> = {}
  for (const row of live) if (row.fallback) fallbacks[row.fallback] = (fallbacks[row.fallback] ?? 0) + 1

  // ── 2. final pass on the copy ──
  const before = readFileSync(meetingPath, 'utf8')
  const finalStarted = performance.now()
  const outcome = await runNemotronFinalPass({ meetingPath, sidecarPath, audioDir, log: line => logLines.push(line) })
  const finalWallMs = Math.round(performance.now() - finalStarted)
  const after = JSON.parse(readFileSync(sidecarPath, 'utf8'))
  // Score on the real timeline (the same concat-offset mapping the pass uses), never nearest-elapsed.
  const timeline = await buildMeetingTimeline(after.chunkEntries, audioDir)
  const perChunk = new Map<number, Map<string, number>>()
  const transitions = new Map<string, number>()
  let liveTrackWords = 0, liveTrackSame = 0, finalWords = 0, finalSame = 0
  if (after.batchApplied === true && Array.isArray(after.batchSegments)) {
    for (const segment of after.batchSegments) {
      for (const word of segment.speakerWords ?? []) {
        const at = batchWordToTimeline(segment, Number(word.start), timeline)
        if (!at) continue
        const tally = perChunk.get(at.window.chunkIndex) ?? new Map<string, number>()
        tally.set(word.speaker, (tally.get(word.speaker) ?? 0) + 1)
        perChunk.set(at.window.chunkIndex, tally)
        const from = word.originalSpeaker ?? word.speaker
        if (from !== word.speaker) transitions.set(`${from} -> ${word.speaker}`, (transitions.get(`${from} -> ${word.speaker}`) ?? 0) + 1)
        const live = (at.window.chunk.segments ?? []).find((s: any) => at.inChunk >= s.startSec - 0.05 && at.inChunk <= s.endSec + 0.05)
        if (live && (live.similarity ?? 0) >= 0.65 && isName(live.speaker)) { liveTrackWords++; if (live.speaker === word.speaker) liveTrackSame++ }
      }
    }
  }
  let eligible = 0, eligibleAgree = 0, hiChunks = 0, hiAgree = 0
  for (const [index, tally] of perChunk) {
    const stored = original.get(index)
    if (!stored || !isName(stored.speaker) || stored.similarity < 0.65) continue
    const total = [...tally.values()].reduce((a, b) => a + b, 0)
    finalWords += total
    finalSame += tally.get(stored.speaker) ?? 0
    const majority = [...tally.entries()].sort((x, y) => y[1] - x[1])[0][0]
    hiChunks++
    if (majority === stored.speaker) hiAgree++
    const role = entries.find(e => e.chunkIndex === index)?.chunk.evenHubSpeakerRole
    if (role && role.frames > 0 && Math.max(role.self, role.other) / role.frames >= 0.8) { eligible++; if (majority === stored.speaker) eligibleAgree++ }
  }
  const afterMd = readFileSync(meetingPath, 'utf8')
  report.push({
    sessionId,
    title: sidecar.title,
    chunksWithText: live.length,
    live: {
      nemotron: nemo.length,
      fallbacks,
      segmentsPerChunk: { one: segCounts.filter(n => n === 1).length, two: segCounts.filter(n => n === 2).length, threePlus: segCounts.filter(n => n >= 3).length, mean: segCounts.length ? +(segCounts.reduce((a, b) => a + b, 0) / segCounts.length).toFixed(3) : null },
      gainedSecondSpeaker: twoSpeakers.length,
      gainedSecondSpeakerShare: nemo.length ? +(twoSpeakers.length / nemo.length).toFixed(3) : null,
      highConfidenceChunks: hi.length,
      highConfidenceWithNemotron: hiNemo.length,
      dominantAgreement: hi.length ? +(liveAgree / hi.length).toFixed(3) : null,
      wordAgreementOnHighConfidence: hiNemo.length ? +(wordAgree(hiNemo)!).toFixed(3) : null,
      nemotronMs: { p50: percentile(nemo.map(r => r.nemotronMs), 0.5), p95: percentile(nemo.map(r => r.nemotronMs), 0.95), max: percentile(nemo.map(r => r.nemotronMs), 1) },
      addedBeyondWhisperMs: { p50: percentile(live.map(r => r.addedMs), 0.5), p95: percentile(live.map(r => r.addedMs), 0.95), max: percentile(live.map(r => r.addedMs), 1) },
      whisperMs: { p50: percentile(live.map(r => r.whisperMs), 0.5), max: percentile(live.map(r => r.whisperMs), 1) },
      chunkTotalMs: { p50: percentile(live.map(r => r.totalMs), 0.5), max: percentile(live.map(r => r.totalMs), 1) },
      pausedForLiveMeeting: paused,
    },
    final: {
      ...outcome,
      wallMs: finalWallMs,
      oneSidedChunksScored: eligible,
      oneSidedMajorityAgreement: eligible ? +(eligibleAgree / eligible).toFixed(3) : null,
      highConfidenceChunksScored: hiChunks,
      highConfidenceMajorityAgreement: hiChunks ? +(hiAgree / hiChunks).toFixed(3) : null,
      wordAgreementOnHighConfidence: finalWords ? +(finalSame / finalWords).toFixed(3) : null,
      vsConfidentLiveTracks: { words: liveTrackWords, agreement: liveTrackWords ? +(liveTrackSame / liveTrackWords).toFixed(3) : null },
      transitions: Object.fromEntries([...transitions.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)),
      transcriptChanged: before !== afterMd,
      channelEvidence: after.diarization?.mapping?.evidence ?? null,
    },
  })
  writeFileSync(join(dir, 'live-rows.json'), JSON.stringify(live, null, 1))
  console.log(JSON.stringify(report.at(-1)))
}
writeFileSync(join(scratch, 'replay-report.json'), JSON.stringify({ snapshot: runtime.snapshot(), report }, null, 2))
writeFileSync(join(scratch, 'replay-log.txt'), logLines.join('\n'))
console.log('done')
