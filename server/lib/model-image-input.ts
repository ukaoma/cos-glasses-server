// Internal model-input shape for image attachments (Release A).
// The bridges receive resolved server-owned FILE PATHS — never base64 —
// plus the public ref and an explicit deletion contract:
//   deleteAfterRun: false  → durable media-store asset; the store's lifecycle
//                            (GC/retention) owns the file. Bridges must not
//                            delete it, even on failed/cancelled runs.
//   deleteAfterRun: true   → truly ephemeral request-temp file; the bridge
//                            deletes it exactly once when the run settles.

import { unlinkSync } from 'node:fs'
import type { MediaAttachmentRef } from '../../shared/media-attachment.js'

export interface ModelImageInput {
  /** Absolute path to a server-owned normalized image file. */
  path: string
  attachment: MediaAttachmentRef
  deleteAfterRun: boolean
}

/** Terminal cleanup used by both bridges: delete ONLY inputs explicitly
 *  marked ephemeral. Idempotent — safe if a bridge settles twice. */
export function cleanupModelImageInputs(inputs: ModelImageInput[]): void {
  for (const input of inputs) {
    if (!input.deleteAfterRun) continue
    try { unlinkSync(input.path) } catch { /* already gone — fine */ }
  }
}
