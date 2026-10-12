# Server 6.71.9 candidate: phone image text in Meeting Ask

Adds to the 6.71.8 grounding, 6.71.7 question-broker and 6.71.5 web/privacy gates.
Experimental transcription and live-cue flags remain disabled; the released
progressive HQ baseline remains unchanged. Companion 6.10.629 is compatible;
no new Control app or EHPK is required for this server addition.

## Behavior

Phone screenshots and photos containing text are read locally using macOS Apple
Vision, like COS Control's Meeting Ask image-text companions. Results become
revisioned file evidence with F citations. OCR rows preserve spatial association;
small numbers, merged cells and skewed tables remain imperfect. The assistant
must distinguish the displayed metric from overall strength or preference.
This is text extraction, not general visual reasoning. Photos without readable
text and videos are not silently treated as understood. Non-macOS servers return
an explicit failed extraction. Existing TXT/MD/CSV/JSON/PDF-text behavior stays.

Two OCR processes maximum, 10 seconds per image and 20 seconds per attachment
batch, bounded output and no network/model call for extraction. Credential checks
cover the whole extract before truncation. Removal, expiry, reservation, changed
revisions and maintenance admission are rechecked after OCR. Shutdown aborts and
waits for extraction. Historical answers retain the revision they actually used.
Re-add an old unsupported image after installing; old answers are never rewritten.

## Automated gates

- Native Apple Vision replay of the actual uploaded IMG_7299.jpeg.
- Replay the original "Who is miles top character?" and explicit Crit Value
  question with the original transcript cutoff in an isolated Ask/media store.
  Require completion, Mavuika first, named metric, a resolving F citation,
  qualitative confidence, no unsupported overall-strength conclusion and less
  than 30 seconds including OCR. Searches are disabled in this replay.
- Credential screen labels, gutters and credentials past the text cap; empty and
  failed OCR; retry; concurrent removal/deletion; maintenance/shutdown cancellation;
  durable F evidence; table rows; output bounds; authenticated HTTP route.
- Full server suite, TypeScript check, production audit, clean diff and packaged
  native JXA helper. Production publish gates still apply.

## Exact phone canary (Claude Sonnet)

1. Open the saved test meeting on the phone. Re-add IMG_7299.jpeg with +. Wait for
   the attachment to become readable. Do not submit before upload/read finishes.
2. Ask: "Using the attached image, who is first in the displayed character table,
   and what metric is shown? Cite the image."
   Pass: Mavuika, Crit Value, an expandable image/file citation, uncertainty about
   any unreadable digits. It must not substitute personality or writing style.
3. Ask: "Does that prove this is my strongest character overall?"
   Pass: distinguishes the displayed metric from overall strength, with a current
   image citation; no invented damage/build/team assessment.
4. Attach a clear screenshot of text or a price list. Ask for one exact visible
   item/amount. Check the original and its citation. Then ask a follow-up.
5. Attach a photo without text. Pass: explicitly no readable text; no invented
   visual description. Upload a synthetic credential screenshot (never a real
   password). Pass: held; credential absent from answer and export.
6. Check Ask/Transcript, keyboard and background/resume behavior. The image row
   should settle without losing the reading position. Saved history must retain
   answers/citations. Repeat after reopening the saved meeting.

Public latest promotion remains gated by phone acceptance and the outstanding
question-broker / older-client / lifecycle checks from the earlier plans.
