// Pure exact-token rendering shared by offline repair and saved Mac finalization.
type Doc = Record<string, any>
function refuse(message: string): never { throw new Error(`Mac speaker repair: ${message}`) }
export interface BoundWord { word: string; before: string; after: string }
export function boundWords(before: Doc, after: Doc): BoundWord[] {
  if (before.batchApplied !== true || !Array.isArray(before.batchSegments) || !before.batchSegments.length) refuse('v1 requires complete canonical batch speaker words')
  return before.batchSegments.flatMap((segment: Doc, si: number) => {
    if (!Array.isArray(segment.speakerWords) || segment.speakerWords.length !== after.batchSegments[si]?.speakerWords?.length) refuse('incomplete batch speaker words')
    return segment.speakerWords.flatMap((row: Doc, wi: number) => {
      const next = after.batchSegments[si].speakerWords[wi]
      if (typeof row.word !== 'string' || typeof row.speaker !== 'string' || typeof next.speaker !== 'string') refuse('invalid canonical word binding')
      return row.word.match(/\S+/gu)?.map((word: string) => ({ word, before: row.speaker, after: next.speaker })) ?? []
    })
  })
}
/** Exact ordered tokens + exact old labels, no nearest/anchor/substring guessing.
 * Spoken token bytes and original separators remain; only prefixes are replaced
 * or inserted when an existing turn must split at a proven word boundary.
 */
export function renderBoundSpeakerLabels(transcript: string, words: BoundWord[], preserveUnlabelled = false): string {
  let pointer = 0
  const result = transcript.split('\n').map(line => {
    const match = /^(\[([^\]\r\n]+)\]:[ \t]*)(.*)$/.exec(line)
    if (!match) { if (line.trim() && !preserveUnlabelled) refuse('unbound nonempty transcript line'); return line }
    const tokens = [...match[3].matchAll(/\S+/gu)]
    if (!tokens.length) return line
    let out = '', previous: string | null = null, consumed = 0
    for (const token of tokens) {
      const bound = words[pointer++]
      if (!bound || bound.word !== token[0] || bound.before !== match[2]) refuse('transcript words/labels do not exactly match canonical evidence')
      const offset = token.index!
      out += match[3].slice(consumed, offset)
      if (previous === null) out = match[1].replace(`[${match[2]}]`, `[${bound.after}]`) + out
      else if (previous !== bound.after) out += `\n[${bound.after}]: `
      out += token[0]; consumed = offset + token[0].length; previous = bound.after
    }
    return out + match[3].slice(consumed)
  }).join('\n')
  if (pointer !== words.length) refuse('transcript has missing canonical words')
  return result
}
/** Omitted/cleaned unaffected lines may stay. Every changed canonical token
 * must still be covered by exactly one full-line, exact-token + old-label join. */
export function renderSparseBoundSpeakerLabels(transcript: string, words: BoundWord[]): string {
  const covered = new Set<number>()
  let lastEnd = 0
  const out = transcript.split('\n').map(line => {
    const match = /^(\[([^\]\r\n]+)\]:[ \t]*)(.*)$/.exec(line)
    if (!match) return line
    const tokens = match[3].match(/\S+/gu) ?? []
    if (!tokens.length) return line
    const candidates: number[] = []
    for (let start = 0; start <= words.length - tokens.length; start++) {
      if (tokens.every((token, offset) => words[start + offset].word === token && words[start + offset].before === match[2])) candidates.push(start)
    }
    const affects = (start: number) => words.slice(start, start + tokens.length).some(word => word.before !== word.after)
    if (candidates.length !== 1) {
      if (candidates.some(affects)) refuse('changed markdown line has ambiguous canonical binding')
      return line
    }
    const start = candidates[0], end = start + tokens.length
    if (start < lastEnd) refuse('markdown canonical line order disagrees')
    lastEnd = end
    for (let index = start; index < end; index++) covered.add(index)
    return affects(start) ? renderBoundSpeakerLabels(line, words.slice(start, end)) : line
  }).join('\n')
  if (words.some((word, index) => word.before !== word.after && !covered.has(index))) refuse('changed canonical words lack unique complete markdown binding')
  return out
}
/** The operations importer writes this literal marker after a character-limited
 * canonical preview. Only an exact ordered prefix may waive omitted tail words. */
export function renderTruncatedBoundSpeakerLabels(body: string, words: BoundWord[]): string {
  const marker = '... [Transcript truncated for length]'
  const position = body.indexOf(marker)
  if (position < 0 || body.indexOf(marker, position + marker.length) >= 0) refuse('one explicit transcript truncation marker required')
  const shown = body.slice(0, position), suffix = body.slice(position)
  if (/^\[[^\]\r\n]+\]:/m.test(suffix)) refuse('spoken lines follow transcript truncation marker')
  const tokens: Array<{word: string; label: string}> = []
  for (const line of shown.split('\n')) {
    const match = /^\[([^\]\r\n]+)\]:[ \t]*(.*)$/.exec(line)
    if (match) for (const word of match[2].match(/\S+/gu) ?? []) tokens.push({word, label:match[1]})
  }
  if (!tokens.length || tokens.length >= words.length) refuse('truncation marker does not describe a canonical prefix')
  const visible = tokens.map((token, index) => {
    const bound = words[index]
    const partial = index === tokens.length - 1 && bound.word.startsWith(token.word)
    if (bound.before !== token.label || (bound.word !== token.word && !partial)) refuse('truncated preview is not an exact canonical prefix')
    return {...bound, word:token.word}
  })
  return renderBoundSpeakerLabels(shown, visible, true) + suffix
}
export function renderMarkdown(markdown: string, words: BoundWord[]): string {
  const headings = [...markdown.matchAll(/^## Transcript[^\n]*\n/gm)]
  if (headings.length !== 1) refuse('exactly one Transcript section required')
  const start = headings[0].index! + headings[0][0].length
  const next = /^## /m.exec(markdown.slice(start)), end = next ? start + next.index : markdown.length
  const body = markdown.slice(start, end)
  let rendered: string
  if (body.includes('... [Transcript truncated for length]')) rendered = renderTruncatedBoundSpeakerLabels(body, words)
  else {
    try { rendered = renderBoundSpeakerLabels(body, words, true) }
    catch { rendered = renderSparseBoundSpeakerLabels(body, words) }
  }
  return markdown.slice(0, start) + rendered + markdown.slice(end)
}
