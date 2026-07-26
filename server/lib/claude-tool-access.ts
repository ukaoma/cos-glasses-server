import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// COS_EXTRA_TOOLS is intentionally limited to Claude MCP selectors. The
// server's built-in Web/Read tools remain code-owned, so a remotely reachable
// glasses query cannot turn a local env typo into Bash/Write access.
const MCP_SELECTOR = /^mcp__[A-Za-z0-9][A-Za-z0-9_.:@/-]*__[A-Za-z0-9*][A-Za-z0-9_.*:@/-]*$/

export function configuredClaudeExtraTools(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.COS_EXTRA_TOOLS ?? ''
  const seen = new Set<string>()
  const tools: string[] = []
  for (const value of raw.split(',')) {
    const tool = value.trim()
    if (!tool || !MCP_SELECTOR.test(tool) || seen.has(tool)) continue
    seen.add(tool)
    tools.push(tool)
  }
  return tools
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
