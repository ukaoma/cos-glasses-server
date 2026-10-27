// A stand-in for COS operations/scripts/sync_meetings.py, for server tests only.
//
// It implements the CONTRACT the server relies on, not the pipeline: `--capabilities` prints
// the capability JSON, and `--mac-import-file <md>` files the recording under
// operations/quilt/meetings/YYYY-MM/ and prints one COS_G2_RESULT= line. The real Python
// (stage_mac_import, the LLM summary/title/domain step, the G2 guards) is tested in the COS
// repo (operations/scripts/tests/test_sync_mac_import.py). Every invocation is appended to
// `invocations.jsonl` beside the script so a test can prove what the server ran, and with
// which COS_G2_IMPORT_ROOT.
//
// The script body is JavaScript and `venv/bin/python3` is a shell shim that runs it with this
// Node, so the server's real spawn path (execFile/spawn of venv/bin/python3) is exercised
// without needing Python on the test machine.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FakeSyncOptions {
  /** Omit to model an older sync_meetings.py that has no --capabilities at all. */
  capabilities?: Record<string, unknown> | null
  /** Exit code for --mac-import-file (0 prints a result line). */
  macImportExit?: number
}

export interface FakeInvocation {
  args: string[]
  importRoot: string | null
  /** With FAKE_SYNC_PROBE_DIR set: that directory's entries when the script ran. */
  probe?: string[]
}

export function writeFakeSyncMeetings(scriptsDir: string, options: FakeSyncOptions = {}): string {
  mkdirSync(join(scriptsDir, 'venv', 'bin'), { recursive: true })
  const shim = join(scriptsDir, 'venv', 'bin', 'python3')
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
  chmodSync(shim, 0o755)
  const capabilities = options.capabilities === undefined ? null : options.capabilities
  const capabilityBranch = capabilities
    ? `if (args[0] === '--capabilities') { process.stdout.write(${JSON.stringify(JSON.stringify(capabilities))} + '\\n'); process.exit(0) }`
    : ''
  const body = `
const fs = require('fs'), path = require('path')
const args = process.argv.slice(2)
const probeDir = process.env.FAKE_SYNC_PROBE_DIR
const probe = probeDir ? (fs.existsSync(probeDir) ? fs.readdirSync(probeDir).sort() : []) : undefined
fs.appendFileSync(path.join(__dirname, 'invocations.jsonl'), JSON.stringify(Object.assign({ args, importRoot: process.env.COS_G2_IMPORT_ROOT || null }, probe ? { probe } : {})) + '\\n')
${capabilityBranch}
const at = args.indexOf('--mac-import-file')
if (at >= 0 && process.env.FAKE_SYNC_DELAY_MS) {
  const until = Date.now() + Number(process.env.FAKE_SYNC_DELAY_MS)
  while (Date.now() < until) { /* hold the filing open so a test can look at the server meanwhile */ }
}
if (at >= 0) {
  if (${options.macImportExit ?? 0} !== 0) process.exit(${options.macImportExit ?? 0})
  const source = args[at + 1]
  const sidecar = JSON.parse(fs.readFileSync(source.replace(/\\.md$/, '.g2-chunks.json'), 'utf8'))
  const month = path.basename(path.dirname(source))
  const dir = path.join(__dirname, '..', 'quilt', 'meetings', month)
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, path.basename(source).slice(0, 10) + '_Q4_Plan_and_Investor_Process_(Mac).md')
  let status = 'enriched'
  if (fs.existsSync(dest)) status = 'already-enriched'
  else {
    fs.writeFileSync(dest.replace(/\\.md$/, '.g2-chunks.json'), JSON.stringify(Object.assign({}, sidecar, { syncState: 'finalized' })))
    fs.writeFileSync(dest, '# Q4 Plan and Investor Process (Mac)\\n\\n| **Source** | Mac System Audio |\\n| **Capture source** | mac_system_audio |\\n')
  }
  process.stdout.write('COS_G2_RESULT=' + JSON.stringify({ status, path: dest, title: 'Q4 Plan and Investor Process (Mac)' }) + '\\n')
  process.exit(0)
}
process.exit(2)
`
  const script = join(scriptsDir, 'sync_meetings.py')
  writeFileSync(script, body)
  return script
}

export function readFakeInvocations(scriptsDir: string): FakeInvocation[] {
  try {
    return readFileSync(join(scriptsDir, 'invocations.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as FakeInvocation)
  } catch {
    return []
  }
}
