// OpenAI key management endpoints — phone-side Settings panel writes the key
// here so users never have to edit a .env file or rerun the wizard.
//
// Wire-protocol contract: the key is push-only. The phone POSTs it to /set;
// the server validates against OpenAI, persists to server/data/openai-key.json,
// and from then on only ever returns metadata (hasKey/source/savedAt/...). The
// raw key value is never echoed back to any client. Same intent as the
// existing /api/tts/* contract that the OPENAI_API_KEY must never reach the
// client.
//
// Resolution priority is enforced upstream by openai-key.ts:
//   env > server/data/openai-key.json > COS scripts .env regex
// So saving via Settings is a no-op when an env-level OPENAI_API_KEY exists.
// /status reflects that honestly so the UI can render "Active (env)" instead
// of pretending the saved value is in use.

import { Router } from 'express'
import { existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { errMsg } from '../lib/utils.js'
import { durableAtomicWriteFileSync } from '../lib/atomic-fs.js'
import { KEY_FILE_PATH, clearCachedKey, getKeyStatus } from '../lib/openai-key.js'
import { securePrivateDirectory } from '../lib/secure-user-config.js'

export const openaiKeyRouter = Router()

/** Validate a candidate key by listing models. The /v1/models endpoint is
 *  cheap (returns ~50 model IDs in JSON), supported by every OpenAI-compatible
 *  proxy, and returns 401 on a bad key — so a successful 200 confirms the key
 *  works for our usage without billing anything. */
async function validateKey(key: string): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (res.ok) return { ok: true }
    const body = await res.text().catch(() => '')
    return {
      ok: false,
      status: res.status,
      reason: body.slice(0, 200) || `OpenAI returned ${res.status}`,
    }
  } catch (err) {
    return { ok: false, status: 0, reason: errMsg(err) }
  }
}

// POST /api/openai-key/set — body { key }. Validates against OpenAI then
// writes server/data/openai-key.json. Returns metadata only.
openaiKeyRouter.post('/openai-key/set', async (req, res) => {
  try {
    const raw = req.body?.key
    if (typeof raw !== 'string') {
      return res.status(400).json({ error: 'key is required (string)' })
    }
    const key = raw.trim()
    if (!key) {
      return res.status(400).json({ error: 'key is empty after trim' })
    }
    // Light shape check — sk- prefix is the historical OpenAI convention but
    // proxies (Azure, third-party gateways) use other prefixes too. Length is
    // the safer guard. We rely on the live /v1/models call to reject bad keys.
    if (key.length < 16 || key.length > 512) {
      return res.status(400).json({ error: 'key length looks wrong (expected 16-512 chars)' })
    }

    const validation = await validateKey(key)
    if (!validation.ok) {
      return res.status(400).json({
        error: `validation failed: ${validation.reason}`,
        upstreamStatus: validation.status,
      })
    }

    const now = new Date().toISOString()
    const payload = JSON.stringify({ key, savedAt: now, validatedAt: now }, null, 2)

    // Ensure parent dir exists (server/data/ is gitignored but may not exist
    // on a fresh checkout that's never run a budget write).
    const parent = dirname(KEY_FILE_PATH)
    securePrivateDirectory(parent)

    durableAtomicWriteFileSync(KEY_FILE_PATH, payload, { mode: 0o600 })
    clearCachedKey()

    const status = getKeyStatus()
    return res.json({
      ok: true,
      validatedAt: now,
      // Echo back the resolved source — if env is set, source will still be
      // 'env' here (env wins over the file we just wrote). The client uses
      // this to surface "Saved (but env override is active)" when relevant.
      activeSource: status.source,
    })
  } catch (err) {
    return res.status(500).json({ error: errMsg(err) })
  }
})

// GET /api/openai-key/status — { hasKey, source, savedAt?, validatedAt? }.
// Never returns the key value.
openaiKeyRouter.get('/openai-key/status', (_req, res) => {
  try {
    return res.json(getKeyStatus())
  } catch (err) {
    return res.status(500).json({ error: errMsg(err) })
  }
})

// DELETE /api/openai-key — removes server/data/openai-key.json. The env or
// scripts-env source (if set) takes over on the next resolve.
openaiKeyRouter.delete('/openai-key', (_req, res) => {
  try {
    if (existsSync(KEY_FILE_PATH)) unlinkSync(KEY_FILE_PATH)
    clearCachedKey()
    return res.json({ ok: true, ...getKeyStatus() })
  } catch (err) {
    return res.status(500).json({ error: errMsg(err) })
  }
})
