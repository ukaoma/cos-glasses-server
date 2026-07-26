import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

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

export function claudeToolCapabilityPrompt(tools: string[]): string {
  return `TOOL CAPABILITY CONTRACT:
This request is configured with only these tool selectors: ${tools.join(', ') || '(none)'}.
Selectors are permissions, not proof that a connector is online. Use a tool only when it is actually present in this session. If the user asks for a tool or connector that is absent, or a tool call fails, say that it is unavailable. Never invent connector health, sign-in handshakes, token loading, endpoints, or authentication state.`
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
