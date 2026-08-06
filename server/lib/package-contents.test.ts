// What actually ships, asked of npm rather than of the config files.
//
// Model exclusion is expressed in TWO places — `.npmignore` and package.json
// `files[]` — and either one alone is sufficient to exclude a file. So editing
// one and believing the job is done is a silent no-op: the file keeps being
// excluded (or included) by the other mechanism. `npm pack --dry-run` is the only
// authority that resolves both, and it runs in under half a second.
//
// This is the check that would have caught 6.16.0 shipping without silero_vad.onnx
// ("audio passes through untrimmed") and without the cursor files.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..')

function packedFiles(): string[] {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return (JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>)[0].files.map(f => f.path)
}

describe('npm tarball contents', () => {
  const files = packedFiles()

  it('ships the Silero VAD weights — trimSilence is not optional', () => {
    expect(files).toContain('server/models/silero_vad.onnx')
  })

  it('does NOT ship the ~26 MB voiceprint model', () => {
    // Deliberate: it lives in ~/.cos-glasses/models/ so it survives generation
    // swaps. Bundling it would also add 26 MB to every install that never
    // enables diarization.
    expect(files.filter(f => f.includes('3dspeaker'))).toEqual([])
  })

  it('ships no model file other than Silero', () => {
    expect(files.filter(f => f.startsWith('server/models/'))).toEqual(['server/models/silero_vad.onnx'])
  })

  it('ships the runtime modules the speaker feature needs', () => {
    // A module present in the repo but absent from the tarball is the 6.16.0
    // failure mode: the import graph breaks only on a managed install.
    for (const mod of [
      'server/lib/voice-profile-store.ts',
      'server/lib/speaker-calibration-log.ts',
      'server/lib/audio-retention.ts',
      'server/lib/speaker-embeddings.ts',
      'server/lib/atomic-fs.ts',
      'server/routes/voice.ts',
    ]) {
      expect(files, `${mod} must be in the tarball`).toContain(mod)
    }
  })

  it('ships no test files and no private data', () => {
    expect(files.filter(f => f.endsWith('.test.ts'))).toEqual([])
    expect(files.filter(f => f.startsWith('server/data/'))).toEqual([])
    expect(files.filter(f => f.startsWith('server/certs/'))).toEqual([])
    // The real profile must never be packaged; only the example.
    expect(files.filter(f => f.endsWith('.cos-profile.json'))).toEqual([])
  })
})
