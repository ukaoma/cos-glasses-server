#!/usr/bin/env tsx
// Creates a fresh short-number namespace. Live sessions are NOT ended and
// nothing is archived -- the companion keeps every card. Disk mtime is enough
// — no server restart.
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
    'Phone: reopen the companion — cards stay, the next message is #1',
    'Send a test message — expect #1',
  ],
}, null, 2))
