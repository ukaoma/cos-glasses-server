// X1 (Q1 P5): the mounted mark starts false. Its own file, so this module is freshly loaded here and nothing has
// reset it first (health.test.ts resets it before every read, which hid a `let mounted = true`).
import { describe, expect, it } from 'vitest'
import { markWebPushRoutesMounted, webPushRoutesMounted } from './web-push-mounted.js'

describe('web-push-mounted', () => {
  it('a freshly loaded module reads false: nothing is mounted until index.ts says so (Q1 P5)', () => {
    expect(webPushRoutesMounted()).toBe(false)
    markWebPushRoutesMounted()
    expect(webPushRoutesMounted()).toBe(true)
  })
})
