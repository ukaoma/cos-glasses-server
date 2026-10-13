// Preview arms through the SHIPPED path: transcribeMeetingPreview (client models list, front
// end, Parakeet deadline, corrections, Turbo fallback rule) followed by the preview route's own
// cleaning (stripInlineHallucinationsOneShot, isFullHallucination). The Turbo fallback has no
// sidecar in this process, so a Parakeet miss is recorded as an empty preview, never sent to
// the user's 8177. stdin {id, wav}; stdout {id, text, model, ms}. ARM=parakeet-ultra|post
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { transcribeMeetingPreview, defaultPreviewDeps } from '../../server/lib/stt-runtime.js'
import { stripInlineHallucinationsOneShot, isFullHallucination } from '../../server/lib/hallucination-filter.js'
import { applyCorrections } from '../../server/lib/whisper-local.js'
import { effectiveStt, DEFAULT_STT_SETTINGS } from '../../server/lib/stt-settings.js'

const clean = (t: string) => { const c = stripInlineHallucinationsOneShot(t.trim()).trim(); return !c || isFullHallucination(c) ? '' : c }
const caps = { turboModel: true, liveLargeV3: true, hqLargeV3: true, parakeetInstalled: true, parakeetPreviewWarm: true, parakeetPreviewWarming: false, previewDisabledByEnv: false }
const eff = effectiveStt({ ...DEFAULT_STT_SETTINGS, preview: 'parakeet' }, caps)
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  if (!line.trim()) continue
  const job = JSON.parse(line)
  if (process.env.ARM === 'post') { // the route's cleaning (and the Turbo path's corrections) applied to saved text
    process.stdout.write(JSON.stringify({ id: job.id, text: clean(applyCorrections(job.text ?? '')) }) + '\n'); continue
  }
  const t0 = performance.now()
  const r = await transcribeMeetingPreview(readFileSync(job.wav), ['large-v3-turbo', 'parakeet-ultra'], {
    ...defaultPreviewDeps, effective: () => eff, turbo: async () => null,
  }).catch(e => ({ error: String(e) }) as any)
  process.stdout.write(JSON.stringify({ id: job.id, text: r && !r.error ? clean(r.text) : '', model: r?.model ?? null, error: r?.error, ms: performance.now() - t0 }) + '\n')
}
