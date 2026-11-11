/**
 * Each agent's efforts for /api/models (Sessions chat-style layout, step 2a; S1_CONTRACT_step2a.md section C).
 *
 * One source for every picker, web and Mac: ghost report item 6 found the model and effort lists hard-coded in seven
 * places. The values are exactly what POST /api/query-jobs accepts as `effort` (EFFORT_OPTIONS; anything else is
 * dropped by the job route today, ghost item 5), and each entry says what the agent actually runs with it, from the
 * same mapping functions the bridges call. Cursor's bridge takes no effort, so its list is empty.
 */
import {
  DEFAULT_EFFORT,
  EFFORT_OPTIONS,
  effortLabel,
  resolveCliEffortFlag,
  resolveCodexReasoningEffort,
  type EffortPreference,
} from '../../shared/model-preference.js'
import { resolveOllamaThink } from './ollama-bridge.js'

export interface EffortChoice { value: EffortPreference; label: string; runs: string }
export interface ModelEfforts {
  default: EffortPreference
  byAgent: { claude: EffortChoice[]; codex: EffortChoice[]; ollama: EffortChoice[]; cursor: EffortChoice[] }
}

export function modelEfforts(env: NodeJS.ProcessEnv = process.env): ModelEfforts {
  const choices = (runs: (effort: EffortPreference) => string): EffortChoice[] =>
    EFFORT_OPTIONS.map(value => ({ value, label: effortLabel(value), runs: runs(value) }))
  return {
    default: DEFAULT_EFFORT,
    byAgent: {
      // `--effort`; Ultracode is a COS choice that runs Claude at xhigh.
      claude: choices(e => resolveCliEffortFlag(e)),
      // `model_reasoning_effort`.
      codex: choices(e => resolveCodexReasoningEffort(e)),
      // Ollama's `think` (COS_OLLAMA_THINK, when set, pins it whatever the effort).
      ollama: choices(e => { const think = resolveOllamaThink(env.COS_OLLAMA_THINK, e); return think === false ? 'off' : think === true ? 'on' : think }),
      cursor: [],
    },
  }
}
