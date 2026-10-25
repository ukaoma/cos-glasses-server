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
//
// 6.91.0 (plan r2, contract frozen 2026-10-24). Token-protected too:
//
//   GET    /api/dictation/learned-style   {enabled, rules, text, hash, revision, updatedAt, registers, kinds, allowlist, ...}
//   PUT    /api/dictation/learned-style   {enabled?, rules?: [{id, kind, register, param?, count, lastSeen}], baseRevision?}
//                                         Strict keys. text, hash, revision and updatedAt are the server's
//                                         (400); a stale baseRevision (it covers the rules AND the switch)
//                                         is 409; over 20 rules or 1,500 characters is 413.
//   DELETE /api/dictation/learned-style   Reset: the rules go, the switch stays as it was
//   GET    /api/dictation/polish/options  {promptVersion, effectiveVersion, source, envOverride, updatedAt}
//   PUT    /api/dictation/polish/options  {promptVersion: "default" | "v3"}: Control's "Previous polish"
//
// Clients find them through capabilities.dictationCleanup.learnedStyle {protocol, maxChars,
// maxRules, enabled} and capabilities.dictationCleanup.polishOptions {protocol} on /api/health and
// /api/models. learnedStyle.enabled is false with COS_DICTATION_LEARNED_STYLE=0: the routes still
// answer, and no prompt carries the rules.

import { Router } from 'express'
import {
  DEFAULT_DICTATION_POLISH_PROMPT, DICTATION_POLISH_SYSTEM_PROMPTS, dictationPolishPromptVersion, dictationPolishRules,
  USER_PREFERENCES_INTRO, USER_PREFERENCES_PRECEDENCE,
} from '../lib/dictation-clean.js'
import {
  CUSTOM_INSTRUCTIONS_MAX_CHARS, CUSTOM_INSTRUCTIONS_PROTOCOL, customInstructionsHash, readCustomInstructions,
  sanitizeCustomInstructions, writeCustomInstructions, type StoredInstructions,
} from '../lib/dictation-polish-instructions.js'
import {
  CONTRACTION_PARAMS, LEARNED_STYLE_ALLOWLIST, LEARNED_STYLE_KINDS, LEARNED_STYLE_MAX_CHARS, LEARNED_STYLE_MAX_RULES,
  LEARNED_STYLE_PROTOCOL, LEARNED_STYLE_REGISTERS, learnedStyleEnabled, learnedStyleLinesFor, readLearnedStyle,
  validateLearnedStyleRules, writeLearnedStyle, type StoredLearnedStyle,
} from '../lib/dictation-learned-style.js'
import {
  dictationPolishPromptChoice, POLISH_MODEL_DEFAULTS, POLISH_OPTIONS_PROTOCOL, POLISH_PROMPT_OPTIONS, readPolishOptions,
  styleAndRegisterApply, writePolishOptions, type PolishPromptOption,
} from '../lib/dictation-polish-options.js'
import { LEARNED_STYLE_INTRO, LEARNED_STYLE_LIMITS, learnedStyleBlock, LITERAL_REGISTER_RULES, V4_CLOSING_RULE, V4_LITERAL_CLOSING_RULE } from '../lib/dictation-clean.js'
import { publishedRegisters, registersEnabled } from '../lib/dictation-register.js'

/** Where the instructions apply (prompt-drafts.ts polishInstructionsFor): never meeting lines. */
export const CUSTOM_INSTRUCTIONS_APPLY_TO = ['message', 'prompt_draft'] as const

/** What capabilities.dictationCleanup carries on both health surfaces. Codes and numbers only. */
export function customInstructionsCapability() {
  return { protocol: CUSTOM_INSTRUCTIONS_PROTOCOL, maxChars: CUSTOM_INSTRUCTIONS_MAX_CHARS }
}

/**
 * 6.91.0: capabilities.dictationCleanup.learnedStyle on both health surfaces. Present on every
 * 6.91.0 server; `enabled` is the server's switch (COS_DICTATION_LEARNED_STYLE). Codes and numbers only.
 */
export function learnedStyleCapability() {
  return { protocol: LEARNED_STYLE_PROTOCOL, maxChars: LEARNED_STYLE_MAX_CHARS, maxRules: LEARNED_STYLE_MAX_RULES, enabled: learnedStyleEnabled() }
}
/** 6.91.0: capabilities.dictationCleanup.polishOptions ("Previous polish"). */
export function polishOptionsCapability() {
  return { protocol: POLISH_OPTIONS_PROTOCOL }
}

