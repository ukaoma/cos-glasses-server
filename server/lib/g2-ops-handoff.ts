// Hand off a durable local G2 recording into COS operations/ and run exact
// enrichment. Private cos-glasses-app did this inline in meeting/save; the
// public managed package only wrote ~/.cos-glasses/data/recordings until
// 2026-07-27 — so HQ could finish while operations/ never got a (G2) scribe.
//
// Contract:
//   1. Keep the local recording as the glasses MeetingStore source of truth.
//   2. When COS_OPERATIONS_DIR / COS_SCRIPTS_DIR is set, stage a pipeline-ready
//      copy under operations/personal/meetings/YYYY-MM/ (domain review marker
//      lets sync_meetings reclassify).
//   3. Run sync_meetings.py --g2-only --g2-file with the private-app retry helper.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { resolveCosOperationsDir } from './cos-operations-meetings.js'
import { runG2EnrichmentWithRetry } from './g2-enrichment-runner.js'
import { COS_SCRIPTS_DIR, PYTHON_BIN } from './python-bridge.js'

const PENDING_SUMMARY = '*G2 recording — summary pending pipeline processing.*'
const DOMAIN_REVIEW_MARKER = '<!-- g2-needs-domain-review -->'

export function patchRecordingForG2Pipeline(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, '\n')
  if (!/\|\s*\*\*Source\*\*\s*\|\s*G2 Glasses\s*\|/i.test(text) && !text.includes('| G2 Glasses')) {
    text = text.replace(
      /(\|\s*\*\*Source\*\*\s*\|)([^|\n]*)\|/,
      '| **Source** | G2 Glasses |',
    )
  }
  text = text.replace(
    /\*Standalone recording[^*]*\*/i,
    PENDING_SUMMARY,
  )
  if (!/summary pending pipeline processing/i.test(text)) {
    if (/## Summary\n\n/.test(text)) {
      text = text.replace(/## Summary\n\n/, `## Summary\n\n${PENDING_SUMMARY}\n\n`)
    } else {
      text = `${text.trimEnd()}\n\n## Summary\n\n${PENDING_SUMMARY}\n`
    }
  }
  if (!text.includes('g2-needs-domain-review')) {
    if (text.includes('## Summary')) {
      text = text.replace('## Summary', `${DOMAIN_REVIEW_MARKER}\n\n## Summary`)
    } else {
      text = `${text.trimEnd()}\n\n${DOMAIN_REVIEW_MARKER}\n`
    }
  }
  return text
}

/** Stage local recording into operations/personal for exact enrichment. */
export function stageRecordingIntoOperations(localMeetingPath: string): string | null {
  const operationsDir = resolveCosOperationsDir()
  if (!operationsDir) return null
  if (!existsSync(localMeetingPath)) {
    console.warn(`[g2-ops-handoff] Local meeting missing: ${localMeetingPath}`)
    return null
  }

  const month = basename(dirname(localMeetingPath))
  if (!/^\d{4}-\d{2}$/.test(month)) {
    console.warn(`[g2-ops-handoff] Unexpected meeting month folder for ${localMeetingPath}`)
    return null
  }

  const destDir = join(operationsDir, 'personal', 'meetings', month)
  mkdirSync(destDir, { recursive: true })
  const destPath = join(destDir, basename(localMeetingPath))
  const patched = patchRecordingForG2Pipeline(readFileSync(localMeetingPath, 'utf8'))
  writeFileSync(destPath, patched, { encoding: 'utf8', mode: 0o600 })

  const stem = basename(localMeetingPath, '.md')
  const localDir = dirname(localMeetingPath)
  for (const companionName of [`${stem}.g2-chunks.json`, `${stem}.json`]) {
    const companion = join(localDir, companionName)
    if (existsSync(companion)) {
      try {
        copyFileSync(companion, join(destDir, companionName))
      } catch (error) {
        console.warn(
          `[g2-ops-handoff] Sidecar copy failed for ${companionName}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  return destPath
}

export async function handoffMeetingToOperations(localMeetingPath: string): Promise<void> {
  if (!COS_SCRIPTS_DIR || !PYTHON_BIN) {
    console.log('[meeting/save] Standalone mode — skipping G2 sync pipeline')
    return
  }
  if (!existsSync(PYTHON_BIN)) {
    console.warn(`[meeting/save] COS python missing at ${PYTHON_BIN} — skipping G2 sync`)
    return
  }

  const staged = stageRecordingIntoOperations(localMeetingPath)
  if (!staged) {
    console.warn('[meeting/save] COS operations dir unset/unavailable — G2 sync skipped')
    return
  }

  const syncScript = join(COS_SCRIPTS_DIR, 'sync_meetings.py')
  if (!existsSync(syncScript)) {
    console.warn(`[meeting/save] sync_meetings.py missing at ${syncScript}`)
    return
  }

  const spawnPath = process.env.PATH?.includes('/opt/homebrew/bin')
    ? process.env.PATH
    : `/opt/homebrew/bin:${process.env.PATH || ''}`

  const enrichment = await runG2EnrichmentWithRetry({
    pythonBin: PYTHON_BIN,
    syncScript,
    scriptsDir: COS_SCRIPTS_DIR,
    meetingFile: staged,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PATH: spawnPath },
    onAttempt: message => console.log(`[meeting/save] G2 exact sync: ${message}`),
  })

  if (enrichment.ok && enrichment.outcome) {
    console.log(
      `[meeting/save] G2 pipeline verified after ${enrichment.attempts} attempt(s): `
      + `${enrichment.outcome.title} → ${enrichment.outcome.path}`,
    )
  } else {
    console.error(
      `[meeting/save] G2 pipeline FAILED after ${enrichment.attempts} attempt(s): `
      + `${enrichment.error ?? 'unknown exact-file enrichment failure'}`,
    )
  }
}
