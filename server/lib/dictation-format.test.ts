// 6.83.1. Synthetic dictation only.
import { describe, expect, it } from 'vitest'
import { linkTokens, polishLinkProblem, renderSpokenPaths, spokenPathsEnabled } from './dictation-format.js'

describe('renderSpokenPaths: forward slash plus one word at a phrase end', () => {
  it.each([
    ['go to forward slash pricing.', 'go to /pricing.'],
    ['demo, forward slash pricing, forward slash build and price', 'demo, /pricing, forward slash build and price'],
    ['Forward slash Pricing', '/pricing'],
    ['open forward-slash demo!', 'open /demo!'],
    ['first forward slash pricing\nthen the rest', 'first /pricing\nthen the rest'],
    ['the page (forward slash pricing) is live', 'the page (/pricing) is live'],
    ['check forward slash v2;', 'check /v2;'],
  ])('%s', (input, output) => {
    expect(renderSpokenPaths(input)).toBe(output)
  })

  it.each([
    // A slug of several words is the model's job: no boundary after the first word.
    'forward slash build and price',
    'forward slash pricing page is new',
    // "slash" alone is ordinary speech.
    'we can slash prices.',
    'pick red and slash or blue.',
    // The character itself, not a path.
    'press the forward slash key.',
    'type a forward slash.',
    // An article names the character even when a phrase-ending word follows it.
    'type the forward slash first.',
    'use one forward slash, not two',
    'forward slash character',
    // Inside other words.
    'straightforward slash pricing.',
  ])('leaves "%s" alone', input => {
    expect(renderSpokenPaths(input)).toBe(input)
  })

  it('is on unless switched off', () => {
    expect(spokenPathsEnabled({})).toBe(true)
    for (const off of ['0', 'false', 'OFF']) expect(spokenPathsEnabled({ COS_DICTATION_SPOKEN_PATHS: off })).toBe(false)
    expect(spokenPathsEnabled({ COS_DICTATION_SPOKEN_PATHS: '1' })).toBe(true)
  })
})

describe('linkTokens', () => {
  it('finds paths, domains, emails and URLs, never and/or or dates', () => {
    expect(linkTokens('See /pricing, /build-and-price and bottlepos.com, mail sam@example.com or https://example.com/a.'))
      .toEqual(['/pricing', '/build-and-price', 'bottlepos.com', 'sam@example.com', 'https://example.com/a'])
    expect(linkTokens('red and/or blue on 10/21, about 3.5 percent, e.g. this')).toEqual([])
  })
})

describe('polishLinkProblem: the model never invents a link', () => {
  it.each([
    ['demo, forward slash pricing, forward slash build and price', 'Demo, /pricing, /build-and-price'],
    ['bottle pos dot com slash pricing', 'bottlepos.com/pricing'],
    ['email sam at example dot com', 'Email sam@example.com.'],
    ['the url is h t t p s colon slash slash example dot com', 'The URL is https://example.com.'],
    ['go to /pricing', 'Go to /pricing.'],
    ['red and slash or blue', 'Red and/or blue.'],
    ['no links here at all', 'No links here at all.'],
    // The speaker asked for slugs: a path without a spoken "slash" is what they asked for.
    ['format these as slugs: pricing, build and price', '/pricing, /build-and-price'],
  ])('accepts %s', (input, output) => {
    expect(polishLinkProblem(input, output)).toBeNull()
  })

  it.each([
    ['check our website', 'Check quilt.com.'],
    ['send it to sam', 'Send it to sam@example.com.'],
    ['open the pricing page', 'Open the /pricing page.'],
    ['visit example dot com', 'Visit https://example.com.'],
    ['visit example dot com', 'Visit www.example.com.'],
    ['open pricing and/or plans.', 'Open /pricing and/or plans.'],
    // Shape spoken, letters not: a domain nobody named.
    ['visit example dot com', 'Visit quilt.com.'],
    // Letters and dot spoken, "at" not: an email nobody dictated.
    ['email sam example dot com', 'Email sam@example.com.'],
    ['the deck is due. Then plans', 'The deck is due. Then plans.com'],
    // Every letter was said, but a sentence's period is not a spoken "dot".
    ['the deck is due. Then plans com', 'The deck is due. Then plans.com'],
  ])('refuses %s', (input, output) => {
    expect(polishLinkProblem(input, output)).toBe('invented_link')
  })

  it('refuses an answer that dropped a link the dictionary wrote', () => {
    expect(polishLinkProblem('go to /pricing now', 'Go to the pricing page now.', ['/pricing'])).toBe('lost_dictionary_link')
    expect(polishLinkProblem('go to /pricing now', 'Go to /pricing now.', ['/pricing'])).toBeNull()
    // A dictionary link that was never in the input is not required.
    expect(polishLinkProblem('go home', 'Go home.', ['/pricing'])).toBeNull()
  })
})
