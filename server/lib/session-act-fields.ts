// `reported_model` and `continue_note` for session rows and the detail route (6.62.0, plans
// 1.8 and 3.12). The route calls these two helpers and nothing else, so its own row shape
// (owned by the observation work) is untouched.
//
// One read per row, bounded in concurrency, and every failure is an omitted field: a list
// must never be slower or emptier because a model could not be read.

import { mapWithConcurrency, ACTIVITY_READ_CONCURRENCY } from './agent-session-activity.js'
import { readComposerFacts, type ComposerFacts } from './cursor-session-model.js'
import { continueFactsFields, resolveSessionContinueFacts, type ContinueFactsDeps, type SessionContinueFacts } from './session-continue-facts.js'
import { realContinueFactsDeps } from './session-continue-facts-real.js'

let deps: ContinueFactsDeps | null = null
function liveDeps(): ContinueFactsDeps {
  deps ??= realContinueFactsDeps()
  return deps
}

/** Tests only: drive the helpers with fakes. */
export function __setSessionActDepsForTests(next: ContinueFactsDeps | null): void {
  deps = next
}

export interface SessionActRow {
  provider: string
  session_id: string
  file?: string | null
}

/** The facts for each row, in order. Composer models for the whole page come from ONE query. */
export async function sessionActFactsFor(rows: readonly SessionActRow[]): Promise<Array<SessionContinueFacts | null>> {
  const d = liveDeps()
  let composerFacts: Map<string, ComposerFacts | null> | undefined
  const cursorIds = rows.filter(row => row.provider === 'cursor').map(row => row.session_id)
  if (cursorIds.length > 0) {
    try {
      composerFacts = await readComposerFacts(cursorIds, d.cursorComposerDb)
    } catch {
      composerFacts = undefined
    }
  }
  return mapWithConcurrency(rows, ACTIVITY_READ_CONCURRENCY, async row => {
    try {
      return await resolveSessionContinueFacts({
        provider: row.provider,
        threadId: row.session_id,
        transcriptPath: row.file ?? null,
        cwd: null,
        composerFacts,
      }, d)
    } catch {
      return null
    }
  })
}

export function sessionActFields(facts: SessionContinueFacts | null | undefined): { reported_model?: string; continue_note?: string } {
  return continueFactsFields(facts)
}
