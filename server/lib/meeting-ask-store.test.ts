import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MeetingAskStore } from './meeting-ask-store.js';

describe('Meeting Ask aggregate file-context capacity', () => {
    it('rejects growth past the aggregate byte ceiling without losing prior text, while permitting removal', () => {
        const root = mkdtempSync(join(tmpdir(), 'ask-files-capacity-'));
        try {
            const store = new MeetingAskStore(root);
            const file = { id: 'file_abcdefgh', revision: 'r1', name: 'Agenda', status: 'ready' as const, text: 'Retained evidence' };
            store.putFiles('meeting_current', [file]);
            // A sparse unrelated file exercises aggregate accounting without allocating 100 MB.
            const other = join(root, 'files', 'meeting_other.json');
            writeFileSync(other, '[]'); truncateSync(other, 100000000);
            expect(() => store.putFiles('meeting_current', [{ ...file, text: 'x'.repeat(1000) }])).toThrow('file_context_storage_limit');
            expect(store.files('meeting_current')[0].text).toBe('Retained evidence');
            expect(store.putFiles('meeting_current', [{ ...file, status: 'removed', text: '' }])[0].status).toBe('removed');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it('caps meeting manifests while allowing an existing meeting to update', () => {
        const root = mkdtempSync(join(tmpdir(), 'ask-files-count-'));
        try {
            const store = new MeetingAskStore(root);
            mkdirSync(join(root, 'files'));
            for (let i = 0; i < 2000; i++) writeFileSync(join(root, 'files', `meeting_${i}.json`), '[]');
            expect(() => store.putFiles('meeting_new', [])).toThrow('file_context_storage_limit');
            expect(store.putFiles('meeting_0', [])).toEqual([]);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
