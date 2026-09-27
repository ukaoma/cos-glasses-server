/** Production adapter. Tests/gateways import runtime/router, never this singleton wiring. */
import { WorkReviewRuntime, createOptionalWorkReviewRuntime } from './work-review-runtime.js'
import { WorkReviewStore, type ReviewModel } from './work-review-store.js'
import { resolveSavedMeetingDetail } from '../routes/meetings.js'
import { queryJobCoordinator } from './query-job-runtime.js'
import { currentMessageEra } from './message-era.js'
import { listBoard } from './task-store.js'
import { dataPath } from './data-dir.js'
import { durableQueryJobsEnabled } from './query-job-feature.js'
import { getHealthStaticProbes } from './health-static-probes.js'
import { getOllamaCatalog, isOllamaProviderReady } from './ollama-catalog.js'

export async function qualifiedWorkReviewModels(): Promise<ReviewModel[]> {
  const [health, ollama] = await Promise.all([getHealthStaticProbes(), getOllamaCatalog()])
  const enabled = durableQueryJobsEnabled()
  return [
    ...['sonnet','opus','fable','haiku'].map(id => ({ id, provider: 'claude', title: `Claude ${id} · read-only review`,
      available: enabled && health.claudeAvailable, reason: 'Configured tier alias; server enforces Read/Grep/Glob only. Individual tier not canary-qualified.' })),
    { id: 'ollama', provider: 'ollama', title: `Ollama · ${ollama.model || 'not configured'}`, available: enabled && isOllamaProviderReady() && !!ollama.model,
      ...(!enabled || !isOllamaProviderReady() || !ollama.model ? { reason: 'Local text model or durable jobs unavailable' } : {}) },
    ...['codex-frontier','codex-balanced','cursor-grok','cursor-composer'].map(id => ({ id, provider: id.startsWith('codex') ? 'codex' : 'cursor', title: id,
      available: false, reason: 'This review endpoint has no qualified read-only adapter for this provider yet.' })),
  ]
}
export function createDefaultWorkReviewRuntime(): WorkReviewRuntime | null {
  return createOptionalWorkReviewRuntime(process.env.COS_WORK_REVIEWS_ENABLED === '1', () => new WorkReviewRuntime({ store: new WorkReviewStore(dataPath('work-reviews')), resolveMeeting: resolveSavedMeetingDetail,
    models: qualifiedWorkReviewModels, listTasks: listBoard, currentMessageEra, jobs: queryJobCoordinator }))
}
