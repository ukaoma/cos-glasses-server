// The merge runner: what the engine's scores MEAN, and how to take it back.
//
// SYNTHETIC INPUTS ONLY. Every capture and transcript here is generated tokens
// (`__fixtures__/synthetic.ts`); no real meeting text reaches this file. The engine itself
// runs for real — the derive path renders actual markdown — but it is called in-process
// rather than on a worker thread, because what is under test is the DECISION layer.
//
// THE PIPELINE IS A FAKE CHILD, not a mock of the spawn: `sync_meetings.py
// --apply-merge-decision` does not exist yet (WS8b). Each test hands the runner a spawn that
// answers with the contract's exit codes and result lines.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImportedMeetingLibrary } from './imported-meeting-library.js'
import {
  DECISION_SCHEMA,
  PIPELINE_EXIT_DECISION_INVALID,
  PIPELINE_EXIT_LOCK_BUSY,
  PIPELINE_EXIT_PARTIAL_OR_FAILED,
  type MergePipelineResult,
  readDecision,
} from './meeting-decisions.js'
import {
  ActionRefusedError,
  MAX_AUTO_ACTIONS_PER_RUN,
  MeetingMergeRunner,
  PIPELINE_LOCK_RETRY_MS,
  PIPELINE_STATUS_ARG,
  PIPELINE_MAX_ATTEMPTS,
  type EngineInputs,
  type RevertPreview,
  toEngineSentences,
} from './meeting-actions.js'
import { MeetingActionsStore, actionIdFor, suggestionIdFor } from './meeting-actions-store.js'
import { type EngineRequest, runEngine } from './meeting-engine/worker.js'
import { EVIDENCE_BIN_MS } from './meeting-engine/evidence.js'
import type { PipelineAttempt } from './pipeline-runner.js'
import { firefliesMeeting, g2Capture, matchingPair, phrase } from './meeting-engine/__fixtures__/synthetic.js'

const MERGE_PREFIX = 'COS_MERGE_RESULT='
const roots: string[] = []
const START = Date.UTC(2026, 7, 20, 15, 0, 0)

interface Harness {
  runner: MeetingMergeRunner
  store: MeetingActionsStore
  library: ImportedMeetingLibrary
  inputs: EngineInputs
  spawns: Array<{ args: readonly string[]; actionId?: string }>
  setMode: (mode: 'imports' | 'advise' | 'apply') => void
  setNow: (ms: number) => void
  setCapture: (active: boolean) => void
  setAdmissions: (open: boolean) => void
  setLeaseFails: (fails: boolean) => void
  setSpawn: (fn: (args: readonly string[]) => PipelineAttempt) => void
  setSpawnNull: () => void
  concurrency: { now: number; max: number }
}

function emptyInputs(): EngineInputs {
  return { g2: [], fireflies: [], g2Meta: {}, firefliesMeta: {} }
}

function attempt(overrides: Partial<PipelineAttempt> = {}): PipelineAttempt {
  return { code: 0, signal: null, timedOut: false, stdout: '', stderr: '', resultLines: [], elapsedMs: 1, ...overrides }
}

function applied(actionId: string, overrides: Partial<MergePipelineResult> = {}): PipelineAttempt {
  const result: MergePipelineResult = {
    schema: DECISION_SCHEMA,
    action_id: actionId,
    status: 'applied',
    outputs: [{ path: 'personal/meetings/2026-08/ff.md', sha256: 'c'.repeat(64) }],
    archived: [{ original: 'personal/meetings/2026-08/ff.md', archive: `archive/${actionId}.md`, sha256: 'b'.repeat(64) }],
    retired: [],
    stamps: [],
    transcript_map: 'applied',
    ...overrides,
  }
  return attempt({ code: 0, resultLines: [JSON.stringify(result)], stdout: `${MERGE_PREFIX}${JSON.stringify(result)}\n` })
}

function harness(options: { inputs?: EngineInputs; mode?: 'imports' | 'advise' | 'apply'; now?: number; collect?: 'real' } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cos-runner-'))
  roots.push(dir)
  const root = join(dir, 'imports')
  const library = new ImportedMeetingLibrary({ root })
  const store = new MeetingActionsStore({ root })
  const state = {
    mode: options.mode ?? 'imports',
    now: options.now ?? START - 1,
    capture: false,
    admissions: true,
    leaseFails: false,
    inputs: options.inputs ?? emptyInputs(),
    spawnNull: false,
    spawn: (args: readonly string[]) => applied(String(args[1] ?? 'a_0000000000000000')),
  }
  const spawns: Array<{ args: readonly string[]; actionId?: string }> = []
  const concurrency = { now: 0, max: 0 }

  const runner = new MeetingMergeRunner({
    store,
    library,
    mode: () => state.mode,
    isPipelineMac: () => state.mode !== 'imports',
    // `collect: 'real'` leaves this dep OUT, so the runner uses its own collector against
    // whatever COS_OPERATIONS_DIR points at. That is the only way a tree diff proves
    // anything: an injected collector means the runner never learns the tree exists.
    ...(options.collect === 'real' ? {} : {
      collectInputs: async () => {
        // The chain is only observable from inside a pass. Counting overlapping passes here
        // is what proves the promise chain serializes rather than merely deduplicating.
        concurrency.now += 1
        concurrency.max = Math.max(concurrency.max, concurrency.now)
        await new Promise(done => setTimeout(done, 5))
        concurrency.now -= 1
        return state.inputs
      },
    }),
    // In-process, not on a worker thread: the decision layer is what is under test, and a
    // worker per test would make every one of them a second slower for nothing.
    runEngine: async request => runEngine(request),
    acquireLease: () => {
      if (state.leaseFails) throw new Error('maintenance_drain_active')
      return { id: 'lease', setPhase: () => undefined, release: () => undefined }
    },
    admissionsOpen: () => state.admissions,
    captureActive: () => state.capture,
    spawnPipeline: async (args, spawnOptions) => {
      if (state.spawnNull) throw new Error('this harness should have used a null spawn')
      spawns.push({ args, actionId: spawnOptions.actionId })
      return state.spawn(args)
    },
    now: () => state.now,
    log: () => undefined,
  })

  return {
    runner,
    store,
    library,
    inputs: state.inputs,
    spawns,
    setMode: mode => { state.mode = mode },
    setNow: ms => { state.now = ms },
    setCapture: active => { state.capture = active },
    setAdmissions: open => { state.admissions = open },
    setLeaseFails: fails => { state.leaseFails = fails },
    setSpawn: fn => { state.spawn = fn },
    setSpawnNull: () => { state.spawnNull = true },
    concurrency,
  }
}

/** One capture and one transcript that pair automatically, both finalized after `boundary`. */
function pairedInputs(options: { k?: number; sessionId?: string; firefliesId?: string; finalizedAtMs?: number } = {}): EngineInputs {
  const pair = matchingPair({
    k: options.k ?? 60,
    sessionId: options.sessionId ?? 's1',
    firefliesId: options.firefliesId ?? 'f1',
    startMs: START,
  })
  const capture = { ...pair.capture, finalizedAtMs: options.finalizedAtMs ?? START + 1_800_000 }
  return {
    g2: [capture],
    fireflies: [pair.meeting],
    g2Meta: {
      [capture.sessionId]: {
        sidecarRelPath: 'personal/meetings/2026-08/g2.g2-chunks.json',
        scribeRelPath: 'personal/meetings/2026-08/g2.md',
        sha256: 'a'.repeat(64),
        finalizedAtMs: capture.finalizedAtMs,
      },
    },
    firefliesMeta: {
      [pair.meeting.id]: {
        scribeRelPath: 'personal/meetings/2026-08/ff.md',
        sidecarRelPath: 'personal/meetings/2026-08/ff.fireflies.json',
        sha256: 'b'.repeat(64),
      },
    },
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('imports mode', () => {
  it('writes a merged record and records it applied', async () => {
    const h = harness({ inputs: pairedInputs() })
    const outcome = await h.runner.run('test')
    expect(outcome.auto).toBe(1)
    const actions = h.store.read().actions
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ state: 'applied', mode: 'imports', tier: 'auto', kind: 'merge' })
    expect(existsSync(actions[0].outputs[0].path)).toBe(true)
    expect(readFileSync(actions[0].outputs[0].path, 'utf8')).toContain('## G2 Capture')
  })

  it('gives the merged row the id every surface routes on', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    expect(h.store.read().actions[0].outputs[0].recordId).toMatch(/^blended:[0-9a-f]{16}$/)
  })

  it('does not take the same action twice', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('first')
    const second = await h.runner.run('second')
    expect(second.auto).toBe(0)
    expect(h.store.read().actions).toHaveLength(1)
  })

  it('spawns no pipeline child at all', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    expect(h.spawns).toEqual([])
  })
})

describe('D14: the advisory first run', () => {
  it('suggests rather than merges a recording that finished before the engine arrived', async () => {
    // The tier rules were measured only on recordings that already had a merge, so the
    // backlog is exactly the population nobody has measured. Automatic behaviour starts
    // when a person could have seen it.
    const h = harness({ now: START + 7_200_000 })
    await h.runner.run('install')   // stamps engineInstalledAt at now
    const installed = h.store.read().status.engineInstalledAt!
    const inputs = pairedInputs({ finalizedAtMs: installed - 60_000 })
    const later = harnessWith(h, inputs)
    const outcome = await later.run('backlog')
    expect(outcome.auto).toBe(0)
    expect(outcome.suggested + outcome.wouldMerge).toBe(1)
    expect(h.store.read().suggestions[0].state).toBe('open')
    expect(h.store.read().actions).toHaveLength(0)
  })

  it('merges a recording that finished after it', async () => {
    const h = harness({ now: START })
    await h.runner.run('install')
    const installed = h.store.read().status.engineInstalledAt!
    const later = harnessWith(h, pairedInputs({ finalizedAtMs: installed + 60_000 }))
    expect((await later.run('new')).auto).toBe(1)
  })
})

