// Step 2a: /api/models efforts are the job route's own values and each bridge's own mapping (S1_CONTRACT_step2a.md C).
import { describe, expect, it } from 'vitest'
import { EFFORT_OPTIONS, DEFAULT_EFFORT } from '../../shared/model-preference.js'
import { modelEfforts } from './model-efforts.js'

describe('modelEfforts', () => {
  it('offers exactly what POST /api/query-jobs accepts, says what each agent runs, and gives Cursor none', () => {
    const e = modelEfforts({})
    expect(e.default).toBe(DEFAULT_EFFORT)
    for (const agent of ['claude', 'codex', 'ollama'] as const) expect(e.byAgent[agent].map(c => c.value)).toEqual(EFFORT_OPTIONS)
    expect(e.byAgent.cursor).toEqual([])
    expect(e.byAgent.claude.map(c => c.runs)).toEqual(['high', 'xhigh', 'max', 'xhigh'])
    expect(e.byAgent.codex.map(c => c.runs)).toEqual(['high', 'xhigh', 'max', 'ultra'])
    expect(e.byAgent.ollama.map(c => c.runs)).toEqual(['off', 'high', 'max', 'max'])
    expect(e.byAgent.claude.map(c => c.label)).toEqual(['High', 'Extra High', 'Max', 'Ultracode'])
  })
  it('a pinned Ollama think setting is reported as what runs', () => {
    expect(modelEfforts({ COS_OLLAMA_THINK: '0' }).byAgent.ollama.every(c => c.runs === 'off')).toBe(true)
  })
})
