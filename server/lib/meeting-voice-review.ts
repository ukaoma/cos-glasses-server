// Cheap voice-assignment stats for the meetings LIST.
//
// The Speakers panel's "Meetings to review" row cannot open every sidecar just
// to paint a tag. The unique `speakers` array sits at the top of the sidecar,
// so a 4 KB head read already used for `sessionId` is enough. Segment counts
// stay on the per-meeting review route.

import { isUnattributed } from './meeting-speaker-review.js'
import { readCorrections } from './meeting-corrections.js'

export interface MeetingVoiceReview {
  voices: number
  unattributedVoices: number
  namedVoices: number
  humanTouched: boolean
}

export function parseSidecarListHead(head: string): {
  sessionId?: string
  speakers: string[]
} {
  const sessionId = head.match(/"sessionId"\s*:\s*"([A-Za-z0-9:_-]{3,96})"/)?.[1]
  const block = head.match(/"speakers"\s*:\s*\[([^\]]*)\]/)
  const speakers = block
    ? [...block[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map(match => match[1].replace(/\\"/g, '"'))
    : []
  return { sessionId, speakers }
}

export function meetingVoiceReview(
  speakers: string[],
  sessionId?: string,
): MeetingVoiceReview {
  const labels = [...new Set(speakers.map(name => name.trim()).filter(Boolean))]
  const unattributedVoices = labels.filter(isUnattributed).length
  return {
    voices: labels.length,
    unattributedVoices,
    namedVoices: Math.max(0, labels.length - unattributedVoices),
    humanTouched: sessionWasHumanTouched(sessionId),
  }
}

export function sessionWasHumanTouched(sessionId?: string): boolean {
  if (!sessionId) return false
  try {
    return readCorrections(sessionId).rows.some(
      row => row.phase === 'applied' || row.phase === 'confirmed',
    )
  } catch {
    return false
  }
}
