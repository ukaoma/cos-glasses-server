// Offline evaluation bridge: runs the SHIPPED resolver (server/lib/stt-resolver.ts)
// over saved hypotheses so the evaluated code is the code that ships.
// stdin: JSONL {id, primary:{engine,text,words?}, second:{engine,text,words?}, apply, correctSecond}
// stdout: JSONL {id, text, wordsFromSecond, disagreements, protected, timed}
// Requires COS_PROFILE_PATH (the bake-off profile snapshot) and a scratch COS_DATA_DIR.
import { createInterface } from 'node:readline'
import { resolveHypotheses, isDeletionProneEngine } from '../../server/lib/stt-resolver.js'
import { getVocabulary } from '../../server/lib/profile.js'
import { applyCorrections } from '../../server/lib/whisper-local.js'

const vocabulary = getVocabulary()
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  if (!line.trim()) continue
  const job = JSON.parse(line)
  const fix = (h: any) => job.correctSecond
    ? { ...h, text: applyCorrections(h.text ?? ''), words: h.words?.map((w: any) => ({ ...w, word: applyCorrections(w.word) })) }
    : h
  if (job.onlyCorrect) {
    const h = fix(job.second)
    process.stdout.write(JSON.stringify({ id: job.id, text: h.text, words: h.words ?? null }) + '\n')
    continue
  }
  const r = resolveHypotheses(job.primary, fix(job.second), {
    vocabulary,
    primaryDeletionProne: isDeletionProneEngine(job.primary.engine),
    apply: job.apply !== false,
  })
  process.stdout.write(JSON.stringify({
    id: job.id, text: applyCorrections(r.text), wordsFromSecond: r.wordsFromSecond, timed: r.timed,
    disagreements: r.disagreements.length,
    protected: r.disagreements.filter(d => d.reason === 'protected').length,
    byReason: r.disagreements.reduce((m: Record<string, number>, d) => { const k = d.reason ?? 'kept'; m[k] = (m[k] ?? 0) + 1; return m }, {}),
  }) + '\n')
}
