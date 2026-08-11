import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Two guards ported out of cos-glasses-app on 2026-08-11.
 *
 * They lived in that repo's `src/lib/marketplace-hardening.test.ts` and read SERVER
 * source through a forked copy of this tree the app repo carried. Every assertion
 * targeted server implementation, so from over there they could only ever describe the
 * fork — which had drifted, was never type-checked (that tsconfig included only
 * `src`), and never ran in production.
 *
 * PROOF OF THAT DRIFT, found by porting them: three assertions failed here against the
 * real code even though the invariants hold.
 *   - the fork's `gracefulShutdown('SIGTERM')` takes a signal argument; this one takes
 *     none and adds an idempotency flag the fork lacked
 *   - `acquireSessionRunLock` was renamed `acquireModelSessionRunLock`
 *   - `const terminalCallbacks: StreamCallbacks` no longer exists; that construct was
 *     refactored away
 * So the guards were green over there while describing code nobody runs. Exactly the
 * "green everywhere but the asset never arrives" shape this repo already documents.
 *
 * Rewritten to pin the PROPERTY rather than the spelling, so a rename cannot fake a
 * failure and a real regression still can. These remain source-shape assertions, which
 * this repo treats as weaker than execution tests — kept because what they guard is
 * expensive to lose and cheap to state. Prefer converting to execution tests over
 * deleting them if they go stale again.
 */

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const readRepo = (p: string) => readFileSync(resolve(repoRoot, p), 'utf8')

describe('server hardening guards (ported from the app repo)', () => {
  it('flushes active sessions on BOTH SIGTERM and SIGINT, once', () => {
    const server = readRepo('server/index.ts')

    // One shutdown path, and it must be idempotent — two signals can arrive.
    expect(server).toMatch(/async function gracefulShutdown\s*\(/)
    // Must assert the flag is both CHECKED and SET. Matching the bare identifier let a
    // mutation that deleted the assignment pass, because the declaration still carried
    // the name — the guard has to see the mechanism, not the word.
    expect(server, 'shutdown must early-return when already started')
      .toMatch(/if\s*\(\s*gracefulShutdownStarted\s*\)\s*return/)
    expect(server, 'shutdown must SET the flag')
      .toMatch(/gracefulShutdownStarted\s*=\s*true/)

    // The async durable-job flush must be AWAITED, ahead of the synchronous snapshot.
    expect(server).toMatch(/await shutdownQueryJobRuntime\(\s*'server_shutdown'\s*\)/)

    // Best-effort conversation flush, guarded so it cannot abort shutdown.
    expect(server).toMatch(/try\s*\{\s*logActiveSessionsOnShutdown\(\)\s*\}\s*catch/)

    // BOTH signals route to it. The original pinned the exact call text and broke on a
    // signature change; this pins that each signal reaches gracefulShutdown.
    for (const sig of ['SIGTERM', 'SIGINT']) {
      expect(server, `${sig} must trigger gracefulShutdown`)
        .toMatch(new RegExp(`process\\.on\\(\\s*'${sig}'[\\s\\S]{0,80}?gracefulShutdown\\(`))
    }
  })

  it('keeps opt-in activity output request-scoped and rolls back failed turns', () => {
    const queryRoute = readRepo('server/routes/query.ts')
    const codexBridge = readRepo('server/lib/codex-bridge.ts')
    const claudeBridge = readRepo('server/lib/claude-bridge.ts')
    const modelRouter = readRepo('server/lib/model-router.ts')

    // Activity goes out on the REQUEST's SSE stream, never the shared display bus —
    // the display bus would leak one caller's activity to every connected surface.
    expect(queryRoute).toContain('event: activity_line')
    expect(queryRoute).not.toContain("emitDisplay({ type: 'activity_line'")

    // A failed turn must be rolled back on both provider paths, or a half-written
    // exchange survives in the conversation.
    expect(codexBridge).toContain('removeExchange(sid, pendingUserExchange)')
    expect(claudeBridge).toContain('removeExchange(sid, pendingUserExchange)')
    expect(claudeBridge).toContain('cliSessionMap.delete(resolvedCliKey)')

    // A per-session run lock is taken. Name-tolerant: the fork pinned
    // `acquireSessionRunLock`, which has since been renamed.
    // Must match a CALL, not the definition. /acquire\w*SessionRunLock\(/ alone matched
    // `export async function acquireModelSessionRunLock(` and so survived a mutation
    // that removed the only call site.
    expect(modelRouter, 'a per-session run lock must be AWAITED at a call site')
      .toMatch(/await\s+acquire\w*SessionRunLock\(/)

    // NOT asserted any more: `const terminalCallbacks: StreamCallbacks`. That construct
    // does not exist in this server — it was refactored away, and the fork's copy kept
    // asserting it. Reinstating it would only re-pin the fork's shape.
  })
})
