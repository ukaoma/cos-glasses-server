/** Opt-in cancellation for Meeting Ask retrieval. Other search callers keep their existing runner. */
import { spawn } from 'node:child_process';
import { AskProcessError } from './meeting-ask-runner.js';
export function runBoundedSearch(file: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted)
        return Promise.reject(new AskProcessError('cancelled'));
    return new Promise((resolve, reject) => {
        let output = '', failure: Error | null = null, finished = false;
        const child = spawn(file, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const alive = () => { if (!child.pid)
            return false; try {
            process.kill(-child.pid, 0);
            return true;
        }
        catch {
            return false;
        } };
        const kill = () => { if (child.pid)
            try {
                process.kill(-child.pid, 'SIGKILL');
            }
            catch { } };
        const abort = () => { failure = new AskProcessError('cancelled'); kill(); };
        const timeout = setTimeout(() => { failure = new Error('search_timeout'); kill(); }, 15000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
        child.stdout.on('data', b => { output += b.toString(); if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
            failure = new Error('search_output_limit');
            kill();
        } });
        child.stderr.on('data', () => { });
        child.once('error', error => { failure = error; });
        child.once('close', code => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            const deadline = Date.now() + 4000;
            if (alive())
                kill();
            const finish = () => { if (finished)
                return; if (alive()) {
                if (Date.now() < deadline) {
                    setTimeout(finish, 50);
                    return;
                }
                finished = true;
                reject(new AskProcessError('child_exit_unconfirmed', true));
                return;
            } finished = true; if (signal.aborted)
                reject(new AskProcessError('cancelled'));
            else if (failure)
                reject(failure);
            else if (code !== 0)
                reject(new Error('search_failed'));
            else
                resolve(output); };
            finish();
        });
    });
}
