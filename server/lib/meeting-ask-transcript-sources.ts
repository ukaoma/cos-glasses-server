import { getSessionChunkEntries, getSessionStartTime, getMeetingSessionStatus } from '../routes/transcribe-stream.js';
import { readBoundedFile, type AskTranscriptSources } from './meeting-ask-transcript.js';
import { getMeetingStore } from './meeting-store.js';
import { dataPath } from './data-dir.js';
import { join } from 'node:path';
export const transcriptSources: AskTranscriptSources = {
    live: id => { const entries = getSessionChunkEntries(id), startTime = getSessionStartTime(id); return entries && startTime !== null ? { entries, startTime } : null; },
    status: id => getMeetingSessionStatus(id),
    activeFile: id => readBoundedFile(join(dataPath('active-sessions'), `${id}.json`)),
    saved: id => getMeetingStore().findBySessionId(id),
    read: readBoundedFile,
    now: Date.now,
};
