// 6.78.0 (P3, Sessions): composition-root wiring of the attempt journal, the restart
// reconcile, receipts, dead-boot pins and Sessions steer.
//
// SOURCE-SHAPE ASSERTIONS, AND THEY SAY SO (the repo's convention for server/index.ts, see
// boot-resume-wiring and meeting-import-wiring): index.ts binds ports and starts timers at
// import, so no test can execute it. These pin only that each piece is CONNECTED. The
// behaviour behind each line is executed elsewhere: agent-session-binding-registry-p3
// (journal, pins), queue-turn-evidence-p3 (verdicts, receipts), thread-turn-queue-p3 (drain,
// reconcile, steer, Send again), agent-session-bindings-p3 and queue-receipts-integration
// (the routes together over a real loopback).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const count = (text: string, needle: string) => text.split(needle).length - 1
/** The text between two anchors, each of which must exist exactly once. */
function between(text: string, from: string, to: string): string {
  expect(count(text, from), from).toBe(1)
  expect(count(text, to), to).toBe(1)
  return text.slice(text.indexOf(from), text.indexOf(to))
}

describe('server/index.ts wires the 6.78.0 Sessions durability pieces', () => {
  const index = source('server/index.ts')

  it('releases dead-boot pins on the 10-minute reap tick (nothing can be due at boot)', () => {
    expect(count(index, 'releaseOrphanPins(')).toBe(1)
    const tick = between(index, 'const bindingReapTimer = setInterval(() => {', '}, 10 * 60_000)\nbindingReapTimer.unref()')
    expect(tick).toContain("releaseOrphanPins('tick')")
    expect(index).toContain('agentSessionBindingRegistry.reapOrphanedPins(Date.now())')
  })

  it('gives the queue drain its boot, the reconcile evidence, the attempt journal and the steer transport', () => {
    const queue = between(index, '  const queueDeps = {', '    // 6.53.0: parked turns hold for two minutes after a cancel on their thread.')
    expect(queue).toContain('bootId: serverMetrics.bootId,')
    expect(queue).toContain('deliveryEvidence: makeDeliveryEvidence({')
    expect(queue).toContain('agentSessionBindingRegistry.findTurnForTarget(provider, threadId, clientTurnId)')
    expect(queue).toContain('attempt: queueAttempt,')
    expect(queue).toContain('transcriptLines: queueEvidenceLines,')
    expect(queue).toContain('...steerDeps,')
    expect(queue).toContain('agentSessionBindingRegistry.beginAttempt(provider, threadId, clientTurnId, mode, now)')
    expect(queue).toContain('agentSessionBindingRegistry.settleAttempt(provider, threadId, clientTurnId, exit, now)')
  })

  it('one live-turn transport for the turns route and Sessions steer', () => {
    expect(count(index, 'makeLiveTurnDeliverer(nativeHeadDeps)')).toBe(1)
    expect(index).toContain('const liveTurnDeliverer = makeLiveTurnDeliverer(nativeHeadDeps)')
    expect(index).toContain('  deliverLiveTurn: liveTurnDeliverer,\n')
    const steer = between(index, 'const steerDeps = {', '/** The bounded transcript tail the reconcile and the receipts read evidence from. */')
    expect(steer).toContain('deliverLiveTurn: liveTurnDeliverer,')
    expect(steer).toContain('selectPeerInbox(threadId, readPeerInboxRecords(), pid => cosSpawnedPids().has(pid)) !== null')
    expect(steer).toContain('waitingOnPrompt: sessionHooksEnabled() ? (signalFor(threadId)?.waiting ?? null) !== null : false')
  })

  it('the turns route reads receipts with THIS boot, and the attach refusal reads steer only with the flag on', () => {
    const receipts = between(index, '  turnReceipt: makeTurnReceiptLookup({', '  sessionSteer: (provider, threadId, gateReason) =>')
    expect(receipts).toContain('queueRows: (provider, threadId) => readQueue(provider, threadId, Date.now()),')
    expect(receipts).toContain('attempt: queueAttempt,')
    expect(receipts).toContain('bootId: serverMetrics.bootId,')
    expect(index).toContain('sessionSteer: (provider, threadId, gateReason) => (sessionSteerEnabled() ? steerAvailabilityFor(steerDeps, provider, threadId, gateReason) : null),')
  })
})