/** Swap the harness's inputs without rebuilding its store. */
function harnessWith(h: Harness, inputs: EngineInputs): MeetingMergeRunner {
  // The runner reads inputs through its injected collector, so a new runner on the SAME
  // store is how a second pass with different files is expressed.
  const state = { inputs }
  return new MeetingMergeRunner({
    store: h.store,
    library: h.library,
    mode: () => 'imports',
    isPipelineMac: () => false,
    collectInputs: () => state.inputs,
    runEngine: async request => runEngine(request),
    acquireLease: () => ({ id: 'l', setPhase: () => undefined, release: () => undefined }),
    admissionsOpen: () => true,
    captureActive: () => false,
    spawnPipeline: null,
    now: () => h.store.read().status.engineInstalledAt ?? START,
    log: () => undefined,
  })
}

describe('advise mode writes nothing outside the imports root', () => {
  it('turns the auto tier into a would-merge item', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'advise' })
    const outcome = await h.runner.run('test')
    expect(outcome.auto).toBe(0)
    expect(outcome.wouldMerge).toBe(1)
    const suggestions = h.store.read().suggestions
    expect(suggestions[0]).toMatchObject({ kind: 'would_merge', state: 'open' })
  })

  it('writes no record, no decision and no pipeline spawn', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'advise' })
    await h.runner.run('test')
    expect(h.library.list()).toEqual([])
    expect(existsSync(join(h.library.root, 'decisions'))).toBe(false)
    expect(h.spawns).toEqual([])
  })

  it('refuses to accept in advise mode, and saves the answer instead', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'advise' })
    await h.runner.run('test')
    const id = h.store.read().suggestions[0].id
    await expect(h.runner.acceptSuggestion(id)).rejects.toMatchObject({ code: 'advise_mode' })
    await h.runner.confirmSuggestion(id)
    expect(h.store.read().suggestions[0].state).toBe('confirmed')
  })

  /**
   * The tree diff, run against the tree the runner actually reads.
   *
   * THE OLD VERSION OF THIS TEST COULD NOT FAIL. It made a directory, put one file in it,
   * ran a harness whose inputs were injected synthetic objects, and asserted the directory
   * was unchanged. The runner had never been told that directory existed and had no way to
   * write to it, so the assertion held for a reason that has nothing to do with advise mode.
   *
   * This version points `COS_OPERATIONS_DIR` at the diffed tree and lets the runner use its
   * REAL collector, so the pass reads those files, scores them, and would write into that
   * tree if advise mode ever let it. Every file is hashed before and after, not just listed,
   * because an in-place splice changes no filename.
   */
  it('writes ONLY under the imports root, proven by a hash diff of the tree it reads', async () => {
    const operations = mkdtempSync(join(tmpdir(), 'cos-operations-'))
    roots.push(operations)
    const monthDir = join(operations, 'personal', 'meetings', '2026-08')
    mkdirSync(monthDir, { recursive: true })
    const pair = matchingPair({ k: 60, sessionId: 'tree_s1', firefliesId: 'tree_f1', startMs: START })
    writeFileSync(join(monthDir, '2026-08-20_Standup.md'), operationsScribe('Standup', 'G2 Glasses'))
    writeFileSync(join(monthDir, '2026-08-20_Standup.g2-chunks.json'), JSON.stringify({
      sessionId: pair.capture.sessionId,
      startTime: pair.capture.startMs,
      durationMs: pair.capture.durationMs,
      chunks: pair.capture.chunks,
      batchSegments: pair.capture.batchSegments,
    }))
    writeFileSync(join(monthDir, '2026-08-20_Weekly.md'), operationsScribe('Weekly', 'Fireflies'))
    writeFileSync(join(monthDir, '2026-08-20_Weekly.fireflies.json'), JSON.stringify({
      sidecar_version: 1,
      clipped: false,
      id: pair.meeting.id,
      date: pair.meeting.startMs,
      duration: 30,
      participants: [],
      sentences: pair.meeting.sentences,
    }))

    const before = hashTree(operations)
    expect(Object.keys(before)).toHaveLength(4)

    const previous = process.env.COS_OPERATIONS_DIR
    process.env.COS_OPERATIONS_DIR = operations
    try {
      // NO injected collector: this pass reads the tree above through the real one.
      const h = harness({ mode: 'advise', collect: 'real' })
      const outcome = await h.runner.run('test')
      // Proof the runner SAW the tree: without it there is nothing to advise about, and a
      // green diff would again mean nothing.
      expect(outcome.wouldMerge).toBe(1)
      expect(h.store.read().suggestions[0]).toMatchObject({ kind: 'would_merge', state: 'open' })
      expect(hashTree(operations)).toEqual(before)
      expect(h.spawns).toEqual([])
      expect(existsSync(join(h.library.root, 'decisions'))).toBe(false)
    } finally {
      if (previous == null) delete process.env.COS_OPERATIONS_DIR
      else process.env.COS_OPERATIONS_DIR = previous
    }
  })
})

