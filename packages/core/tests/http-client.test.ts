import { describe, test, expect } from 'bun:test';
import { createHttpClient, isNotFound, isUnavailable, isConflict, RateLimitError } from '../src/http/index.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function server(handler: Handler) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return handler(url, init);
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
}

const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

const noSleep = async () => {};

describe('createHttpClient', () => {
    test('retries a read after a 503 and returns the data', async () => {
        let n = 0;
        const { calls, fetch } = server(() => (++n < 3 ? new Response('busy', { status: 503 }) : json({ ok: true })));
        const client = createHttpClient({ baseUrl: 'https://cms.test/api', fetch, sleep: noSleep });
        expect(await client.get('/pages')).toEqual({ ok: true });
        expect(calls).toHaveLength(3);
        expect(calls[0].url).toBe('https://cms.test/api/pages');
    });

    test('never retries a write', async () => {
        const { calls, fetch } = server(() => new Response('busy', { status: 503 }));
        const client = createHttpClient({ fetch, sleep: noSleep });
        const error = await client.post('https://cms.test/x', { json: { a: 1 } }).catch((e) => e);
        expect(isUnavailable(error)).toBe(true);
        expect(calls).toHaveLength(1);
    });

    test('a write after a network error is not repeated', async () => {
        const { calls, fetch } = server(() => {
            throw new TypeError('fetch failed');
        });
        const client = createHttpClient({ fetch, sleep: noSleep });
        const error = await client.put('https://cms.test/x', { json: {} }).catch((e) => e);
        expect(isUnavailable(error)).toBe(true);
        expect(calls).toHaveLength(1);
    });

    test('sends JSON with exactly application/json', async () => {
        const { calls, fetch } = server(() => json({}));
        const client = createHttpClient({ fetch, headers: { 'content-type': 'text/plain' } });
        await client.post('https://cms.test/x', { json: { a: 1 } });
        const headers = calls[0].init.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        expect(Object.keys(headers).filter((name) => name.toLowerCase() === 'content-type')).toHaveLength(1);
        expect(calls[0].init.body).toBe('{"a":1}');
    });

    test('times out and reports it as unavailable', async () => {
        const { fetch } = server(
            (_url, init) =>
                new Promise<Response>((_, reject) => {
                    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
                })
        );
        const client = createHttpClient({ fetch, timeoutMs: 20, retries: 0 });
        const error = await client.get('https://cms.test/slow').catch((e) => e);
        expect(isUnavailable(error)).toBe(true);
        expect(String(error.message)).toContain('timeout');
    });

    test('waits for a short Retry-After on 429', async () => {
        const waits: number[] = [];
        let n = 0;
        const { fetch } = server(() => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : json([1])));
        const client = createHttpClient({ fetch, sleep: async (ms) => void waits.push(ms) });
        expect(await client.get('https://cms.test/x')).toEqual([1]);
        expect(waits).toEqual([2000]);
    });

    test('fails at once when Retry-After is too long', async () => {
        const { calls, fetch } = server(() => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
        const client = createHttpClient({ fetch, sleep: noSleep });
        const error = await client.get('https://cms.test/x').catch((e) => e);
        expect(error).toBeInstanceOf(RateLimitError);
        expect(error.retryAfter).toBe(120);
        expect(calls).toHaveLength(1);
    });

    test('revalidates with the ETag and reuses the body on 304', async () => {
        const { calls, fetch } = server((_url, init) => {
            const headers = init.headers as Record<string, string>;
            return headers['If-None-Match'] === '"v1"'
                ? new Response(null, { status: 304 })
                : json({ title: 'Home' }, { headers: { etag: '"v1"' } });
        });
        const client = createHttpClient({ fetch });
        expect(await client.get('https://cms.test/page')).toEqual({ title: 'Home' });
        const second = await client.request('GET', 'https://cms.test/page');
        expect(second.data).toEqual({ title: 'Home' });
        expect(second.revalidated).toBe(true);
        expect(calls).toHaveLength(2);
    });

    test('shares one request between identical reads in flight', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const { calls, fetch } = server(async () => {
            await gate;
            return json({ n: 1 });
        });
        const client = createHttpClient({ fetch });
        const both = Promise.all([client.get('https://cms.test/a'), client.get('https://cms.test/a')]);
        release();
        expect(await both).toEqual([{ n: 1 }, { n: 1 }]);
        expect(calls).toHaveLength(1);
    });

    test('types 404 and 409', async () => {
        const { fetch } = server((url) => new Response('', { status: url.endsWith('missing') ? 404 : 409 }));
        const client = createHttpClient({ fetch, sleep: noSleep });
        expect(isNotFound(await client.get('https://cms.test/missing').catch((e) => e))).toBe(true);
        expect(isConflict(await client.post('https://cms.test/conflict').catch((e) => e))).toBe(true);
    });
});

describe('idempotent writes', () => {
    test('are retried once after a dropped connection, never after an answer', async () => {
        let n = 0;
        const dropped = server(() => {
            if (++n === 1) throw new TypeError('fetch failed');
            return json({ ok: true });
        });
        const client = createHttpClient({ fetch: dropped.fetch, sleep: noSleep });
        expect(await client.post('https://cms.test/x', { json: {}, idempotent: true })).toEqual({ ok: true });
        expect(dropped.calls).toHaveLength(2);

        const busy = server(() => new Response('', { status: 503 }));
        const again = createHttpClient({ fetch: busy.fetch, sleep: noSleep });
        await again.post('https://cms.test/x', { json: {}, idempotent: true }).catch(() => {});
        expect(busy.calls).toHaveLength(1);
    });
});
