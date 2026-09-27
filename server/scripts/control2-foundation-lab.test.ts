import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const scratch: string[] = []
afterEach(() => { for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true }) })
function temp() { const root = mkdtempSync(join(tmpdir(), 'control2-lab-admission-')); scratch.push(root); return root }
function launch(root: string) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', 'server/scripts/control2-foundation-lab.ts'], {
    env: { ...process.env, COS_CONTROL2_FOUNDATION: '1', COS_CONTROL_TEST_HOME: root, COS_CONTROL_TEST_API_PORT: '3199' },
    timeout: 5000, encoding: 'utf8',
  })
}
describe('foundation launcher rejects roots before mutation', () => {
  it('does not create a missing path through an ancestor symlink', () => {
    const home = temp(); const outside = temp()
    symlinkSync(outside, join(home, 'redirect'))
    const result = launch(join(home, 'redirect', 'new'))
    expect(result.status).not.toBe(0); expect(result.error).toBeUndefined()
    expect(existsSync(join(outside, 'new'))).toBe(false)
    expect(existsSync(join(outside, '.cos-glasses'))).toBe(false)
  })
  it('rejects a symlink root without creating its token directory', () => {
    const home = temp(); const outside = temp(); symlinkSync(outside, join(home, 'link'))
    expect(launch(join(home, 'link')).status).not.toBe(0)
    expect(existsSync(join(outside, '.cos-glasses'))).toBe(false)
  })
  it('requires private permissions before token creation', () => {
    const home = temp(); chmodSync(home, 0o755)
    expect(launch(home).status).not.toBe(0)
    expect(existsSync(join(home, '.cos-glasses'))).toBe(false)
  })
  it('refuses an existing redirected token directory without writing through it', () => {
    const home = temp(); const outside = temp(); symlinkSync(outside, join(home, '.cos-glasses'))
    expect(launch(home).status).not.toBe(0)
    expect(existsSync(join(outside, '.env'))).toBe(false)
  })
})
