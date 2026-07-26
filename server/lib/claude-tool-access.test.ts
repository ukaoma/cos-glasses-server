import { describe, expect, it } from 'vitest'
import {
  buildClaudeToolList,
  claudeMcpConfigArgs,
  claudeToolCapabilityPrompt,
  configuredClaudeExtraTools,
} from './claude-tool-access.js'

describe('Claude MCP tool access', () => {
  it('accepts only explicit MCP selectors and de-duplicates them', () => {
    const env = {
      COS_EXTRA_TOOLS: 'mcp__calendar__list,mcp__calendar__*, Bash,Write,mcp__calendar__list, bad value',
    }
    expect(configuredClaudeExtraTools(env)).toEqual([
      'mcp__calendar__list',
      'mcp__calendar__*',
    ])
    expect(buildClaudeToolList({ includeRead: true, env })).toEqual([
      'WebSearch',
      'WebFetch',
      'Read',
      'mcp__calendar__list',
      'mcp__calendar__*',
    ])
  })

  it('tells the model not to fabricate unavailable connector machinery', () => {
    const prompt = claudeToolCapabilityPrompt(['WebSearch', 'mcp__calendar__*'])
    expect(prompt).toContain('only these tool selectors')
    expect(prompt).toContain('Never invent connector health')
  })

  it('fails closed when an explicit MCP config file is missing', () => {
    expect(() => claudeMcpConfigArgs({ COS_CLAUDE_MCP_CONFIG: '/missing/cos-mcp.json' }))
      .toThrow(/not a readable file/i)
  })
})
