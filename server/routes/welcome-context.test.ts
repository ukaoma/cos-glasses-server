import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWelcomeContextCachesForTests,
  fetchWeather,
  parseCoord,
  resolveWeatherCoords,
  wmoDescription,
} from './welcome-context.js'

describe('welcome-context public package', () => {
  beforeEach(() => {
    _resetWelcomeContextCachesForTests()
    delete process.env.COS_WEATHER_DEFAULT_LAT
    delete process.env.COS_WEATHER_DEFAULT_LON
    delete process.env.COS_WEATHER_DEFAULT_CITY
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    _resetWelcomeContextCachesForTests()
    delete process.env.COS_WEATHER_DEFAULT_LAT
    delete process.env.COS_WEATHER_DEFAULT_LON
    delete process.env.COS_WEATHER_DEFAULT_CITY
    vi.unstubAllGlobals()
  })

  it('keeps operator-specific names and calendar filters out of the public route', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'welcome-context.ts'), 'utf8')
    expect(src).not.toMatch(/\b(?:Miles|Ukaoma|Leander|Hermit|Lean-Labs|MU-Chief-Staff)\b/i)
    // Private app noise filters must not be ported (public uses OOO/PTO only).
    expect(src).not.toMatch(/hermit crab|lean-labs|miles\s*&\s*team|sprocket rocket|launchpad/i)
    expect(src).toMatch(/isGenericNoiseEvent/)
  })

  it('awaits city label before returning weather (no stale empty location)', async () => {
    let geocodeCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('bigdatacloud')) {
        geocodeCalls++
        await new Promise(r => setTimeout(r, 20))
        return new Response(JSON.stringify({
          city: 'Cedar Park',
          principalSubdivisionCode: 'US-TX',
        }), { status: 200 })
      }
      if (url.includes('open-meteo')) {
        return new Response(JSON.stringify({
          current: { temperature_2m: 79.1, weather_code: 2 },
        }), { status: 200 })
      }
      return new Response('missing', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const weather = await fetchWeather(30.50, -97.82)
    expect(geocodeCalls).toBeGreaterThanOrEqual(1)
    expect(weather?.location).toBe('Cedar Park, TX')
    expect(weather?.desc).toBe('Partly Cloudy')
  })

  it('maps WMO codes exactly', () => {
    expect(wmoDescription(0)).toBe('Clear')
    expect(wmoDescription(95)).toBe('Thunderstorm')
    expect(wmoDescription(61)).toBe('Light Rain')
  })

  it('validates lat/lon pairs', () => {
    expect(parseCoord('30.27', 'lat')).toBeCloseTo(30.27)
    expect(parseCoord('91', 'lat')).toBeUndefined()
    expect(parseCoord('-200', 'lon')).toBeUndefined()
    expect(parseCoord('nope', 'lat')).toBeUndefined()
  })

  it('omits weather coords when nothing is known', () => {
    expect(resolveWeatherCoords(undefined, undefined)).toBeNull()
  })

  it('uses env home defaults when phone coords are absent', () => {
    process.env.COS_WEATHER_DEFAULT_LAT = '30.5788'
    process.env.COS_WEATHER_DEFAULT_LON = '-97.8531'
    process.env.COS_WEATHER_DEFAULT_CITY = 'Home'
    const resolved = resolveWeatherCoords(undefined, undefined)
    expect(resolved).toMatchObject({ source: 'env', lat: 30.5788, lon: -97.8531 })
  })

  it('fetches Open-Meteo for phone coords and awaits city label', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('bigdatacloud')) {
        return new Response(JSON.stringify({
          city: 'Austin',
          principalSubdivisionCode: 'US-TX',
        }), { status: 200 })
      }
      if (url.includes('open-meteo')) {
        return new Response(JSON.stringify({
          current: { temperature_2m: 82.4, weather_code: 0 },
        }), { status: 200 })
      }
      return new Response('missing', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const weather = await fetchWeather(30.27, -97.74)
    expect(weather).toEqual({
      temp: '82°F',
      desc: 'Clear',
      location: 'Austin, TX',
    })
    expect(fetchMock).toHaveBeenCalled()
  })

  it('returns null weather when no coords and no env default', async () => {
    expect(await fetchWeather(undefined, undefined)).toBeNull()
  })
})
