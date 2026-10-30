// The log-only contract, pinned in source. Shadow mode may write ONLY its own records and
// state (<data>/speaker-shadow/), the CLI's private HOME, and a temp dir it removes. The
// runtime proof is the byte-identical data-home snapshot in speaker-shadow.test.ts; this file
// is the tripwire that makes a NEW write path fail before anyone reaches that test:
//
//   1. every shadow module imports only from an allowlist (no meeting store, relabel,
//      profile or correction writer can be imported here). A separately admitted closed-call
//      consumer may retain the SAME verified native execution in its own namespace; only
//      its reviewed admission/retention bridge is reachable, never its publisher;
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
  'speaker-shadow.ts': [...NODE, './atomic-fs.js', './mac-recording.js', './maintenance-lifecycle.js', './parakeet.js', './speaker-shadow-decide.js', './speaker-shadow-models.js', './speaker-shadow-report.js', './speaker-shadow-timeline.js', './speaker-shadow-worker.js', './mac-speaker-call-producer.js', './mac-speaker-call-producer-worker.js'],
  'speaker-shadow-worker.ts': [...NODE, './parakeet.js', './speaker-shadow-decide.js', './speaker-shadow-models.js', './speaker-shadow-numeric.js', './speaker-shadow-report.js', './speaker-shadow-timeline.js', './speaker-shadow-pair-source.js', './speaker-shadow-paired.js', './mac-speaker-call-producer-worker.js'],
  'speaker-shadow-report.ts': ['node:path', './speaker-shadow-decide.js', './speaker-shadow-numeric.js'],
  'speaker-shadow-timeline.ts': [...NODE, './mac-speaker-protection.js', './speaker-shadow-decide.js', './speaker-shadow-numeric.js'],
  'speaker-shadow-models.ts': [...NODE, './data-dir.js'],
  'speaker-shadow-decide.ts': ['./speaker-shadow-numeric.js'],
  'speaker-shadow-numeric.ts': [],
  'speaker-shadow-pair-source.ts': ['node:fs', 'node:fs/promises', 'node:path', 'node:crypto'],
  'speaker-shadow-paired.ts': ['./speaker-name.js', './speaker-shadow-decide.js'],
  'speaker-name.ts': [],
  '../routes/speaker-shadow.ts': ['express', '../lib/speaker-shadow.js', '../lib/speaker-shadow-models.js'],
}

