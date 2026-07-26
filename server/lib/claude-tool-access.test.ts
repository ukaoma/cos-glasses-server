import { describe, expect, it, vi } from 'vitest'
import {
  buildClaudeToolList,
  claudeMcpConfigArgs,
  claudeToolCapabilityPrompt,
  configuredClaudeExtraTools,
  parseClaudeExtraToolConfiguration,
  reportClaudeExtraToolConfiguration,
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

  it('migrates legacy MCP server scopes, rejects local tools, and warns once', () => {
    const env = {
      COS_EXTRA_TOOLS: 'mcp__google-workspace,mcp__pubmed-server,Read,Glob,Grep',
    }
    expect(parseClaudeExtraToolConfiguration(env)).toEqual({
      accepted: ['mcp__google-workspace__*', 'mcp__pubmed-server__*'],
      rejected: ['Read', 'Glob', 'Grep'],
      migrated: [
        { from: 'mcp__google-workspace', to: 'mcp__google-workspace__*' },
        { from: 'mcp__pubmed-server', to: 'mcp__pubmed-server__*' },
      ],
    })

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportClaudeExtraToolConfiguration(env)
    reportClaudeExtraToolConfiguration(env)
    expect(warning).toHaveBeenCalledTimes(2)
    expect(warning.mock.calls[0]?.join(' ')).toMatch(/Migrated legacy/i)
    expect(warning.mock.calls[1]?.join(' ')).toMatch(/Ignored unsafe or invalid/i)
    expect(warning.mock.calls[1]?.join(' ')).toMatch(/Read.*Glob.*Grep/i)
    warning.mockRestore()
  })

  it('does not warn for an empty or fully valid selector configuration', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportClaudeExtraToolConfiguration({})
    reportClaudeExtraToolConfiguration({ COS_EXTRA_TOOLS: 'mcp__calendar__list,mcp__calendar__*' })
    expect(warning).not.toHaveBeenCalled()
    warning.mockRestore()
  })
})
