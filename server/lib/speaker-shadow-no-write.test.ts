// The log-only contract, pinned in source. Shadow mode may write ONLY its own records and
// state (<data>/speaker-shadow/), the CLI's private HOME, and a temp dir it removes. The
// runtime proof is the byte-identical data-home snapshot in speaker-shadow.test.ts; this file
// is the tripwire that makes a NEW write path fail before anyone reaches that test:
//
//   1. every shadow module imports only from an allowlist (no meeting store, relabel,
//      profile, embedding or correction module can be reached from here);
//   2. the number of write-capable calls in each file is pinned. Adding one fails this test,
//      and the fix is to review the new call against the contract, then update the pin.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const LIB = import.meta.dirname
const read = (rel: string) => readFileSync(join(LIB, rel), 'utf8')
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

const NODE = ['node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:module', 'node:os', 'node:path', 'node:stream', 'node:stream/promises', 'node:url']
const ALLOWED: Record<string, string[]> = {
  'speaker-shadow.ts': [...NODE, './atomic-fs.js', './mac-recording.js', './maintenance-lifecycle.js', './parakeet.js', './speaker-shadow-decide.js', './speaker-shadow-models.js', './speaker-shadow-timeline.js', './speaker-shadow-worker.js'],
  'speaker-shadow-worker.ts': [...NODE, './parakeet.js', './speaker-shadow-decide.js', './speaker-shadow-models.js', './speaker-shadow-numeric.js', './speaker-shadow-timeline.js'],
  'speaker-shadow-timeline.ts': [...NODE, './mac-speaker-protection.js', './speaker-shadow-decide.js', './speaker-shadow-numeric.js'],
  'speaker-shadow-models.ts': [...NODE, './data-dir.js'],
  'speaker-shadow-decide.ts': ['./speaker-shadow-numeric.js'],
  'speaker-shadow-numeric.ts': [],
  '../routes/speaker-shadow.ts': ['express', '../lib/speaker-shadow.js', '../lib/speaker-shadow-models.js'],
}

const WRITE_CALL = /\b(writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|rmSync|rmdirSync|rmdir|unlinkSync|unlink|mkdirSync|mkdir|mkdtempSync|mkdtemp|symlinkSync|symlink|linkSync|copyFileSync|copyFile|cpSync|createWriteStream|durableAtomicWriteFileSync|atomicWriteFileSync|chmodSync|chmod|truncateSync|truncate|utimesSync|open|openSync)\(/g

/** What each write is for. All of them land under speaker-shadow/, the private HOME or the run's temp dir. */
const PINNED: Record<string, { count: number; why: string }> = {
  'speaker-shadow.ts': { count: 9, why: 'records: mkdir root, rotate rename, temp open+write, rename into place, unlink a failed temp; state: mkdir root + atomic write; boot sweep: rm old temp dirs' },
  'speaker-shadow-worker.ts': { count: 3, why: 'mkdtemp the run dir, write the timeline WAV into it, rm it' },
  'speaker-shadow-models.ts': { count: 5, why: 'private HOME model folder: mkdir, rm the old folder (links only), mkdir, symlink each entry, write the revision marker' },
  'speaker-shadow-timeline.ts': { count: 0, why: 'read only' },
  'speaker-shadow-decide.ts': { count: 0, why: 'pure' },
  'speaker-shadow-numeric.ts': { count: 0, why: 'pure' },
  '../routes/speaker-shadow.ts': { count: 0, why: 'GET only' },
}

describe('speaker shadow: the log-only contract in source', () => {
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    it(`${file} imports only from its allowlist`, () => {
      // `from '...'`, a bare side-effect `import '...'`, a dynamic `import('...')` and `require('...')`.
      const imports = [...code(read(file)).matchAll(/\bfrom\s+'([^']+)'|\bimport\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)|\brequire\(\s*'([^']+)'\s*\)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4])
      expect(imports.length).toBeGreaterThan(file.endsWith('numeric.ts') ? -1 : 0)
      expect(imports.filter(i => !allowed.includes(i))).toEqual([])
    })
  }

  for (const [file, pin] of Object.entries(PINNED)) {
    it(`${file} has exactly ${pin.count} write-capable call sites (${pin.why})`, () => {
      expect(code(read(file)).match(WRITE_CALL)?.length ?? 0).toBe(pin.count)
    })
  }

  it('never names a meeting, label, profile, embedding or ledger writer', () => {
    const all = Object.keys(PINNED).map(f => code(read(f))).join('\n')
    for (const writer of [
      'markCanonicalFinalizationState', 'relabelSpeaker', 'commitMacVoiceAssignment', 'enrolNamedVoice', 'retractEmbeddingsBySource',
      'saveVoiceProfiles', 'writeVoiceProfiles', 'appendCorrection', 'recordCorrection', 'applyMacSpeakerRepair', 'writeMeeting',
      'persistBatch', 'saveSidecar', 'writeSidecar',
    ]) expect(all.includes(writer)).toBe(false)
  })

  it('the trigger in the finalization path is the only call into shadow mode from meeting.ts, and it runs after complete', () => {
    const meeting = read('../routes/meeting.ts')
    expect(meeting.match(/notifySpeakerShadowFinalized\(/g)?.length).toBe(1)
    const complete = meeting.indexOf("markCanonicalFinalizationState(current.sidecarPath, 'complete', false)\n    // 6.95.0")
    const call = meeting.indexOf('notifySpeakerShadowFinalized({ sessionId: current.sessionId')
    expect(complete).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(complete)
    expect(meeting.slice(complete, call)).not.toMatch(/await /)
  })

  it('the server wires a live-work probe at boot, or the runner never starts a diarization', () => {
    const index = read('../index.ts')
    expect(index).toMatch(/configureSpeakerShadow\(\{\s*captureActive: \(\) => getTranscriptionSessionLiveness\(\)\.live > 0 \|\| speakerShadowLeaseActive\(\),/)
    expect(index).toMatch(/app\.use\('\/api', createSpeakerShadowRouter\(\)\)/)
  })
})
