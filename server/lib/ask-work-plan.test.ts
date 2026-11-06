import { describe, it, expect } from 'vitest'
import { parseAskWorkPlanRequest, resolveAskWorkTask, prepareAskWorkPlan, askWorkMeetingIDs, askWorkProposalID } from './ask-work-plan.js'
import { controlSnapshotRevision } from './work-activity.js'
import { parseWorkChatAnswer } from './work-chat.js'
import type { TaskBoardRow } from './task-store.js'
import type { OrchestratorInput } from './work-orchestrator/input.js'

const now = Date.parse('2026-11-05T12:00:00Z'), sid = 'claude:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const task = { id: 'aaaaaaaaaaaa', domain: 'quilt', title: 'Review design', text: 'Review the design', doneWhen: 'Report findings', checked: false, workRevision: 'a'.repeat(64) } as TaskBoardRow
const request = { workID: 'task:quilt:aaaaaaaaaaaa', revision: task.workRevision!, question: 'Plan a review' }
const evidence = (): OrchestratorInput => ({ protocolVersion: 1, workID: request.workID, now: new Date(now).toISOString(),
  snapshotAgeSec: 1, liveListAgeSec: 1, logScanComplete: true, discovered: 1, leftOut: [],
  usage: [{ provider: 'claude', state: 'ok', headroomPct: 80, resetsAt: null, ageSec: 1, source: 'probe', plan: null, stale: false, note: '' }],
  rows: [{ id: sid, title: 'Design review', summary: '', status: 'idle', discoveredBy: ['link'], linked: true, member: true,
    lastTouchedCard: new Date(now).toISOString(), lastActivity: new Date(now).toISOString(), live: true, busy: false,
    pickup: '', available: true, forkable: true }] })

