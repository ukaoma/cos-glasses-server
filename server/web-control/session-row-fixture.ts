/**
 * Session list rows for the web tests, built the way the server builds them (X1 01:0x): routes/agent-sessions.ts
 * toEntry sends `state` as running or recent, and the one derived state (agent_state, waiting_kind and the rest) comes
 * from lib/session-state-derive.ts derivedRowFields, the same function the route calls. A field the server does not
 * send cannot make a test pass. The session detail route (GET /api/agent-sessions/<p>/<id>) spreads the same fields.
 */
import { derivedRowFields, type AgentState, type DerivedSessionState } from '../lib/session-state-derive.js'

type Extra = Omit<Partial<DerivedSessionState>, 'agent_state' | 'deadScans' | 'deadSince'>

export function derivedFields(agentState: AgentState, extra: Extra = {}): Record<string, unknown> {
  return derivedRowFields({ state_source: 'hook', state_since: '2026-11-17T06:00:00.000Z', ...extra, agent_state: agentState, deadScans: 0, deadSince: null })
}

export function listRow(o: { id: string; provider?: string; state?: 'running' | 'recent'; agentState?: AgentState; derived?: Extra }): Record<string, unknown> {
  return { session_id: o.id, provider: o.provider ?? 'claude', alive: true, state: o.state ?? 'running', ...(o.agentState ? derivedFields(o.agentState, o.derived) : {}) }
}
