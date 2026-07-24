import { Router } from 'express'
import {
  PromptEditValidationError,
  applyPromptEdit,
  normalizePromptEditInput,
} from '../lib/prompt-edit.js'
import { errMsg } from '../lib/utils.js'

export const promptEditRouter = Router()

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
  try {
    const input = normalizePromptEditInput(req.body)
    const revisedText = await applyPromptEdit(input, abort.signal)
    res.json({ revisedText })
  } catch (err) {
    if (err instanceof PromptEditValidationError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    res.status(500).json({ error: errMsg(err) })
  }
})
