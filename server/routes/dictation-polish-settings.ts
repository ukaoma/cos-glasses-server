// 6.85.0 "Your polish instructions". Token-protected by the /api middleware.
//
//   GET    /api/dictation/polish/instructions   the saved instructions (or ""), the cap, a hash
//   PUT    /api/dictation/polish/instructions   {"customInstructions": "..."}; "" turns it off
//   DELETE /api/dictation/polish/instructions   Clear (the same as PUT "")
//   GET    /api/dictation/polish/rules          the built-in rules in use (v3, or v2 when rolled
//                                               back) and the block the instructions go into
//
// Clients find it through capabilities.dictationCleanup.customInstructions on /api/health and
// /api/models; an older server omits it (and answers 404 here), so the clients hide the box.
// The text is never logged and never returned anywhere but GET/PUT here.

import { Router } from 'express'
import {
  DEFAULT_DICTATION_POLISH_PROMPT, DICTATION_POLISH_SYSTEM_PROMPTS, dictationPolishPromptVersion, dictationPolishRules,
  USER_PREFERENCES_INTRO, USER_PREFERENCES_PRECEDENCE,
} from '../lib/dictation-clean.js'
import {
  CUSTOM_INSTRUCTIONS_MAX_CHARS, CUSTOM_INSTRUCTIONS_PROTOCOL, customInstructionsHash, readCustomInstructions,
  sanitizeCustomInstructions, writeCustomInstructions, type StoredInstructions,
} from '../lib/dictation-polish-instructions.js'

/** Where the instructions apply (prompt-drafts.ts polishInstructionsFor): never meeting lines. */
export const CUSTOM_INSTRUCTIONS_APPLY_TO = ['message', 'prompt_draft'] as const

/** What capabilities.dictationCleanup carries on both health surfaces. Codes and numbers only. */
export function customInstructionsCapability() {
  return { protocol: CUSTOM_INSTRUCTIONS_PROTOCOL, maxChars: CUSTOM_INSTRUCTIONS_MAX_CHARS }
}

function view(stored: StoredInstructions) {
  return {
    customInstructions: stored.customInstructions,
    enabled: stored.customInstructions.length > 0,
    updatedAt: stored.updatedAt,
    instructionsHash: customInstructionsHash(stored.customInstructions),
    maxChars: CUSTOM_INSTRUCTIONS_MAX_CHARS,
    appliesTo: CUSTOM_INSTRUCTIONS_APPLY_TO,
  }
}

/** The placeholder the rules view shows where the user's own words go. */
export const INSTRUCTIONS_PLACEHOLDER = '(your polish instructions)'

export const dictationPolishSettingsRouter = Router()

dictationPolishSettingsRouter.get('/dictation/polish/instructions', (_req, res) => {
  res.json(view(readCustomInstructions()))
})

dictationPolishSettingsRouter.put('/dictation/polish/instructions', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).every(key => key === 'customInstructions')) {
    return res.status(400).json({ error: 'invalid_body', expected: { customInstructions: 'string' } })
  }
  const clean = sanitizeCustomInstructions(body.customInstructions)
  if (!clean.ok) {
    return res.status(clean.error === 'too_long' ? 413 : 400).json({
      error: clean.error === 'too_long' ? 'instructions_too_long' : 'instructions_not_a_string',
      maxChars: clean.maxChars, ...(clean.length !== undefined ? { length: clean.length } : {}),
    })
  }
  try {
    res.json(view(writeCustomInstructions(clean.value)))
  } catch {
    // The reason stays generic: an fs error can carry the path, never the text, but say less.
    res.status(500).json({ error: 'instructions_not_saved' })
  }
})

dictationPolishSettingsRouter.delete('/dictation/polish/instructions', (_req, res) => {
  try {
    res.json(view(writeCustomInstructions('')))
  } catch {
    res.status(500).json({ error: 'instructions_not_saved' })
  }
})

dictationPolishSettingsRouter.get('/dictation/polish/rules', (_req, res) => {
  const version = dictationPolishPromptVersion()
  res.json({
    version,
    defaultVersion: DEFAULT_DICTATION_POLISH_PROMPT,
    rolledBack: version !== DEFAULT_DICTATION_POLISH_PROMPT,
    systemPrompt: DICTATION_POLISH_SYSTEM_PROMPTS[version],
    rules: dictationPolishRules(version).join('\n'),
    // The block exactly as the model sees it, with a placeholder for the user's words.
    userBlock: [...USER_PREFERENCES_INTRO, '<user-style-preferences>', INSTRUCTIONS_PLACEHOLDER, '</user-style-preferences>', USER_PREFERENCES_PRECEDENCE].join('\n'),
    maxChars: CUSTOM_INSTRUCTIONS_MAX_CHARS,
  })
})
