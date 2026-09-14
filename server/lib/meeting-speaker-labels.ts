/** Shared, position-scoped correction primitive. Transcript words are immutable. */
import { attachRawChunkIndices, type ReviewChunk } from './meeting-speaker-review.js'
import { invalidLabelReason } from './meeting-relabel.js'

export type SpeakerPatch = { path: Array<string | number>; before: unknown; after: unknown }
export type PrefixPatch = { line: number; before: string; after: string }
export interface LabelEdit {
  doc: Record<string, any>
  markdown: string
  patches: SpeakerPatch[]
  prefixes: PrefixPatch[]
  changed: number[]
  transcript: number
  attendees: number
  unresolvedTurns: number
}
const prefix = /^(\[([^\]\r\n]+)\]:|\*\*([^*\r\n]+)\*\*(?:[ \t]+_\[[^\]\r\n]*\]_)?:?)([ \t]*)/
const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim()
export function strippedTranscript(markdown: string): string {
  const section = /^## Transcript[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(markdown)
  return (section?.[1] ?? '').split('\n').map(line => line.replace(prefix, '')).join('\n')
}
function setPatch(doc: Record<string, any>, path: Array<string | number>, value: unknown, patches: SpeakerPatch[]) {
  let obj: any = doc
  for (const key of path.slice(0, -1)) obj = obj[key]
  const key = path[path.length - 1]
  if (obj[key] === value) return
  patches.push({ path, before: obj[key], after: value })
  obj[key] = value
}
export function patchValue(doc: Record<string, any>, patch: SpeakerPatch, reverse = false): void {
  let obj: any = doc
  for (const key of patch.path.slice(0, -1)) {
    if (obj?.[key] == null) throw new Error('Transcript shape changed; review before undo')
    obj = obj[key]
  }
  const key = patch.path[patch.path.length - 1]
  if (reverse && JSON.stringify(obj[key]) === JSON.stringify(patch.before)) return
  if (JSON.stringify(obj[key]) !== JSON.stringify(reverse ? patch.after : patch.before)) throw new Error('A later correction touched this position')
  const value = reverse ? patch.before : patch.after
  if (value === undefined) delete obj[key]
  else obj[key] = value
}

/** Complete compacted-to-raw mapping; no trusting chunkIndex on compacted rows. */
export function validatedRawMap(doc: Record<string, any>): number[] {
  if (!Array.isArray(doc.chunks)) throw new Error('Sidecar has no chunks')
  const mapped = attachRawChunkIndices(doc.chunks as ReviewChunk[], doc.chunkEntries)
  if (mapped === doc.chunks) throw new Error('Chunk counts disagree or no raw index map')
  const raw = mapped.map(c => c.chunkIndex)
  if (raw.some(i => !Number.isInteger(i) || Number(i) < 0) || new Set(raw).size !== raw.length) throw new Error('Invalid or ambiguous raw index map')
  // Counts alone are insufficient: a damaged entry ordering can have the right length.
  const entries = doc.chunkEntries.filter((e: any) => e?.chunk?.text)
  if (entries.some((e: any, i: number) => e.chunk.text !== doc.chunks[i].text)) throw new Error('Chunk text and raw index map disagree')
  return raw as number[]
}

