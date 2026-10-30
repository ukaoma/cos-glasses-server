// Shared execution admission only. All workers/CLI/model bytes are synthetic;
// this does not qualify native execution or issue a production policy grant.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, describe, it, expect, vi } from 'vitest';
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'shared-call-producer-')));
process.env.COS_DATA_DIR = join(scratch, 'data');
const { SpeakerShadowRunner } = await import('./speaker-shadow.js');
const { dataPath } = await import('./data-dir.js');
const { maintenanceLifecycle } = await import('./maintenance-lifecycle.js');
const { syntheticMeeting } = await import('./__fixtures__/speaker-shadow/synthetic-meeting.js');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let serial = 0;
function setup() {
    const id = `mac_00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`, dir = join(scratch, String(serial));
    mkdirSync(dir);
    const sidecarPath = join(dir, 'meeting.g2-chunks.json');
    writeFileSync(sidecarPath, JSON.stringify(syntheticMeeting(id).sidecar));
    const producerRoot = dataPath('speaker-call');
    mkdirSync(producerRoot, { recursive: true });
    const request = { captureId: id, sidecarPath, root: producerRoot, ledgerPath: dataPath('meeting-corrections', `${id}.jsonl`), policyPath: join(producerRoot, 'admission.json'), policySHA256: 'a'.repeat(64), humanJournalPath: join(dir, 'meeting.speaker-call-human-transaction.json') };
    const child = Object.assign(new EventEmitter(), { pid: 123456, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() }) as unknown as ChildProcess;
    const root = join(dir, 'shadow'), jobs: any[] = [], kill = vi.fn();
    let live = true, flags = { COS_SPEAKER_SHADOW: '0', COS_MAC_SPEAKER_CALL_PRODUCER: '1' }, resources = { availableBytes: 20 * 1024 ** 3, swapBytes: 0 };
    child.stdin!.on('data', b => jobs.push(JSON.parse(b.toString())));
    const spawn = vi.fn(() => child), runner = new SpeakerShadowRunner({ env: () => flags, root: () => root, captureActive: () => live, admissionsOpen: () => true, resolveCli: async () => ({ path: join(dir, 'fake-cli'), sha256: 'b'.repeat(64), trust: 'synthetic' }), modelsPresent: () => true, audioDirFor: () => dir, spawnWorker: spawn, producerResources: async () => resources, sampleRss: async () => 1000, killGroup: kill, setTimer: () => ({}), log: () => { } });
    const flush = async () => { for (let i = 0; i < 15; i++)
        await Promise.resolve(); };
    const wait = async () => { for (let i = 0; i < 100 && !jobs.length; i++)
        await new Promise(r => setTimeout(r, 2)); expect(jobs).toHaveLength(1); };
    const close = () => { child.stdout!.emit('data', Buffer.from('{"status":"skipped","reason":"bad_sidecar","detail":"synthetic no inference"}')); child.emit('close', 0, null); };
    return { request, runner, root, spawn, jobs, kill, child, flush, wait, close, setLive: (v: boolean) => { live = v; }, setResources: (n: number) => { resources = { availableBytes: n, swapBytes: 0 }; }, setShadow: () => { flags = { ...flags, COS_SPEAKER_SHADOW: '1' }; } };
}
describe('separate closed-call consumer shares shadow execution', () => {
    it('forwards one consumer-only job without writing a shadow report', async () => { const x = setup(); await x.runner.notifyConsumerFinalized(x.request); x.setLive(false); await x.flush(); const p = x.runner.pump(); await x.wait(); expect(x.jobs[0]).toMatchObject({ callProducer: x.request, shadowLogRequested: false }); expect(maintenanceLifecycle.snapshot().activeByKind.mac_speaker_call).toBe(1); x.close(); await p; expect(maintenanceLifecycle.snapshot().activeByKind.mac_speaker_call ?? 0).toBe(0); expect(existsSync(join(x.root, 'proposals.jsonl'))).toBe(false); expect(existsSync(join(x.root, 'reports'))).toBe(false); });
    it('deduplicates both consumers and keeps the report explicitly log-only', async () => { const x = setup(); x.setShadow(); await x.runner.notifyConsumerFinalized(x.request); x.runner.notifyFinalized({ sessionId: x.request.captureId, sidecarPath: x.request.sidecarPath }); await new Promise(r => setTimeout(r, 10)); x.setLive(false); const p = x.runner.pump(); await x.wait(); expect(x.jobs[0].shadowLogRequested).toBe(true); x.close(); await p; expect(x.spawn).toHaveBeenCalledTimes(1); expect(JSON.parse(readFileSync(join(x.root, 'proposals.jsonl'), 'utf8'))).toMatchObject({ logOnly: true }); });
    it('defers resources and rejects a poisoned persisted producer request before spawning', async () => { const x = setup(); await x.runner.notifyConsumerFinalized(x.request); await x.flush(); x.setLive(false); x.setResources(1024); await x.runner.pump(); expect(x.spawn).not.toHaveBeenCalled(); const path = join(x.root, 'state.json'), state = JSON.parse(readFileSync(path, 'utf8')); state.queue[0].producerRequest.root = '/outside'; writeFileSync(path, JSON.stringify(state)); x.setResources(20 * 1024 ** 3); await x.runner.pump(); expect(x.spawn).not.toHaveBeenCalled(); expect(JSON.parse(readFileSync(path, 'utf8')).queue).toEqual([]); });
    it('defers an active log-only join before queue mutation and never invents prior provenance',async()=>{const x=setup();x.setShadow();x.setLive(false);x.runner.notifyFinalized({sessionId:x.request.captureId,sidecarPath:x.request.sidecarPath});await x.wait();expect(x.jobs[0].callProducer).toBeUndefined();await expect(x.runner.notifyConsumerFinalized(x.request)).rejects.toMatchObject({code:'MAC_CALL_NATIVE_PENDING'});expect(JSON.parse(readFileSync(join(x.root,'state.json'),'utf8')).queue[0].producerRequest).toBeUndefined();x.close();for(let i=0;i<100&&(x.runner as any).pumping;i++)await new Promise(r=>setTimeout(r,2));await expect(x.runner.notifyConsumerFinalized(x.request)).rejects.toMatchObject({code:'MAC_CALL_NATIVE_UNAVAILABLE'});expect(x.spawn).toHaveBeenCalledTimes(1);expect(JSON.parse(readFileSync(join(x.root,'state.json'),'utf8')).queue).toEqual([]);expect(existsSync(join(x.request.root,x.request.captureId,'native-latest.json'))).toBe(false)})


    it.each([false, true])('durably refuses a missing retained export with legacy logging %s and never repeats native', async legacy => {
        const x = setup(); if (legacy) x.setShadow();
        await x.runner.notifyConsumerFinalized(x.request); x.setLive(false); await x.flush();
        const p = x.runner.pump(); await x.wait();
        x.child.stdout!.emit('data', Buffer.from(JSON.stringify({ status: 'proposed', facts: {}, proposals: {}, report: { title: 'synthetic', markdown: 'synthetic legacy report' }, callProducerFailure: { stage: 'retain', reason: 'mac_call_producer_canonical_path' } })));
        x.child.emit('close', 0, null); await p;
        const state = JSON.parse(readFileSync(join(x.root, 'state.json'), 'utf8'));
        expect(state.lastRun).toMatchObject({ status: 'failed', reason: 'consumer_export_failed' });
        expect(state.lastError.detail).toBe('retain: mac_call_producer_canonical_path');
        expect(state.done).toContain(x.request.captureId); expect(state.queue).toEqual([]);
        await expect(x.runner.notifyConsumerFinalized(x.request)).rejects.toMatchObject({ code: 'MAC_CALL_NATIVE_UNAVAILABLE' });
        await x.runner.pump(); expect(x.spawn).toHaveBeenCalledTimes(1);
        expect(existsSync(join(x.root, 'proposals.jsonl'))).toBe(legacy);
    });

});
