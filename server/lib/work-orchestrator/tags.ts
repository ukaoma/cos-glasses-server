/**
 * 6.83.0 Work orchestrator: the COS-WORK tag a card's handoffs carry, and the two shapes the tag takes in a log.
 * Leaf module. The tag rule is COS Control's `WorkProgress.tag(forWorkID:)` (0.5.247), so both sides agree:
 * a task card's tag is its 12-hex identity; any other card's is the first 12 hex of SHA-256 of its work ID.
 */
import { createHash } from 'node:crypto'

export const TAG_HEX = /^[a-f0-9]{12}$/
export const TAG_IN_TEXT = /COS-WORK\s+([a-fA-F0-9]{12})/g
/** The template COS Control appends to every handoff (WorkProgress.instruction). Only a real handoff carries it. */
export const HANDOFF_TEMPLATE = '<done, needs input or blocked>'
const STATUS_LINE = /^COS-WORK\s+([a-fA-F0-9]{12})\s*:\s*(done|needs[ _-]input|blocked)\s*[:\-–—]\s*(.+)$/i

export function tagForWorkID(workID: string): string {
  const parts = workID.split(':')
  if (parts.length === 3 && parts[0] === 'task' && TAG_HEX.test(parts[2]!)) return parts[2]!
  return createHash('sha256').update(workID, 'utf8').digest('hex').slice(0, 12)
}

export function tagsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(TAG_IN_TEXT)) out.add(m[1]!.toLowerCase())
  return [...out]
}

export interface StatusLine { tag: string; status: 'done' | 'needs input' | 'blocked'; evidence: string }

/**
 * Valid status lines in one reply: the line stands alone (Markdown emphasis, bullets and quote marks stripped), names
 * one of the three states, and carries at least three characters of evidence that are not the template itself.
 */
export function statusLines(text: string): StatusLine[] {
  const out: StatusLine[] = []
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\*\*/g, '').replace(/__/g, '').replace(/`/g, '').trim()
    while (line && '*_>#-•'.includes(line[0]!)) line = line.slice(1).trim()
    while (line && '*_'.includes(line[line.length - 1]!)) line = line.slice(0, -1)
    const m = STATUS_LINE.exec(line)
    if (!m) continue
    const evidence = m[3]!.trim()
    if (evidence.length < 3 || evidence.startsWith('<')) continue
    const state = m[2]!.toLowerCase().replace(/[ _-]/, ' ')
    out.push({ tag: m[1]!.toLowerCase(), status: state as StatusLine['status'], evidence: evidence.slice(0, 200) })
  }
  return out
}

/** A user turn that received this tag's handoff: the template follows the tag, exactly as Control sends it. */
export function isHandoffPrompt(text: string, tag: string): boolean {
  if (!TAG_HEX.test(tag)) return false
  return new RegExp(`COS-WORK\\s+${tag}\\s*:\\s*${HANDOFF_TEMPLATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text)
}