describe('Ask Work preparation', () => {
  it('accepts only a bounded explicit task request; forbids caller eligibility, context, confirmation and sends', () => {
    expect(parseAskWorkPlanRequest(request)).toEqual(request)
    for (const extra of [{ sessions: [] }, { context: 'forged' }, { automatic: true }, { confirm: 'two-step' }, { send: true }, { snapshot: {} }]) {
      expect(() => parseAskWorkPlanRequest({ ...request, ...extra })).toThrow('invalid_ask_work_plan')
    }
    for (const bad of [null, [], {}, { ...request, question: ' ' }, { ...request, question: 'a'.repeat(2001) },
      { ...request, question: '\u0001' }, { ...request, revision: 'a' }, { ...request, workID: 'synthetic' },
      { ...request, planner: 'haiku' }, { ...request, effort: 'max' }]) expect(() => parseAskWorkPlanRequest(bad)).toThrow()
  })
  it('resolves authoritative identity/revision and refuses unknown, ambiguous, finished or broken tasks', () => {
    expect(resolveAskWorkTask(request, [task])).toBe(task)
    for (const [rows, code] of [[[], 'task_not_found'], [[task, task], 'task_identity_ambiguous'],
      [[{ ...task, checked: true }], 'task_complete'], [[{ ...task, workStage: 'complete' }], 'task_complete'],
      [[{ ...task, workRevision: 'b'.repeat(64) }], 'revision_changed'], [[{ ...task, workMetadataError: 'bad' }], 'task_metadata_unavailable'],
      [[{ ...task, workRevision: undefined }], 'task_metadata_unavailable'], [[{ ...task, text: '' }], 'task_metadata_unavailable'],
      [[{ ...task, id: 'wrong', workIdentity: task.id }], 'task_metadata_unavailable']] as const) {
      expect(() => resolveAskWorkTask(request, [...rows] as TaskBoardRow[])).toThrow(code)
    }
    expect(() => resolveAskWorkTask({ ...request, revision: controlSnapshotRevision(task) }, [task])).toThrow('revision_changed')
  })
  it('uses board context and confirmed meeting ids; validates model targets using existing parser', () => {
    const ready = prepareAskWorkPlan(request, task, evidence(), now)
    expect(JSON.parse(ready.input.context)).toMatchObject({ title: task.title, task: task.text, doneWhen: task.doneWhen })
    expect(ready.input.sessions[0]).toMatchObject({ automatic: true, forkable: true })
    expect(ready.input.newSessionProviders).toEqual([])
    expect(ready.evidence.eligibleContinueSessionIDs).toEqual([sid])
    expect(ready.evidence.eligibleForkSessionIDs).toEqual([sid])
    expect(() => parseWorkChatAnswer(JSON.stringify({ answer: 'Plan', assignments: [{ mode: 'newSession', provider: 'claude', prompt: 'Review' }] }), ready.input)).toThrow()
    expect(askWorkMeetingIDs({ ...task, meetingRefs: [{ recordId: 'm1' }, { recordId: 'm1' }] as any })).toEqual(['meeting:m1'])
    expect(() => parseWorkChatAnswer(JSON.stringify({ answer: 'Plan', assignments: [{ sessionID: 'invented', prompt: 'Review' }] }), ready.input)).toThrow()
    expect(parseWorkChatAnswer(JSON.stringify({ answer: 'Who owns this?', assignments: [] }), ready.input).assignments).toEqual([])
    const answer = { answer: 'Who owns this?', assignments: [] }
    expect(askWorkProposalID(ready.input, answer)).toBe(askWorkProposalID(ready.input, answer))
    expect(askWorkProposalID(ready.input, answer)).not.toBe(askWorkProposalID(ready.input, { ...answer, answer: 'Different' }))
  })
  it.each(['stale', 'futureAge', 'futureNow', 'incomplete', 'suggestion', 'appOwned', 'busy', 'notLive', 'exhausted', 'unknown', 'usageStale'])(
    'fails closed for Continue with %s evidence', kind => {
      const data = evidence(), row = data.rows[0]!
      if (kind === 'stale') data.liveListAgeSec = 181
      if (kind === 'futureAge') data.snapshotAgeSec = -1
      if (kind === 'futureNow') data.now = new Date(now + 1000).toISOString()
      if (kind === 'incomplete') data.logScanComplete = false
      if (kind === 'suggestion') row.member = false
      if (kind === 'appOwned') { row.available = false; row.reason = 'app_owned' }
      if (kind === 'busy') row.busy = true
      if (kind === 'notLive') row.live = false
      if (kind === 'exhausted' || kind === 'unknown') data.usage[0]!.state = kind
      if (kind === 'usageStale') data.usage[0]!.stale = true
      const prepared = prepareAskWorkPlan(request, task, data, now)
      expect(prepared.input.sessions[0]!.automatic).toBe(false)
      expect(prepared.input.sessions[0]!.available).toBe(false)
      const status = JSON.parse(prepared.input.context).evidenceStatus
      expect(status).toMatchObject({ snapshotAgeSec: data.snapshotAgeSec, liveListAgeSec: data.liveListAgeSec,
        logScanComplete: data.logScanComplete, scope: expect.stringContaining('no local attachments') })
      expect(status.disabledTargets[0].reasons.length).toBeGreaterThan(0)
      expect(() => parseWorkChatAnswer(JSON.stringify({ answer: 'Plan', assignments: [{ sessionID: sid, prompt: 'Do work' }] }), prepared.input)).toThrow()
    })
  it('rejects future usage evidence and never silently truncates task context', () => {
    const data = evidence(); data.usage[0]!.ageSec = -1
    expect(() => prepareAskWorkPlan(request, task, data, now)).toThrow('orchestrator_input_unavailable')
    expect(() => prepareAskWorkPlan(request, { ...task, text: 'a'.repeat(16000) }, data, now)).toThrow('task_context_too_large')
    expect(() => prepareAskWorkPlan(request, task, { ...data, workID: 'other' }, now)).toThrow('orchestrator_input_unavailable')
  })
  it('refuses a fork whose prioritized reason can hide another exclusion', () => {
    const data = evidence(); data.rows[0]!.reason = 'on_another_card'; data.rows[0]!.forkable = true
    const prepared = prepareAskWorkPlan(request, task, data, now)
    expect(prepared.input.sessions[0]).toMatchObject({ automatic: false, available: false, forkable: false })
    expect(() => parseWorkChatAnswer(JSON.stringify({ answer: 'Fork it', assignments: [{ mode: 'fork', sessionID: sid, prompt: 'Review' }] }), prepared.input)).toThrow()
  })
})
