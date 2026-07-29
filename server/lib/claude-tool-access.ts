import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { getClaudeTrustMode, type ClaudeTrustMode } from './claude-permissions.js'

// COS_EXTRA_TOOLS is intentionally limited to Claude MCP selectors. The
// server's built-in Web/Read tools remain code-owned, so a remotely reachable
// glasses query cannot turn a local env typo into Bash/Write access.
const MCP_SELECTOR = /^mcp__[A-Za-z0-9][A-Za-z0-9_.:@/-]*__[A-Za-z0-9*][A-Za-z0-9_.*:@/-]*$/
const LEGACY_MCP_SERVER_SELECTOR = /^mcp__(?!.*__)[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/

export interface ClaudeExtraToolConfiguration {
  accepted: string[]
  rejected: string[]
  migrated: Array<{ from: string; to: string }>
}

let reportedConfiguration: string | null = null

export function parseClaudeExtraToolConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeExtraToolConfiguration {
  const raw = env.COS_EXTRA_TOOLS ?? ''
  const seen = new Set<string>()
  const rejectedSeen = new Set<string>()
  const accepted: string[] = []
  const rejected: string[] = []
  const migrated: Array<{ from: string; to: string }> = []

  for (const value of raw.split(',')) {
    const original = value.trim()
    if (!original) continue
    const tool = LEGACY_MCP_SERVER_SELECTOR.test(original)
      ? `${original}__*`
      : original
    if (!MCP_SELECTOR.test(tool)) {
      if (!rejectedSeen.has(original)) {
        rejectedSeen.add(original)
        rejected.push(original)
      }
      continue
    }
    if (seen.has(tool)) continue
    seen.add(tool)
    accepted.push(tool)
    if (tool !== original) migrated.push({ from: original, to: tool })
  }

  return { accepted, rejected, migrated }
}

export function configuredClaudeExtraTools(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return parseClaudeExtraToolConfiguration(env).accepted
}

function safeSelectorList(values: string[]): string {
  const visible = values.slice(0, 8).map(value => {
    const sanitized = value.replace(/[^A-Za-z0-9_.:@/*=>-]/g, '?')
    return sanitized.length > 64 ? `${sanitized.slice(0, 61)}...` : sanitized
  })
  return `${visible.join(', ')}${values.length > visible.length ? ` (+${values.length - visible.length} more)` : ''}`
}

/** Log migration/rejection once per process configuration, never per query. */
export function reportClaudeExtraToolConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeExtraToolConfiguration {
  const raw = env.COS_EXTRA_TOOLS ?? ''
  const parsed = parseClaudeExtraToolConfiguration(env)
  if (!raw.trim() || reportedConfiguration === raw) return parsed
  reportedConfiguration = raw

  if (parsed.migrated.length > 0) {
    console.warn(
      '[claude-tools] Migrated legacy COS_EXTRA_TOOLS server selector(s): ' +
      safeSelectorList(parsed.migrated.map(item => `${item.from}->${item.to}`)) +
      '. Persist the full mcp__server__* form.',
    )
  }
  if (parsed.rejected.length > 0) {
    console.warn(
      '[claude-tools] Ignored unsafe or invalid COS_EXTRA_TOOLS selector(s): ' +
      safeSelectorList(parsed.rejected) +
      '. Use mcp__server__tool or mcp__server__*. Read/Glob/Grep/Bash/Write cannot be enabled through this setting.',
    )
  }
  return parsed
}

export function buildClaudeToolList(input: {
  includeRead?: boolean
  publisherTool?: string
  env?: NodeJS.ProcessEnv
} = {}): string[] {
  const tools = ['WebSearch', 'WebFetch']
  if (input.includeRead) tools.push('Read')
  tools.push(...configuredClaudeExtraTools(input.env))
  if (input.publisherTool) tools.push(input.publisherTool)
  return [...new Set(tools)]
}

/**
 * The capability header MUST describe the permission mode the CLI actually ran
 * with, because the two modes mean opposite things:
 *
 * - trusted (default; the agent models — Claude/Opus, Codex/GPT): the CLI gets
 *   `--dangerously-skip-permissions --allowedTools <list>`, so the list is an
 *   AUTO-APPROVE hint. Bash, Read/Edit/Write, Skill, git, the COS scripts and
 *   every connected MCP remain available. Describing that list as a restriction
 *   made sessions refuse work they could do and invent downstream outages to
 *   explain the refusal (2026-07-28 G2 incident).
 * - allowlist (the read-only path — e.g. the Cursor slots, or a hardened
 *   install setting COS_CLAUDE_TRUST_MODE=allowlist): `--permission-mode dontAsk
 *   --tools <list>` genuinely denies everything undeclared, so the strict
 *   wording is accurate there and only there.
 *
 * The anti-fabrication clause is unconditional — it holds in both modes.
 */
/** Read live, not at module load, so a Control-updated plist env is visible and
 *  tests can toggle it. COS_SCRIPTS_DIR is optional — standalone installs (most
 *  public users) have no COS Python pipeline at all. */
function cosPipelineConfigured(): boolean {
  return Boolean(process.env.COS_SCRIPTS_DIR?.trim())
}

export const TOOL_HONESTY_CLAUSE =
  'When a call does fail, report the failure of YOUR call and stop there. "My request could not reach X" is the finding; "the X service is down" is fabrication. Never invent connector health, sign-in handshakes, token loading, endpoints, or authentication state.'

/**
 * Contract for the genuinely read-only slots (Cursor ask-mode on grok/composer,
 * `codex exec --sandbox read-only`). Says what is actually denied and why, so
 * the model neither over-claims write access nor invents a downstream outage to
 * explain a denial it should have named plainly.
 */
export function readOnlyCapabilityPrompt(surface: string, detail: string): string {
  return `TOOL CAPABILITY CONTRACT:
This request runs on the READ-ONLY ${surface} path. ${detail} Reads, searches, and analysis are available; writes are not. If the user asks for something that needs write access, say so plainly and offer to re-run it on an agent model (Opus or Codex/GPT) instead of attempting it or claiming it succeeded.
The read-only limit is on WRITES, not on knowledge. Connected MCP servers and read-only COS scripts are still reachable here and load lazily, so an absent tool name means "not fetched yet", not "not connected" — search for it before reporting a connector as unavailable.
${TOOL_HONESTY_CLAUSE}`
}

export function claudeToolCapabilityPrompt(
  tools: string[],
  mode: ClaudeTrustMode = getClaudeTrustMode(),
): string {
  const list = tools.join(', ') || '(none)'
  const honesty = TOOL_HONESTY_CLAUSE

  if (mode === 'allowlist') {
    return `TOOL CAPABILITY CONTRACT:
This request runs in RESTRICTED allowlist mode and is genuinely limited to these tool selectors: ${list}. Undeclared tools are denied without prompting, so a call outside this list will fail.
Selectors are permissions, not proof that a connector is online. Use a tool only when it is actually present in this session. If the user asks for a tool or connector that is absent, or a tool call fails, say that it is unavailable. ${honesty}`
  }

  // The COS Python pipeline is OPTIONAL — COS_SCRIPTS_DIR is unset on a
  // standalone install, which is most public users. Promising scripts that are
  // not installed is the same defect as denying tools that are: the session
  // trusts the header, and this one would push it to over-claim rather than
  // over-refuse. Only name the pipeline when it is actually configured.
  const harness = cosPipelineConfigured()
    ? 'Bash, Read, Edit, Write, Skill, git, the COS Python scripts, and every connected MCP server'
    : 'Bash, Read, Edit, Write, Skill, git, and every connected MCP server'

  return `TOOL CAPABILITY CONTRACT:
This session runs the FULL agent harness. ${harness} are available to you whether or not they appear in any list.
MCP tools load LAZILY. They are deferred by design and are not enumerated up front, so an MCP server missing from your tool list means "not fetched yet", never "not connected". Call ToolSearch to load a schema before you say a connector is unavailable. Mid-session system-reminders announcing servers as connecting, disconnected, or reconnected are transient tool-catalog churn on this machine — they are not evidence about the service, and a connector that vanished a moment ago is usually callable again on the next turn.
Pre-approved selectors for this request (non-exhaustive, routing only, NOT an inventory): ${list}.
Never refuse, hedge, or claim a limitation from that list or from any header. PROBE first with one real call (\`date\`, a \`Read\`, a ToolSearch, \`curl -o /dev/null\`) — only an attempted call that actually failed is evidence a capability is missing. Do not tell the user to re-ask from another surface, and do not hand them a command to run themselves, until a real call has failed. ${honesty}`
}

/** Optional explicit MCP config for managed launches whose CLI cwd differs
 * from the COS brain. Normal project-local `.mcp.json` discovery needs no flag. */
export function claudeMcpConfigArgs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = env.COS_CLAUDE_MCP_CONFIG?.trim()
  if (!configured) return []
  const path = resolve(configured)
  let regular = false
  try { regular = existsSync(path) && statSync(path).isFile() } catch { regular = false }
  if (!regular) {
    throw new Error(`claude-bridge: COS_CLAUDE_MCP_CONFIG is not a readable file: ${path}`)
  }
  return ['--mcp-config', path]
}
