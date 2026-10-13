// Home city — where the owner is based, for Meeting Ask fact checks that leave a starting point implicit
// ("flying from here"). Persists as profile `home_city`. City level only: HOME_AREA_LABEL refuses digits, so a
// street address can never be stored. Auto token-protected by the /api middleware (server/index.ts).
//
//   GET /api/home-area → { homeCity: string | null, effective: { text, source } | null }
//   PUT /api/home-area   { homeCity: "Austin, TX" } sets it; { homeCity: "" } or null clears it, and the
//                        phone's last reported area is used again.
//
// Clients find the route by calling GET: a 404 means an older server, so they hide the setting.

import { Router } from 'express'
import { getOwnerHomeArea, HOME_AREA_LABEL, updateProfileFields } from '../lib/profile.js'
import { defaultOwnerArea } from '../lib/meeting-fact-check.js'
import { errMsg } from '../lib/utils.js'

export const homeAreaRouter = Router()

function current() {
  return { homeCity: getOwnerHomeArea(), effective: defaultOwnerArea() }
}

homeAreaRouter.get('/home-area', (_req, res) => {
  try { res.json(current()) } catch (err) { res.status(500).json({ error: errMsg(err) }) }
})

homeAreaRouter.put('/home-area', (req, res) => {
  const raw = (req.body as { homeCity?: unknown } | undefined)?.homeCity
  if (raw !== null && raw !== undefined && typeof raw !== 'string') return res.status(400).json({ error: 'homeCity must be a string or null' })
  const value = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (value && !HOME_AREA_LABEL.test(value)) return res.status(400).json({ error: 'Use a city and state, like Austin, TX. Letters only, no street address.' })
  try {
    updateProfileFields({ home_city: value })
    res.json(current())
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})