export function relabelSpeakerPositions(input: Record<string, any>, markdown: string, positions: number[], name: string, batchId?: string): LabelEdit {
  if (invalidLabelReason(name)) throw new Error('Invalid speaker label')
  const raw = validatedRawMap(input)
  const wanted = new Set(positions)
  if (positions.some(i => !Number.isInteger(i) || !input.chunks[i])) throw new Error('Unknown transcript position')
  const doc = structuredClone(input)
  const patches: SpeakerPatch[] = []
  const changed = [...wanted].sort((a,b) => a-b)
  for (const position of changed) {
    setPatch(doc, ['chunks', position, 'speaker'], name, patches)
    if (batchId) setPatch(doc, ['chunks', position, 'speakerCorrectionBatchId'], batchId, patches)
    const entry = doc.chunkEntries.findIndex((e: any) => e.chunkIndex === raw[position])
    setPatch(doc, ['chunkEntries', entry, 'chunk', 'speaker'], name, patches)
    if (batchId) setPatch(doc, ['chunkEntries', entry, 'chunk', 'speakerCorrectionBatchId'], batchId, patches)
  }
  // Match capture HQ's exact nearest-chunk rule, raw segment bounds, 3.5s
  // maximum. Never use compacted positions as raw capture indices (6.27.10).
  for (const [si, segment] of (doc.batchSegments ?? []).entries()) {
    for (const [wi, word] of (segment.speakerWords ?? []).entries()) {
      if (!Number.isFinite(word.start)) continue
      const absolute = Number(segment.startElapsed ?? 0) + word.start * 1000
      let nearest = -1, distance = Infinity
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] < segment.startChunkIdx || raw[i] > segment.endChunkIdx) continue
        const d = Math.abs(Number(input.chunks[i].elapsed) - absolute)
        if (d < distance) { distance = d; nearest = i }
      }
      if (distance <= 3500 && wanted.has(nearest)) {
        setPatch(doc, ['batchSegments', si, 'speakerWords', wi, 'speaker'], name, patches)
        if (batchId) setPatch(doc, ['batchSegments', si, 'speakerWords', wi, 'speakerCorrectionBatchId'], batchId, patches)
      }
      // similarity remains capture-time evidence; it is never refreshed here.
    }
  }
  const speakers = [...new Set(doc.chunks.map((c: any) => c.speaker).filter((s: any) => typeof s === 'string' && s))]
  doc.speakers = speakers
  doc.correctionRevision = Number(input.correctionRevision ?? 0) + 1
  doc.labelsNewerThanGraph = true

  const lines = markdown.split('\n')
  const prefixes: PrefixPatch[] = []
  let section = '', transcript = 0, unresolvedTurns = 0, attendees = 0
  const chunks: string[] = input.chunks.map((c: any) => normalized(String(c.text ?? '')))
  for (let i = 0; i < lines.length; i++) {
    if (/^## /.test(lines[i])) section = lines[i].slice(3).trim()
    if (section !== 'Transcript') continue
    const match = prefix.exec(lines[i])
    if (!match) continue
    let end = i + 1
    while (end < lines.length && !prefix.test(lines[end]) && !/^## /.test(lines[end])) end++
    const text = normalized([lines[i].slice(match[0].length), ...lines.slice(i+1,end)].join('\n').replace(/\n?<!-- speaker-labels-newer-than-graph -->\n?/g,''))
    const runs: number[][] = []
    for (let a = 0; a < chunks.length; a++) {
      let joined = ''
      for (let b = a; b < chunks.length; b++) {
        joined = normalized(joined + ' ' + chunks[b])
        if (joined === text) runs.push(Array.from({length:b-a+1},(_,k)=>a+k))
        if (joined.length >= text.length) break
      }
    }
    if (runs.length === 1 && runs[0].every(j => wanted.has(j))) {
      const next = match[2] !== undefined ? `[${name}]:${match[4]}` : match[0].replace(`**${match[3]}**`, `**${name}**`)
      if (next !== match[0]) { prefixes.push({line:i,before:match[0],after:next}); lines[i] = next + lines[i].slice(match[0].length); transcript++ }
    } else if (runs.length !== 1 || runs[0].some(j => wanted.has(j))) unresolvedTurns++
  }
  // Attendees preserve every existing person and never add an unidentified label.
  const att = lines.findIndex(line => /^## Attendees\s*$/.test(line))
  if (att >= 0 && !/^(ext|unknown|unidentified|speaker\s*\d+)/i.test(name)) {
    let end = att+1
    while (end < lines.length && !/^## /.test(lines[end])) end++
    if (!lines.slice(att+1,end).some(line => line.trim() === `- ${name}`)) {
      const first = doc.chunks.findIndex((c: any) => c.speaker === name)
      let insertion = end
      for (let line = att + 1; line < end; line++) {
        const listed = /^- (.+)$/.exec(lines[line])?.[1]
        const appeared = listed ? doc.chunks.findIndex((c: any) => c.speaker === listed) : -1
        if (appeared > first) { insertion = line; break }
      }
      lines.splice(insertion,0,`- ${name}`,'')
      for (const p of prefixes) if (p.line >= insertion) p.line += 2
      attendees = 1
    }
  }
  if (att < 0 && !/^(ext|unknown|unidentified|speaker\s*\d+)/i.test(name) && changed.length > 0) {
    const transcriptStart = lines.findIndex(line => /^## Transcript\s*$/.test(line))
    if (transcriptStart >= 0) { lines.splice(transcriptStart,0,'## Attendees','',`- ${name}`,''); attendees = 1 }
  }
  let nextMarkdown = lines.join('\n')
  if (!nextMarkdown.includes('<!-- speaker-labels-newer-than-graph -->')) nextMarkdown += '\n<!-- speaker-labels-newer-than-graph -->\n'
  // Marker is metadata, outside the stripped-text comparison.
  const clean = (s: string) => s.replace(/\n?<!-- speaker-labels-newer-than-graph -->\n?/g,'')
  if (strippedTranscript(clean(markdown)) !== strippedTranscript(clean(nextMarkdown))) throw new Error('Transcript word preservation assertion failed')
  return {doc,markdown:nextMarkdown,patches,prefixes,changed,transcript,attendees,unresolvedTurns}
}

/** Restore only this batch's label prefixes, using immutable turn text as the
 * join key. Attendee insertions and disjoint later corrections do not shift it. */
export function undoSpeakerMarkdown(before:string,after:string,current:string,currentSpeakers:string[]):string {
  const turns=(md:string)=>{
    const lines=md.split('\n'),result:Array<{line:number;label:string;text:string}>=[]
    let section=''
    for(let i=0;i<lines.length;i++){
      if(/^## /.test(lines[i]))section=lines[i].slice(3).trim()
      if(section!=='Transcript')continue
      const match=prefix.exec(lines[i]);if(!match)continue
      let end=i+1
      while(end<lines.length&&!prefix.test(lines[end])&&!/^## /.test(lines[end]))end++
      const content=[lines[i].slice(match[0].length),...lines.slice(i+1,end)].join('\n').replace(/\n?<!-- speaker-labels-newer-than-graph -->\n?/g,'')
      result.push({line:i,label:match[0],text:normalized(content)})
    }
    return result
  }
  const beforeTurns=turns(before),afterTurns=turns(after),currentTurns=turns(current)
  if(beforeTurns.length!==afterTurns.length)throw new Error('Receipt transcript shape changed')
  const lines=current.split('\n')
  for(let i=0;i<beforeTurns.length;i++){
    const a=afterTurns[i],b=beforeTurns[i]
    if(a.label===b.label)continue
    if(a.text!==b.text)throw new Error('Receipt transcript words changed')
    const matches=currentTurns.filter(t=>t.text===a.text)
    if(matches.length!==1)throw new Error('Transcript turn is missing or ambiguous; review before undo')
    const match=matches[0]
    if(match.label===b.label)continue // a prior interrupted Undo already restored it
    if(match.label!==a.label)throw new Error('Later naming touched transcript prefix')
    lines[match.line]=b.label+lines[match.line].slice(a.label.length)
  }
  const attendees=(md:string)=>{
    const match=/^## Attendees\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(md)
    return new Set((match?.[1]??'').split('\n').flatMap(line=>/^- (.+)$/.exec(line)?.[1]?[line.slice(2)]:[]))
  }
  const priorAttendees=attendees(before),added=[...attendees(after)].filter(name=>!priorAttendees.has(name)&&!currentSpeakers.includes(name))
  let section=''
  const out=lines.filter(line=>{if(/^## /.test(line))section=line.slice(3).trim();return !(section==='Attendees'&&added.some(name=>line===`- ${name}`))}).join('\n')
  return out.includes('<!-- speaker-labels-newer-than-graph -->')?out:out+'\n<!-- speaker-labels-newer-than-graph -->\n'
}
