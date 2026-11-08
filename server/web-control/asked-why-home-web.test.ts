// 7.0.4 W5: a waiting permission's command reaches Control Web with the home folder shown as "[home]" (the server's
// COMMAND_KEYS), never as a base name. The Needs you line says it is a display; the approval card keeps the exact
// command (routes/permission-broker.test.ts). Runs app.js's own askedWhy.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { redactLocalPathsDeep } from '../lib/local-path-redact.js'

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.js'), 'utf8')

function askedWhy(row: Record<string, unknown>): string {
  const start = APP.indexOf('  var TOOL_NAMES = ['), end = APP.indexOf('  // 6.99.26: where a waiting')
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const ctx: Record<string, unknown> = { sxProvider: (p: string) => p || 'claude' }
  vm.createContext(ctx)
  vm.runInContext(APP.slice(start, end) + '\n;this.__ = askedWhy;', ctx)
  return (ctx.__ as (s: unknown) => string)(row)
}

describe('Wants to run: the command as the session list carries it', () => {
  it('rm -rf /Users/<name>/Documents shows the marker and says the home folder is hidden', () => {
    const row = redactLocalPathsDeep({ provider: 'claude', waiting_kind: 'permission', waiting_detail: 'rm -rf /Users/ukaoma/Documents' })
    expect(row.waiting_detail).toBe('rm -rf [home]/Documents')
    expect(askedWhy(row)).toBe('Wants to run (home folder hidden) rm -rf [home]/Documents')
  })
  it('a command with no home folder is shown as it is, with no label', () => {
    const row = redactLocalPathsDeep({ provider: 'claude', waiting_kind: 'permission', waiting_detail: 'cp -r /tmp/build ./out' })
    expect(askedWhy(row)).toBe('Wants to run cp -r /tmp/build ./out')
  })
})
