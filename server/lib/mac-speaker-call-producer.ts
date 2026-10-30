/** Independent, default-OFF consumer of one shared native execution. Shadow
 * reports remain log-only; this queue alone may ask the reviewed store to
 * publish anonymous derived views. No model download, name or enrollment API. */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { durableAtomicWriteFileSync } from './atomic-fs.js';
import { dataPath } from './data-dir.js';
import { acquireMaintenanceWork, maintenanceAdmissionsOpen } from './maintenance-lifecycle.js';
import { onCorrectionApplied } from './meeting-corrections.js';
import type { MacSpeakerCallNativeRef, MacSpeakerCallProducerRequest } from './mac-speaker-call-producer-worker.js';
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const GIB = 1024 ** 3;
let childOwned = false;
export const macSpeakerCallProducerEnabled = (env: NodeJS.ProcessEnv = process.env) => /^(?:1|true|yes|on)$/i.test(env.COS_MAC_SPEAKER_CALL_PRODUCER?.trim() ?? '');
export type MacSpeakerCallProducerJob = {
    action: 'freeze';
    request: MacSpeakerCallProducerRequest;
} | {
    action: 'publish';
    request: MacSpeakerCallProducerRequest;
    ref: MacSpeakerCallNativeRef;
};
export function macSpeakerCallProducerRequestValid(r: MacSpeakerCallProducerRequest, root = dataPath('speaker-call')): boolean {
    try {
        return !!r && /^mac_[A-Za-z0-9_-]{1,100}$/.test(r.captureId) && r.root === root && realpathSync(root) === root && r.policyPath === join(root, 'admission.json') && /^[a-f0-9]{64}$/.test(r.policySHA256) && typeof r.sidecarPath === 'string' && r.sidecarPath.length <= 4096 && resolve(r.sidecarPath) === r.sidecarPath && realpathSync(dirname(r.sidecarPath)) === dirname(r.sidecarPath) && (!existsSync(r.sidecarPath) || !lstatSync(r.sidecarPath).isSymbolicLink()) && r.sidecarPath.endsWith('.g2-chunks.json') && r.ledgerPath === dataPath('meeting-corrections', `${r.captureId}.jsonl`) && r.humanJournalPath === r.sidecarPath.replace(/\.g2-chunks\.json$/, '.speaker-call-human-transaction.json');
    }
    catch {
        return false;
    }
}
export interface MacSpeakerCallResources {
    availableBytes: number;
    swapBytes: number;
    rssBytes?: number;
}
export interface MacSpeakerCallProducerDeps {
    enabled: () => boolean;
    admit: () => boolean;
    resources: (pid?: number) => Promise<MacSpeakerCallResources | null>;
    spawn: () => ChildProcess;
    now: () => number;
    kill: (pid: number) => void;
    parentExit: (cleanup: () => void) => () => void;
}
function command(path: string, args: string[]): Promise<string> { return new Promise((ok, bad) => execFile(path, args, { timeout: 1500, maxBuffer: 1024 * 1024 }, (e, s) => e ? bad(e) : ok(s))); }
export async function sampleMacSpeakerCallResources(pid?: number): Promise<MacSpeakerCallResources | null> {
    if (process.platform !== 'darwin')
        return null;
    try {
        const [vm, swap, rss] = await Promise.all([command('/usr/bin/vm_stat', []), command('/usr/sbin/sysctl', ['-n', 'vm.swapusage']), pid ? command('/bin/ps', ['-axo', 'pgid=,rss=']) : Promise.resolve('')]);
        const page = Number(vm.match(/page size of (\d+)/)?.[1]), count = (name: string) => Number(vm.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? NaN);
        const used = swap.match(/used\s*=\s*([\d.]+)([MG])/), swapBytes = used ? Number(used[1]) * (used[2] === 'G' ? GIB : 1024 ** 2) : NaN;
        const availableBytes = (count('Pages free') + count('Pages inactive') + count('Pages speculative')) * page;
        const rssBytes = pid ? rss.split('\n').reduce((n, line) => { const [g, k] = line.trim().split(/\s+/).map(Number); return n + (g === pid && Number.isFinite(k) ? k * 1024 : 0); }, 0) : undefined;
        return Number.isFinite(availableBytes) && Number.isFinite(swapBytes) ? { availableBytes, swapBytes, rssBytes } : null;
    }
    catch {
        return null;
    }
}
function spawnWorker() { const tsx = createRequire(import.meta.url).resolve('tsx/esm'); return spawn(process.execPath, ['--import', pathToFileURL(tsx).href, fileURLToPath(new URL('./mac-speaker-call-producer-worker.ts', import.meta.url))], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, COS_DATA_DIR: process.env.COS_DATA_DIR, TMPDIR: process.env.TMPDIR, OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', COS_MAC_SPEAKER_CALL_PRODUCER: '0', COS_MAC_SPEAKER_LIVE: '0', COS_TRANSCRIPT_CLEANUP: '0', COS_OPENAI_WHISPER_FALLBACK: '0', COS_LIVE_CUES: '0', COS_LIVE_CUES_V2: '0' } }); }
/** Ownership is held until actual child close, including timeout/error paths. */
export async function runMacSpeakerCallProducerChild(job: MacSpeakerCallProducerJob, overrides: Partial<MacSpeakerCallProducerDeps> = {}): Promise<{
    status: 'applied' | 'frozen' | 'deferred' | 'withheld';
    reason?: string;
    result?: unknown;
}> {
    const deps: MacSpeakerCallProducerDeps = { enabled: macSpeakerCallProducerEnabled, admit: maintenanceAdmissionsOpen, resources: sampleMacSpeakerCallResources, spawn: spawnWorker, now: Date.now, parentExit: cleanup => { process.once('exit', cleanup); return () => { process.off('exit', cleanup); }; }, kill: pid => {
            try {
                process.kill(-pid, 'SIGKILL');
            }
            catch { }
        }, ...overrides };
    let input: string;
    let unlisten = () => { };
    try {
        input = JSON.stringify(job);
        if (Buffer.byteLength(input) > 65536)
            throw Error();
    }
    catch {
        return { status: 'withheld', reason: 'worker_input_bound' };
    }
    if (childOwned)
        return { status: 'deferred', reason: 'producer_child_busy' };
    if (!deps.enabled() || !deps.admit())
        return { status: 'deferred', reason: 'admission_closed' };
    const initial = await deps.resources().catch(() => null);
    if (!initial || !Number.isFinite(initial.availableBytes) || !Number.isFinite(initial.swapBytes) || initial.availableBytes < 16 * GIB)
        return { status: 'deferred', reason: 'resource_admission' };
    if (!deps.enabled() || !deps.admit())
        return { status: 'deferred', reason: 'admission_changed' };
    if (childOwned)
        return { status: 'deferred', reason: 'producer_child_busy' };
    const lease = acquireMaintenanceWork('mac_speaker_call'), deadline = deps.now() + (job.action === 'freeze' ? 10000 : 75000);
    childOwned = true;
    try {
        return await new Promise(resolve => {
            let child: ChildProcess;
            try {
                child = deps.spawn();
            }
            catch {
                return resolve({ status: 'withheld', reason: 'worker_spawn_failed' });
            }
            let output = '', verdict: string | null = null, exited = false, sampling = false;
            const stop = (reason: string) => {
                verdict ??= reason;
                if (child.pid)
                    deps.kill(child.pid);
            };
            unlisten = deps.parentExit(() => stop('parent_exit'));
            const tick = setInterval(() => {
                if (deps.now() > deadline) {
                    stop('worker_deadline');
                    return;
                }
                if (!deps.enabled() || !deps.admit()) {
                    stop('admission_changed');
                    return;
                }
                if (sampling || !child.pid)
                    return;
                sampling = true;
                void deps.resources(child.pid).catch(() => null).then(r => {
                    sampling = false;
                    if (exited)
                        return;
                    if (!r || !Number.isFinite(r.availableBytes) || !Number.isFinite(r.swapBytes) || !Number.isFinite(r.rssBytes) || r.availableBytes < 8 * GIB || r.swapBytes - initial.swapBytes > 256 * 1024 ** 2 || (r.rssBytes ?? Infinity) > 3 * GIB)
                        stop('resource_reserve');
                });
            }, 250);
            tick.unref();
            child.stdout?.on('data', (b: Buffer) => {
                if (verdict)
                    return;
                output += b.toString();
                if (Buffer.byteLength(output) > 1024 * 1024) {
                    output = output.slice(0, 1024 * 1024);
                    stop('worker_output_bound');
                }
            });
            child.stderr?.on('data', () => { });
            child.on('error', () => {
                stop('worker_error');
                if (!child.pid) {
                    exited = true;
                    clearInterval(tick);
                    resolve({ status: 'withheld', reason: verdict! });
                }
            });
            child.on('close', code => {
                if (exited)
                    return;
                exited = true;
                clearInterval(tick);
                if (verdict || deps.now() > deadline)
                    return resolve({ status: 'deferred', reason: verdict ?? 'worker_deadline' });
                try {
                    const value = JSON.parse(output.trim());
                    if (code !== 0 || !value || !['applied', 'frozen', 'withheld'].includes(value.status))
                        throw Error();
                    resolve(value);
                }
                catch {
                    resolve({ status: 'withheld', reason: 'worker_result_invalid' });
                }
            });
            child.stdin?.on('error', () => stop('worker_input_error'));
            try {
                child.stdin?.end(input);
            }
            catch {
                stop('worker_input_error');
            }
        });
    }
    finally {
        unlisten();
        childOwned = false;
        lease.release();
    }
}
type Queued = ({
    action: 'freeze';
    request: MacSpeakerCallProducerRequest;
    freezeOnly: boolean;
    attempts: number;
    enqueuedAt: number;
} | {
    action: 'publish';
    request: MacSpeakerCallProducerRequest;
    ref: MacSpeakerCallNativeRef;
    enqueuedAt: number;
}) & {
    jobId: string;
};
export class MacSpeakerCallProducer {
    private queue: Queued[] = [];
    private running = false;
    private blockedQueue = false;
    private queueSHA256: string | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    constructor(private options: {
        root: string;
        enabled: () => boolean;
        admit: () => boolean;
        requestNative: (r: MacSpeakerCallProducerRequest) => void | Promise<void>;
        run?: (job: MacSpeakerCallProducerJob) => ReturnType<typeof runMacSpeakerCallProducerChild>;
    }) { }
    private queuePath() { return join(this.options.root, 'producer-queue.json'); }
    private write() {
        try {
            if (this.blockedQueue)
                throw Error('producer_queue_quarantined');
            const path = this.queuePath();
            if (existsSync(path) && (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 4 * 1024 * 1024))
                throw Error('producer_queue_path');
            const actual = existsSync(path) ? sha(readFileSync(path)) : null;
            if (actual !== this.queueSHA256) {
                this.blockedQueue = true;
                throw Error('producer_queue_cas');
            }
            const bytes = JSON.stringify({ version: 1, queue: this.queue }) + '\n', expected = sha(bytes);
            durableAtomicWriteFileSync(path, bytes);
            if (sha(readFileSync(path)) !== expected) {
                this.blockedQueue = true;
                throw Error('producer_queue_readback_drift');
            }
            this.queueSHA256 = expected;
        }
        catch (error) {
            this.blockedQueue = true;
            throw error;
        }
    }
    private remove(jobId: string): boolean {
        if (!this.queue.some(q => q.jobId === jobId))
            return false;
        this.queue = this.queue.filter(q => q.jobId !== jobId);
        this.write();
        return true;
    }
    private async finishFreeze(q: Extract<Queued, {
        action: 'freeze';
    }>, result: {
        status: string;
        reason?: string;
    }) {
        if (!this.queue.some(current => current.jobId === q.jobId))
            return;
        if (result.status === 'deferred') {
            this.schedule();
            return;
        }
        if (result.status !== 'frozen') {
            this.remove(q.jobId);
            this.status(q.request.captureId, result.reason ?? 'seed_withheld');
            return;
        }
        try {
            // Keep the durable token until target registration AND the shared
            // native notification have completed. Crash/restart repeats safely.
            await this.seedReady(q.request, q.freezeOnly);
            this.remove(q.jobId);
        }
        catch(error) {
            const i = this.queue.findIndex(current => current.jobId === q.jobId);
            if (i < 0)
                return; // A newer refresh superseded this exact job.
            if((error as NodeJS.ErrnoException)?.code==='MAC_CALL_NATIVE_PENDING'){
                this.status(q.request.captureId,'native_active_without_prenative_provenance');this.schedule();return;
            }
            if((error as NodeJS.ErrnoException)?.code==='MAC_CALL_NATIVE_UNAVAILABLE'){
                this.remove(q.jobId);this.status(q.request.captureId,error instanceof Error?error.message:'native_provenance_unavailable');return;
            }
            if (q.attempts < 2) {
                this.queue[i] = { ...q, jobId: randomUUID(), attempts: q.attempts + 1 };
                this.write();
                this.schedule();
            }
            else {
                this.remove(q.jobId);
                this.status(q.request.captureId, 'native_request_failed');
            }
        }
    }
    private path(path: unknown) { return typeof path === 'string' && path.length <= 4096 && resolve(path) === path && realpathSync(dirname(path)) === dirname(path) && (!existsSync(path) || !lstatSync(path).isSymbolicLink()); }
    private validRequest(r: MacSpeakerCallProducerRequest) { return macSpeakerCallProducerRequestValid(r, this.options.root); }
    private validRef(ref: MacSpeakerCallNativeRef) { return ref && /^mac_[A-Za-z0-9_-]{1,100}$/.test(ref.captureId) && /^[a-f0-9]{64}$/.test(ref.sha256) && typeof ref.path === 'string' && ref.path.startsWith(join(this.options.root, ref.captureId, 'native-')) && /^native-[a-f0-9-]{36}$/.test(dirname(ref.path).split('/').at(-1) ?? '') && ref.path.endsWith('/receipt.json') && this.path(ref.path); }
    private targets(captureId: string): MacSpeakerCallProducerRequest[] {
        const path = join(this.options.root, captureId, 'targets.json');
        if (!existsSync(path))
            return [];
        if (lstatSync(path).size > 65536)
            throw Error('producer_targets_bound');
        const v = JSON.parse(readFileSync(path, 'utf8'));
        if (!Array.isArray(v) || v.length > 8 || new Set(v.map(r => r.sidecarPath)).size !== v.length || v.some(r => !this.validRequest(r) || r.captureId !== captureId))
            throw Error('producer_targets_invalid');
        return v;
    }
    private status(id: string, reason: string) {
        try {
            if (!/^mac_[A-Za-z0-9_-]{1,100}$/.test(id))
                return;
            const dir = join(this.options.root, id);
            if (existsSync(dir))
                durableAtomicWriteFileSync(join(dir, 'producer-status.json'), JSON.stringify({ status: 'withheld', reason }) + '\n');
        }
        catch { /* A diagnostic failure cannot fail a saved meeting or notification. */ }
    }
    private retry(request: MacSpeakerCallProducerRequest, freezeOnly: boolean): Extract<Queued, {
        action: 'freeze';
    }> {
        const job: Extract<Queued, {
            action: 'freeze';
        }> = { jobId: randomUUID(), action: 'freeze', request, freezeOnly, attempts: 0, enqueuedAt: Date.now() };
        this.queue = this.queue.filter(q => q.action !== 'freeze' || q.request.sidecarPath !== request.sidecarPath);
        this.queue.push(job);
        if (this.queue.length > 200)
            throw Error('producer_queue_bound');
        this.write();
        this.schedule();
        return job;
    }
    busy() { return this.running || childOwned; }
    async refreshAvailability(captureId: string, sidecarPath: string): Promise<{
        available: boolean;
        reason: string;
    }> {
        try {
            if (!this.options.enabled())
                return { available: false, reason: 'producer_disabled' };
            if (this.blockedQueue)
                return { available: false, reason: 'producer_queue_quarantined' };
            if (!/^mac_[A-Za-z0-9_-]{1,100}$/.test(captureId))
                return { available: false, reason: 'capture_invalid' };
            const request = this.targets(captureId).find(r => r.sidecarPath === sidecarPath);
            if (!request)
                return { available: false, reason: 'copy_unregistered' };
            const path = join(this.options.root, captureId, 'native-latest.json');
            if (!existsSync(path))
                return { available: false, reason: 'cached_native_missing' };
            const worker = await import('./mac-speaker-call-producer-worker.js'), ref = JSON.parse(worker.readMacSpeakerCallProducerFile(path, 4096)!.toString());
            if (!this.options.enabled() || !this.validRef(ref) || ref.captureId !== captureId)
                return { available: false, reason: 'cached_native_invalid' };
            worker.checkMacSpeakerCallCachedNative(request, ref);
            return this.options.enabled() ? { available: true, reason: 'cached_refresh_available' } : { available: false, reason: 'producer_disabled' };
        }
        catch {
            return { available: false, reason: 'cached_refresh_unavailable' };
        }
    }
    resume() {
        if (!this.options.enabled() || !existsSync(this.queuePath()))
            return;
        try {
            if (lstatSync(this.queuePath()).isSymbolicLink() || lstatSync(this.queuePath()).size > 4 * 1024 * 1024)
                throw Error();
            const bytes = readFileSync(this.queuePath());
            const p = JSON.parse(bytes.toString());
            if (p.version !== 1 || !Array.isArray(p.queue) || p.queue.length > 200 || new Set(p.queue.map((q: Queued) => q.jobId)).size !== p.queue.length || p.queue.some((q: Queued) => !/^[a-f0-9-]{36}$/.test(q.jobId) || !this.validRequest(q.request) || !Number.isSafeInteger(q.enqueuedAt) || q.action === 'freeze' && (!Number.isInteger(q.attempts) || q.attempts < 0 || q.attempts > 3 || typeof q.freezeOnly !== 'boolean') || q.action === 'publish' && (!this.validRef(q.ref) || q.ref.captureId !== q.request.captureId) || !['freeze', 'publish'].includes(q.action)))
                throw Error();
            this.queue = p.queue;
            this.queueSHA256 = sha(bytes);
            void this.pump();
        }
        catch {
            this.blockedQueue = true; /* Preserve corrupt bytes; never treat them as paths or overwrite them. */
        }
    }
    async finalized(input: {
        sessionId: string;
        sidecarPath: string;
        freezeOnly?: boolean;
    }) {
        try {
            if (!this.options.enabled() || this.blockedQueue || !/^mac_[A-Za-z0-9_-]{1,100}$/.test(input.sessionId))
                return;
            const policyPath = join(this.options.root, 'admission.json');
            if (!existsSync(policyPath))
                return;
            const policy = readFileSync(policyPath);
            if (policy.length > 256 * 1024)
                return;
            const request: MacSpeakerCallProducerRequest = { captureId: input.sessionId, sidecarPath: input.sidecarPath, root: this.options.root, ledgerPath: dataPath('meeting-corrections', `${input.sessionId}.jsonl`), policyPath, policySHA256: sha(policy), humanJournalPath: input.sidecarPath.replace(/\.g2-chunks\.json$/, '.speaker-call-human-transaction.json') };
            if (!this.validRequest(request))
                return;
            // Persist FIRST, before a child can freeze the seed or this
            // notification can be lost in a server crash.
            const q = this.retry(request, !!input.freezeOnly);
            if (this.running)
                return;
            this.running = true;
            try {
                const result = await (this.options.run ?? runMacSpeakerCallProducerChild)({ action: 'freeze', request });
                await this.finishFreeze(q, result);
            }
            finally {
                this.running = false;
                this.schedule();
            }
        }
        catch {
            this.status(input.sessionId, 'finalization_notification_withheld');
        }
    }
    private async seedReady(request: MacSpeakerCallProducerRequest, freezeOnly: boolean) {
        const input = { sessionId: request.captureId };
        const dir = join(this.options.root, input.sessionId), path = join(dir, 'targets.json');
        let targets: MacSpeakerCallProducerRequest[] = [];
        targets = this.targets(input.sessionId);
        targets = targets.filter(t => t.sidecarPath !== request.sidecarPath);
        targets.push(request);
        if (targets.length > 8)
            return;
        durableAtomicWriteFileSync(path, JSON.stringify(targets) + '\n');
        if (freezeOnly)
            return;
        if (existsSync(join(dir, 'native-latest.json'))) {
            if (!this.nativeExport(JSON.parse(readFileSync(join(dir, 'native-latest.json'), 'utf8'))))
                throw Error('cached_native_invalid');
        }
        else
            await this.options.requestNative(request);
    }
    nativeExport(ref: MacSpeakerCallNativeRef): boolean {
        try {
            if (!this.options.enabled() || this.blockedQueue || !this.validRef(ref))
                return false;
            const dir = join(this.options.root, ref.captureId), targets = this.targets(ref.captureId);
            if (!targets.length) {
                this.status(ref.captureId, 'native_targets_missing');
                return false;
            }
            durableAtomicWriteFileSync(join(dir, 'native-latest.json'), JSON.stringify(ref) + '\n');
            for (const request of targets) {
                this.queue = this.queue.filter(q => q.request.sidecarPath !== request.sidecarPath);
                this.queue.push({ jobId: randomUUID(), action: 'publish', request, ref, enqueuedAt: Date.now() });
            }
            if (this.queue.length > 200)
                throw Error('producer_queue_bound');
            this.write();
            void this.pump();
            return true;
        }
        catch {
            this.status(ref?.captureId, 'native_targets_invalid');
            return false;
        }
    }
    ledgerChanged(captureId: string) {
        if (!this.options.enabled())
            return;
        try {
            this.nativeExport(JSON.parse(readFileSync(join(this.options.root, captureId, 'native-latest.json'), 'utf8')));
        }
        catch { /* Never rerun native merely to name/correct. */ }
    }
    async pump() {
        if (this.running || this.blockedQueue || !this.options.enabled() || !this.queue.length)
            return;
        if (!this.options.admit()) {
            this.schedule();
            return;
        }
        this.running = true;
        try {
            while (this.options.enabled() && this.options.admit() && this.queue.length) {
                const q = this.queue[0];
                if (Date.now() - q.enqueuedAt > 24 * 60 * 60 * 1000) {
                    this.status(q.request.captureId, 'queue_expired');
                    this.remove(q.jobId);
                    continue;
                }
                const result = await (this.options.run ?? (j => runMacSpeakerCallProducerChild(j, { enabled: this.options.enabled, admit: this.options.admit })))(q.action === 'freeze' ? { action: 'freeze', request: q.request } : { action: 'publish', request: q.request, ref: q.ref });
                if (result.status === 'deferred') {
                    this.schedule();
                    return;
                }
                if (q.action === 'freeze'){
                    await this.finishFreeze(q, result);
                    if(this.queue.some(current=>current.jobId===q.jobId))return;
                }
                else {
                    // A notification may replace the head while run() awaits.
                    // Never dequeue a newer token or another representation.
                    this.remove(q.jobId);
                    if (result.status === 'withheld')
                        this.status(q.request.captureId, result.reason ?? 'worker_withheld');
                }
                // Fail closed without an unbounded retry loop. A new finalization,
                // filing, correction or explicit resume may enqueue fresh valid work.
            }
        }
        catch {
            this.blockedQueue = true;
        }
        finally {
            this.running = false;
        }
    }
    private schedule() {
        if (this.timer)
            return;
        this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, 10000);
        this.timer.unref();
    }
}
let instance: MacSpeakerCallProducer | null = null;
let correctionListener = false;
export function configureMacSpeakerCallProducer(input: {
    captureActive: () => boolean;
    admissionsOpen: () => boolean;
    requestNative: (r: MacSpeakerCallProducerRequest) => void;
}) {
    instance ??= new MacSpeakerCallProducer({ root: dataPath('speaker-call'), enabled: macSpeakerCallProducerEnabled, admit: () => input.admissionsOpen() && !input.captureActive(), requestNative: input.requestNative });
    if (!correctionListener) {
        onCorrectionApplied(sessionId => instance?.ledgerChanged(sessionId));
        correctionListener = true;
    }
    instance.resume();
}
export const notifyMacSpeakerCallFinalized = (input: {
    sessionId: string;
    sidecarPath: string;
    freezeOnly?: boolean;
}): Promise<void> => instance?.finalized(input) ?? Promise.resolve();
export const notifyMacSpeakerCallNativeExport = (ref: MacSpeakerCallNativeRef) => instance?.nativeExport(ref);
export const notifyMacSpeakerCallLedgerChanged = (id: string) => instance?.ledgerChanged(id);
export const macSpeakerCallCachedRefreshAvailability = (captureId: string, sidecarPath: string): Promise<{
    available: boolean;
    reason: string;
}> => instance?.refreshAvailability(captureId, sidecarPath) ?? Promise.resolve({ available: false, reason: 'producer_not_configured' });
export const macSpeakerCallProducerBusy = () => childOwned || (instance?.busy() ?? false);
