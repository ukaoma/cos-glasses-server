// GET /api/welcome-context — weather + optional next event for glasses home.
// Weather uses phone-supplied lat/lon (Even Hub WebView geolocation). The Mac
// only proxies Open-Meteo / reverse-geocode — it is not "server location".

import { Router } from 'express'
import { callPython } from '../lib/python-bridge.js'

export const welcomeContextRouter = Router()

const WEATHER_TTL_MS = 30 * 60_000
const GEOCODE_TIMEOUT_MS = 3_000
const FORECAST_TIMEOUT_MS = 3_000
const CALENDAR_TTL_MS = 2 * 60_000
const COORD_MOVE_DEG = 0.05 // ~5km

type WeatherPayload = { temp: string; desc: string; location: string }
type NextEventPayload = { title: string; time: string; inMinutes?: number }

let cachedWeather: WeatherPayload | null = null
let weatherFetchedAt = 0
let lastKnownLat: number | undefined
let lastKnownLon: number | undefined
let lastKnownCity = ''

let cachedNextEvent: NextEventPayload | null = null
let calendarFetchedAt = 0

/** Full WMO 4677 — discrete codes, exact match required. */
export const WMO_CODES: Record<number, string> = {
  0: 'Clear',
  1: 'Mostly Clear',
  2: 'Partly Cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Rime Fog',
  51: 'Light Drizzle',
  53: 'Drizzle',
  55: 'Heavy Drizzle',
  56: 'Freezing Drizzle',
  57: 'Icy Drizzle',
  61: 'Light Rain',
  63: 'Rain',
  65: 'Heavy Rain',
  66: 'Freezing Rain',
  67: 'Icy Rain',
  71: 'Light Snow',
  73: 'Snow',
  75: 'Heavy Snow',
  77: 'Snow Grains',
  80: 'Light Showers',
  81: 'Showers',
  82: 'Violent Showers',
  85: 'Snow Showers',
  86: 'Heavy Snow Showers',
  95: 'Thunderstorm',
  96: 'T-Storm + Hail',
  99: 'Severe T-Storm',
}

export function wmoDescription(code: number): string {
  if (code in WMO_CODES) return WMO_CODES[code]
  if (code >= 95) return 'Thunderstorm'
  if (code >= 80) return 'Showers'
  if (code >= 71) return 'Snow'
  if (code >= 61) return 'Rain'
  if (code >= 51) return 'Drizzle'
  if (code >= 45) return 'Foggy'
  if (code >= 1) return 'Cloudy'
  return 'Clear'
}

export function parseCoord(raw: unknown, kind: 'lat' | 'lon'): number | undefined {
  if (raw == null || raw === '') return undefined
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw))
  if (!Number.isFinite(n)) return undefined
  if (kind === 'lat' && (n < -90 || n > 90)) return undefined
  if (kind === 'lon' && (n < -180 || n > 180)) return undefined
  return n
}

function envDefaultCoords(): { lat: number; lon: number; city: string } | null {
  const lat = parseCoord(process.env.COS_WEATHER_DEFAULT_LAT, 'lat')
  const lon = parseCoord(process.env.COS_WEATHER_DEFAULT_LON, 'lon')
  if (lat == null || lon == null) return null
  const city = (process.env.COS_WEATHER_DEFAULT_CITY || '').trim()
  return { lat, lon, city }
}

/** Resolve coords: phone query → last successful this process → optional env home. */
export function resolveWeatherCoords(
  queryLat?: number,
  queryLon?: number,
): { lat: number; lon: number; source: 'query' | 'last' | 'env' } | null {
  if (queryLat != null && queryLon != null) {
    return { lat: queryLat, lon: queryLon, source: 'query' }
  }
  if (lastKnownLat != null && lastKnownLon != null) {
    return { lat: lastKnownLat, lon: lastKnownLon, source: 'last' }
  }
  const env = envDefaultCoords()
  if (env) return { lat: env.lat, lon: env.lon, source: 'env' }
  return null
}

async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
      { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) },
    )
    if (!res.ok) return lastKnownCity
    const data = await res.json() as {
      city?: string
      locality?: string
      principalSubdivision?: string
      principalSubdivisionCode?: string
      countryCode?: string
    }
    const city = data.city || data.locality || data.principalSubdivision || ''
    const region = data.principalSubdivisionCode?.split('-')[1] || data.countryCode || ''
    if (city) {
      lastKnownCity = region ? `${city}, ${region}` : city
    }
    return lastKnownCity
  } catch {
    return lastKnownCity
  }
}

/** Ensure a city label before any weather JSON leaves the server (3s capped). */
async function ensureCityLabel(lat: number, lon: number, source: 'query' | 'last' | 'env'): Promise<void> {
  if (lastKnownCity) return
  if (source === 'env') {
    const env = envDefaultCoords()
    if (env?.city) {
      lastKnownCity = env.city
      return
    }
  }
  await reverseGeocode(lat, lon)
}