/** Where the learned style applies (lib/dictation-polish-pipeline.ts learnedStyleFor): never meeting lines. */
export const LEARNED_STYLE_APPLY_TO = ['message', 'prompt_draft'] as const

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

dictationPolishSettingsRouter.get('/dictation/polish/rules', (req, res) => {
  // 6.91.0 option C: each model has its own default (v4 on Sonnet, v3 otherwise). `?model=` picks
  // whose view `version` and `rules` describe; without it they describe the newest default.
  const wanted = typeof req.query?.model === 'string' && (POLISH_MODEL_DEFAULTS as readonly string[]).includes(req.query.model) ? req.query.model : undefined
  const choice = dictationPolishPromptChoice(process.env, wanted)
  const version = choice.version
  const promptByModel = Object.fromEntries(POLISH_MODEL_DEFAULTS.map(model => [model, dictationPolishPromptVersion(process.env, model)]))
  // Learned style and the literal register apply only to the pairs they were canaried on.
  const stylePairs = POLISH_MODEL_DEFAULTS.filter(model => styleAndRegisterApply(model, promptByModel[model])).map(model => ({ model, prompt: promptByModel[model] }))
  const styled = wanted === undefined ? stylePairs.length > 0 : styleAndRegisterApply(wanted, version)
  res.json({
    version,
    defaultVersion: DEFAULT_DICTATION_POLISH_PROMPT,
    rolledBack: choice.source !== 'default',
    systemPrompt: DICTATION_POLISH_SYSTEM_PROMPTS[version],
    rules: dictationPolishRules(version).join('\n'),
    // The block exactly as the model sees it, with a placeholder for the user's words.
    userBlock: [...USER_PREFERENCES_INTRO, '<user-style-preferences>', INSTRUCTIONS_PLACEHOLDER, '</user-style-preferences>', USER_PREFERENCES_PRECEDENCE].join('\n'),
    maxChars: CUSTOM_INSTRUCTIONS_MAX_CHARS,
    // 6.91.0: which prompt each model gets, the rules of each prompt in use, and where the learned
    // style and the literal register apply (Sonnet with v4 only: the pair canaries C2 and C3 ran on).
    ...(wanted ? { model: wanted } : {}),
    promptByModel,
    rulesByPrompt: Object.fromEntries([...new Set(Object.values(promptByModel))].map(v => [v, dictationPolishRules(v).join('\n')])),
    stylePairs,
    registersEnabled: registersEnabled(),
    // The other blocks exactly as the model sees them. The learned style is the saved rules rendered
    // from the server's templates ('' when none apply); the literal block goes to terminals only
    // (none with COS_DICTATION_REGISTERS=0); the closing line is v4's.
    learnedStyleBlock: styled && learnedStyleEnabled() ? learnedStyleBlock(learnedStyleLinesFor(readLearnedStyle(), 'default')).join('\n').trim() : '',
    learnedStyleFrame: [LEARNED_STYLE_INTRO, '<learned-style>', LEARNED_STYLE_PLACEHOLDER, '</learned-style>', LEARNED_STYLE_LIMITS].join('\n'),
    registerBlocks: styled && registersEnabled() && version === 'v4' ? { literal: LITERAL_REGISTER_RULES.join('\n') } : {},
    closingRules: version === 'v4' ? { default: V4_CLOSING_RULE, literal: V4_LITERAL_CLOSING_RULE } : {},
  })
})

/** The placeholder the rules view shows where the learned-style lines go. */
export const LEARNED_STYLE_PLACEHOLDER = '(your learned style rules)'

// ---------------------------------------------------------------------------------------------
// 6.91.0 learned style and polish options.

function styleView(stored: StoredLearnedStyle) {
  return {
    enabled: stored.enabled,
    rules: stored.rules,
    text: stored.text,
    hash: stored.hash,
    revision: stored.revision,
    updatedAt: stored.updatedAt,
    // Control reads the app-to-register map here, so it never keeps a second table. The literal
    // register is opt-in (COS_DICTATION_REGISTERS=1); `registersEnabled` says whether it applies.
    registers: publishedRegisters(),
    registersEnabled: registersEnabled(),
    kinds: LEARNED_STYLE_KINDS,
    registerValues: LEARNED_STYLE_REGISTERS,
    allowlist: LEARNED_STYLE_ALLOWLIST,
    contractionParams: CONTRACTION_PARAMS,
    maxChars: LEARNED_STYLE_MAX_CHARS,
    maxRules: LEARNED_STYLE_MAX_RULES,
    serverEnabled: learnedStyleEnabled(),
    appliesTo: LEARNED_STYLE_APPLY_TO,
  }
}

