# Media upload contract (frozen 2026-08-11)

This document is the **join point** for parallel work on large-video upload. Lanes
build against it without negotiating with each other. If a lane believes the
contract is wrong, it reports that instead of silently diverging — a lane that
changes the contract unilaterally breaks the other lanes' work.

Measured facts this design rests on, from the real assets in
`~/.cos-glasses/data/media/assets` on 2026-08-10:

| Fact | Value |
| --- | --- |
| A real phone upload | 3840x2160, 30fps, H.264, **25.5 Mbps**, 11.73s, 36 MB |
| 64 MiB holds | ~21 seconds of that footage |
| 100 MB holds | ~31 seconds |
| `libx265 -crf 30` on it | 13.3 MB, **2.7x smaller, SSIM 0.969** |
| `libx265 -crf 34` | 6.6 MB, 5.5x smaller, SSIM 0.953 |
| `hevc_videotoolbox` at similar size | SSIM **0.858** — hardware is much worse per byte |
| Two encoder settings tried | produced files **LARGER** than the source |

Consequences that are not negotiable:

1. **Compression cannot run inside the upload request.** x265 encodes at roughly
   real time, so a 3-minute video would block the response for ~3 minutes and blow
   the client's deadline. It is a background job.
2. **Compression does not unlock long uploads.** A 3-minute 4K original is ~570 MB
   and cannot pass any sane single-shot cap. Only chunked upload unlocks length.
   Compression reduces *storage*, not *transit*.
3. **Never downscale.** Resolution and frame rate are what later frame-mining
   depends on, and upscaling cannot recover them. Reduce bitrate only.
4. **An encode that is not smaller is a failure, not a result.** Measured: two
   settings inflated the file. Compare sizes and keep the original if it wins.

## 1. Limits advertised by the server

The client must NOT hardcode a byte cap. `cos-glasses-app` and `cos-glasses-server`
are separate repos that have already diverged, so a constant in both is guaranteed
to drift. The server is the single authority and publishes limits on health.

`GET /api/health` gains one object. Absent means an older server: the client falls
back to its previous behaviour and single-shot only.

```jsonc
{
  "mediaLimits": {
    "videoMaxBytes": 104857600,        // 100 MiB (NOT 100 MB = 100_000_000)
    "otherMaxBytes": 67108864,         // 64 MiB, images and documents (unchanged)
    "chunkedUploadEnabled": false,     // Phase 1 ships FALSE — see note below
    "chunkBytes": 8388608,             // 8 MB per chunk
    "chunkedMaxBytes": 2147483648,     // 2 GB assembled ceiling
    "videoCompression": "x265-crf30"   // or null when ffmpeg/ffprobe are absent
  }
}
```

### chunkedUploadEnabled is FALSE until the routes exist

Phase 1 publishes `false`, because §2's endpoints are not mounted and a client told
`true` would call routes that 404. The flag lives beside the routes it describes
(`MEDIA_CHUNKED_UPLOAD_ENABLED` in `server/routes/media.ts`) so it cannot drift from
them; flip it in the same change that registers them. Clients must therefore treat a
complete chunked block as the feature gate, never the flag alone.

The byte figures are MiB, not MB. `104857600` is 100 MiB. It renders as "100 MB" to
users only because the client formats with `Math.round(bytes / 1024 / 1024)`. Do not
"correct" the constant to 100_000_000 to match a colloquial label — that would silently
shrink the cap and change the refusal string to 95.

## 2. Chunked upload endpoints

All require `X-Cos-Token`. Chunk indexes are 0-based and must arrive in order; the
client may re-send the chunk at `nextIndex` after a reconnect.

```
POST /api/media/upload/init
  headers  X-COS-Filename, X-COS-Captured-At, X-COS-Session-Id
  body     { "totalBytes": number, "mime": string }
  200      { "uploadId": string, "chunkBytes": number, "receivedBytes": 0 }
  413      { "error": "attachment_too_large" }
  503      { "error": "chunked_upload_unavailable" }

PUT  /api/media/upload/:uploadId/:index
  body     raw bytes of that chunk
  200      { "receivedBytes": number, "nextIndex": number }
  409      { "error": "chunk_out_of_order", "expectedIndex": number }
  404      { "error": "upload_not_found" }

GET  /api/media/upload/:uploadId          // resume probe, safe to poll
  200      { "uploadId", "totalBytes", "receivedBytes", "nextIndex", "expiresAt" }
  404      { "error": "upload_not_found" }

POST /api/media/upload/:uploadId/finalize
  200      { "attachment": MediaAttachmentRef }   // identical shape to /api/media/file
  400      { "error": "incomplete_upload", "receivedBytes", "totalBytes" }
```