/** A scribe in the shape every reader in this repo parses. */
function operationsScribe(title: string, source: string): string {
  return [
    `# ${title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    '| **Date** | 2026-08-20 15:00 |',
    '| **Duration** | 30 minutes |',
    `| **Source** | ${source} |`,
    '| **Domain** | personal |',
    '',
    '## Transcript',
    '',
    '[00:00:05] Speaker A: Synthetic line.',
    '',
  ].join('\n')
}

/** Every file under `root`, by relative path, with its sha256. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, rel)
      else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(root, '')
  return out
}

describe('apply mode', () => {
  it('writes one decision file per action and spawns the pipeline', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const action = h.store.read().actions[0]
    expect(action.mode).toBe('apply')
    expect(action.state).toBe('applied')
    expect(h.spawns[0].args).toEqual(['--apply-merge-decision', action.id])
    expect(h.spawns[0].actionId).toBe(action.id)
  })

  it('puts the rendered content in the decision, never in the action log', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const action = h.store.read().actions[0]
    const decision = readDecision(action.id, h.library.root)!
    expect(decision.patch.sections.join('\n')).toContain('## G2 Capture')
    // A status poll reads the action log. Transcript text in it would make every poll a
    // transcript read, and would put meeting content in a bookkeeping file.
    expect(readFileSync(h.store.actionsPath(), 'utf8')).not.toContain('## G2 Capture')
  })

  it('names the inputs the pipeline has to verify, with their hashes', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const decision = readDecision(h.store.read().actions[0].id, h.library.root)!
    expect(decision.inputs).toEqual([
      { kind: 'g2', sessionId: 's1', sidecarRelPath: 'personal/meetings/2026-08/g2.g2-chunks.json', scribeRelPath: 'personal/meetings/2026-08/g2.md', sha256: 'a'.repeat(64) },
      { kind: 'fireflies', firefliesId: 'f1', scribeRelPath: 'personal/meetings/2026-08/ff.md', sidecarRelPath: 'personal/meetings/2026-08/ff.fireflies.json', sha256: 'b'.repeat(64) },
    ])
    expect(decision.retire).toEqual(['personal/meetings/2026-08/g2.md'])
  })

  it('writes the pipeline report back into the decision', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const action = h.store.read().actions[0]
    // Revert reads the archive path and its sha256 from here.
    expect(readDecision(action.id, h.library.root)!.result).toMatchObject({ status: 'applied' })
  })

  it('refuses when the Fireflies scribe is not on disk', async () => {
    const inputs = pairedInputs()
    delete inputs.firefliesMeta.f1.scribeRelPath
    const h = harness({ inputs, mode: 'apply' })
    await h.runner.run('test')
    expect(h.store.read().actions[0]).toMatchObject({ state: 'failed', error: 'fireflies_scribe_missing' })
    expect(h.spawns).toEqual([])
  })
})

describe('the pipeline contract', () => {
  it('leaves the action pending with a retry time when the child cannot take the lock', async () => {
    // Exit 3 is not a failure: the hourly sync holds the lock every hour. Marking it failed
    // would turn a normal collision into something a person has to look at.
    const h = harness({ inputs: pairedInputs(), mode: 'apply', now: 1_000_000 })
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    await h.runner.run('test')
    const action = h.store.read().actions[0]
    expect(action.state).toBe('pending')
    expect(action.nextAt).toBe(1_000_000 + PIPELINE_LOCK_RETRY_MS)
    expect(action.error).toBe('sync_lock_busy')
  })

  it('fails terminally on exit 4 and never retries it', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_DECISION_INVALID }))
    await h.runner.run('test')
    const action = h.store.read().actions[0]
    expect(action.state).toBe('failed')
    expect(action.error).toBe('decision_invalid')
    expect(action.nextAt).toBeUndefined()
  })

  it.each([
    ['no result line', attempt({ code: PIPELINE_EXIT_PARTIAL_OR_FAILED })],
    ['two result lines', attempt({ code: 0, resultLines: ['{"schema":1}', '{"schema":1}'] })],
    ['an unparseable result line', attempt({ code: 0, resultLines: ['{oops'] })],
  ])('retries once on %s and then stops', async (_label, reply) => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => reply)
    await h.runner.run('test')
    let action = h.store.read().actions[0]
    expect(action.state).toBe('pending')
    expect(action.error).toContain('result_unreadable')

    h.setNow(Number.MAX_SAFE_INTEGER / 2)
    await h.runner.run('retry')
    action = h.store.read().actions[0]
    expect(action.state).toBe('failed')
    expect(action.attempts).toBe(PIPELINE_MAX_ATTEMPTS)
  })

  it('treats a partial report as failed at the step it names', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(args => applied(String(args[1]), { status: 'partial', step: 'splice', error_code: 'write_failed' }))
    await h.runner.run('test')
    expect(h.store.read().actions[0].error).toBe('write_failed at splice')
  })

  it('records the outputs and their hashes that the pipeline actually wrote', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const action = h.store.read().actions[0]
    expect(action.outputs.map(o => o.path)).toEqual(['personal/meetings/2026-08/ff.md'])
    expect(action.outputSha256).toEqual(['c'.repeat(64)])
  })
})

describe('the cap', () => {
  it('takes at most 25 automatic actions in one run', async () => {
    // Counted INSIDE the runner because five triggers call it; a cap the caller applied
    // would be a cap the other four do not have.
    const g2 = []
    const fireflies = []
    const g2Meta: EngineInputs['g2Meta'] = {}
    const firefliesMeta: EngineInputs['firefliesMeta'] = {}
    for (let i = 0; i < MAX_AUTO_ACTIONS_PER_RUN + 4; i++) {
      const pair = matchingPair({ k: 60, sessionId: `s${i}`, firefliesId: `f${i}`, startMs: START + i * 7_200_000 })
      g2.push({ ...pair.capture, finalizedAtMs: pair.capture.startMs + 1_800_000 })
      fireflies.push(pair.meeting)
      g2Meta[`s${i}`] = { sha256: `${i}`.repeat(64).slice(0, 64), finalizedAtMs: pair.capture.startMs + 1_800_000 }
      firefliesMeta[`f${i}`] = {}
    }
    const h = harness({ inputs: { g2, fireflies, g2Meta, firefliesMeta }, now: START - 1 })
    const outcome = await h.runner.run('backlog')
    expect(outcome.auto).toBe(MAX_AUTO_ACTIONS_PER_RUN)
    expect(outcome.deferredByCap).toBe(4)
    expect(h.store.read().actions.filter(row => row.state === 'applied')).toHaveLength(MAX_AUTO_ACTIONS_PER_RUN)
  })

  it('takes the rest on the next run', async () => {
    const g2 = []
    const fireflies = []
    const g2Meta: EngineInputs['g2Meta'] = {}
    const firefliesMeta: EngineInputs['firefliesMeta'] = {}
    for (let i = 0; i < MAX_AUTO_ACTIONS_PER_RUN + 2; i++) {
      const pair = matchingPair({ k: 60, sessionId: `s${i}`, firefliesId: `f${i}`, startMs: START + i * 7_200_000 })
      g2.push({ ...pair.capture, finalizedAtMs: pair.capture.startMs + 1_800_000 })
      fireflies.push(pair.meeting)
      g2Meta[`s${i}`] = { finalizedAtMs: pair.capture.startMs + 1_800_000 }
      firefliesMeta[`f${i}`] = {}
    }
    const h = harness({ inputs: { g2, fireflies, g2Meta, firefliesMeta }, now: START - 1 })
    await h.runner.run('one')
    expect((await h.runner.run('two')).auto).toBe(2)
  })
})

describe('deferring', () => {
  it('does nothing while a capture is live', async () => {
    // Principle 7. Scoring is CPU-bound over every capture against every transcript; during
    // a meeting that competes with chunk writes and transcription.
    const h = harness({ inputs: pairedInputs() })
    h.setCapture(true)
    const outcome = await h.runner.run('test')
    expect(outcome.skippedReason).toBe('capture_active')
    expect(h.store.read().actions).toEqual([])
  })

  it('does nothing while admissions are closed', async () => {
    const h = harness({ inputs: pairedInputs() })
    h.setAdmissions(false)
    expect((await h.runner.run('test')).skippedReason).toBe('maintenance_deferred')
    expect(h.store.read().actions).toEqual([])
  })

  it('defers the action rather than fighting a drain that lands on the lease', async () => {
    const h = harness({ inputs: pairedInputs() })
    h.setLeaseFails(true)
    const outcome = await h.runner.run('test')
    expect(outcome.auto).toBe(0)
    // Nothing was written, so the next run repeats the same decision at no cost.
    expect(h.library.list()).toEqual([])
  })

  it('refuses every person-initiated mutation during a drain', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    const actionId = h.store.read().actions[0].id
    h.setAdmissions(false)
    const calls: Array<() => Promise<unknown>> = [
      () => h.runner.acceptSuggestion('s_x'),
      () => h.runner.confirmSuggestion('s_x'),
      () => h.runner.dismissSuggestion('s_x'),
      () => h.runner.revert(actionId, { previewHash: 'x' }),
      () => h.runner.revertAll({ previewHash: 'x' }),
    ]
    for (const call of calls) {
      await expect(Promise.resolve().then(call)).rejects.toMatchObject({ status: 409, code: 'maintenance_drain_active' })
    }
  })

  it('still previews a revert during a drain, because a preview changes nothing', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    h.setAdmissions(false)
    await expect(h.runner.revert(h.store.read().actions[0].id, { dryRun: true })).resolves.toMatchObject({ previewHash: expect.any(String) })
  })
})

describe('reverting in imports mode', () => {
  async function applyOne() {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    return { h, action: h.store.read().actions[0] }
  }

  it('needs a preview, and the preview is what it applies', async () => {
    const { h, action } = await applyOne()
    await expect(h.runner.revert(action.id, {})).rejects.toMatchObject({ code: 'preview_required' })
    const preview = await h.runner.revert(action.id, { dryRun: true }) as RevertPreview
    const done = await h.runner.revert(action.id, { previewHash: preview.previewHash })
    expect(done).toMatchObject({ state: 'reverted' })
    expect(existsSync(action.outputs[0].path)).toBe(false)
    expect(existsSync(action.outputs[0].sidecarPath!)).toBe(false)
  })

  it('refuses a preview hash from before the world changed', async () => {
    const { h, action } = await applyOne()
    const preview = await h.runner.revert(action.id, { dryRun: true }) as RevertPreview
    writeFileSync(action.outputs[0].path, '# a person edited this\n')
    await expect(h.runner.revert(action.id, { previewHash: preview.previewHash }))
      .rejects.toMatchObject({ code: 'revert_stale' })
  })

  it('keeps an edited record in .reverted rather than destroying the edit', async () => {
    const { h, action } = await applyOne()
    writeFileSync(action.outputs[0].path, '# a person edited this\n')
    const preview = await h.runner.revert(action.id, { dryRun: true }) as RevertPreview
    expect(preview.editedOutputs).toEqual([action.outputs[0].path])
    await h.runner.revert(action.id, { previewHash: preview.previewHash })
    const kept = join(h.store.revertedDir(), action.id)
    expect(readdirSync(kept).some(name => name.endsWith('.md'))).toBe(true)
    expect(readFileSync(join(kept, readdirSync(kept).find(n => n.endsWith('.md'))!), 'utf8')).toBe('# a person edited this\n')
  })

  it('leaves a tombstone so the next run does not redo it', async () => {
    const { h, action } = await applyOne()
    const preview = await h.runner.revert(action.id, { dryRun: true }) as RevertPreview
    await h.runner.revert(action.id, { previewHash: preview.previewHash })
    expect(h.store.read().tombstones).toHaveLength(1)
    const again = await h.runner.run('after-revert')
    expect(again.auto).toBe(0)
    expect(h.library.list()).toEqual([])
  })

  it('answers a second revert of a finished one with 200, not an error', async () => {
    const { h, action } = await applyOne()
    const preview = await h.runner.revert(action.id, { dryRun: true }) as RevertPreview
    await h.runner.revert(action.id, { previewHash: preview.previewHash })
    await expect(h.runner.revert(action.id, { previewHash: preview.previewHash }))
      .resolves.toMatchObject({ alreadyReverted: true, state: 'reverted' })
  })

  it('refuses to revert an action the pipeline made itself', async () => {
    const h = harness({
      inputs: {
        ...emptyInputs(),
        g2Meta: { s9: { blendedInto: 'personal/meetings/2026-08/parent.md' } },
      },
      mode: 'advise',
    })
    await h.runner.run('adopt')
    const legacy = h.store.read().actions.find(row => row.tier === 'legacy_applied')!
    expect(() => h.runner.previewRevert(legacy.id)).toThrow(ActionRefusedError)
  })

  it('refuses an action that is not there', async () => {
    const h = harness()
    expect(() => h.runner.previewRevert('a_ffffffffffffffff')).toThrow(ActionRefusedError)
  })
})

describe('reverting in apply mode', () => {
  it('spawns the revert command and records the outcome', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const action = h.store.read().actions[0]
    h.setSpawn(args => applied(String(args[1]), { status: 'reverted' }))
    const preview = await h.runner.revert(action.id, { dryRun: true }) as RevertPreview
    await h.runner.revert(action.id, { previewHash: preview.previewHash })
    expect(h.spawns.map(row => row.args[0])).toContain('--revert-merge-decision')
    expect(h.store.read().actions[0].state).toBe('reverted')
    expect(h.store.read().tombstones.length).toBeGreaterThan(0)
  })

  it('keeps a contended revert claimed rather than dropping it', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const action = h.store.read().actions[0]
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    const preview = await h.runner.revert(action.id, { dryRun: true }) as RevertPreview
    await h.runner.revert(action.id, { previewHash: preview.previewHash })
    // The claim stands, so the next drive finishes it rather than starting over.
    expect(h.store.read().actions[0].state).toBe('revert_pending')
  })
})

/**
 * QA round 1, blockers 1 and 2: a deferred Undo is re-driven, and a retried Undo stays an
 * Undo.
 *
 * WHAT WAS WRONG. `tick()` and the pass's own drive loop both selected only `pending`, so an
 * Undo the sync lock deferred sat in `revert_pending` until the server restarted — with
 * `setMode` refusing the whole time because something was in flight, and no affordance in
 * Control. And a revert that failed retryably was reset to `pending`, where the next drive
 * read the direction off the state and spawned `--apply-merge-decision`: Undo became Redo.
 */
describe('a deferred or failed revert', () => {
  async function appliedApplyAction(): Promise<{ h: Harness; actionId: string }> {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    return { h, actionId: h.store.read().actions[0].id }
  }

  async function claimRevert(h: Harness, actionId: string): Promise<void> {
    const preview = await h.runner.revert(actionId, { dryRun: true }) as RevertPreview
    await h.runner.revert(actionId, { previewHash: preview.previewHash })
  }

  it('is picked up by the tick, not left until a restart', async () => {
    const { h, actionId } = await appliedApplyAction()
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    await claimRevert(h, actionId)
    expect(h.store.read().actions[0].state).toBe('revert_pending')
    // The lock retry window passes.
    h.setNow(START + PIPELINE_LOCK_RETRY_MS + 1)
    expect(h.runner.tick()).toMatchObject({ fired: true, reason: 'pending_retry' })
  })

  it('is re-driven by the next pass as a REVERT, not as an apply', async () => {
    const { h, actionId } = await appliedApplyAction()
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    await claimRevert(h, actionId)
    h.spawns.length = 0
    h.setNow(START + PIPELINE_LOCK_RETRY_MS + 1)
    h.setSpawn(args => applied(String(args[1]), { status: 'reverted' }))
    await h.runner.run('retry')
    expect(h.spawns.map(row => row.args[0])).toEqual(['--revert-merge-decision'])
    expect(h.store.read().actions[0].state).toBe('reverted')
  })

  it('retries as a revert after a partial result, never as an apply', async () => {
    const { h, actionId } = await appliedApplyAction()
    h.spawns.length = 0
    // `partial` is retryable, which is exactly the path that used to flip the direction.
    h.setSpawn(args => applied(String(args[1]), { status: 'partial', step: 'archive', error_code: 'archive_busy' }))
    await claimRevert(h, actionId)
    const row = h.store.read().actions[0]
    expect(row.state).toBe('revert_pending')
    expect(row.direction).toBe('revert')
    h.setNow(START + PIPELINE_LOCK_RETRY_MS + 1)
    h.spawns.length = 0
    h.setSpawn(args => applied(String(args[1]), { status: 'reverted' }))
    await h.runner.run('retry')
    expect(h.spawns.map(row2 => row2.args[0])).toEqual(['--revert-merge-decision'])
    expect(h.store.read().actions[0].state).toBe('reverted')
  })

  it('counts revert_pending in status on its own, not folded into pending', async () => {
    const { h, actionId } = await appliedApplyAction()
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    await claimRevert(h, actionId)
    const status = await h.runner.status()
    expect(status.counts.revertPending).toBe(1)
    expect(status.counts.pending).toBe(0)
  })

  it('reads the direction off the STATE for a row written before 6.47.0 QA1', async () => {
    // Rows already on disk carry no `direction`. `revert_pending` could only have been
    // reached through a Revert, so that is what the fallback says — and it has to, or the
    // first drive after an upgrade re-applies a merge somebody had undone.
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const actionId = h.store.read().actions[0].id
    await h.store.update(store => {
      const row = store.actions.find(item => item.id === actionId)!
      row.state = 'revert_pending'
      delete row.direction
    })
    expect(h.store.read().actions[0].direction).toBeUndefined()
    h.spawns.length = 0
    h.setSpawn(args => applied(String(args[1]), { status: 'reverted' }))
    await h.runner.driveWaitingAction(actionId)
    expect(h.spawns.map(row => row.args[0])).toEqual(['--revert-merge-decision'])
    expect(h.store.read().actions[0].state).toBe('reverted')
  })

  it('reads a legacy row with no direction and no revert as an apply', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    await h.runner.run('test')
    const actionId = h.store.read().actions[0].id
    await h.store.update(store => {
      const row = store.actions.find(item => item.id === actionId)!
      row.state = 'pending'
      delete row.direction
    })
    h.spawns.length = 0
    h.setSpawn(args => applied(String(args[1])))
    await h.runner.driveWaitingAction(actionId)
    expect(h.spawns.map(row => row.args[0])).toEqual(['--apply-merge-decision'])
  })

  it('is re-driven on boot through the waiting driver', async () => {
    const { h, actionId } = await appliedApplyAction()
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    await claimRevert(h, actionId)
    h.spawns.length = 0
    h.setSpawn(args => applied(String(args[1]), { status: 'reverted' }))
    await h.runner.driveWaitingAction(actionId)
    expect(h.spawns.map(row => row.args[0])).toEqual(['--revert-merge-decision'])
  })
})

/** QA round 1, blocker 4: a failed action is not terminal. */
describe('retrying a failed action', () => {
  async function failedApplyAction(): Promise<{ h: Harness; actionId: string }> {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_DECISION_INVALID, stderr: 'COS_MERGE_DECISION_INVALID=sha_mismatch\n' }))
    await h.runner.run('test')
    const action = h.store.read().actions[0]
    expect(action.state).toBe('failed')
    return { h, actionId: action.id }
  }

  it('puts it back in its own direction and drives it', async () => {
    const { h, actionId } = await failedApplyAction()
    h.spawns.length = 0
    h.setSpawn(args => applied(String(args[1])))
    const result = await h.runner.retryAction(actionId)
    expect(result).toMatchObject({ ok: true, state: 'pending', direction: 'apply' })
    await h.runner.idle()
    expect(h.spawns.map(row => row.args[0])).toContain('--apply-merge-decision')
    expect(h.store.read().actions[0].state).toBe('applied')
  })

  it('resets the attempt budget, or the first retry is the last', async () => {
    const { h, actionId } = await failedApplyAction()
    await h.runner.retryAction(actionId)
    const row = h.store.read().actions.find(item => item.id === actionId)!
    expect(row.attempts).toBe(0)
    expect(row.error).toBeUndefined()
    expect(row.diagnostics).toBeUndefined()
  })

  it('refuses an action that is not failed, and one that is already queued', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const actionId = h.store.read().actions[0].id
    await expect(h.runner.retryAction(actionId)).rejects.toMatchObject({ status: 409, code: 'action_not_failed' })
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    const preview = await h.runner.revert(actionId, { dryRun: true }) as RevertPreview
    await h.runner.revert(actionId, { previewHash: preview.previewHash })
    await expect(h.runner.retryAction(actionId)).rejects.toMatchObject({ status: 409, code: 'apply_in_flight' })
  })

  it('refuses an action that is not there', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await expect(h.runner.retryAction('a_0000000000000000')).rejects.toMatchObject({ status: 404, code: 'action_not_found' })
  })

  /**
   * An IMPORTS-mode retry is a different thing, and moving it to `pending` strands it.
   *
   * That action failed in the DERIVE, not in a pipeline child: there is nothing to spawn and
   * nothing to re-drive. `classify` already retakes a `failed` row, and it skips every state
   * except `failed` and `reverted` — so `pending` is a state nothing would ever leave.
   */
  it('leaves an imports-mode action failed, and the next pass retakes it', async () => {
    const h = harness({ inputs: pairedInputs() })
    // Make the derive fail: the engine answers with the wrong result kind.
    let failDerive = true
    const h2 = new MeetingMergeRunner({
      store: h.store,
      library: h.library,
      mode: () => 'imports',
      isPipelineMac: () => false,
      collectInputs: () => pairedInputs(),
      runEngine: async request => {
        if (request.kind === 'derive_merge' && failDerive) throw new Error('derive_exploded')
        return runEngine(request)
      },
      acquireLease: () => ({ id: 'l', setPhase: () => undefined, release: () => undefined }),
      admissionsOpen: () => true,
      captureActive: () => false,
      spawnPipeline: null,
      now: () => START,
      log: () => undefined,
    })
    await h2.run('first')
    const failed = h.store.read().actions[0]
    expect(failed.state).toBe('failed')
    expect(failed.mode).toBe('imports')

    const result = await h2.retryAction(failed.id)
    // STILL failed, because that is the state the engine retakes from.
    expect(result).toMatchObject({ ok: true, state: 'failed', direction: 'apply' })
    const afterRetry = h.store.read().actions[0]
    expect(afterRetry.state).toBe('failed')
    expect(afterRetry.attempts).toBe(0)
    expect(afterRetry.nextAt).toBeUndefined()
    expect(afterRetry.error).toBeUndefined()

    // And the next pass takes it, rather than skipping it forever.
    failDerive = false
    await h2.run('after-retry')
    expect(h.store.read().actions[0].state).toBe('applied')
  })

  it('refuses during a drain', async () => {
    const { h, actionId } = await failedApplyAction()
    h.setAdmissions(false)
    await expect(h.runner.retryAction(actionId)).rejects.toMatchObject({ status: 409, code: 'maintenance_drain_active' })
  })

  it('returns one action by id', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const actionId = h.store.read().actions[0].id
    expect(h.runner.getAction(actionId).id).toBe(actionId)
    expect(() => h.runner.getAction('a_ffffffffffffffff')).toThrow(ActionRefusedError)
  })

  it('a retried REVERT goes back to revert_pending', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const actionId = h.store.read().actions[0].id
    // Two failures: the automatic retry, then terminal.
    h.setSpawn(args => applied(String(args[1]), { status: 'failed', step: 'restore', error_code: 'archive_missing' }))
    const preview = await h.runner.revert(actionId, { dryRun: true }) as RevertPreview
    await h.runner.revert(actionId, { previewHash: preview.previewHash })
    h.setNow(START + PIPELINE_LOCK_RETRY_MS + 1)
    await h.runner.run('second')
    expect(h.store.read().actions[0].state).toBe('failed')
    expect(h.store.read().actions[0].direction).toBe('revert')
    h.setSpawn(args => applied(String(args[1]), { status: 'reverted' }))
    const result = await h.runner.retryAction(actionId)
    expect(result).toMatchObject({ state: 'revert_pending', direction: 'revert' })
  })
})

/** A failed child leaves evidence, not just a message. */
describe('failure diagnostics', () => {
  it('records the code, the signal, the timeout, the elapsed time and the stderr tail', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => attempt({
      code: null,
      signal: 'SIGKILL',
      timedOut: true,
      elapsedMs: 75_123,
      stderr: 'Traceback (most recent call last):\n  File "sync_meetings.py", line 1\n',
    }))
    await h.runner.run('test')
    const row = h.store.read().actions[0]
    expect(row.diagnostics).toMatchObject({ code: null, signal: 'SIGKILL', timedOut: true, elapsedMs: 75_123 })
    expect(row.diagnostics!.stderr).toContain('Traceback')
  })

  it('keeps the pipeline’s own decision-invalid line from exit 4', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => attempt({
      code: PIPELINE_EXIT_DECISION_INVALID,
      stderr: 'COS_MERGE_DECISION_INVALID=g2_sidecar_sha_mismatch\n',
      elapsedMs: 120,
    }))
    await h.runner.run('test')
    const row = h.store.read().actions[0]
    expect(row.state).toBe('failed')
    expect(row.diagnostics!.decisionInvalid).toBe('COS_MERGE_DECISION_INVALID=g2_sidecar_sha_mismatch')
  })

  it('records a spawn that never ran at all', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => { throw new Error('ENOENT python3') })
    await h.runner.run('test')
    expect(h.store.read().actions[0].diagnostics).toMatchObject({ spawnError: 'ENOENT python3', code: null })
  })
})

describe('revert-all', () => {
  it('previews every applied action and refuses without the hash', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    const preview = await h.runner.revertAll({ dryRun: true })
    expect(preview.actions).toHaveLength(1)
    await expect(h.runner.revertAll({})).rejects.toMatchObject({ code: 'preview_required' })
    const done = await h.runner.revertAll({ previewHash: preview.previewHash })
    expect(done.reverted).toEqual(preview.actions)
    expect(h.library.list()).toEqual([])
  })

  it('leaves the pipeline own merges alone', async () => {
    const h = harness({
      inputs: { ...emptyInputs(), g2Meta: { s9: { blendedInto: 'parent.md' } } },
      mode: 'advise',
    })
    await h.runner.run('adopt')
    expect((await h.runner.revertAll({ dryRun: true })).actions).toEqual([])
  })
})

describe('suggestions', () => {
  async function suggested() {
    // K of 15 is over the suggest floor of 10 and under the auto floor of 30.
    const pair = matchingPair({ k: 15, startMs: START })
    const inputs: EngineInputs = {
      g2: [{ ...pair.capture, finalizedAtMs: START + 1_800_000 }],
      fireflies: [pair.meeting],
      g2Meta: { s1: { sha256: 'a'.repeat(64), finalizedAtMs: START + 1_800_000 } },
      firefliesMeta: { f1: {} },
    }
    const h = harness({ inputs, now: START - 1 })
    await h.runner.run('test')
    return { h, id: h.store.read().suggestions[0].id }
  }

  it('offers a low-confidence pair rather than merging it', async () => {
    const { h, id } = await suggested()
    expect(h.store.read().suggestions[0]).toMatchObject({ kind: 'merge', state: 'open' })
    expect(h.store.read().actions).toEqual([])
    expect(id).toMatch(/^s_[0-9a-f]{16}$/)
  })

  it('accepting makes the merge and marks it accepted', async () => {
    const { h, id } = await suggested()
    const result = await h.runner.acceptSuggestion(id)
    expect(result.ok).toBe(true)
    expect(h.store.read().suggestions[0].state).toBe('accepted')
    expect(h.store.read().actions[0]).toMatchObject({ tier: 'accepted_suggestion', state: 'applied' })
  })

  it('refuses to accept what was shown against different files', async () => {
    const { h, id } = await suggested()
    const stored = h.store.read().suggestions[0]
    await h.store.update(store => {
      store.suggestions.find(row => row.id === stored.id)!.fingerprints = 'something-else'
    })
    await expect(h.runner.acceptSuggestion(id)).rejects.toMatchObject({ code: 'suggestion_stale' })
    expect(h.store.read().actions).toEqual([])
  })

  it('accepting twice is not two merges', async () => {
    const { h, id } = await suggested()
    await h.runner.acceptSuggestion(id)
    await h.runner.acceptSuggestion(id)
    expect(h.store.read().actions).toHaveLength(1)
  })

  it('a dismissed set never comes back', async () => {
    const { h, id } = await suggested()
    await h.runner.dismissSuggestion(id)
    expect(h.store.read().suggestions[0].state).toBe('dismissed')
    expect(h.store.read().tombstones.length).toBeGreaterThan(0)
    await h.runner.run('again')
    expect(h.store.read().suggestions).toHaveLength(1)
    expect(h.store.read().suggestions[0].state).toBe('dismissed')
  })

  it('refuses to accept a dismissed one', async () => {
    const { h, id } = await suggested()
    await h.runner.dismissSuggestion(id)
    await expect(h.runner.acceptSuggestion(id)).rejects.toMatchObject({ code: 'suggestion_dismissed' })
  })

  it('refuses an id that is not there', async () => {
    const h = harness()
    await expect(h.runner.acceptSuggestion('s_ffffffffffffffff')).rejects.toMatchObject({ code: 'suggestion_not_found' })
    await expect(h.runner.confirmSuggestion('s_ffffffffffffffff')).rejects.toMatchObject({ code: 'suggestion_not_found' })
    await expect(h.runner.dismissSuggestion('s_ffffffffffffffff')).rejects.toMatchObject({ code: 'suggestion_not_found' })
  })

  it('lists by state', async () => {
    const { h, id } = await suggested()
    expect(h.runner.listSuggestions('open')).toHaveLength(1)
    await h.runner.dismissSuggestion(id)
    expect(h.runner.listSuggestions('open')).toHaveLength(0)
    expect(h.runner.listSuggestions('dismissed')).toHaveLength(1)
    expect(h.runner.listSuggestions()).toHaveLength(1)
  })
})

/**
 * QA round 2, blocker 1: an accepted merge carries the evidence behind it.
 *
 * The accept path passed no `group`, so the derived sidecar said K1 = K2 = 0 and alignment had
 * no pairing offset, falling back to the difference between the two clocks. This reads the
 * DERIVE REQUEST itself, so it fails on the old path however the renderer behaves.
 */
describe('an accepted merge carries its evidence', () => {
  it('passes the stored K1 and K2 and the re-scored offset to the derive request', async () => {
    // 15 shared phrases is a suggestion, not an automatic merge. The capture's WORDS sit 42 s
    // off the transcript while both clocks say the same start, so the clock fallback is 0 and
    // only pairing can supply the real offset.
    const phrases = [phrase('acceptw', 15, 60)]
    const meeting = firefliesMeeting({ id: 'f1', startMs: START, durationS: 1800, phrases, title: 'Synthetic meeting' })
    const capture = {
      ...g2Capture({ sessionId: 's1', startMs: START, durationMs: 1_800_000, phrases, offsetMs: 42_000, labels: [{ speaker: 'Nadia Okonkwo', startS: 0, similarity: 0.9 }] }),
      finalizedAtMs: START + 1_800_000,
    }
    const inputs: EngineInputs = {
      g2: [capture],
      fireflies: [meeting],
      g2Meta: { s1: { sha256: 'a'.repeat(64), finalizedAtMs: START + 1_800_000 } },
      firefliesMeta: { f1: {} },
    }
    const dir = mkdtempSync(join(tmpdir(), 'cos-accept-evidence-'))
    roots.push(dir)
    const root = join(dir, 'imports')
    const store = new MeetingActionsStore({ root })
    const requests: EngineRequest[] = []
    const runner = new MeetingMergeRunner({
      store,
      library: new ImportedMeetingLibrary({ root }),
      mode: () => 'imports',
      isPipelineMac: () => false,
      collectInputs: () => inputs,
      runEngine: async request => {
        requests.push(request)
        return runEngine(request)
      },
      acquireLease: () => ({ id: 'l', setPhase: () => undefined, release: () => undefined }),
      admissionsOpen: () => true,
      captureActive: () => false,
      spawnPipeline: null,
      now: () => START - 1,
      log: () => undefined,
    })

    await runner.run('score')
    const suggestion = store.read().suggestions[0]
    expect(suggestion).toMatchObject({ kind: 'merge', state: 'open' })
    expect(suggestion.evidence.K1).toBeGreaterThan(0)

    requests.length = 0
    expect((await runner.acceptSuggestion(suggestion.id)).ok).toBe(true)
    const derive = requests.find(request => request.kind === 'derive_merge')
    if (!derive || derive.kind !== 'derive_merge') throw new Error('expected a derive_merge request')
    // The evidence the person was shown, not zeros.
    expect(derive.input.evidence).toEqual({ k1: suggestion.evidence.K1, k2: suggestion.evidence.K2 })
    // The offset pairing measured, not the clock fallback of 0. Pairing reports offsets in
    // `EVIDENCE_BIN_MS` bins (10 s), so a 42 s shift reads back within one bin of 42 000, which
    // is also at least 32 000 away from the 0 the clock fallback would have used.
    const offset = derive.input.coarseOffsetMsBySession?.s1
    expect(typeof offset).toBe('number')
    expect(Math.abs(Math.abs(offset as number) - 42_000)).toBeLessThanOrEqual(EVIDENCE_BIN_MS)
    // And written where a person reads why the merge happened.
    const sidecarPath = store.read().actions[0].outputs[0].sidecarPath!
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as { evidence: unknown }
    expect(sidecar.evidence).toEqual({ K1: suggestion.evidence.K1, K2: suggestion.evidence.K2 })
  })
})

describe('advise answers survive the switch to apply', () => {
  it('a confirmed would-merge becomes an accepted action once the mode is apply', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'advise' })
    await h.runner.run('advise')
    const id = h.store.read().suggestions[0].id
    await h.runner.confirmSuggestion(id)

    h.setMode('apply')
    await h.runner.run('apply')
    const action = h.store.read().actions.find(row => row.tier === 'accepted_suggestion')
    expect(action).toBeTruthy()
    expect(h.store.read().suggestions[0].state).toBe('accepted')
  })

  it('a dismissed one stays dismissed', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'advise' })
    await h.runner.run('advise')
    await h.runner.dismissSuggestion(h.store.read().suggestions[0].id)
    h.setMode('apply')
    await h.runner.run('apply')
    expect(h.store.read().actions.filter(row => row.tier !== 'legacy_applied')).toEqual([])
  })
})

describe('legacy adoption', () => {
  it('records a capture the pipeline already blended, once, and never merges it', async () => {
    const inputs = pairedInputs()
    inputs.g2Meta.s1.blendedInto = 'personal/meetings/2026-08/parent.md'
    const h = harness({ inputs, mode: 'advise' })
    const first = await h.runner.run('one')
    expect(first.alreadyMerged).toBe(1)
    const legacy = h.store.read().actions.filter(row => row.tier === 'legacy_applied')
    expect(legacy).toHaveLength(1)
    expect(legacy[0].legacyParentPath).toBe('personal/meetings/2026-08/parent.md')

    await h.runner.run('two')
    expect(h.store.read().actions.filter(row => row.tier === 'legacy_applied')).toHaveLength(1)
    expect(h.store.read().suggestions).toEqual([])
  })

  it('reads claimed_parent as well as blended_into', async () => {
    const inputs = pairedInputs()
    inputs.g2Meta.s1.claimedParent = 'personal/meetings/2026-08/parent.md'
    const h = harness({ inputs, mode: 'advise' })
    expect((await h.runner.run('one')).alreadyMerged).toBe(1)
  })

  it('adopts a Fireflies scribe blended by the old path', async () => {
    const inputs = pairedInputs()
    inputs.firefliesMeta.f1.blendedMarker = true
    const h = harness({ inputs, mode: 'advise' })
    expect((await h.runner.run('one')).alreadyMerged).toBe(1)
    expect(h.store.read().actions[0].tier).toBe('legacy_applied')
  })

  it('does NOT adopt a scribe this engine merged itself', async () => {
    // A scribe carrying both markers is one of ours. Adopting it would make its own action
    // untouchable and its merge unrevertible.
    const inputs = pairedInputs()
    inputs.firefliesMeta.f1.blendedMarker = true
    inputs.firefliesMeta.f1.mergeActionId = 'a_0123456789abcdef'
    const h = harness({ inputs, mode: 'advise' })
    const outcome = await h.runner.run('one')
    expect(outcome.alreadyMerged).toBe(0)
    expect(h.store.read().actions.filter(row => row.tier === 'legacy_applied')).toEqual([])
  })
})

describe('re-derive after a speaker correction', () => {
  it('rewrites the records that hold the session, and takes no new action', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    const before = h.store.read().actions.length
    await h.runner.rederive('s1')
    expect(h.store.read().actions).toHaveLength(before)
  })

  it('does nothing for a session no record holds', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    expect(await h.runner.rederive('s-unknown')).toEqual({ rewritten: 0 })
  })
})

describe('the mode switch', () => {
  it('refuses on a Mac with no pipeline', async () => {
    const h = harness({ mode: 'imports' })
    await expect(Promise.resolve().then(() => h.runner.setMode('apply')))
      .rejects.toMatchObject({ code: 'not_a_pipeline_mac' })
  })

  it('refuses a value it does not know', async () => {
    const h = harness({ mode: 'advise' })
    await expect(Promise.resolve().then(() => h.runner.setMode('yolo' as 'apply')))
      .rejects.toMatchObject({ code: 'invalid_mode' })
  })

  it('refuses while an apply is still in flight', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    await h.runner.run('test')
    expect(h.store.read().actions[0].state).toBe('pending')
    await expect(Promise.resolve().then(() => h.runner.setMode('advise')))
      .rejects.toMatchObject({ code: 'apply_in_flight' })
  })
})

describe('status', () => {
  it('reports counts, the last run and the first-run report', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    const status = await h.runner.status()
    expect(status.mode).toBe('imports')
    expect(status.counts.auto).toBe(1)
    expect(status.firstRun).toMatchObject({ mode: 'imports', auto: 1 })
    expect(status.lastRun).toMatchObject({ trigger: 'test' })
    expect(status.engineInstalledAt).toBeTruthy()
  })

  it('writes the first-run report once', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('one')
    const first = h.store.read().status.firstRun
    await h.runner.run('two')
    expect(h.store.read().status.firstRun).toEqual(first)
  })

  it('does not claim a first run from a pass that was deferred', async () => {
    const h = harness({ inputs: pairedInputs() })
    h.setCapture(true)
    await h.runner.run('deferred')
    expect(h.store.read().status.firstRun).toBeUndefined()
  })

  it('counts every applied action in counts.applied, any tier but legacy, never a suggestion', async () => {
    // QA round 2, blocker 5. Control's Undo-all count added OPEN suggestions to applied
    // actions, so a Mac with suggestions and nothing merged offered an Undo of zero merges.
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    const at = new Date(START).toISOString()
    await h.store.update(store => {
      store.actions.push(
        { id: 'a_00000000000000a1', kind: 'merge', tier: 'accepted_suggestion', inputs: { sessionIds: ['sx'], firefliesIds: ['fx'] }, fingerprints: '', outputs: [], outputSha256: [], state: 'applied', mode: 'imports', at },
        { id: 'a_00000000000000a2', kind: 'merge', tier: 'legacy_applied', inputs: { sessionIds: ['sy'], firefliesIds: [] }, fingerprints: '', outputs: [], outputSha256: [], state: 'applied', mode: 'apply', at },
        { id: 'a_00000000000000a3', kind: 'merge', tier: 'auto', inputs: { sessionIds: ['sz'], firefliesIds: ['fz'] }, fingerprints: '', outputs: [], outputSha256: [], state: 'reverted', mode: 'imports', at },
      )
      store.suggestions.push({ id: 's_00000000000000b1', kind: 'merge', inputs: { sessionIds: ['sq'], firefliesIds: ['fq'] }, fingerprints: '', evidence: { K1: 12, K2: 0 }, state: 'open', at })
    })
    const status = await h.runner.status()
    // The run's automatic merge plus the accepted one. Not the legacy, the reverted or the suggestion.
    expect(status.counts.applied).toBe(2)
    expect(status.counts.auto).toBe(1)
    expect(status.counts.suggested).toBe(1)
    // Exactly the set revert-all would undo.
    expect((await h.runner.revertAll({ dryRun: true })).actions).toHaveLength(status.counts.applied)
  })

  it('reports merges remaining applied when the pipeline counts some', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'advise' })
    h.setSpawn(() => attempt({ code: 0, stdout: '{"mode":"advise","active":true,"applied_actions":2}\n' }))
    const status = await h.runner.status()
    expect(status.mergesRemainApplied).toBe(true)
    expect(status.mismatch).toBe(false)
  })

  it('does NOT read advise, active and zero applied as the benign rollback state', async () => {
    // QA round 2, blocker 4. An actions file the pipeline cannot read prints exactly this. It
    // must surface as a disagreement rather than the reassuring rollback sentence.
    const h = harness({ inputs: pairedInputs(), mode: 'advise' })
    h.setSpawn(() => attempt({ code: 0, stdout: '{"mode":"advise","active":true,"applied_actions":0}\n' }))
    const status = await h.runner.status()
    expect(status.mergesRemainApplied).toBe(false)
    expect(status.mismatch).toBe(true)
  })

  it('reports null and no mismatch when the pipeline cannot be asked', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => attempt({ code: 1 }))
    const status = await h.runner.status()
    // "Not known" is not "disagrees". Reporting a mismatch from a failed probe would send a
    // person looking for a problem that may not exist.
    expect(status.pipelineSees).toBeNull()
    expect(status.mismatch).toBe(false)
  })

  it('reports a mismatch when the server says apply and the pipeline does not', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => attempt({ code: 0, stdout: '{"mode":"advise","active":false,"applied_actions":0}\n' }))
    const status = await h.runner.status()
    expect(status.pipelineSees).toEqual({ mode: 'advise', active: false, appliedActions: 0 })
    expect(status.mismatch).toBe(true)
  })

  it('agrees when both say apply', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => attempt({ code: 0, stdout: '{"mode":"apply","active":true,"applied_actions":3}\n' }))
    expect((await h.runner.status()).mismatch).toBe(false)
  })

  it('asks the pipeline at most once every five minutes', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply', now: 1_000_000 })
    h.setSpawn(() => attempt({ code: 0, stdout: '{"mode":"apply","active":true,"applied_actions":0}\n' }))
    await h.runner.status()
    await h.runner.status()
    expect(h.spawns.filter(row => row.args[0] === '--merge-engine-status')).toHaveLength(1)
    h.setNow(1_000_000 + 5 * 60_000 + 1)
    await h.runner.status()
    expect(h.spawns.filter(row => row.args[0] === '--merge-engine-status')).toHaveLength(2)
  })
})

describe('the tick', () => {
  it('drives a due pending action', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply', now: 1_000_000 })
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    await h.runner.run('test')
    h.setNow(1_000_000 + PIPELINE_LOCK_RETRY_MS + 1)
    expect(h.runner.tick()).toMatchObject({ fired: true, reason: 'pending_retry' })
  })

  it('does not drive one that is not due yet', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply', now: 1_000_000 })
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    await h.runner.run('test')
    await h.runner.idle()
    expect(h.runner.tick()).toMatchObject({ fired: false })
  })

  it('refuses while admissions are closed', () => {
    const h = harness()
    h.setAdmissions(false)
    expect(h.runner.tick()).toEqual({ fired: false, reason: 'admissions_closed' })
  })

  it('fires a full pass at most every six hours', async () => {
    // A fresh process has never run a pass, so the first tick fires.
    const h = harness({ now: START })
    expect(h.runner.tick()).toMatchObject({ fired: true, reason: 'due' })
    await h.runner.idle()
    expect(h.runner.tick()).toMatchObject({ fired: false, reason: 'not_due' })
    h.setNow(START + 6 * 60 * 60_000 - 1)
    expect(h.runner.tick()).toMatchObject({ fired: false, reason: 'not_due' })
    h.setNow(START + 6 * 60 * 60_000 + 1)
    expect(h.runner.tick()).toMatchObject({ fired: true, reason: 'due' })
    await h.runner.idle()
  })
})

describe('the queue', () => {
  it('runs one pass at a time however many triggers fire', async () => {
    const h = harness({ inputs: pairedInputs() })
    await Promise.all([h.runner.run('a'), h.runner.run('b'), h.runner.run('c')])
    // Three triggers, one merge. Two passes racing would each score the same backlog, each
    // spend the whole cap, and each decide from a store snapshot the other is changing.
    expect(h.concurrency.max).toBe(1)
    expect(h.store.read().actions).toHaveLength(1)
    expect(h.library.list().filter(row => row.derivedKind === 'merge')).toHaveLength(1)
  })

  it('serializes a mutation behind a run', async () => {
    const h = harness({ inputs: pairedInputs() })
    const running = h.runner.run('slow')
    const mutation = h.runner.dismissSuggestion('s_ffffffffffffffff').catch(() => 'refused')
    await Promise.all([running, mutation])
    expect(h.concurrency.max).toBe(1)
  })

  it('never throws at a trigger', async () => {
    const h = harness()
    expect(() => h.runner.trigger('whatever')).not.toThrow()
    await h.runner.idle()
  })
})

describe('reading sentences from either sidecar shape', () => {
  it('reads the vendor raw snake_case shape', () => {
    expect(toEngineSentences([{ text: 'a', speaker_name: 'Nadia', start_time: 1, end_time: 2 }]))
      .toEqual([{ text: 'a', speaker_name: 'Nadia', start_time: 1, end_time: 2 }])
  })

  it('reads the importer camelCase shape', () => {
    // `.import.json` stores the client's normalization; `.fireflies.json` stores the
    // vendor's raw rows. One engine has to score both modes.
    expect(toEngineSentences([{ text: 'a', speakerName: 'Nadia', startTime: 1, endTime: 2 }]))
      .toEqual([{ text: 'a', speaker_name: 'Nadia', start_time: 1, end_time: 2 }])
  })

  it('survives rows that are not objects at all', () => {
    expect(toEngineSentences([null, 3, 'x'])).toEqual([
      { text: '', speaker_name: '', start_time: 0, end_time: 0 },
      { text: '', speaker_name: '', start_time: 0, end_time: 0 },
      { text: '', speaker_name: '', start_time: 0, end_time: 0 },
    ])
    expect(toEngineSentences(null)).toEqual([])
  })
})

/**
 * Splits, end to end.
 *
 * WHAT WAS WRONG. Every split was a suggestion, nothing called `derive_piece`, and accepting
 * one answered 200 with `ok: false` — while the changelog, the contract and Control's copy
 * all said long recordings are split automatically with a Revert. The pieces are real now in
 * imports mode; in apply mode the refusal is typed and the copy says so.
 */
function longRecordingInputs(options: { now?: number } = {}): { inputs: EngineInputs; sourceId: string } {
  const longMeeting = firefliesMeeting({
    id: 'f-long',
    startMs: START,
    durationS: 10_800,
    phrases: [phrase('alphaw', 60, 60), phrase('betaw', 60, 4_000), phrase('gammaw', 60, 8_000)],
    title: 'Long recording',
  })
  const captures = ['alphaw', 'betaw', 'gammaw'].map((prefix, index) => g2Capture({
    sessionId: `s-${prefix}`,
    startMs: START + [60, 4_000, 8_000][index] * 1000,
    durationMs: 600_000,
    phrases: [longMeeting.sentences[index]].map((sentence, i) => ({
      tokens: String(sentence.text).split(' '),
      startS: [60, 4_000, 8_000][index] + i,
      endS: [60, 4_000, 8_000][index] + 12,
    })),
    offsetMs: 0,
  }))
  void options
  return {
    sourceId: 'f-long',
    inputs: {
      g2: captures.map(capture => ({ ...capture, finalizedAtMs: capture.startMs + 600_000 })),
      fireflies: [longMeeting],
      g2Meta: Object.fromEntries(captures.map(capture => [capture.sessionId, { finalizedAtMs: capture.startMs + 600_000 }])),
      firefliesMeta: { 'f-long': {} },
    },
  }
}

describe('splits', () => {
  it('writes one record per piece in imports mode, and the action names them all', async () => {
    const { inputs } = longRecordingInputs()
    const h = harness({ inputs, now: START - 1 })
    const outcome = await h.runner.run('test')
    expect(outcome.auto).toBe(1)
    const action = h.store.read().actions.find(row => row.kind === 'split')
    expect(action).toBeTruthy()
    expect(action!.state).toBe('applied')
    expect(action!.outputs.length).toBeGreaterThan(1)
    for (const output of action!.outputs) {
      expect(existsSync(output.path)).toBe(true)
      expect(output.recordId).toMatch(/^blended:[0-9a-f]{16}$/)
    }
    // Each piece is its OWN record, not a copy of the whole recording.
    const recordIds = new Set(action!.outputs.map(output => output.recordId))
    expect(recordIds.size).toBe(action!.outputs.length)
  })

  it('reverts a split by deleting every piece it wrote', async () => {
    const { inputs } = longRecordingInputs()
    const h = harness({ inputs, now: START - 1 })
    await h.runner.run('test')
    const action = h.store.read().actions.find(row => row.kind === 'split')!
    const preview = await h.runner.revert(action.id, { dryRun: true }) as RevertPreview
    await h.runner.revert(action.id, { previewHash: preview.previewHash })
    expect(h.store.read().actions.find(row => row.id === action.id)!.state).toBe('reverted')
    for (const output of action.outputs) expect(existsSync(output.path)).toBe(false)
  })

  it('leaves the long recording as a suggestion in advise mode', async () => {
    const { inputs } = longRecordingInputs()
    const h = harness({ inputs, mode: 'advise', now: START - 1 })
    await h.runner.run('test')
    const split = h.store.read().suggestions.find(row => row.kind === 'split')
    expect(split).toBeTruthy()
    expect(split!.id).toBe(suggestionIdFor('split', { sessionIds: [], firefliesIds: ['f-long'] }))
    expect(split!.evidence.spans!.length).toBeGreaterThan(1)
    expect(h.store.read().actions.filter(row => row.kind === 'split')).toEqual([])
    expect(h.library.list()).toEqual([])
  })

  it('offers rather than takes a recording that finished before the engine arrived (D14)', async () => {
    const { inputs } = longRecordingInputs()
    // `now` is AFTER the whole recording, so its finish is before the boundary this run
    // stamps, which is the backlog case nobody has measured.
    const h = harness({ inputs, now: START + 20_000_000 })
    const outcome = await h.runner.run('test')
    expect(outcome.auto).toBe(0)
    expect(h.store.read().suggestions.find(row => row.kind === 'split')).toBeTruthy()
    expect(h.store.read().actions.filter(row => row.kind === 'split')).toEqual([])
  })

  it('accepts a split suggestion in imports mode and writes the pieces', async () => {
    const { inputs } = longRecordingInputs()
    const h = harness({ inputs, now: START + 20_000_000 })
    await h.runner.run('test')
    const suggestion = h.store.read().suggestions.find(row => row.kind === 'split')!
    const result = await h.runner.acceptSuggestion(suggestion.id)
    expect(result.ok).toBe(true)
    const action = h.store.read().actions.find(row => row.id === result.actionId)!
    expect(action.kind).toBe('split')
    expect(action.tier).toBe('accepted_suggestion')
    expect(action.outputs.length).toBeGreaterThan(1)
    expect(h.store.read().suggestions.find(row => row.id === suggestion.id)!.state).toBe('accepted')
  })

  it('refuses to accept a split in advise mode, and saves the answer instead', async () => {
    const { inputs } = longRecordingInputs()
    const h = harness({ inputs, mode: 'advise', now: START - 1 })
    await h.runner.run('test')
    const suggestion = h.store.read().suggestions.find(row => row.kind === 'split')!
    await expect(h.runner.acceptSuggestion(suggestion.id)).rejects.toMatchObject({ code: 'advise_mode' })
    await h.runner.confirmSuggestion(suggestion.id)
    expect(h.store.read().suggestions.find(row => row.id === suggestion.id)!.state).toBe('confirmed')
  })

  it('refuses a split accept in apply mode with a typed code, and spawns nothing', async () => {
    // A split writes NEW records. Apply mode splices a patch into a scribe that already
    // exists, and there is no additive, revertible way to turn one scribe into three.
    const { inputs } = longRecordingInputs()
    const h = harness({ inputs, mode: 'advise', now: START - 1 })
    await h.runner.run('test')
    const suggestion = h.store.read().suggestions.find(row => row.kind === 'split')!
    h.setMode('apply')
    await expect(h.runner.acceptSuggestion(suggestion.id))
      .rejects.toMatchObject({ code: 'split_not_supported_in_apply_mode', status: 409 })
    expect(h.spawns).toEqual([])
    expect(h.store.read().actions.filter(row => row.kind === 'split')).toEqual([])
  })

  it('never takes a split automatically in apply mode', async () => {
    const { inputs } = longRecordingInputs()
    const h = harness({ inputs, mode: 'apply', now: START - 1 })
    await h.runner.run('test')
    expect(h.store.read().actions.filter(row => row.kind === 'split')).toEqual([])
    expect(h.store.read().suggestions.find(row => row.kind === 'split')).toBeTruthy()
  })
})

/**
 * `pipelineSees` and `mismatch`: the one failure a person cannot see for themselves.
 *
 * WHAT WAS WRONG. Advise mode plus an ACTIVE pipeline was reported as a disagreement. It is
 * not: `merge_engine_active()` stays true while any applied action exists, precisely so the
 * old blend path does not restart over merged scribes after the mode is rolled back. That is
 * the documented rollback state, and calling it a mismatch told a person their two halves
 * disagreed when they agreed.
 */
describe('what the pipeline sees', () => {
  function statusHarness(pipeline: { mode: string; active: boolean; appliedActions?: number } | null): Harness {
    const h = harness({ inputs: pairedInputs(), mode: 'advise' })
    h.setSpawn(() => attempt({
      code: 0,
      stdout: pipeline
        ? `${JSON.stringify({ mode: pipeline.mode, active: pipeline.active, applied_actions: pipeline.appliedActions ?? 0 })}\n`
        : 'not json\n',
    }))
    return h
  }

  it('reports advise plus an active pipeline as mergesRemainApplied, not a mismatch', async () => {
    const h = statusHarness({ mode: 'advise', active: true, appliedActions: 3 })
    const status = await h.runner.status()
    expect(status.mergesRemainApplied).toBe(true)
    expect(status.mismatch).toBe(false)
  })

  it('reports a real disagreement when the server says apply and the pipeline does not', async () => {
    const h = statusHarness({ mode: 'advise', active: false })
    h.setMode('apply')
    const status = await h.runner.status()
    expect(status.mismatch).toBe(true)
    expect(status.mergesRemainApplied).toBe(false)
  })

  it('agrees when both say apply', async () => {
    const h = statusHarness({ mode: 'apply', active: true })
    h.setMode('apply')
    const status = await h.runner.status()
    expect(status.mismatch).toBe(false)
    expect(status.mergesRemainApplied).toBe(false)
  })

  it('agrees when the server says apply and the pipeline is ACTIVE without its file saying so', async () => {
    // `merge_engine_active()` is true whenever an applied action exists, whatever the mode
    // file says — that is how the old blend path stays off. A pipeline that is honouring
    // merges is not disagreeing with a server that is making them.
    const h = statusHarness({ mode: 'advise', active: true, appliedActions: 2 })
    h.setMode('apply')
    const status = await h.runner.status()
    expect(status.mismatch).toBe(false)
    expect(status.mergesRemainApplied).toBe(false)
  })

  it('says not known rather than disagrees when the pipeline cannot be asked', async () => {
    const h = statusHarness(null)
    const status = await h.runner.status()
    expect(status.pipelineSees).toBeNull()
    expect(status.mismatch).toBe(false)
    expect(status.mergesRemainApplied).toBe(false)
  })

  it('carries WHY a run did nothing into the status a person reads', async () => {
    // A skipped run used to report nothing at all, so a pass that deferred every time
    // looked identical to one that had nothing to do.
    const h = statusHarness(null)
    h.setCapture(true)
    await h.runner.run('during-capture')
    const status = await h.runner.status()
    expect(status.lastRun?.skippedReason).toBe('capture_active')
    h.setCapture(false)
    h.setAdmissions(false)
    await h.runner.run('during-drain')
    expect((await h.runner.status()).lastRun?.skippedReason).toBe('maintenance_deferred')
  })

  it('carries the inputs it refused, by reason, into the run summary', async () => {
    const inputs = pairedInputs()
    const h = harness({ inputs: { ...inputs, skipped: { fireflies_sidecar_clipped: 2 } }, mode: 'advise' })
    await h.runner.run('test')
    expect((await h.runner.status()).lastRun?.inputsSkipped).toEqual({ fireflies_sidecar_clipped: 2 })
  })

  it('carries what the clock band did this run', async () => {
    // The band was chosen from one Mac's 198 scored recordings and nothing made its effect
    // observable anywhere else.
    const h = harness({ inputs: pairedInputs(), mode: 'advise' })
    await h.runner.run('test')
    const band = (await h.runner.status()).lastRun?.clockBand
    expect(band).toBeDefined()
    expect(band).toMatchObject({ candidates: expect.any(Number), anchorsDropped: expect.any(Number), candidatesZeroed: expect.any(Number) })
    // A pair whose clocks agree exactly has a zero winner skew, and that is a measurement.
    expect(band!.maxWinnerSkewS).toBe(0)
    expect(band!.medianWinnerSkewS).toBe(0)
  })

  it('asks with the INHERITED environment, so the answer is not the server reading itself', async () => {
    // Injecting the server's own COS_DATA_DIR made the child resolve the SERVER's mode file.
    // `defaultPipelineSpawn` is the production path; this pins the argument it keys on.
    expect(PIPELINE_STATUS_ARG).toBe('--merge-engine-status')
    const h = statusHarness({ mode: 'advise', active: false })
    await h.runner.status()
    expect(h.spawns.map(row => row.args[0])).toEqual([PIPELINE_STATUS_ARG])
    expect(h.spawns[0].actionId).toBeUndefined()
  })
})

describe('the action log', () => {
  it('lists newest first and bounds the limit', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    expect(h.runner.listActions(1)).toHaveLength(1)
    expect(h.runner.listActions(0)).toHaveLength(1)
  })

  it('gives an action the id both surfaces derive from its inputs', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('test')
    expect(h.store.read().actions[0].id)
      .toBe(actionIdFor('merge', { sessionIds: ['s1'], firefliesIds: ['f1'] }))
  })
})

describe('gaps the mutation gate found', () => {
  it('does not re-decide an action that is still pending in the pipeline', async () => {
    // The applied-and-unchanged check further down cannot see this: a `pending` action has
    // no outputs and no settled fingerprints, so without the state guard a second run
    // writes a second decision for a merge that is already being applied.
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    await h.runner.run('one')
    expect(h.store.read().actions[0].state).toBe('pending')
    const spawnsBefore = h.spawns.length
    await h.runner.run('two')
    expect(h.store.read().actions).toHaveLength(1)
    expect(h.spawns.length).toBe(spawnsBefore)
  })

  it('never auto-merges a pair whose suggestion was dismissed, even at the auto tier', async () => {
    // The dismissal arrives while the pair is only a suggestion; the same pair can reach
    // the auto tier later when a fuller transcript lands. Without the dismissed check in
    // the auto path, "not the same meeting" is overruled by the engine changing its mind.
    const h = harness({ inputs: pairedInputs() })
    await h.store.update(store => {
      store.suggestions.push({
        id: suggestionIdFor('merge', { sessionIds: ['s1'], firefliesIds: ['f1'] }),
        kind: 'merge',
        inputs: { sessionIds: ['s1'], firefliesIds: ['f1'] },
        fingerprints: 'old',
        evidence: { K1: 12, K2: 0 },
        state: 'dismissed',
        at: 'then',
      })
    })
    const outcome = await h.runner.run('after-dismissal')
    expect(outcome.auto).toBe(0)
    expect(h.store.read().actions).toEqual([])
  })

  it('does not count a decided suggestion as newly suggested', async () => {
    const h = harness({ inputs: pairedInputs({ k: 15 }), now: START - 1 })
    await h.runner.run('one')
    const id = h.store.read().suggestions[0].id
    await h.runner.dismissSuggestion(id)
    const second = await h.runner.run('two')
    // A dismissed row that is re-offered every six hours is a refusal that never sticks.
    expect(second.suggested).toBe(0)
    expect(second.suggestions).toEqual([])
  })

  it('does not re-offer a suggestion that was ACCEPTED', async () => {
    // The dismissed case is caught earlier by its tombstone, so it never reaches the
    // decided check. An accepted one has no tombstone: its pair DID belong together. The
    // engine keeps scoring the same inputs, so without the decided check the merge a
    // person already made goes back on the "waiting for you" list every six hours.
    const h = harness({ inputs: pairedInputs({ k: 15 }), now: START - 1 })
    await h.runner.run('one')
    const id = h.store.read().suggestions[0].id
    await h.runner.acceptSuggestion(id)
    expect(h.store.read().suggestions[0].state).toBe('accepted')
    const second = await h.runner.run('two')
    expect(second.suggested).toBe(0)
    expect(second.suggestions).toEqual([])
    expect(h.store.read().suggestions[0].state).toBe('accepted')
  })

  it('does not re-offer a would-merge item that was CONFIRMED in advise mode', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'advise' })
    await h.runner.run('one')
    const id = h.store.read().suggestions[0].id
    await h.runner.confirmSuggestion(id)
    const second = await h.runner.run('two')
    expect(second.wouldMerge).toBe(0)
    expect(h.store.read().suggestions[0].state).toBe('confirmed')
  })

  it('refuses a second revert while the first is still with the pipeline', async () => {
    const h = harness({ inputs: pairedInputs(), mode: 'apply' })
    await h.runner.run('test')
    const action = h.store.read().actions[0]
    h.setSpawn(() => attempt({ code: PIPELINE_EXIT_LOCK_BUSY }))
    const preview = await h.runner.revert(action.id, { dryRun: true }) as RevertPreview
    await h.runner.revert(action.id, { previewHash: preview.previewHash })
    expect(h.store.read().actions[0].state).toBe('revert_pending')
    await expect(h.runner.revert(action.id, { previewHash: preview.previewHash }))
      .rejects.toMatchObject({ status: 409, code: 'revert_in_progress' })
  })

  it('applies D14 in apply mode from the moment the mode was switched', async () => {
    // Not from install: a person has seen the advise report by the time they choose apply,
    // so what happens after THAT moment is what they opted into. Before it, the same
    // recordings are the unmeasured backlog and may only be suggested.
    const h = harness({ mode: 'apply', now: START })
    await h.store.update(store => {
      store.status.engineInstalledAt = START - 30 * 24 * 60 * 60_000
      store.status.applyModeSince = START + 3_600_000
    })
    const inputs = pairedInputs({ finalizedAtMs: START + 1_800_000 })
    const h2 = harness({ inputs, mode: 'apply', now: START })
    await h2.store.update(store => {
      store.status.engineInstalledAt = START - 30 * 24 * 60 * 60_000
      store.status.applyModeSince = START + 3_600_000
    })
    const outcome = await h2.runner.run('after-switch')
    expect(outcome.auto).toBe(0)
    expect(outcome.suggested).toBe(1)

    const h3 = harness({ inputs: pairedInputs({ finalizedAtMs: START + 7_200_000 }), mode: 'apply', now: START })
    await h3.store.update(store => {
      store.status.engineInstalledAt = START - 30 * 24 * 60 * 60_000
      store.status.applyModeSince = START + 3_600_000
    })
    expect((await h3.runner.run('after-switch')).auto).toBe(1)
  })

  it('writes the first-run report once, and does not overwrite it on a later run', async () => {
    const h = harness({ inputs: pairedInputs() })
    await h.runner.run('one')
    const first = h.store.read().status.firstRun!
    expect(first.auto).toBe(1)
    await h.runner.run('two')
    const after = h.store.read().status.firstRun!
    // The SECOND run does zero merges. A report that were overwritten would say so, and
    // Control would show "0 merged" for an install that merged.
    expect(after).toEqual(first)
    expect(after.auto).toBe(1)
  })

  it('reports no_pipeline rather than throwing on a Mac with no pipeline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-nopipe-'))
    roots.push(dir)
    const root = join(dir, 'imports')
    const store = new MeetingActionsStore({ root })
    const runner = new MeetingMergeRunner({
      store,
      library: new ImportedMeetingLibrary({ root }),
      mode: () => 'imports',
      isPipelineMac: () => false,
      collectInputs: () => emptyInputs(),
      runEngine: async request => runEngine(request),
      acquireLease: () => ({ id: 'l', setPhase: () => undefined, release: () => undefined }),
      admissionsOpen: () => true,
      captureActive: () => false,
      spawnPipeline: null,
      now: () => START,
      log: () => undefined,
    })
    await store.update(current => {
      current.actions.push({
        id: 'a_0123456789abcdef',
        kind: 'merge',
        tier: 'auto',
        inputs: { sessionIds: ['s1'], firefliesIds: ['f1'] },
        fingerprints: 'fp',
        outputs: [],
        outputSha256: [],
        state: 'pending',
        mode: 'apply',
        at: 'then',
      })
    })
    // An imports-mode install that somehow carries a pending apply-mode action must not
    // crash the boot re-drive; it reports and leaves the row alone.
    await expect(runner.drivePipelineAction('a_0123456789abcdef'))
      .resolves.toEqual({ ok: false, state: 'pending', reason: 'no_pipeline' })
    expect(store.read().actions[0].state).toBe('pending')
  })
})
