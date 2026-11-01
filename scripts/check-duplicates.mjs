#!/usr/bin/env node
// Fail-loud check for iCloud sync-conflict copies ("name 2.ts", "x 3.json", "dir 2/").
//
// WHY. The checkout can live under iCloud, which writes a conflict copy next to the original
// instead of overwriting it. .gitignore carries `* 2.*`, so `git status` never shows one, but
// tsc (tsconfig include: server, shared), the key-lanes spawn census and the npm `files` globs
// all walk the filesystem and trip on it. 6.94.2 v1 failed on `control2-draft 2.ts` after a full
// suite, which is the late failure this check exists to move to second zero.
//
// It walks the filesystem rather than asking git, because git is exactly what hides them.
// Nothing is excluded silently: the only skipped directories are node_modules and .git, and the
// summary line names them. A hit prints the path and exits 1.
//
// Usage: node scripts/check-duplicates.mjs [--root <dir>]
import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** "<name> <digits>" optionally followed by ONE extension. "Release notes 2.5.md" does not match. */
export const DUPLICATE_NAME = /^.+ \d+(\.[A-Za-z0-9_-]+)?$/
/** Directories this check does not enter. Printed in the summary so the skip is never silent. */
export const SKIPPED_DIRS = ['node_modules', '.git']

export function findDuplicates(root) {
  const found = []
  let scanned = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRS.includes(entry.name)) continue
      scanned += 1
      const full = join(dir, entry.name)
      if (DUPLICATE_NAME.test(entry.name)) found.push(relative(root, full))
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(root)
  return { found: found.sort(), scanned }
}

function main() {
  const args = process.argv.slice(2)
  const at = args.indexOf('--root')
  const root = resolve(at >= 0 ? args[at + 1] : join(fileURLToPath(new URL('.', import.meta.url)), '..'))
  const { found, scanned } = findDuplicates(root)
  if (found.length > 0) {
    console.error(`check-duplicates: ${found.length} iCloud-style duplicate(s) under ${root}:`)
    for (const path of found) console.error(`  ${path}`)
    console.error('Delete or merge each one (compare against the original first), then re-run.')
    process.exit(1)
  }
  console.log(`check-duplicates: ok, ${scanned} entries scanned (skipped: ${SKIPPED_DIRS.join(', ')})`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
