import { meetingAskCitations, type MeetingAskSection, type MeetingAskSource } from '../../shared/meeting-ask.js'
function key(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return null
    u.hostname = u.hostname.replace(/^www\./, '')
    return u.href.replace(/\/$/, '')
  } catch { return null }
}
/** A plain displayed public link resolves to an observed URL source, never a search-summary card. */
export function groundWebLinks(sections: readonly MeetingAskSection[], sources: readonly MeetingAskSource[]) {
  const web = sources.filter(s => s.kind === 'web' && s.url)
  if (!sources.some(s => s.kind === 'web')) return { sections: [...sections], withheld: false }
  const allowed = new Set(sources.map(s => s.id))
  const observed = (raw: string) => { const k = key(raw); return k ? web.find(w => key(w.url!) === k) : undefined }
  let withheld = false
  const rows = sections.map(s => {
    const linked = s.text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)(?:\s*\[W\d+\])?/g, (_, title: string, url: string) => {
      const found = observed(url)
      if (!found) { withheld = true; return title + ' [source unavailable]' }
      return `[${title}](${found.url}) [${found.id}]`
    })
    const text = linked.replace(/https?:\/\/[^\s<>"\[\]()]+(?:\s*\[W\d+\])?/g, (match, at: number) => {
      // Existing Markdown targets are handled by their normal safe renderer.
      if (linked.slice(at - 2, at) === '](') return match
      const parts = /^(https?:\/\/[^\s\[]+?)([.,;:]?)(?:\s*\[W\d+\])?$/.exec(match)!
      const found = observed(parts[1])
      if (!found) { withheld = true; return '[source unavailable]' + parts[2] }
      return found.url + ` [${found.id}]` + parts[2]
    })
    return { ...s, text, sources: meetingAskCitations(text).filter(id => allowed.has(id)) }
  })
  return { sections: rows, withheld }
}