export async function fetchWeather(
  queryLat?: number,
  queryLon?: number,
): Promise<WeatherPayload | null> {
  const resolved = resolveWeatherCoords(queryLat, queryLon)
  if (!resolved) return null

  const { lat: useLat, lon: useLon, source } = resolved
  const coordsChanged = source === 'query'
    && (
      lastKnownLat == null
      || lastKnownLon == null
      || Math.abs(useLat - lastKnownLat) > COORD_MOVE_DEG
      || Math.abs(useLon - lastKnownLon) > COORD_MOVE_DEG
    )

  if (coordsChanged) {
    lastKnownLat = useLat
    lastKnownLon = useLon
    weatherFetchedAt = 0
    lastKnownCity = '' // force fresh reverse-geocode for the new place
  } else if (lastKnownLat == null || lastKnownLon == null) {
    lastKnownLat = useLat
    lastKnownLon = useLon
  }

  // Warning fix: never return weather (cached or fresh) without a city when
  // we can still resolve one — closes reverse-geocode race on first paint.
  await ensureCityLabel(useLat, useLon, source)

  if (cachedWeather && Date.now() - weatherFetchedAt < WEATHER_TTL_MS) {
    // Refresh location string if geocode caught up after an older cache write.
    if (lastKnownCity && cachedWeather.location !== lastKnownCity) {
      cachedWeather = { ...cachedWeather, location: lastKnownCity }
    }
    return cachedWeather
  }

  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${useLat}&longitude=${useLon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`,
      { signal: AbortSignal.timeout(FORECAST_TIMEOUT_MS) },
    )
    if (!res.ok) return cachedWeather

    const data = await res.json() as {
      current?: { temperature_2m?: number; weather_code?: number }
    }
    const temp = data.current?.temperature_2m
    const code = data.current?.weather_code
    if (typeof temp !== 'number' || typeof code !== 'number') return cachedWeather

    await ensureCityLabel(useLat, useLon, source)

    cachedWeather = {
      temp: `${Math.round(temp)}\u00B0F`,
      desc: wmoDescription(code),
      location: lastKnownCity || `${useLat.toFixed(2)}, ${useLon.toFixed(2)}`,
    }
    weatherFetchedAt = Date.now()
    return cachedWeather
  } catch {
    return cachedWeather
  }
}

/** Public-safe filter only — no operator-specific title rules. */
function isGenericNoiseEvent(title: string): boolean {
  const t = (title || '').toLowerCase()
  return /\booo\b|out of office|vacation|\bpto\b/i.test(t)
}

async function fetchNextEvent(): Promise<NextEventPayload | null> {
  if (cachedNextEvent && Date.now() - calendarFetchedAt < CALENDAR_TTL_MS) {
    return cachedNextEvent
  }

  try {
    const cal = await callPython(['calendar']) as {
      today_remaining?: Array<{
        title?: string
        start_time?: string
        start?: string
        is_all_day?: boolean
      }>
      next_event?: { title?: string; start_time?: string }
      minutes_until_next?: number
    } | null

    const remaining = cal?.today_remaining ?? []
    const meaningful = remaining.find((evt) => {
      if (evt.is_all_day) return false
      return !isGenericNoiseEvent(evt.title || '')
    })

    if (meaningful) {
      const now = Date.now()
      const eventTime = new Date(meaningful.start_time || meaningful.start || '').getTime()
      const minsUntil = Number.isFinite(eventTime)
        ? Math.max(0, Math.round((eventTime - now) / 60_000))
        : undefined
      cachedNextEvent = {
        title: meaningful.title || 'Meeting',
        time: meaningful.start_time || meaningful.start || '',
        ...(minsUntil != null ? { inMinutes: minsUntil } : {}),
      }
    } else if (cal?.next_event && !isGenericNoiseEvent(cal.next_event.title || '')) {
      cachedNextEvent = {
        title: cal.next_event.title || 'Meeting',
        time: cal.next_event.start_time || '',
        ...(cal.minutes_until_next != null ? { inMinutes: cal.minutes_until_next } : {}),
      }
    } else {
      cachedNextEvent = null
    }

    calendarFetchedAt = Date.now()
    return cachedNextEvent
  } catch {
    return cachedNextEvent
  }
}

/** Test helper — reset module caches between cases. */
export function _resetWelcomeContextCachesForTests(): void {
  cachedWeather = null
  weatherFetchedAt = 0
  lastKnownLat = undefined
  lastKnownLon = undefined
  lastKnownCity = ''
  cachedNextEvent = null
  calendarFetchedAt = 0
}

welcomeContextRouter.get('/welcome-context', async (req, res) => {
  const lat = parseCoord(req.query.lat, 'lat')
  const lon = parseCoord(req.query.lon, 'lon')
  // Both required together; one alone is ignored.
  const pairLat = lat != null && lon != null ? lat : undefined
  const pairLon = lat != null && lon != null ? lon : undefined

  const [weather, nextEvent] = await Promise.all([
    fetchWeather(pairLat, pairLon),
    fetchNextEvent(),
  ])

  res.json({
    ...(weather ? { weather } : {}),
    ...(nextEvent ? { nextEvent } : {}),
  })
})
