// Decision files: the one thing the pipeline reads, and the one file the server writes back.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DECISION_SCHEMA,
  DecisionError,
  MERGE_RESULT_PREFIX,
  PIPELINE_EXIT_DECISION_INVALID,
  PIPELINE_EXIT_LOCK_BUSY,
  PIPELINE_EXIT_PARTIAL_OR_FAILED,
  type MergeDecision,
  type MergePipelineResult,
  assertActionId,
  decisionPath,
  deleteDecision,
  isMergePipelineResult,
  listDecisionIds,
  readDecision,
  sha256OfFile,
  writeDecision,
  writeDecisionResult,
} from './meeting-decisions.js'

const ACTION = 'a_0123456789abcdef'
const roots: string[] = []

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-decisions-'))
  roots.push(dir)
  return join(dir, 'imports')
}

function decision(overrides: Partial<MergeDecision> = {}): MergeDecision {
  return {
    schema: DECISION_SCHEMA,
    actionId: ACTION,
    kind: 'merge',
    inputs: [
      { kind: 'g2', sessionId: 's1', sidecarRelPath: 'personal/meetings/2026-09/a.g2-chunks.json', sha256: 'a'.repeat(64) },
      { kind: 'fireflies', firefliesId: 'f1', scribeRelPath: 'personal/meetings/2026-09/b.md', sidecarRelPath: 'personal/meetings/2026-09/b.fireflies.json', sha256: 'b'.repeat(64) },
    ],
    patch: { sections: ['## G2 Capture\n'], rows: ['| **Sources** | Fireflies + G2 Glasses |'], markers: ['<!-- g2-transcript-blended -->'], speakerMap: {}, verification: [] },
    speakerMap: {},
    retire: ['personal/meetings/2026-09/a.md'],
    ...overrides,
  }
}

function result(overrides: Partial<MergePipelineResult> = {}): MergePipelineResult {
  return {
    schema: DECISION_SCHEMA,
    action_id: ACTION,
    status: 'applied',
    outputs: [{ path: 'personal/meetings/2026-09/b.md', sha256: 'c'.repeat(64) }],
    archived: [{ original: 'personal/meetings/2026-09/b.md', archive: 'x', sha256: 'b'.repeat(64) }],
    retired: [],
    stamps: [],
    transcript_map: 'applied',
    ...overrides,
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('the action id is a path component', () => {
  it('accepts the contract shape', () => {
    expect(assertActionId(ACTION)).toBe(ACTION)
  })

  it('refuses anything that could leave the decisions folder', () => {
    // The id becomes a filename. Without this, `--apply-merge-decision ../../x` is a write
    // anywhere the server can reach.
    for (const bad of ['../escape', 'a_..', 'a_0123456789ABCDEF', 's_0123456789abcdef', 'a_0123', '', 'a_0123456789abcdef/x']) {
      expect(() => assertActionId(bad)).toThrow(DecisionError)
    }
  })

  it('refuses the same shapes when building a path', () => {
    expect(() => decisionPath('../escape', root())).toThrow(DecisionError)
  })
})

describe('writing and reading one decision', () => {
  it('round trips, in a 0700 directory with a 0600 file', () => {
    const dir = root()
    const path = writeDecision(decision(), dir)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'decisions')).mode & 0o777).toBe(0o700)
    expect(readDecision(ACTION, dir)).toMatchObject({ actionId: ACTION, kind: 'merge' })
  })

  it('keeps the rendered patch here and nowhere else', () => {
    const dir = root()
    writeDecision(decision(), dir)
    const raw = readFileSync(decisionPath(ACTION, dir), 'utf8')
    expect(raw).toContain('## G2 Capture')
    expect(raw).toContain('<!-- g2-transcript-blended -->')
  })

  it('returns null for a decision that is not there', () => {
    expect(readDecision('a_ffffffffffffffff', root())).toBeNull()
  })

  it('refuses a decision whose schema it does not know', () => {
    // A decision from a future version could mean anything; guessing is how a merge
    // applies under rules this build does not implement.
    const dir = root()
    writeDecision({ ...decision(), schema: 99 } as MergeDecision, dir)
    expect(readDecision(ACTION, dir)).toBeNull()
  })

  it('refuses a decision whose id does not match its filename', () => {
    const dir = root()
    writeDecision(decision(), dir)
    writeFileSync(decisionPath(ACTION, dir), JSON.stringify({ ...decision(), actionId: 'a_ffffffffffffffff' }))
    expect(readDecision(ACTION, dir)).toBeNull()
  })

  it('returns null rather than throwing on unparseable bytes', () => {
    const dir = root()
    writeDecision(decision(), dir)
    writeFileSync(decisionPath(ACTION, dir), '{not json')
    expect(readDecision(ACTION, dir)).toBeNull()
  })
})

