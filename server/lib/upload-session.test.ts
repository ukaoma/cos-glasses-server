import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertFullWrite } from './upload-session.js'
import {
  MAX_CHUNKED_MEDIA_BYTES,
  MAX_OTHER_MEDIA_BYTES,
  MAX_VIDEO_MEDIA_BYTES,
  mediaCeilingBytes,
} from './rich-media-safety.js'

// Two guards that EXISTED but were UNREACHED: deleting each one left the whole suite
// green. Recorded as findings rather than accepted, then covered here. Both were found
// by mutation, not by reading — which is the argument for mutating every new guard.

describe('the ceiling that applies to an upload', () => {
  it('gives video the chunked ceiling but never gives it to a document', () => {
    // The per-kind split is not cosmetic. A flat chunked ceiling would admit a 2 GiB
    // .txt, and the text path does capText(decodeStrictUtf8(readFileSync(...))) — a
    // whole-file Buffer plus a whole-file JS string, which throws ERR_STRING_TOO_LONG
    // at V8's ~512 MB string limit AFTER allocating, inside the request, in the process
    // that also owns the G2 bridge and whisper. Streaming the upload only to explode
    // reading it back would defeat the entire rewrite.
    expect(mediaCeilingBytes(true, 'chunked')).toBe(MAX_CHUNKED_MEDIA_BYTES)
    expect(mediaCeilingBytes(true, 'single_shot')).toBe(MAX_VIDEO_MEDIA_BYTES)
    expect(mediaCeilingBytes(false, 'chunked')).toBe(MAX_OTHER_MEDIA_BYTES)
    expect(mediaCeilingBytes(false, 'single_shot')).toBe(MAX_OTHER_MEDIA_BYTES)
  })

  it('defaults to the NARROW ceiling, so an un-threaded caller cannot widen it', () => {
    // The defect this replaces was a caller inheriting the wrong cap silently. If the
    // default ever became the chunked ceiling, /api/media/file would quietly accept
    // 2 GiB single-shot bodies.
    expect(mediaCeilingBytes(true)).toBe(MAX_VIDEO_MEDIA_BYTES)
    expect(mediaCeilingBytes(false)).toBe(MAX_OTHER_MEDIA_BYTES)
    expect(MAX_CHUNKED_MEDIA_BYTES).toBeGreaterThan(MAX_VIDEO_MEDIA_BYTES)
  })
})

describe('the short-write guard', () => {
  it('accepts a write that landed in full', () => {
    expect(() => assertFullWrite(8, 8)).not.toThrow()
    expect(() => assertFullWrite(0, 0)).not.toThrow()
    expect(() => assertFullWrite(8 * 1024 * 1024, 8 * 1024 * 1024)).not.toThrow()
  })

  it('rejects a short write rather than letting a zero-holed asset pass the size check', () => {
    // fs.writeSync may return short. Unchecked, writeAt then ftruncates to the ASSUMED
    // length, so the file ends up EXACTLY the expected size with a zero-filled hole
    // where the unwritten tail belongs — finalize's assembled-size re-verification
    // passes and a silently corrupt video is published. Throwing leaves the session
    // counters untouched, so the client's retry at the same nextIndex overwrites from
    // the same offset via the existing idempotency path.
    expect(() => assertFullWrite(7, 8)).toThrow(/short chunk write: 7 of 8/)
    expect(() => assertFullWrite(0, 4096)).toThrow(/short chunk write/)
    expect(() => assertFullWrite(1, 8 * 1024 * 1024)).toThrow(/short chunk write/)
  })
})

describe('finalize is wired to the chunked ceiling', () => {
  // HONEST LABEL: this is a source-shape assertion, and it is weaker than the rest of
  // this file. A true end-to-end proof needs a real >100 MiB staging file, because
  // finalize re-verifies the assembled size against the declared total before the cap
  // is consulted, so the number cannot simply be asserted. The ceiling LOGIC above is
  // proven behaviourally; only this one wire is not.
  //
  // It exists because the mutation that removes `transfer: 'chunked'` from the finalize
  // call left the entire suite green — reverting the exact defect two reviewers found,
  // undetected. A weak guard on a known-unreached line beats no guard.
  it('passes transfer: chunked to the shared ingest', () => {
    const media = readFileSync(new URL('../routes/media.ts', import.meta.url).pathname, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const finalize = media.slice(media.indexOf("'/media/upload/:uploadId/finalize'"))
    const call = finalize.slice(finalize.indexOf('ingestRichMediaFromFile({'))
    expect(call.slice(0, call.indexOf('})')), 'finalize must not inherit the single-shot cap')
      .toMatch(/transfer:\s*'chunked'/)
  })
})
