// One predicate, read by every surface that behaves differently on a Mac with
// the COS pipeline than on a Mac without it.
//
// `advise` means this Mac's own pipeline already files Fireflies meetings into
// operations/, so the server must not import them a second time: two writers
// producing near-identical records is how one meeting becomes two rows that
// each look canonical. On such a Mac the engine reads and advises, and writes
// nothing outside the imports root.
//
// `imports` means nothing else here brings meetings in, so the server does.
//
// The check is the STRICTER of the two available: `g2RecordingsReachOperations`
// requires both the venv Python and sync_meetings.py to exist, which is the
// same condition the save path uses to decide whether a recording can reach
// operations at all. Reading env live (rather than caching) matters because COS
// Control can change COS_SCRIPTS_DIR under a running server.

import { g2RecordingsReachOperations } from './g2-ops-handoff.js'

export type MeetingEngineMode = 'advise' | 'imports'

export function meetingEngineMode(): MeetingEngineMode {
  return g2RecordingsReachOperations() ? 'advise' : 'imports'
}
