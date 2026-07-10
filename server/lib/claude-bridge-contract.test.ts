import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Claude model/effort bridge contract', () => {
  it('wires Fable, auto-latest aliases, per-request effort, and hidden ultracode injection', () => {
    const source = readFileSync(new URL('./claude-bridge.ts', import.meta.url), 'utf8')
    expect(source).toContain('fable: 180_000')
    expect(source).toContain('fable: 900_000')
    expect(source).toContain("'--model', resolveClaudeCliModelId(resolvedModel)")
    expect(source).toContain("'--effort', cliEffortFlag")
    expect(source).toContain("resolvedEffort === 'ultracode'")
    expect(source).toContain('${ULTRACODE_KEYWORD}')
    expect(source.indexOf('addExchange(sid, \'user\', historyQuery')).toBeLessThan(source.indexOf('const cliQuery ='))
  })
})
