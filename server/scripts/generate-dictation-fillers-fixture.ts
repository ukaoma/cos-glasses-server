#!/usr/bin/env -S npx tsx
// 6.92.0 (plan r3, A-W10): writes server/lib/__fixtures__/dictation-fillers.json from the server's own
// filler functions (lib/dictation-fillers-fixture-cases.ts). No model calls, no network.
// Usage: npx tsx server/scripts/generate-dictation-fillers-fixture.ts
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FILLER_FIXTURE_CASES, fillerFixtureOutput, renderFillerFixture } from '../lib/dictation-fillers-fixture-cases.js'

const wrong = FILLER_FIXTURE_CASES.filter(c => fillerFixtureOutput(c.scope, c.input) !== c.want)
if (wrong.length) {
  for (const c of wrong) console.error(`${c.id}: want ${JSON.stringify(c.want)}, got ${JSON.stringify(fillerFixtureOutput(c.scope, c.input))}`)
  process.exit(1)
}
const text = renderFillerFixture()
const target = fileURLToPath(new URL('../lib/__fixtures__/dictation-fillers.json', import.meta.url))
writeFileSync(target, text)
console.log(`${FILLER_FIXTURE_CASES.length} rows, sha256 ${createHash('sha256').update(text).digest('hex')}`)