describe('writing the pipeline report back', () => {
  it('stores the result in the decision it was given', () => {
    const dir = root()
    writeDecision(decision(), dir)
    expect(writeDecisionResult(ACTION, result(), dir)).toBe(true)
    expect(readDecision(ACTION, dir)?.result).toMatchObject({ status: 'applied' })
  })

  it('keeps the patch and inputs when the result lands', () => {
    // Revert reads the archive paths from the result and the inputs from the decision.
    // A write-back that replaced the file would leave a revert with nothing to restore.
    const dir = root()
    writeDecision(decision(), dir)
    writeDecisionResult(ACTION, result(), dir)
    const stored = readDecision(ACTION, dir)!
    expect(stored.inputs).toHaveLength(2)
    expect(stored.retire).toEqual(['personal/meetings/2026-09/a.md'])
  })

  it('reports rather than creates when the decision is gone', () => {
    expect(writeDecisionResult(ACTION, result(), root())).toBe(false)
  })
})

describe('listing and deleting', () => {
  it('lists only ids of the contract shape', () => {
    const dir = root()
    writeDecision(decision(), dir)
    writeFileSync(join(dir, 'decisions', 'notes.txt'), 'x')
    writeFileSync(join(dir, 'decisions', 'a_nothex.json'), '{}')
    expect(listDecisionIds(dir)).toEqual([ACTION])
  })

  it('answers an absent folder with an empty list', () => {
    expect(listDecisionIds(root())).toEqual([])
  })

  it('deletes without complaining about a decision already gone', () => {
    const dir = root()
    writeDecision(decision(), dir)
    deleteDecision(ACTION, dir)
    deleteDecision(ACTION, dir)
    expect(readDecision(ACTION, dir)).toBeNull()
  })
})

describe('validating a pipeline report', () => {
  it('accepts the contract shape', () => {
    expect(isMergePipelineResult(result())).toBe(true)
    expect(isMergePipelineResult(result({ status: 'reverted' }))).toBe(true)
    expect(isMergePipelineResult(result({ status: 'partial', step: 'splice', error_code: 'x' }))).toBe(true)
  })

  it('accepts a report that grew an unknown field', () => {
    expect(isMergePipelineResult({ ...result(), future_field: 1 })).toBe(true)
  })

  it('refuses a report with no archive list', () => {
    // Without `archived` there is nothing to restore, so an apply that reported this way
    // would be an apply nobody could undo.
    const { archived, ...without } = result()
    expect(isMergePipelineResult(without)).toBe(false)
  })

  for (const [label, value] of [
    ['a wrong schema', result({ schema: 2 as number })],
    ['a status it does not know', result({ status: 'maybe' as MergePipelineResult['status'] })],
    ['an id of the wrong shape', result({ action_id: 'nope' })],
    ['a transcript_map it does not know', result({ transcript_map: 'partial' as MergePipelineResult['transcript_map'] })],
    ['a string', 'applied'],
    ['null', null],
    ['an array', []],
  ] as Array<[string, unknown]>) {
    it(`refuses ${label}`, () => {
      expect(isMergePipelineResult(value)).toBe(false)
    })
  }
})

describe('the protocol constants WS8b builds against', () => {
  it('are the ones the plan names', () => {
    expect(MERGE_RESULT_PREFIX).toBe('COS_MERGE_RESULT=')
    expect(PIPELINE_EXIT_LOCK_BUSY).toBe(3)
    expect(PIPELINE_EXIT_DECISION_INVALID).toBe(4)
    expect(PIPELINE_EXIT_PARTIAL_OR_FAILED).toBe(5)
    expect(DECISION_SCHEMA).toBe(1)
  })
})

describe('hashing a file', () => {
  it('hashes what is there and answers null for what is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-sha-'))
    roots.push(dir)
    const path = join(dir, 'x.md')
    writeFileSync(path, 'hello')
    expect(sha256OfFile(path)).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256OfFile(join(dir, 'missing.md'))).toBeNull()
  })
})
