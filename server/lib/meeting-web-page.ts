/** Small, bounded article fetch. DNS is checked and pinned for the actual socket.
 * No cookies, credentials, scripts, or page-supplied instructions run.
 * At most two redirects; each destination receives the same DNS and URL checks. */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export function articleText(html: string): string {
    const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1]
        ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
    return article.replace(/<(script|style|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
        .replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => {
            const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1),16) : Number(n);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
        })
        .replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, n: string) => ({nbsp:' ',amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'}[n.toLowerCase()] ?? ' '))
        .replace(/\s+/g, ' ').trim().slice(0, 6000);
}

export interface PublicArticle { url:string; text:string; title?:string }
export async function fetchPublicArticle(url: string, allowedAddress: (address: string) => boolean, signal?: AbortSignal): Promise<PublicArticle | null> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 5000);
    signal?.addEventListener('abort', abort, {once:true});
    const visit = async (next:string, redirects:number): Promise<PublicArticle | null> => {
    const u = new URL(next);
    if (controller.signal.aborted || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port)) || !allowedAddress(u.hostname)) return null;
        if (signal?.aborted) return null;
        const addresses = await Promise.race([
            lookup(u.hostname, {all:true}),
            new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(Error('aborted')), {once:true})),
        ]);
        if (!addresses.length || addresses.some(a => !isIP(a.address) || !allowedAddress(a.address)) || controller.signal.aborted) return null;
        const pinned = addresses[0];
        return await new Promise<PublicArticle | null>((resolve) => {
            let done = false;
            const finish = (value: PublicArticle | null) => { if (!done) { done = true; resolve(value); } };
            const request = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
                signal:controller.signal, agent:false, family:pinned.family,
                headers:{Accept:'text/html, text/plain', 'Accept-Encoding':'identity', 'User-Agent':'COS-Meeting-Ask/1.0'},
                lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
            }, response => {
                // Redirect destinations cannot inherit the original socket approval.
                if ([301,302,303,307,308].includes(response.statusCode ?? 0) && response.headers.location) {
                    response.destroy();
                    if (redirects >= 2) { finish(null); return; }
                    try { void visit(new URL(response.headers.location,u).href,redirects+1).then(finish, () => finish(null)); }
                    catch { finish(null); }
                    return;
                }
                const type = String(response.headers['content-type'] ?? '').toLowerCase();
                if (response.statusCode !== 200 || !/^(text\/html|text\/plain)\b/.test(type)
                    || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
                    response.destroy(); finish(null); return;
                }
                const chunks: Buffer[] = []; let size = 0;
                response.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > 512000) { response.destroy(); finish(null); }
                    else chunks.push(chunk);
                });
                response.on('error', () => finish(null));
                response.on('aborted', () => finish(null));
                response.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    const text = type.startsWith('text/html') ? articleText(raw) : raw.slice(0,6000);
                    const title = type.startsWith('text/html') ? articleText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? '').slice(0,240) : '';
                    finish(text.length >= 160 ? {url:u.href,text,...(title ? {title} : {})} : null);
                });
            });
            request.on('error', () => finish(null));
            request.end();
        });
    };
    try { return await visit(url,0); } catch { return null; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
