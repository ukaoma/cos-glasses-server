import { getSessionChunkEntries, getSessionStartTime, getMeetingSessionStatus } from '../routes/transcribe-stream.js';
import { readBoundedFile, type AskTranscriptSources } from './meeting-ask-transcript.js';
import { getMeetingStore } from './meeting-store.js';
import { dataPath } from './data-dir.js';
import { join } from 'node:path';
import { requirePhoneRecording, PHONE_SOURCE_TYPE, type PhoneRecording } from './phone-recording.js';
import { AskError } from './live-cos-ask.js';

function phoneRecording(id: string): PhoneRecording | null {
    if (!id.startsWith('phone_')) return null;
    try { return requirePhoneRecording(id); }
    catch (error) { const e = error as { reason?: string; status?: number }; throw new AskError(e.reason ?? 'phone_capture_metadata_unreadable', e.status ?? 409); }
}
function anonymousChunks(chunks: unknown): boolean {
    return Array.isArray(chunks) && chunks.every(c => c && typeof c === 'object' && c.speaker === 'Ext' && c.speakerPolicy === 'anonymous' && (c.segments === undefined || (Array.isArray(c.segments) && c.segments.every((s: any) => s && s.speaker === 'Ext'))));
}
/** Ask may not recover a phone journal that audio/session recovery refused. */
function validatePhoneDocument(text: string | null, phone: PhoneRecording): void {
    try {
        const doc = JSON.parse(text ?? 'null'), capture = doc?.captureSource;
        if (!doc || doc.sessionId !== phone.sessionId || doc.startTime !== phone.startTime || doc.sourceType !== PHONE_SOURCE_TYPE || doc.speakerPolicy !== 'anonymous' || capture?.version !== 1 || capture?.captureId !== phone.captureId || capture?.sessionId !== phone.sessionId || capture?.startTime !== phone.startTime || capture?.sourceType !== PHONE_SOURCE_TYPE || capture?.speakerPolicy !== 'anonymous') throw Error('provenance');
        let found = false;
        for (const [key, field] of [['chunks', null], ['chunksIndexed', 'c'], ['chunkEntries', 'chunk']] as const) {
            if (doc[key] === undefined) continue;
            if (!Array.isArray(doc[key]) || !anonymousChunks(field ? doc[key].map((entry: any) => entry?.[field]) : doc[key])) throw Error('anonymous transcript');
            found = true;
        }
        if (!found || (doc.batchSegments !== undefined && (!Array.isArray(doc.batchSegments) || !doc.batchSegments.every((s: any) => s && s.speaker === 'Ext')))) throw Error('anonymous transcript');
    } catch { throw new AskError('phone_transcript_provenance_unreadable', 409); }
}
export const transcriptSources: AskTranscriptSources = {
    live: id => {
        const phone = phoneRecording(id), entries = getSessionChunkEntries(id), startTime = getSessionStartTime(id);
        if (phone && entries && (phone.closedAt || startTime !== phone.startTime || !anonymousChunks(entries.map(e => e.chunk)))) throw new AskError('phone_transcript_provenance_unreadable', 409);
        return entries && startTime !== null ? { entries, startTime } : null;
    },
    status: id => getMeetingSessionStatus(id),
    activeFile: id => {
        const phone = phoneRecording(id), text = readBoundedFile(join(dataPath('active-sessions'), `${id}.json`));
        if (phone && text) validatePhoneDocument(text, phone);
        return text;
    },
    saved: id => {
        const phone = phoneRecording(id), saved = getMeetingStore().findBySessionId(id);
        if (phone && saved) validatePhoneDocument(readBoundedFile(saved.sidecarPath), phone);
        if (phone?.closedAt && !saved) throw new AskError('phone_saved_metadata_unreadable', 409);
        return saved;
    },
    read: readBoundedFile,
    now: Date.now,
};
