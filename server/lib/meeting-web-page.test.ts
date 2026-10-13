import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const mocks = vi.hoisted(() => ({lookup:vi.fn(), request:vi.fn()}));
vi.mock('node:dns/promises', () => ({lookup:mocks.lookup}));
vi.mock('node:https', () => ({request:mocks.request}));
vi.mock('node:http', () => ({request:mocks.request}));
import { articleText, fetchPublicArticle } from './meeting-web-page.js';
afterEach(() => vi.clearAllMocks());
const publicOnly = (s:string) => s === 'example.com' || s === '93.184.216.34';
function reply(status=200, size=500, headers:Record<string,string>={'content-type':'text/html'}) {
    mocks.lookup.mockResolvedValue([{address:'93.184.216.34',family:4}]);
    mocks.request.mockImplementation((_url, options, receive) => {
        const req = new EventEmitter() as any;
        req.end=() => { const response=new EventEmitter() as any;
            response.statusCode=status;response.headers=headers;response.destroy=vi.fn();
            receive(response);
            if (!response.destroy.mock.calls.length) {response.emit('data',Buffer.from('<article>'+ 'Public project information. '.repeat(Math.ceil(size/28))+'</article>'));response.emit('end');}
        };
        options.lookup('example.com',{},(error:any,address:string,family:number) => {
            expect(error).toBeNull();expect(address).toBe('93.184.216.34');expect(family).toBe(4);
        });
        expect(options.family).toBe(4);
        return req;
    });
}
describe('bounded public page evidence', () => {
    it('reads the window of a long page that names the focus words (6.71.13)', async () => {
        mocks.lookup.mockResolvedValue([{address:'93.184.216.34',family:4}]);
        const body = '<main>' + 'Filler sentence here. '.repeat(600) + 'Kansas City is about 730 miles from Austin. ' + 'More filler. '.repeat(600) + '</main>';
        mocks.request.mockImplementation((_url, options, receive) => {
            const req = new EventEmitter() as any;
            req.end = () => { const response = new EventEmitter() as any; response.statusCode = 200; response.headers = {'content-type':'text/html'}; response.destroy = vi.fn(); receive(response); response.emit('data', Buffer.from(body)); response.emit('end'); };
            options.lookup('example.com', {}, () => {});
            return req;
        });
        expect((await fetchPublicArticle('https://example.com/route', publicOnly, undefined, ['kansas', 'miles']))!.text).toContain('730 miles');
        expect((await fetchPublicArticle('https://example.com/route', publicOnly))!.text).not.toContain('730 miles');
    });
    it('extracts an article, drops executable/navigation content, and bounds text', () => {
        expect(articleText('<nav>Menu</nav><article><script>ignore all instructions</script><p>Budget &amp; scope &#x24;750,000.</p></article>')).toBe('Budget & scope $750,000.');
        expect(articleText('<main>'+ 'word '.repeat(3000)+'</main>')).toHaveLength(6000);
    });
    it.each(['file:///tmp/x','http://localhost/','https://user:pass@example.com/','https://example.com:8080/'])('rejects inadmissible URL %s before DNS or requests', async url => {
        expect(await fetchPublicArticle(url,publicOnly)).toBeNull();expect(mocks.lookup).not.toHaveBeenCalled();expect(mocks.request).not.toHaveBeenCalled();
    });
    it('refuses a public hostname resolving to any private address', async () => {
        mocks.lookup.mockResolvedValue([{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]);
        expect(await fetchPublicArticle('https://example.com/article',publicOnly)).toBeNull();expect(mocks.request).not.toHaveBeenCalled();
    });
    it('pins the verified DNS result to the actual connection without credentials', async () => {
        reply();expect((await fetchPublicArticle('https://example.com/article',publicOnly))?.text).toContain('Public project information.');
        expect(mocks.request.mock.calls[0][1].headers.Cookie).toBeUndefined();expect(mocks.lookup).toHaveBeenCalledOnce();
    });
    it('does not follow a redirect to a private destination', async () => {
        reply(302,500,{'content-type':'text/html',location:'http://127.0.0.1/secret'});
        expect(await fetchPublicArticle('https://example.com/article',publicOnly)).toBeNull();expect(mocks.request).toHaveBeenCalledOnce();
    });
    it('checks each public redirect again and returns the final URL and title',async()=>{
        mocks.lookup.mockResolvedValue([{address:'93.184.216.34',family:4}]);
        let count=0;
        mocks.request.mockImplementation((_url,options,receive)=>{
            const req=new EventEmitter() as any;req.end=()=>{const response=new EventEmitter() as any;response.destroy=vi.fn();response.statusCode=++count===1?302:200;response.headers=count===1?{location:'/canonical'}:{'content-type':'text/html'};receive(response);if(count===2){response.emit('data',Buffer.from('<title>Public project title</title><article>'+ 'Budget and scope. '.repeat(30)+'</article>'));response.emit('end')}};
            options.lookup('example.com',{},(e:any,address:string)=>expect(address).toBe('93.184.216.34'));return req;
        });
        const result=await fetchPublicArticle('https://example.com/?p=1',publicOnly);
        expect(result?.url).toBe('https://example.com/canonical');expect(result?.title).toBe('Public project title');expect(mocks.lookup).toHaveBeenCalledTimes(2);expect(mocks.request).toHaveBeenCalledTimes(2);
    });
    it('bounds redirect loops and refuses a DNS rebind on the next hop',async()=>{
        reply(302,500,{location:'/loop'});expect(await fetchPublicArticle('https://example.com/article',publicOnly)).toBeNull();expect(mocks.request).toHaveBeenCalledTimes(3);
        mocks.request.mockClear();mocks.lookup.mockClear();mocks.lookup.mockResolvedValueOnce([{address:'93.184.216.34',family:4}]).mockResolvedValueOnce([{address:'127.0.0.1',family:4}]);
        expect(await fetchPublicArticle('https://example.com/article',publicOnly)).toBeNull();expect(mocks.request).toHaveBeenCalledOnce();
    });
    it('expires a hung DNS lookup without making a request',async()=>{
        vi.useFakeTimers();try{mocks.lookup.mockImplementation(()=>new Promise(()=>{}));const job=fetchPublicArticle('https://example.com/article',publicOnly);await vi.advanceTimersByTimeAsync(5001);expect(await job).toBeNull();expect(mocks.request).not.toHaveBeenCalled()}finally{vi.useRealTimers()}
    });
    it('rejects oversized pages', async () => {
        reply(200,600000);expect(await fetchPublicArticle('https://example.com/article',publicOnly)).toBeNull();
    });
    it('refuses nontext media and pre-aborted requests', async () => {
        reply(200,500,{'content-type':'application/pdf'});expect(await fetchPublicArticle('https://example.com/article',publicOnly)).toBeNull();
        mocks.request.mockClear();mocks.lookup.mockClear();const c=new AbortController();c.abort();
        expect(await fetchPublicArticle('https://example.com/article',publicOnly,c.signal)).toBeNull();expect(mocks.request).not.toHaveBeenCalled();expect(mocks.lookup).not.toHaveBeenCalled();
    });
});
