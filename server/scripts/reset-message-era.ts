#!/usr/bin/env tsx
// Archives live sessions, then creates a fresh short-number namespace.
// History stays in day archives. Disk mtime is enough — no server restart.
//
//   npx tsx server/scripts/reset-message-era.ts --confirm

import { currentMessageEraState } from '../lib/message-era.js'
import { resetLiveMessageEra } from '../lib/message-era-reset.js'

if (!process.argv.includes('--confirm')) {
  const current = currentMessageEraState()
  console.error(`Current message era: ${current.era}`)
  console.error('Refusing to reset without --confirm. History will be retained.')
  process.exit(2)
}

const next = await resetLiveMessageEra({ confirm: true })
console.log(JSON.stringify({
  status: 'created',
  ...next,
  history: 'retained',
  restartRequired: false,
  verify: 'GET /api/message-counter should return { max: 0, era: "<era above>" }',
  nextSteps: [
    'Phone: tap RESET # or reopen the companion so the live list clears',
    'Send a test message — expect #1',
  ],
}, null, 2))
