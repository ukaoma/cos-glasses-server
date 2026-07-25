// Optional, public-safe pronunciation lexicon for local Kokoro and OpenAI TTS.
// No personal names ship in the npm package. Operators may opt in with:
// COS_TTS_PRONUNCIATIONS_JSON='{"Exampleco":{"local":"[Exampleco](/ɪgzˈæmpəlkoʊ/)","openai":"ig-ZAM-pul-co"}}'

interface PronunciationEntry {
  local?: string
  openai?: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readLexicon(): Array<{ term: string; local?: string; openai?: string }> {
  const raw = (process.env.COS_TTS_PRONUNCIATIONS_JSON || '').trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Record<string, PronunciationEntry>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.entries(parsed)
      .slice(0, 64)
      .flatMap(([term, entry]) => {
        const cleanTerm = term.trim()
        if (!cleanTerm || cleanTerm.length > 64 || !entry || typeof entry !== 'object') return []
        const local = typeof entry.local === 'string' && entry.local.length <= 160 ? entry.local : undefined
        const openai = typeof entry.openai === 'string' && entry.openai.length <= 160 ? entry.openai : undefined
        return local || openai ? [{ term: cleanTerm, local, openai }] : []
      })
  } catch {
    console.warn('[tts-pronounce] invalid COS_TTS_PRONUNCIATIONS_JSON; ignoring')
    return []
  }
}

export function applyLocalPronunciation(text: string): string {
  let out = text
  for (const entry of readLexicon()) {
    if (!entry.local) continue
    const pattern = new RegExp(`(?<!\\[)\\b${escapeRegExp(entry.term)}\\b`, 'gi')
    out = out.replace(pattern, entry.local)
  }
  return out
}

export function applyOpenAIPronunciation(text: string): string {
  let out = text
  for (const entry of readLexicon()) {
    if (!entry.openai) continue
    const pattern = new RegExp(`\\b${escapeRegExp(entry.term)}\\b`, 'gi')
    out = out.replace(pattern, entry.openai)
  }
  return out
}
