import { Router } from 'express'
import type { Response } from 'express'
import {
  PROMPT_EDIT_REFUSALS,
  PromptEditValidationError,
  applyPromptEdit,
  buildPromptEditPrompt,
  normalizePromptEditInput,
  promptEditBreaker,
  promptEditModel,
  promptEditRefusal,
  recordPromptEditCall,
  type PromptEditRefusal,
} from '../lib/prompt-edit.js'
import { ClaudeTextError } from '../lib/claude-text-runner.js'
import { logTokenAudit } from '../lib/token-audit.js'

export const promptEditRouter = Router()

/** 6.92.0: a short text/plain body (24 characters or fewer), which G2 6.10.654 shows after "Edit failed.". */
function refuse(res: Response, refusal: PromptEditRefusal): void {
  const { status, body } = PROMPT_EDIT_REFUSALS[refusal]
  res.status(status).type('text/plain').send(body)
}

promptEditRouter.post('/prompt-edit', async (req, res) => {
  const abort = new AbortController()
  // Abort the model spawn ONLY if the client disconnects before we respond.
  // Must listen on `res`, not `req`: express.json() fully drains the request
  // body stream before this handler runs, so `req` emits 'close' on the next
  // tick and would abort EVERY edit mid-flight (instant 500 "Prompt edit
  // aborted"). `res` 'close' + !writableEnded fires only on a genuine premature
  // disconnect. (House pattern: see routes/query.ts.)
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  // 6.92.0: the switch first, so "off" answers the same whatever the body.
  if (promptEditRefusal() === 'off') return refuse(res, 'off')
  let input
  try {
    input = normalizePromptEditInput(req.body)
  } catch (err) {
    if (err instanceof PromptEditValidationError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    return refuse(res, 'failed')
  }
  const refusal = promptEditRefusal()
  if (refusal) return refuse(res, refusal)
  // Counted before the call, as the dictation polish counts: a call that started was spent.
  recordPromptEditCall()
  const startedAt = Date.now()
  const audit = (outcome: 'ok' | 'failed' | 'aborted', outputChars: number) => logTokenAudit({
    source: 'g2-prompt-edit', model: promptEditModel(), inputChars: buildPromptEditPrompt(input).length, outputChars,
    durationMs: Date.now() - startedAt, caller: 'prompt_edit', promptEditOutcome: outcome,
  })
  try {
    const revisedText = await applyPromptEdit(input, abort.signal)
    promptEditBreaker.recordSuccess()
    audit('ok', revisedText.length)
    res.json({ revisedText })
  } catch (err) {
    if (abort.signal.aborted) {
      // The phone went away: not a CLI failure, so the breaker neither counts nor resets.
      audit('aborted', 0)
      return
    }
    promptEditBreaker.recordFailure()
    audit('failed', 0)
    // A code only: the CLI's stdout and stderr can carry the draft.
    console.warn(`[prompt-edit] failed (${err instanceof ClaudeTextError ? err.code : 'error'})`)
    refuse(res, 'failed')
  }
})
