// The Continue side's own counters on /api/health (6.62.0 /qa W6): spawn isolation, Codex
// posture reads and Cursor model reads. Until this they were counted and never read, so a
// Mac whose isolation kept failing open looked exactly like one where it worked.

import { cursorSpawnStats } from './cursor-spawn-env.js'
import { postureReadStats } from './codex-session-posture.js'
import { cursorModelReadStats } from './cursor-session-model.js'
import { cursorChatHolderStats } from './occupancy-probes.js'

export function continueReadHealthFields(): {
  continueReads: {
    cursorSpawn: typeof cursorSpawnStats
    codexPosture: typeof postureReadStats
    cursorModel: typeof cursorModelReadStats
    cursorChatHolders: typeof cursorChatHolderStats
  }
} {
  return {
    continueReads: {
      cursorSpawn: { ...cursorSpawnStats },
      codexPosture: { ...postureReadStats },
      cursorModel: { ...cursorModelReadStats },
      cursorChatHolders: { ...cursorChatHolderStats },
    },
  }
}
