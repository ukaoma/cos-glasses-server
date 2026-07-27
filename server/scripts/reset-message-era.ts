#!/usr/bin/env tsx
// Creates a fresh short-number namespace without touching sessions or archives.
// Restart the server afterward so every new exchange is stamped into the era.
//
//   npx tsx server/scripts/reset-message-era.ts --confirm

import { createMessageEra, currentMessageEraState } from '../lib/message-era.js'

if (!process.argv.includes('--confirm')) {
  const current = currentMessageEraState()
  console.error(`Current message era: ${current.era}`)
  console.error('Refusing to reset without --confirm. History will be retained.')
  process.exit(2)
}

const next = createMessageEra()
console.log(JSON.stringify({
  status: 'created',
  ...next,
  history: 'retained',
  restartRequired: true,
}, null, 2))
