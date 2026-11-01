// Live cues v3 grounded judge ("judge B"): ONE Jev request per evaluation that asks, for each candidate, whether it is directly
// relevant to what is being said now (a `choice` {yes, no} question per candidate), plus production's own `same` choice as a
// logged diagnostic. The wording below is copied verbatim from the replay that measured it (cue_rrf_replay prompts.py:
// REL_YES, REL_NO, the rel_<id> instructions, note_line at 300 characters). A candidate is kept when its own yes probability
// reaches judgeYes, so two relevant notes no longer split one probability and both lose, which is what the single `same`
// question did (the replay's kept>0 rate went from 18% to 45% with 79% directly useful and none irrelevant).
//
// Hand-written on purpose: live-cues-v2-prompts.ts is GENERATED and its hash is pinned. The `same` question reuses that
// file's instructions and none sentence unchanged.

import { CUE_JUDGE_INSTRUCTIONS, CUE_JUDGE_NONE } from './live-cues-v2-prompts.js'

export const JUDGE_B_WINDOW_CHARS = 2_200
export const JUDGE_B_NOTE_CHARS = 300
export const CUE_REL_YES = 'Yes: the note is about the same client, project, brand, person or decision as the conversation, and would help the wearer right now.'
export const CUE_REL_NO = 'No: the note is about something else, or is only loosely related to the conversation.'

export interface JudgeBCandidate { id: string; date: string; title: string; notes: string }

/** The note as the judge reads it: date, title, then the first 300 characters of the note. */
export function judgeNoteLine(c: JudgeBCandidate): string {
  return `${c.date} ${c.title}: ${c.notes.slice(0, JUDGE_B_NOTE_CHARS)}`
}

/** The `same` question first (production's wording and criteria, so it stays comparable), then one yes/no question per candidate. */
export function judgeBQuestions(cands: JudgeBCandidate[]): Record<string, unknown> {
  const criteria: Record<string, string> = Object.fromEntries(cands.map(c => [c.id, judgeNoteLine(c)]))
  criteria.none = CUE_JUDGE_NONE
  const questions: Record<string, unknown> = { same: { type: 'choice', instructions: CUE_JUDGE_INSTRUCTIONS, criteria } }
  for (const c of cands) {
    questions['rel_' + c.id] = { type: 'choice',
      instructions: 'Is this past meeting note directly relevant to what is being discussed in the last part of `window`? Past note: ' + judgeNoteLine(c),
      criteria: { yes: CUE_REL_YES, no: CUE_REL_NO } }
  }
  return questions
}

/** Each candidate's yes probability and its `same` probability. A missing, non-numeric or out-of-range value reads as 0, so a
 *  malformed answer can never keep a note. */
export function parseJudgeB(answers: Record<string, { probabilities?: Record<string, number> } | undefined> | undefined,
  ids: string[]): { yes: Record<string, number>; same: Record<string, number> } {
  const prob = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0)
  const yes: Record<string, number> = {}, same: Record<string, number> = {}
  for (const id of ids) {
    yes[id] = prob(answers?.['rel_' + id]?.probabilities?.yes)
    same[id] = prob(answers?.same?.probabilities?.[id])
  }
  return { yes, same }
}

/** The candidates the writer sees: yes at or above the threshold, best first (ties keep candidate order), at most `max`. */
export function selectJudgeB<T extends { id: string }>(cands: T[], yes: Record<string, number>, threshold: number, max: number): T[] {
  return cands
    .map((c, order) => ({ c, order, p: yes[c.id] ?? 0 }))
    .filter(x => x.p >= threshold)
    .sort((a, b) => b.p - a.p || a.order - b.order)
    .slice(0, max)
    .map(x => x.c)
}
