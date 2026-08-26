#!/usr/bin/env tsx
// Repair day files written by the pre-upsert archive merge.
//
//   npx tsx server/scripts/repair-archive-duplicates.ts            # dry run, writes nothing
//   npx tsx server/scripts/repair-archive-duplicates.ts --apply    # rewrites, after backing up
//
// WHAT WENT WRONG. `runDailyArchiveMirror` re-archives every session still
// resident in memory, skipping only today's, at boot and every 24h -- without
// evicting it. `appendToArchive` merged with a blind `existing.chats.push(...)`.
// So a session that stayed resident gained one more copy of itself in its day
// file on every restart. Measured before the fix: 1.28 GB across 176 day files,
// ~1.26 GB of it duplicates. One 69 MB file held ONE conversation 2,388 times.
//
// The upsert in archive.ts fixes new writes AND self-heals a file the next time
// it is touched -- so most affected days repair themselves once the mirror
// revisits them. This script exists for the remainder: days whose sessions have
// since been evicted, which nothing will ever touch again.
//
// THIS SCRIPT IMPORTS NOTHING FROM THE SERVER. `archive.ts` runs
// checkYesterdayArchive() at module scope, so importing it would start archive
// work while we are rewriting the archive. The atomic write below is inlined for
// the same reason. Nothing here has an effect until --apply.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const APPLY = process.argv.includes('--apply')
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface Chat {
  id: number
  sessionId: string
  startedAt: number
  exchangeCount: number
  [k: string]: unknown
}
interface Day { date: string; summary: string; chats: Chat[]; archivedAt: string; [k: string]: unknown }

function archiveDirPath(): string {
  const base = process.env.COS_DATA_DIR ?? join(homedir(), '.cos-glasses', 'data')
  return resolve(base, 'archive')
}

/** Identity of a chat. `startedAt` is its first exchange's timestamp, so it
 *  survives re-archiving. `id` does NOT -- it is renumbered on every merge,
 *  which is exactly why the old code could never see a duplicate. */
const keyOf = (c: Chat): string => `${c.sessionId}:${c.startedAt}`

/** Collapse duplicates, keeping the most complete copy of each chat. Pure. */
export function dedupeChats(chats: Chat[]): { kept: Chat[]; removed: number } {
  const byKey = new Map<string, Chat>()
  for (const chat of chats) {
    const prior = byKey.get(keyOf(chat))
    if (!prior || (chat.exchangeCount ?? 0) > (prior.exchangeCount ?? 0)) byKey.set(keyOf(chat), chat)
  }
  const kept = [...byKey.values()].sort((a, b) => a.startedAt - b.startedAt)
  kept.forEach((c, i) => { c.id = i })
  return { kept, removed: chats.length - kept.length }
}

function atomicWrite(path: string, data: string): void {
  // Inlined rather than imported: see the header note about module-scope effects.
  const tmp = `${path}.repair-tmp`
  writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

function main(): void {
  const dir = archiveDirPath()
  if (!existsSync(dir)) {
    console.error(`No archive directory at ${dir}`)
    process.exit(2)
  }

  // A concurrent appendToArchive would race this rewrite. The in-process archive
  // lock cannot be taken from outside the server, so the only safe answer is to
  // refuse while it is up rather than to hope the window is small.
  // Only the DEFAULT data dir is at risk: that is the one the running server writes
  // to. Pointed at a scratch copy, there is nothing to race, and refusing there
  // would block the very rehearsal this script deserves before it touches real data.
  const isLiveDataDir = process.env.COS_DATA_DIR === undefined
  if (APPLY && isLiveDataDir && serverIsUp()) {
    console.error('The COS server is listening on 127.0.0.1:3141.')
    console.error('Stop it through COS Control before repairing, then re-run.')
    console.error('Refusing to rewrite archive files while the server may write to them.')
    process.exit(3)
  }

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json') && DATE_RE.test(f.slice(0, -5)))
    .sort()

  let affected = 0
  let chatsBefore = 0
  let chatsAfter = 0
  let bytesBefore = 0
  let bytesAfter = 0

  for (const file of files) {
    const path = join(dir, file)
    const size = statSync(path).size

    let day: Day
    try {
      day = JSON.parse(readFileSync(path, 'utf8')) as Day
    } catch (err) {
      console.error(`  SKIP ${file} — unreadable: ${(err as Error).message.slice(0, 80)}`)
      continue
    }
    if (!Array.isArray(day.chats) || day.chats.length === 0) continue

    const { kept, removed } = dedupeChats(day.chats)
    if (removed === 0) continue

    affected++
    chatsBefore += day.chats.length
    chatsAfter += kept.length
    bytesBefore += size

    const before = day.chats.length
    day.chats = kept
    const serialised = `${JSON.stringify(day, null, 2)}\n`
    bytesAfter += Buffer.byteLength(serialised, 'utf8')

    console.log(
      `  ${APPLY ? 'REPAIR' : 'would repair'} ${file}  ` +
      `${(size / 1e6).toFixed(1)} MB → ${(Buffer.byteLength(serialised, 'utf8') / 1e6).toFixed(1)} MB  ` +
      `chats ${before} → ${kept.length}  (-${removed})`,
    )

    if (APPLY) {
      // Back up BEFORE writing. This is user conversation history; a bad rewrite
      // with no copy is unrecoverable.
      const backup = `${path}.bak-${Date.now()}`
      copyFileSync(path, backup)
      atomicWrite(path, serialised)

      // Verify by UNIQUE CHAT COUNT, never by file size -- size is the metric the
      // bug distorted, so shrinkage proves nothing about correctness.
      const reread = JSON.parse(readFileSync(path, 'utf8')) as Day
      const uniq = new Set(reread.chats.map(keyOf)).size
      if (reread.chats.length !== kept.length || uniq !== kept.length) {
        console.error(`  FAILED verification on ${file}; original preserved at ${backup}`)
        process.exit(4)
      }
    }
  }

  const summary = {
    mode: APPLY ? 'applied' : 'dry-run',
    filesScanned: files.length,
    filesAffected: affected,
    chats: { before: chatsBefore, after: chatsAfter, removed: chatsBefore - chatsAfter },
    bytes: { before: bytesBefore, after: bytesAfter, reclaimed: bytesBefore - bytesAfter },
  }
  console.log('')
  console.log(JSON.stringify(summary, null, 2))
  if (!APPLY && affected > 0) {
    console.log('')
    console.log('Nothing was written. Re-run with --apply to repair (each file is backed up first).')
  }
}

function serverIsUp(): boolean {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-ti', ':3141'], { encoding: 'utf8', timeout: 5000 })
    return out.trim().length > 0
  } catch {
    return false // lsof missing or nothing listening — do not block on an inconclusive probe
  }
}

// Run ONLY when invoked directly. Importing this file (a test, or any tooling)
// must not execute a repair or call process.exit -- the same module-scope hazard
// this script refuses to inherit from archive.ts.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