const STYLE_PUT_KEYS = new Set(['enabled', 'rules', 'baseRevision'])
const SERVER_OWNED = new Set(['text', 'hash', 'revision', 'updatedAt'])

/** A Node error code ("EACCES") for the log, never a message (a message can carry the path). */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,23}$/.test(code) ? code : 'error'
}

dictationPolishSettingsRouter.get('/dictation/learned-style', (_req, res) => {
  res.json(styleView(readLearnedStyle()))
})

dictationPolishSettingsRouter.put('/dictation/learned-style', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'invalid_body' })
  const keys = Object.keys(body)
  const owned = keys.find(key => SERVER_OWNED.has(key))
  if (owned) return res.status(400).json({ error: 'server_owned_field', field: owned })
  if (!keys.every(key => STYLE_PUT_KEYS.has(key)) || !('rules' in body || 'enabled' in body)) {
    return res.status(400).json({ error: 'invalid_body', expected: { enabled: 'boolean?', rules: '[{id, kind, register, param, count, lastSeen}]?', baseRevision: 'string?' } })
  }
  if ('enabled' in body && typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'invalid_enabled' })
  if ('baseRevision' in body && (typeof body.baseRevision !== 'string' || !/^[0-9a-f]{8}$/.test(body.baseRevision))) {
    return res.status(400).json({ error: 'invalid_base_revision' })
  }
  const current = readLearnedStyle()
  if (typeof body.baseRevision === 'string' && body.baseRevision !== current.revision) {
    // Someone else saved first (rules or the switch): re-GET and merge.
    return res.status(409).json({ error: 'base_revision_mismatch', revision: current.revision })
  }
  let rules = current.rules
  if ('rules' in body) {
    const clean = validateLearnedStyleRules(body.rules)
    if (!clean.ok) {
      return res.status(clean.status).json({
        error: clean.error,
        ...(clean.index !== undefined ? { index: clean.index } : {}),
        ...(clean.max !== undefined ? { max: clean.max } : {}),
      })
    }
    rules = clean.rules
  }
  try {
    res.json(styleView(writeLearnedStyle(typeof body.enabled === 'boolean' ? body.enabled : current.enabled, rules)))
  } catch (err) {
    // The reason stays generic: an fs error can carry the path, never the rules, but say less.
    console.warn(`[dictation-polish] learned_style_not_saved put (${errorCode(err)})`)
    res.status(500).json({ error: 'learned_style_not_saved' })
  }
})

dictationPolishSettingsRouter.delete('/dictation/learned-style', (_req, res) => {
  try {
    // Reset clears the rules and leaves the person's switch as it was: an Off stays off.
    res.json(styleView(writeLearnedStyle(readLearnedStyle().enabled, [])))
  } catch (err) {
    console.warn(`[dictation-polish] learned_style_not_saved delete (${errorCode(err)})`)
    res.status(500).json({ error: 'learned_style_not_saved' })
  }
})

function optionsView() {
  const stored = readPolishOptions()
  const choice = dictationPolishPromptChoice()
  return {
    promptVersion: stored.promptVersion,
    effectiveVersion: choice.version,
    // 6.91.0 option C: the prompt each model actually gets.
    effectiveByModel: Object.fromEntries(POLISH_MODEL_DEFAULTS.map(model => [model, dictationPolishPromptChoice(process.env, model).version])),
    source: choice.source,
    // The environment named a version, so this option has no effect until it is removed.
    envOverride: choice.source === 'env',
    options: POLISH_PROMPT_OPTIONS,
    updatedAt: stored.updatedAt,
  }
}

dictationPolishSettingsRouter.get('/dictation/polish/options', (_req, res) => {
  res.json(optionsView())
})

dictationPolishSettingsRouter.put('/dictation/polish/options', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).every(key => key === 'promptVersion')
    || !(POLISH_PROMPT_OPTIONS as readonly string[]).includes(body.promptVersion)) {
    return res.status(400).json({ error: 'invalid_body', expected: { promptVersion: POLISH_PROMPT_OPTIONS } })
  }
  try {
    writePolishOptions(body.promptVersion as PolishPromptOption)
    res.json(optionsView())
  } catch (err) {
    console.warn(`[dictation-polish] options_not_saved (${errorCode(err)})`)
    res.status(500).json({ error: 'options_not_saved' })
  }
})
