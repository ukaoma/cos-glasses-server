// Splice generated enrichment into a saved meeting markdown file.
//
// TWO HARD RULES, both learned from validation:
//
// 1. EVERY new section goes BEFORE `## Transcript`, never after.
//    replaceMeetingTranscriptAtomic (meeting-batch-persistence.ts:7-12)
//    replaces /## Transcript\n\n[\s\S]*$/ — from the marker to END OF FILE —
//    when HQ batch transcription lands. Anything appended after the transcript
//    is destroyed minutes later, silently.
//
// 2. REFUSE when the operations markers are present.
//    sync_meetings.py:925-926 decides whether to process a meeting by looking
//    for 'summary pending pipeline processing' and 'g2-needs-domain-review',
//    written by MeetingStore.save when COS_SCRIPTS_DIR is set. Overwriting the
//    summary section erases both, and the pipeline then skips the meeting
//    entirely — permanent loss of domain reclassification, task extraction and
//    the operations copy. The caller already gates on
//    cosOpsPipelineConfigured(); this is defence in depth against a future
//    caller that forgets.
//
// The file is re-read immediately before the write so a speaker relabel that
// landed during the (up to 45s) LLM call is not clobbered. Atomic write is not
// atomic read-modify-write; the read has to be late, not early.

import { readFileSync } from 'node:fs'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import type { MeetingSummaryResult } from './meeting-summary.js'

/** Markers that mean the operations pipeline owns this file. */
export const OPS_PIPELINE_MARKERS = [
  'summary pending pipeline processing',
  'g2-needs-domain-review',
]

export function hasOpsPipelineMarkers(markdown: string): boolean {
  const lower = markdown.toLowerCase()
  return OPS_PIPELINE_MARKERS.some(marker => lower.includes(marker.toLowerCase()))
}

function renderSections(result: MeetingSummaryResult, attendees: string[]): string {
  const blocks: string[] = []
  if (result.topics.length > 0) {
    blocks.push('## Topics Discussed', '', ...result.topics.map(t => `- ${t}`), '')
  }
  if (result.decisions.length > 0) {
    blocks.push('## Decisions', '', ...result.decisions.map(d => `- ${d}`), '')
  }
  if (result.actionItems.length > 0) {
    blocks.push(
      '## Action Items',
      '',
      // parseActions() reads the owner from a trailing (**Name**).
      ...result.actionItems.map(a => (a.owner ? `- ${a.task} (**${a.owner}**)` : `- ${a.task}`)),
      '',
    )
  }
  if (attendees.length > 0) {
    // parseAttendees() reads the name from a leading **Name**.
    blocks.push('## Attendees', '', ...attendees.map(name => `- **${name}**`), '')
  }
  return blocks.join('\n')
}

/**
 * Return the markdown with enrichment spliced in, or null when the file must
 * not be touched. Pure — does no IO — so the splice is unit-testable.
 */
export function spliceMeetingEnrichment(
  markdown: string,
  result: MeetingSummaryResult,
  attendees: string[],
): string | null {
  if (hasOpsPipelineMarkers(markdown)) return null
  if (!/^##\s+Summary\s*$/m.test(markdown)) return null
  if (!/^##\s+Transcript\s*$/m.test(markdown)) return null

  const sections = renderSections(result, attendees)

  // Replace the Summary body (up to the next `## ` heading) with the generated
  // summary followed by the new sections. Everything from `## Transcript`
  // onward is left byte-identical.
  // [^\S\n]* not \s*: \s* also matches the newline, swallowing the blank line
  // after the heading into the capture and emitting a double blank.
  return markdown.replace(
    /(^##[^\S\n]+Summary[^\S\n]*$\n)([\s\S]*?)(?=^##\s)/m,
    (_full, heading: string) =>
      `${heading}\n${result.summary}\n\n${sections}${sections ? '\n' : ''}`,
  )
}

/**
 * Read the file fresh, splice, and write atomically. Returns false when the
 * file was not eligible — never throws for an ineligible file.
 */
export function writeMeetingEnrichment(
  meetingPath: string,
  result: MeetingSummaryResult,
  attendees: string[],
): boolean {
  let current: string
  try {
    current = readFileSync(meetingPath, 'utf-8')
  } catch {
    return false
  }
  const updated = spliceMeetingEnrichment(current, result, attendees)
  if (!updated || updated === current) return false
  durableAtomicWriteFileSync(meetingPath, updated)
  return true
}

// ── Orchestrator ────────────────────────────────────────────

import {
  summariseMeeting,
  transcriptSpeakers,
  enqueueSummaryWork,
  FINALIZATION_WALL_BUDGET_MS,
} from './meeting-summary.js'

function sectionBody(markdown: string, heading: string, toEnd = false): string {
  const pattern = toEnd
    ? new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*)$`, 'i')
    : new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i')
  return markdown.match(pattern)?.[1]?.trim() ?? ''
}

function durationMinutes(markdown: string): number | undefined {
  const raw = markdown.match(/\*\*Duration\*\*\s*\|\s*(\d+)/)?.[1]
  return raw ? Number(raw) : undefined
}

/**
 * Generate and persist enrichment for a standalone meeting. Never throws — a
 * summariser failure must not fail the finalization job, mark lastError, or
 * trigger a retry, because the meeting itself saved correctly.
 *
 * `jobStartedAt` anchors the wall budget: the summariser only gets whatever
 * remains of FINALIZATION_WALL_BUDGET_MS, so batch decode plus this call plus
 * lease release stays inside COS Control's 90s waitForRestartProof.
 */
export async function enrichStandaloneMeeting(
  meetingPath: string,
  jobStartedAt: number,
): Promise<void> {
  try {
    let markdown: string
    try {
      markdown = readFileSync(meetingPath, 'utf-8')
    } catch {
      return
    }
    if (hasOpsPipelineMarkers(markdown)) return

    const transcript = sectionBody(markdown, 'Transcript', true)
    if (!transcript) return

    const remainingWallMs = FINALIZATION_WALL_BUDGET_MS - (Date.now() - jobStartedAt)
    const result = await enqueueSummaryWork(() =>
      summariseMeeting(transcript, {
        durationMinutes: durationMinutes(markdown),
        remainingWallMs,
      }),
    )

    const wrote = writeMeetingEnrichment(meetingPath, result, transcriptSpeakers(transcript))
    if (wrote) {
      console.log(
        `[meeting-summary] enriched ${meetingPath} (tier=${result.tier}`
        + `${result.skipReason ? `, skipped=${result.skipReason}` : ''})`,
      )
    }
  } catch (error) {
    console.error(
      `[meeting-summary] enrichment failed for ${meetingPath}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
