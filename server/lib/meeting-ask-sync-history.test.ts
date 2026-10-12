import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeetingAskSubmit } from '../../shared/meeting-ask.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('saved Ask history across sync and merge', () => {
    it('retains both captures, pagination and frozen citations across rename, merge, restart and unmerge without inference', async () => {
        const root = mkdtempSync(join(tmpdir(), 'ask-sync-history-'));
        try {
            vi.stubEnv('COS_OPERATIONS_DIR', root);
            vi.stubEnv('COS_DATA_DIR', join(root, 'isolated-data'));
            vi.stubEnv('COS_MEETINGS_ROOT', '');
            vi.stubEnv('COS_SCRIPTS_DIR', '');
            vi.stubEnv('COS_MEETING_ASK_HQ_EVIDENCE', '0');
            vi.stubEnv('COS_BATCH_HQ_TIMESTAMPS', '0');
            vi.resetModules();
            const { MeetingAskStore, askFingerprint } = await import('./meeting-ask-store.js');
            const { MeetingAskRuntime } = await import('./meeting-ask-runtime.js');
            const { listCosOperationsMeetings, getCosOperationsMeetingDetail, resetMeetingPrimaryKeyCache } = await import('./cos-operations-meetings.js');
            const dir = join(root, 'quilt', 'meetings', '2026-10'); mkdirSync(dir, { recursive: true });
            const store = new MeetingAskStore(join(root, 'ask-journal'));
            const run = vi.fn();
            const runtime = () => new MeetingAskRuntime({ store: new MeetingAskStore(store.root), identity: () => 'same-server', run });
            const sessions = ['meeting_original', 'meeting_second'];
            const capture = (index: number) => {
                const stem = `2026-10-12_Capture_${index}`;
                writeFileSync(join(dir, stem + '.md'), '# Marketing review\n\n**Date** | 2026-10-12 09:31 |\n');
                writeFileSync(join(dir, stem + '.g2-chunks.json'), JSON.stringify({ sessionId: sessions[index], speakers: [], chunks: [] }));
            };
            sessions.forEach((_, index) => capture(index));
            for (let i = 0; i < 53; i++) {
                const input: MeetingAskSubmit = { requestId: `sync_request_${String(i).padStart(3, '0')}`, sessionId: sessions[i < 52 ? 0 : 1], serverInstanceId: 'same-server', action: 'ask', question: `Question ${i}`, elapsedMs: 1000, turns: [{ id: 0, elapsedMs: 500, speaker: 'Person', text: `Frozen words ${i}` }] };
                store.write({ version: 2, fingerprint: askFingerprint(input), input, exchange: { requestId: input.requestId, sessionId: input.sessionId, serverInstanceId: input.serverInstanceId, action: 'ask', question: input.question, status: 'completed', createdAt: `2026-10-12T15:00:${String(i).padStart(2, '0')}.000Z`, updatedAt: '2026-10-12T15:01:00.000Z', selectedModel: { engine: 'claude', model: 'haiku' }, answer: `Answer ${i} [T1]`, sources: [{ id: 'T1', kind: 'transcript', title: 'Person', text: `Frozen words ${i}`, turnId: 0, elapsedMs: 500 }], throughMs: 1000, notices: [], files: [] } });
            }
            const originalBytes = store.list().map(r => readFileSync(join(store.root, 'requests', r.exchange.requestId + '.json'), 'utf8'));
            expect(runtime().history(sessions[0], 'same-server', 0, 100).exchanges).toHaveLength(52);
            sessions.forEach((_, i) => unlinkSync(join(dir, `2026-10-12_Capture_${i}.md`)));
            const merged = '2026-10-12_Renamed_Fireflies_Review.md';
            writeFileSync(join(dir, merged), '# Marketing review\n\n**Date** | 2026-10-12 09:31 |\n' + sessions.map(s => `<!-- g2-session: ${s} -->`).join('\n'));
            writeFileSync(join(dir, '2026-10-12_Decoy.md'), '# Marketing review\n\n**Date** | 2026-10-12 09:31 |\n');
            resetMeetingPrimaryKeyCache();
            const rows = listCosOperationsMeetings({ month: '2026-10', recordingsRoot: join(root, 'no-recordings') });
            const row = rows.find(r => r.filename === merged)!;
            const detail = getCosOperationsMeetingDetail('quilt', '2026-10', merged)!;
            expect(row.g2SessionIds).toEqual(sessions);
            expect(detail.contextKeys).toEqual(sessions.map(s => 'g2:' + s));
            expect(rows.find(r => r.filename.includes('Decoy'))?.contextKeys).toEqual([]);
            const reloaded = runtime();
            const first = reloaded.history(sessions[0], 'same-server', 0, 50);
            const second = reloaded.history(sessions[0], 'same-server', first.nextOffset!, 50);
            expect(first.nextOffset).toBe(50); expect(second.nextOffset).toBeNull();
            const answers = [...first.exchanges, ...second.exchanges, ...reloaded.history(sessions[1], 'same-server').exchanges];
            expect(new Set(answers.map(e => e.requestId)).size).toBe(53);
            expect(answers.map(e => e.sources[0].text)).toEqual(Array.from({ length: 53 }, (_, i) => `Frozen words ${i}`));
            expect(() => reloaded.history(sessions[0], 'another-server')).toThrow('server_instance_mismatch');
            expect(reloaded.history('meeting_unrelated', 'same-server').exchanges).toEqual([]);
            unlinkSync(join(dir, merged)); sessions.forEach((_, i) => capture(i)); resetMeetingPrimaryKeyCache();
            expect(runtime().history(sessions[0], 'same-server', 0, 100).exchanges).toHaveLength(52);
            expect(store.list().map(r => readFileSync(join(store.root, 'requests', r.exchange.requestId + '.json'), 'utf8'))).toEqual(originalBytes);
            expect(run).not.toHaveBeenCalled();
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
