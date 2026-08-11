import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let root = ''

function writeEvidence(base: string, sessionId: string, speaker: string, title: string): void {
  const month = join(base, '2026-08')
  mkdirSync(month, { recursive: true })
  const stem = `2026-08-11_${title.replaceAll(' ', '_')}_${sessionId}`
  writeFileSync(join(month, `${stem}.g2-chunks.json`), JSON.stringify({
    sessionId,
    title,
    durationMs: 10_000,
    chunks: [{ text: title, speaker, elapsed: 5_000, similarity: speaker === 'Niala' ? 0.72 : 0 }],
  }))
  writeFileSync(join(month, `${stem}.md`), `# ${title}\n`)
}

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('voice directory corpus aggregation', () => {
  it('dedupes canonical sessions, keeps zero-appearance profiles, and isolates unidentified voices', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-voice-directory-'))
    const operations = join(root, 'operations')
    const direct = join(root, 'direct')
    const recordings = join(root, 'recordings')
    const operationMeetings = join(operations, 'quilt', 'meetings')
    writeEvidence(operationMeetings, 'session_same', 'Niala', 'Canonical title')
    writeEvidence(direct, 'session_same', 'Niala', 'Duplicate direct title')
    writeEvidence(recordings, 'session_ext', 'Ext', 'Unidentified room')

    // A Markdown symlink must never let the directory read outside its selected
    // library. The sidecar title remains the safe fallback.
    const secret = join(root, 'secret.md')
    writeFileSync(secret, '# SECRET OUTSIDE ROOT\n')
    const extMarkdown = join(recordings, '2026-08', '2026-08-11_Unidentified_room_session_ext.md')
    rmSync(extMarkdown)
    symlinkSync(secret, extMarkdown)

    vi.doMock('./data-dir.js', () => ({ dataPath: (name: string) => join(root, name) }))
    vi.doMock('./cos-operations-meetings.js', () => ({
      resolveCosOperationsDir: () => operations,
      resolveMeetingLibrary: () => ({ layout: 'direct', root: direct }),
    }))
    vi.doMock('./meeting-corrections.js', () => ({ confirmedLabels: () => new Set<string>() }))
    vi.doMock('./profile.js', () => ({ getOwnerSpeakerLabel: () => 'MU' }))
    vi.doMock('./speaker-embeddings.js', () => ({
      readVoiceProfiles: () => ({ profiles: [
        { name: 'Niala', embeddings: [[1], [2]], sources: ['manual', 'fireflies'] },
        { name: 'Never Heard', embeddings: [[3]], sources: ['manual'] },
      ] }),
    }))
    vi.doMock('./meeting-speaker-review.js', () => ({
      isUnattributed: (label: string) => label === 'Ext' || label.startsWith('Unidentified'),
      reviewMeetingSpeakers: (chunks: Array<{ speaker: string; similarity: number }>) => {
        const label = chunks[0].speaker
        return {
          speakingTimeSource: 'words',
          voices: [{
            label,
            segments: 5,
            speakingMs: 9_000,
            meanSimilarity: label === 'Niala' ? 0.72 : null,
            reliability: label === 'Niala' ? 'confident' : 'unattributed',
            nameAsserted: label === 'Niala',
            confirmedByHuman: false,
          }],
        }
      },
    }))

    const { buildVoiceDirectorySnapshot } = await import('./voice-directory.js')
    const snapshot = await buildVoiceDirectorySnapshot()

    expect(snapshot.meetingsScanned).toBe(2)
    expect(snapshot.unresolvedMeetings).toBe(1)
    expect(snapshot.unresolvedSegments).toBe(5)
    expect(snapshot.profiles).toHaveLength(2)
    expect(snapshot.profiles.find(p => p.name === 'Niala')).toMatchObject({
      embeddings: 2,
      assertedSegments: 5,
      assertedSpeakingMs: 9_000,
      meetingCount: 1,
      observedMatch: 0.72,
      firstSeen: '2026-08-11',
      lastSeen: '2026-08-11',
    })
    expect(snapshot.profiles.find(p => p.name === 'Niala')?.appearances[0].title).toBe('Canonical title')
    expect(snapshot.profiles.find(p => p.name === 'Never Heard')).toMatchObject({
      assertedSegments: 0,
      meetingCount: 0,
      observedMatch: null,
    })
    expect(JSON.stringify(snapshot)).not.toContain('SECRET OUTSIDE ROOT')
    expect(JSON.stringify(snapshot)).not.toContain(root)
  })
})
