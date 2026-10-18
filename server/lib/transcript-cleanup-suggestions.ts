// Dictionary suggestions from transcript cleanup (6.77.0).
//
// When a cleanup edit is accepted and what it wrote is a term this meeting's CONTEXT
// supplied (a screen line, a dropped file, the owner card, COS people, a notes hit) and
// the dictionary does not already hold it, COS records a SUGGESTION: the written form,
// the heard forms, and where the evidence came from. Never an automatic addition. A
// person accepts it (the word joins the profile vocabulary through the glossary's own
// writer, optionally with its heard form as a logged, undoable correction) or dismisses
// it (that written form is never suggested again).
//
// One file, `transcript-cleanup/suggestions.json`, rewritten atomically. Deduped by the
// written form, case-insensitive. Bounded: 200 suggestions, 5 heard forms and 5 evidence
// rows each; accepted and dismissed ones are evicted before pending ones. Evidence rows
// carry ids, a file or app name and a time, never transcript or screen text.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { cleanupDir } from './transcript-cleanup-screen.js'
import type { EvidenceSource } from './transcript-cleanup-context.js'

export const SUGGESTION_LIMITS = { suggestions: 200, heard: 5, evidence: 5 } as const
export const SUGGESTION_ID = /^sug_[0-9a-f]{16}$/

export interface SuggestionEvidence {
  source: EvidenceSource
  sessionId: string
  heard: string
  at: string
  detail: string | null
}

export interface DictionarySuggestion {
  id: string
  written: string
  heard: string[]
  status: 'pending' | 'accepted' | 'dismissed'
  count: number
  createdAt: string
  updatedAt: string
  evidence: SuggestionEvidence[]
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export class SuggestionStore {
  constructor(readonly file: string = cleanupDir('suggestions.json')) {}

  list(): DictionarySuggestion[] {
    try {
      if (!existsSync(this.file)) return []
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { suggestions?: unknown }
      if (!raw || !Array.isArray(raw.suggestions)) return []
      return raw.suggestions.filter((s): s is DictionarySuggestion => !!s && typeof s === 'object'
        && typeof (s as DictionarySuggestion).id === 'string' && typeof (s as DictionarySuggestion).written === 'string'
        && ['pending', 'accepted', 'dismissed'].includes((s as DictionarySuggestion).status)
        && Array.isArray((s as DictionarySuggestion).heard) && Array.isArray((s as DictionarySuggestion).evidence))
    } catch {
      return []
    }
  }

  private write(list: DictionarySuggestion[]): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    durableAtomicWriteFileSync(this.file, JSON.stringify({ schema: 1, suggestions: list }, null, 2) + '\n', { mode: 0o600 })
  }

  get(id: string): DictionarySuggestion | null {
    return this.list().find(s => s.id === id) ?? null
  }

  /**
   * Record one piece of evidence for a written form. Returns the suggestion, or null when
   * nothing was recorded: no evidence, the form is already in the dictionary, or it was
   * dismissed before.
   */
  record(input: { written: string; heard: string; evidence: Array<{ source: EvidenceSource; detail: string | null }>; sessionId: string; at: string; inDictionary: (written: string) => boolean }): DictionarySuggestion | null {
    const written = input.written.replace(/\s+/g, ' ').trim()
    if (!written || written.length > 100 || !input.evidence.length) return null
    if (input.inDictionary(written)) return null
    const list = this.list()
    const existing = list.find(s => same(s.written, written))
    if (existing && existing.status !== 'pending') return null
    const rows: SuggestionEvidence[] = input.evidence.map(e => ({ source: e.source, sessionId: input.sessionId, heard: input.heard.slice(0, 100), at: input.at, detail: e.detail }))
    let out: DictionarySuggestion
    if (existing) {
      if (!existing.heard.some(h => same(h, input.heard)) && existing.heard.length < SUGGESTION_LIMITS.heard) existing.heard.push(input.heard.slice(0, 100))
      for (const row of rows) {
        const dup = existing.evidence.some(e => e.source === row.source && e.sessionId === row.sessionId && same(e.heard, row.heard))
        if (!dup && existing.evidence.length < SUGGESTION_LIMITS.evidence) existing.evidence.push(row)
      }
      existing.count += 1
      existing.updatedAt = input.at
      out = existing
    } else {
      out = { id: `sug_${randomBytes(8).toString('hex')}`, written, heard: [input.heard.slice(0, 100)], status: 'pending', count: 1, createdAt: input.at, updatedAt: input.at, evidence: rows.slice(0, SUGGESTION_LIMITS.evidence) }
      list.push(out)
    }
    this.write(evict(list))
    return out
  }

  setStatus(id: string, status: 'accepted' | 'dismissed', at: string): DictionarySuggestion | null {
    const list = this.list()
    const s = list.find(x => x.id === id)
    if (!s) return null
    s.status = status
    s.updatedAt = at
    this.write(list)
    return s
  }
}

function evict(list: DictionarySuggestion[]): DictionarySuggestion[] {
  if (list.length <= SUGGESTION_LIMITS.suggestions) return list
  const ordered = [...list].sort((a, b) => (a.status === 'pending' ? 1 : 0) - (b.status === 'pending' ? 1 : 0) || a.updatedAt.localeCompare(b.updatedAt))
  const drop = new Set(ordered.slice(0, list.length - SUGGESTION_LIMITS.suggestions).map(s => s.id))
  return list.filter(s => !drop.has(s.id))
}

let singleton: SuggestionStore | null = null
export function suggestionStore(): SuggestionStore {
  if (!singleton) singleton = new SuggestionStore()
  return singleton
}
