// Run from this worktree: node --import tsx/esm docs/validation/dictation-luna-2026-10-03/smoke.ts
// Synthetic input, signed-in CLIs only. No API client and no production preference writes.
import { autoCleanDictation } from '../../../server/lib/dictation-clean.js'
import { writeFileSync } from 'node:fs'
const input = 'um keep the the budget at 1250 dollars not 12500 dollars I think we should wait do not send anything yet'
const results = []
for (const model of ['sonnet', 'luna-5.6-fast']) {
  const start = performance.now()
  try {
    const output = await autoCleanDictation(input, [], { model })
    results.push({ model, input, output, durationMs: Math.round(performance.now() - start), ok: true })
  } catch (error) {
    results.push({ model, input, error: String(error), durationMs: Math.round(performance.now() - start), ok: false })
  }
}
const proof = { at: new Date().toISOString(), results }
writeFileSync(new URL('./smoke.json', import.meta.url), JSON.stringify(proof, null, 2) + '\n')
console.log(JSON.stringify(proof, null, 2))
if (results.some(result => !result.ok)) process.exitCode = 1
