// Audio enhancement via ffmpeg — noise reduction + loudness normalization.
// Extracted so both batch (post-meeting) and one-shot (message query HQ) paths
// can use the same filter chain.
//
// Filter chains:
//   light — highpass=f=80 only (short interactive clips; lower latency)
//   full  — highpass + afftdn + loudnorm (meetings / longer outdoor audio)
//
// Graceful: returns the original buffer if ffmpeg is missing, fails, or times out.
// Callers should never crash a user request because enhancement couldn't run.

import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const FFMPEG_TIMEOUT_MS = 30_000
const FILTER_FULL = 'highpass=f=80,afftdn=nt=w,loudnorm=I=-16:LRA=11:TP=-1.5'
const FILTER_LIGHT = 'highpass=f=80'

export type EnhanceProfile = 'light' | 'full'

/**
 * Enhance raw audio (WAV/webm/etc) and return a 16kHz mono WAV buffer suitable
 * for whisper-cli or whisper-server. Input format is detected by ffmpeg — no
 * need to pre-convert.
 *
 * Returns the ORIGINAL buffer unchanged on any failure. Logs the reason.
 */
export async function enhanceAudio(
  audioBuffer: Buffer,
  opts: { profile?: EnhanceProfile } = {},
): Promise<Buffer> {
  const profile: EnhanceProfile = opts.profile === 'light' ? 'light' : 'full'
  const filterChain = profile === 'light' ? FILTER_LIGHT : FILTER_FULL
  const id = randomUUID().slice(0, 8)
  const inputPath = join('/tmp', `cos-enhance-in-${id}`)
  const outputPath = join('/tmp', `cos-enhance-out-${id}.wav`)

  try {
    writeFileSync(inputPath, audioBuffer)

    const enhanced = await new Promise<Buffer>((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-i', inputPath,
        '-af', filterChain,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        '-y',
        outputPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })

      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(new Error(`ffmpeg timeout (${FFMPEG_TIMEOUT_MS / 1000}s)`))
      }, FFMPEG_TIMEOUT_MS)

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(-200)}`))
          return
        }
        if (!existsSync(outputPath)) {
          reject(new Error('ffmpeg produced no output file'))
          return
        }
        try {
          resolve(readFileSync(outputPath))
        } catch (readErr: unknown) {
          reject(readErr instanceof Error ? readErr : new Error(String(readErr)))
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    return enhanced
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[audio-enhance] ffmpeg failed (${profile}), returning original buffer: ${msg}`)
    return audioBuffer
  } finally {
    try { unlinkSync(inputPath) } catch { /* ignore */ }
    try { unlinkSync(outputPath) } catch { /* ignore */ }
  }
}
