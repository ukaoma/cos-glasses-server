// No raw control bytes in shipped source (6.52.0 QA round 1).
//
// `job-trail.ts` carried its control-character class as RAW bytes (NUL through US and DEL
// typed literally inside a regex). It worked, but git called the file binary, no diff or
// review showed the line, and any editor or tool that normalizes control characters would
// have silently changed what the regex strips. Every such character is written as an escape
// (`\x00`), which is the same regex and a reviewable one.
//
// This fails if any `server/**/*.ts` or `bin/**` file holds a byte below 0x20 other than tab,
// LF or CR.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f]/

function walk(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'data' || name === 'certs' || name === 'models') continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, keep, out)
    else if (keep(path)) out.push(path)
  }
  return out
}

describe('shipped source has no raw control bytes', () => {
  it('every server/**/*.ts and bin/** file: only tab, LF and CR below 0x20', () => {
    const files = [
      ...walk(join(ROOT, 'server'), path => path.endsWith('.ts')),
      ...walk(join(ROOT, 'bin'), () => true),
    ]
    // The walk reached the files that matter, including the one this was found in.
    expect(files.length).toBeGreaterThan(300)
    expect(files.map(f => relative(ROOT, f))).toEqual(expect.arrayContaining(['server/lib/job-trail.ts', 'bin/hooks/cos-session-hook', 'server/index.ts']))
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'latin1')
      const at = text.search(FORBIDDEN)
      if (at >= 0) offenders.push(`${relative(ROOT, file)} byte 0x${text.charCodeAt(at).toString(16).padStart(2, '0')} at ${at}`)
    }
    expect(offenders).toEqual([])
  })

  it('the check itself catches a control byte', () => {
    expect(FORBIDDEN.test('a\x00b')).toBe(true)
    expect(FORBIDDEN.test('a\x1fb')).toBe(true)
    expect(FORBIDDEN.test('tab\there\nand\r\n')).toBe(false)
  })
})
