import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('maintenance admission wiring', () => {
  it('retains every long-running public work class through its terminal path', () => {
    expect(source('server/lib/query-job-runtime.ts')).toContain("acquireMaintenanceWork('durable_query', { phase: 'queued' })")
    expect(source('server/lib/query-job-runtime.ts')).toContain("acquireMaintenanceWork('query_attachment_write', { allowDuringDrain: true })")
    expect(source('server/routes/query.ts')).toContain("acquireMaintenanceWork('legacy_query')")
    expect(source('server/routes/openai-compat.ts')).toContain("acquireMaintenanceWork('openai_query')")
    expect(source('server/routes/transcribe.ts')).toContain("acquireMaintenanceWork('one_shot_transcription')")
    expect(source('server/routes/transcribe-stream.ts')).toContain("acquireMaintenanceWork('recording_chunk'")
    expect(source('server/routes/meeting.ts')).toContain("acquireMaintenanceWork('meeting_batch_finalization'")
    expect(source('server/routes/prompt-drafts.ts')).toContain("acquireMaintenanceWork('prompt_draft_warm'")
    expect(source('server/routes/prompt-drafts.ts')).toContain("acquireMaintenanceWork('prompt_draft_finalize')")
    // Live Cues pipelines outlive their triggering HTTP request, so the lease
    // is taken in the engine (lib), not a route — and the ASR feed hook must
    // stay fire-and-forget with a rejection sink.
    expect(source('server/lib/live-cues-engine.ts')).toContain("acquireMaintenanceWork('live_cue_pipeline')")
    expect(source('server/lib/task-dispatcher.ts')).toContain("acquireMaintenanceWork('task_dispatch')")
    const callOptions = source('server/lib/claude-bridge.ts').match(/export interface CallOptions \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(callOptions).toContain('dispatch?: { restricted: true; tools: readonly string[] }')
    expect(callOptions).not.toContain('model?:')
    expect(source('server/routes/transcribe-stream.ts')).toContain('void feedLiveCueTranscript(')
    expect(source('server/routes/transcribe-stream.ts')).toContain('.catch(() => {})')
  })

  it('fails closed for secondary mutations and exposes no Whisper restart route', () => {
    expect(source('server/index.ts')).toContain("acquireMaintenanceWork('api_mutation', {")
    expect(source('server/index.ts')).toContain("req.path === '/diagnostics/provider-proof'")
    expect(source('server/index.ts')).toContain("req.path === '/tts/prepare'")
    expect(source('server/index.ts')).toContain('maintenanceOperationCredentialsValid')
    expect(source('server/routes/maintenance.ts')).not.toContain("maintenance/whisper/restart")
    expect(source('server/routes/maintenance.ts')).not.toContain('restartWhisperServer')
  })
})