`finalize` assembles the chunks, then runs the SAME validation and ingest path as
`/api/media/file`. It must not fork that logic: a second ingest path is a second
place for the safety rules to rot.

Abandoned uploads expire on the existing quarantine/retention clock. An expired or
unknown `uploadId` is a 404, never a partial success.

## 3. Compression module signature

Owned by one lane, called by another. The module knows nothing about the media
store: it takes a path, returns a path, and **never** writes into `assets/` or
deletes its input. The caller owns placement, using the existing
`renameWithTransientRetry` boundary in `media-store.ts`.

```ts
// server/lib/video-compression.ts
export const VIDEO_COMPRESSION_CRF = 30
export const VIDEO_COMPRESSION_LABEL = 'x265-crf30'

export type CompressionStatus =
  | 'compressed'            // outputPath is a validated, smaller file
  | 'skipped_unavailable'   // ffmpeg or ffprobe missing
  | 'skipped_not_smaller'   // encode produced >= input; keep the original
  | 'skipped_not_video'
  | 'failed'                // encode or validation failed; keep the original

export interface CompressionResult {
  status: CompressionStatus
  outputPath?: string
  originalBytes: number
  compressedBytes?: number
  width?: number
  height?: number
  reason?: string           // bounded, safe to log, never a full path
}

export async function compressVideoFile(
  inputPath: string,
  workDir: string,
): Promise<CompressionResult>
```

Required behaviour:

- `-c:v libx265 -crf 30 -preset medium -tag:v hvc1`, audio copied.
- **No scale filter.** Output width/height/fps must equal the input's; verify with
  `ffprobe` and return `failed` if they differ.
- Validate the output decodes before returning `compressed`.
- If `compressedBytes >= originalBytes`, return `skipped_not_smaller`.
- Bounded timeout proportional to duration, with a hard ceiling. Kill the child on
  timeout and clean up the partial file.
- Capability-gated through the existing `richMediaCapabilities()` detection rather
  than a second probe.
- Every failure mode keeps the original intact. There is no path where the only
  copy is destroyed.

## 4. Ownership, so no two lanes touch one file

| Lane | Repo | Owns (exclusive write) |
| --- | --- | --- |
| A: storage, limits, health | cos-glasses-server | `server/routes/media.ts`, `server/lib/media-store.ts`, `server/routes/health.ts`, `server/lib/rich-media-safety.ts` |
| B: compression module | cos-glasses-server | `server/lib/video-compression.ts` + its test (NEW files only) |
| C: client | cos-glasses-app | `src/lib/api-client.ts`, `shared/media-attachment.ts` + its tests |

Lane B creates files that do not exist yet, so A and B never collide. Lane A calls
`compressVideoFile` against the signature above. Phase 3's server half extends
`media.ts`, which Lane A owns, so it is a second wave in that lane rather than a
fourth concurrent lane.

## 5. Open hazard: the maintenance lease spans the body transfer

`POST /api/media/file` runs under the generic `api_mutation` maintenance lease
(server/index.ts), which is released on response finish. Every other mutation is
sub-second; this one now accepts up to 100 MiB, which the client budgets ~7.3 minutes
for. COS Control's drain timeout is 90s, so a drain landing during a large upload
hard-fails to Repair.

Not fixed in Phase 1, and the obvious fix is a trap: `MaintenanceWorkKind` is a
label-only union with no per-kind budget, and `blocksRestart` is owned by the
meeting-sync progress surface, so a new `media_upload` kind would change no behaviour
while looking like it had.

The real fix is to hold the lease around the INGEST (validate + index write, fast)
rather than the whole request. That edits a fail-closed middleware guarding every
mutation, so it belongs in its own change with its own tests. Until then: avoid
running Update Server while a large upload is in flight.