const WRITE_CALL = /\b(writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|rmSync|rmdirSync|rmdir|unlinkSync|unlink|mkdirSync|mkdir|mkdtempSync|mkdtemp|symlinkSync|symlink|linkSync|copyFileSync|copyFile|cpSync|createWriteStream|durableAtomicWriteFileSync|atomicWriteFileSync|chmodSync|chmod|truncateSync|truncate|utimesSync|open|openSync)\(/g

/** What each write is for. All of them land under speaker-shadow/, the private HOME or the run's temp dir. */
const PINNED: Record<string, { count: number; why: string }> = {
  'speaker-shadow.ts': { count: 13, why: 'records: mkdir root, rotate rename, temp open+write, rename into place, unlink a failed temp; state: mkdir root + atomic write; setting: mkdir root + atomic write; report: mkdir reports/<day> + atomic write; boot sweep: rm old temp dirs' },
  'speaker-shadow-report.ts': { count: 0, why: 'pure: returns text' },
  'speaker-shadow-worker.ts': { count: 3, why: 'mkdtemp the run dir, write the timeline WAV into it, rm it' },
  'speaker-shadow-models.ts': { count: 5, why: 'private HOME model folder: mkdir, rm the old folder (links only), mkdir, symlink each entry, write the revision marker' },
  'speaker-shadow-timeline.ts': { count: 0, why: 'read only' },
  'speaker-shadow-decide.ts': { count: 0, why: 'pure' },
  'speaker-shadow-numeric.ts': { count: 0, why: 'pure' },
  'speaker-shadow-pair-source.ts': { count: 1, why: 'read-only open with O_RDONLY and O_NOFOLLOW; bounded diagnostics, no writable handle' },
  'speaker-shadow-paired.ts': { count: 0, why: 'pure diagnostic evaluator' },
  'speaker-name.ts': { count: 0, why: 'pure label validation' },
  '../routes/speaker-shadow.ts': { count: 0, why: 'GET only' },
}

/** Exact named bridge imports prevent adding a publisher just because its module
 * now appears on the allowlist. Type-only state cannot grant a write capability. */
function producerBridgeErrors(file: string, text: string): string[] {
  const source = code(text), compact = source.replace(/\s+/g, ''), errors: string[] = []
  const expected = file === 'speaker-shadow.ts'
    ? {
      './mac-speaker-call-producer.js': ['configureMacSpeakerCallProducer', 'macSpeakerCallProducerEnabled', 'macSpeakerCallProducerBusy', 'macSpeakerCallProducerRequestValid', 'notifyMacSpeakerCallNativeExport', 'sampleMacSpeakerCallResources'],
      './mac-speaker-call-producer-worker.js': ['MacSpeakerCallProducerRequest'],
    }
    : { './mac-speaker-call-producer-worker.js': ['beginMacSpeakerCallNative', 'retainMacSpeakerCallNative', 'MacSpeakerCallProducerRequest', 'MacSpeakerCallNativeRef'] }
  for (const [module, names] of Object.entries(expected)) {
    const imports = [...source.matchAll(/import\s+(type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)].filter(m => m[3] === module)
    const actual = imports.flatMap(m => m[2].split(',').map(n => n.trim().replace(/^type\s+/, ''))).sort()
    if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) errors.push(`bridge symbols: ${module}`)
    if (file === 'speaker-shadow.ts' && module.endsWith('producer-worker.js') && (imports.length !== 1 || !imports[0][1])) errors.push('runner worker import must be type-only')
    // Namespace/default/dynamic imports would evade the named-symbol fence.
    const occurrences = [...source.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"]([^'"]+)['"]/g)].filter(m => m[1] === module)
    if (occurrences.length !== imports.length) errors.push(`unnamed bridge import: ${module}`)
  }
  if (file === 'speaker-shadow.ts') {
    for (const required of [
      'if(!macSpeakerCallProducerEnabled(this.deps.env())||!macSpeakerCallProducerRequestValid(request))throw',
      'letproducerRequest=macSpeakerCallProducerEnabled(this.deps.env())?item.producerRequest:undefined',
      'producerRequest.captureId!==item.sessionId||producerRequest.sidecarPath!==item.sidecarPath',
      '...(producerRequest?{callProducer:producerRequest,shadowLogRequested:this.enabled(),callProducerSwapStart:resourceStart!.swapBytes}:{})',
      'if(outcome.callProducerExport&&macSpeakerCallProducerEnabled(this.deps.env()))notifyMacSpeakerCallNativeExport(outcome.callProducerExport)',
    ]) if (!compact.includes(required)) errors.push(`producer admission: ${required}`)
    if ([...source.matchAll(/\bnotifyMacSpeakerCallNativeExport\(/g)].length !== 1) errors.push('exactly one retained-ref handoff')
  } else {
    for (const required of [
      'if(job.callProducer){try{producerContext=beginMacSpeakerCallNative(job.callProducer,',
      'if(producerContext){try{callProducerExport=retainMacSpeakerCallNative(producerContext,{nativePath,embeddingPath:embPath,exitCode:run.code,closed:run.closed,networkDenied:true})}',
    ]) if (!compact.includes(required)) errors.push(`native retention: ${required}`)
    if ([...source.matchAll(/\bbeginMacSpeakerCallNative\(/g)].length !== 1 || [...source.matchAll(/\bretainMacSpeakerCallNative\(/g)].length !== 1) errors.push('exactly one begin/retain pair')
    const begin = compact.indexOf('producerContext=beginMacSpeakerCallNative('), run = compact.indexOf('construn=awaitrunCli('), retain = compact.indexOf('callProducerExport=retainMacSpeakerCallNative(')
    if (!(begin >= 0 && run > begin && retain > run)) errors.push('pre-native provenance before single run and retained closed output after it')
    if ([...source.matchAll(/\bawait\s+runCli\(/g)].length !== 1) errors.push('single shared inference call')
  }
  return errors
}

function finalizedTriggerErrors(text: string): string[] {
  const source = code(text), errors: string[] = []
  const filing = source.slice(source.indexOf('export async function fileFinishedMacRecording('), source.indexOf('export function scheduleFinalizationJob('))
  const notify = filing.indexOf('try { await notify({ sessionId, sidecarPath: meetingPath.replace(')
  const shadow = filing.indexOf('(deps.shadowNotify ?? notifySpeakerShadowFinalized)({ sessionId, sidecarPath: meetingPath.replace(')
  if (!(filing.includes('} finally {') && notify >= 0 && shadow > notify)) errors.push('original producer registration must precede log-only notification in filing finally')
  if ([...source.matchAll(/\(deps\.shadowNotify \?\? notifySpeakerShadowFinalized\)\(/g)].length !== 1 || /\bnotifySpeakerShadowFinalized\(/.test(source)) errors.push('single log-only filing trigger, no direct completion trigger')
  const finalizer = source.slice(source.indexOf('export function scheduleFinalizationJob('))
  const complete = finalizer.indexOf("markCanonicalFinalizationState(current.sidecarPath, 'complete', false)")
  const freeze = finalizer.indexOf('await notifyMacSpeakerCallFinalized({ sessionId: current.sessionId, sidecarPath: current.sidecarPath, freezeOnly: true })', complete)
  const remove = finalizer.indexOf('runtime.finalizationJobs.remove(current.sessionId)', complete)
  const file = finalizer.indexOf("fileFinishedMacRecording(current.sessionId, current.meetingPath, 'meeting/save')", complete)
  if (!(complete >= 0 && freeze > complete && remove > freeze && file > remove)) errors.push('complete -> freeze under finalization guard -> remove -> background filing')
  const recovery = finalizer.slice(finalizer.indexOf('if (canonicalFinalizationIsComplete(current))'), finalizer.indexOf("if (current.phase === 'capture_pending')"))
  if (!/await notifyMacSpeakerCallFinalized\(\{ sessionId: current\.sessionId, sidecarPath: current\.sidecarPath, freezeOnly: true \}\)[\s\S]*runtime\.finalizationJobs\.remove\(current\.sessionId\)[\s\S]*fileFinishedMacRecording/.test(recovery)) errors.push('complete recovery freezes before releasing job and filing')
  return errors
}

describe('speaker shadow: the log-only contract in source', () => {
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    it(`${file} imports only from its allowlist`, () => {
      // `from '...'`, a bare side-effect `import '...'`, a dynamic `import('...')` and `require('...')`.
      const imports = [...code(read(file)).matchAll(/\bfrom\s+'([^']+)'|\bimport\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)|\brequire\(\s*'([^']+)'\s*\)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4])
      expect(imports.length).toBeGreaterThan((file.endsWith('numeric.ts') || file === 'speaker-name.ts') ? -1 : 0)
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
      'persistBatch', 'saveSidecar', 'writeSidecar', 'publishMacSpeakerCallNative',
      'prepareMacSpeakerCallPublication', 'executeMacSpeakerCallPublication', 'freezeMacSpeakerCallSeed',
    ]) expect(all.includes(writer)).toBe(false)
  })

  it.each(['speaker-shadow.ts', 'speaker-shadow-worker.ts'])('%s reaches only the separately admitted producer bridge, never a direct publisher', file => {
    expect(producerBridgeErrors(file, read(file))).toEqual([])
  })

  it('freezes complete sources while finalization is held, then registers the producer before the single log-only filing trigger', () => {
    // Behavioral async ordering/crash coverage lives in routes/meeting-call-speaker-groups.test.ts.
    expect(finalizedTriggerErrors(read('../routes/meeting.ts'))).toEqual([])
  })

  it.each([
    ['runner publisher import', 'speaker-shadow.ts', (s: string) => s.replace('configureMacSpeakerCallProducer,', 'publishMacSpeakerCallNative,configureMacSpeakerCallProducer,')],
    ['double-quoted namespace import', 'speaker-shadow.ts', (s: string) => s + '\nimport * as writer from "./mac-speaker-call-producer.js"'],
    ['runtime worker import', 'speaker-shadow.ts', (s: string) => s.replace('import type {MacSpeakerCallProducerRequest}', 'import {MacSpeakerCallProducerRequest}')],
    ['producer flag bypass', 'speaker-shadow.ts', (s: string) => s.replace('let producerRequest=macSpeakerCallProducerEnabled(this.deps.env())?item.producerRequest:undefined', 'let producerRequest=item.producerRequest')],
    ['unchecked retained export', 'speaker-shadow.ts', (s: string) => s.replace('if(outcome.callProducerExport&&macSpeakerCallProducerEnabled(this.deps.env()))', 'if(outcome.callProducerExport)')],
    ['unconditional native provenance', 'speaker-shadow-worker.ts', (s: string) => s.replace('if(job.callProducer){', 'if(true){')],
    ['unchecked close receipt', 'speaker-shadow-worker.ts', (s: string) => s.replace('closed:run.closed', 'closed:true')],
    ['native rerun', 'speaker-shadow-worker.ts', (s: string) => s.replace('const run = await runCli(', 'await runCli(job, wavPath, nativePath, embPath, work, deps); const run = await runCli(')],
  ] as const)('the bridge fence catches %s', (_name, file, mutate) => {
    const original = read(file), changed = mutate(original)
    expect(changed).not.toBe(original)
    expect(producerBridgeErrors(file, changed).length).toBeGreaterThan(0)
  })

  it('the trigger fence catches removed pre-correction freeze and early log-only notification', () => {
    const source = read('../routes/meeting.ts')
    const removed = source.replaceAll('await notifyMacSpeakerCallFinalized({ sessionId: current.sessionId, sidecarPath: current.sidecarPath, freezeOnly: true })', 'void 0')
    expect(finalizedTriggerErrors(removed).length).toBeGreaterThan(0)
    const early = source.replace('try { await notify({ sessionId, sidecarPath: meetingPath.replace(', 'try { notifySpeakerShadowFinalized({sessionId,sidecarPath:meetingPath}); await notify({ sessionId, sidecarPath: meetingPath.replace(')
    expect(early).not.toBe(source)
    expect(finalizedTriggerErrors(early).length).toBeGreaterThan(0)
  })

  it('the server wires a live-work probe at boot, or the runner never starts a diarization', () => {
    const index = read('../index.ts')
    expect(index).toMatch(/configureSpeakerShadow\(\{\s*captureActive: \(\) => getTranscriptionSessionLiveness\(\)\.live > 0 \|\| speakerShadowLeaseActive\(\),/)
    expect(index).toMatch(/app\.use\('\/api', createSpeakerShadowRouter\(\)\)/)
  })

  it('/api/health spreads the shadow fields, so the key is absent while shadow mode is off', () => {
    const health = read('../routes/health.ts')
    expect(health.match(/\.\.\.speakerShadowHealthFields\(\),/g)?.length).toBe(1)
    expect(health).not.toMatch(/speaker_shadow:/)
  })
})
