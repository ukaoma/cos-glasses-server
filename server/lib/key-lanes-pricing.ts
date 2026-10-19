// Key lanes K1, P11: the one price function the relay meter and the direct lane share. Live
// OpenRouter catalog prices when P5's 24 h cache has them (never fetched from here), else the
// curated price, else P2's fallback (the most expensive Claude tier, so an unknown price can only
// make the cap stricter). Pure apart from reading the in-memory catalog cache.
import { getKeyCatalog, keyModelPrice } from './key-catalog.js'
import { FALLBACK_PRICE, type ModelPrice } from './key-relay-meter.js'

export function keyCatalogPeekPrice(model: string): ModelPrice {
  const info = keyModelPrice(model, getKeyCatalog().peek())
  if (info.from === 'unknown') return FALLBACK_PRICE
  return { inUsdPerM: info.inUsdPerM, outUsdPerM: info.outUsdPerM }
}
