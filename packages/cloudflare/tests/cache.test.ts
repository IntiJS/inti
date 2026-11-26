/**
 * The KV cache provider and the CDN purge, against an in-memory KV and a recorded fetch.
 * A purge is one write whatever the size of the site: a Worker invocation may make 1000
 * KV operations at most, so deleting every entry of a tag would not scale.
 */

import { describe, test, expect } from 'bun:test';
import { createCacheManager, pageTags } from '@intijs/core/cache';
import { cloudflarePurge, createKvCacheProvider } from '../src/cache.js';

function fakeKv() {
    const values = new Map<string, string>();
    let operations = 0;
    const kv = {
        values,
        get operations() {
            return operations;
        },
        async get(key: string | string[], typeOrOptions: unknown) {
            operations++;
            const type = typeof typeOrOptions === 'string' ? typeOrOptions : (typeOrOptions as { type: string }).type;
            const one = (k: string) => {
                const raw = values.get(k) ?? null;
                return raw !== null && type === 'json' ? JSON.parse(raw) : raw;
            };
            if (Array.isArray(key)) {
                if (key.length > 100) throw new Error('KV bulk get takes at most 100 keys');
                return new Map(key.map((k) => [k, one(k)]));
            }
            return one(key);
        },
        async put(key: string, value: string, options: { expirationTtl?: number } = {}) {
            operations++;
            if (new TextEncoder().encode(key).length > 512) throw new Error('key too long');
            if (options.expirationTtl !== undefined && options.expirationTtl < 60) throw new Error('expirationTtl below 60');
            values.set(key, value);
        },
        async delete(key: string) {
            operations++;
            values.delete(key);
        }
    };
    return kv;
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createKvCacheProvider', () => {
    test('shared between isolates; a purge is one write and hides older entries', async () => {
        const kv = fakeKv();
        const one = createCacheManager({ provider: createKvCacheProvider(kv as never, { purgeMargin: 0 }) });
        const other = createCacheManager({ provider: createKvCacheProvider(kv as never, { purgeMargin: 0 }) });

        for (let i = 0; i < 50; i++) await one.set(`page:${i}`, i, { ttl: 60, tags: ['inti:pages', pageTags.page(String(i))] });
        expect(await other.get('page:7')).toBe(7);

        const before = kv.operations;
        await other.invalidateByTag('inti:pages');
        expect(kv.operations - before).toBe(1);
        expect(await one.get('page:7')).toBeNull();

        await later(5);
        await one.set('page:7', 'again', { ttl: 60, tags: ['inti:pages'] });
        expect(await other.get('page:7')).toBe('again');
    });

    test('a purge by one page leaves the others', async () => {
        const kv = fakeKv();
        const cache = createCacheManager({ provider: createKvCacheProvider(kv as never, { purgeMargin: 0 }) });
        await cache.set('a', 'A', { ttl: 60, tags: [pageTags.page('a')] });
        await cache.set('b', 'B', { ttl: 60, tags: [pageTags.page('b')] });
        await cache.invalidateByTag(pageTags.page('a'));
        expect(await cache.get('a')).toBeNull();
        expect(await cache.get('b')).toBe('B');
        await cache.clear();
        expect(await cache.get('b')).toBeNull();
    });

    test('an entry stored within the margin after a purge counts as purged', async () => {
        const kv = fakeKv();
        const cache = createCacheManager({ provider: createKvCacheProvider(kv as never) });
        await cache.invalidateByTag('t');
        await cache.set('k', 'rendered before the purge, stored after', { ttl: 60, tags: ['t'] });
        expect(await cache.get('k')).toBeNull();
    });

    test('long keys, many tags and short TTLs stay inside KV limits', async () => {
        const kv = fakeKv();
        const cache = createCacheManager({ provider: createKvCacheProvider(kv as never, { purgeMargin: 0 }) });
        const key = `inti:html:site.test/${'x'.repeat(800)}`;
        await cache.set(key, 'long', { ttl: 1, swr: 0, tags: Array.from({ length: 250 }, (_, i) => `tag${i}`) });
        expect(await cache.get(key)).toBe('long');
        await cache.invalidateByTag('tag249');
        expect(await cache.get(key)).toBeNull();
    });

    test('a refused write (429) does not break the page', async () => {
        const kv = fakeKv();
        kv.put = async () => {
            throw new Error('KV PUT failed: 429 Too Many Requests');
        };
        const cache = createCacheManager({ provider: createKvCacheProvider(kv as never) });
        await cache.set('k', 1, { ttl: 60 });
        expect(await cache.get('k')).toBeNull();
    });
});

describe('cloudflarePurge', () => {
    const zoneId = '0123456789abcdef0123456789abcdef';

    test('posts the tags, 100 per call, with the token', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const fetch = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return Response.json({ success: true, result: { id: '1' } });
        }) as unknown as typeof globalThis.fetch;
        const purge = cloudflarePurge({ zoneId, apiToken: () => 'tok', fetch });
        await purge(Array.from({ length: 150 }, (_, i) => `t${i}`));
        expect(calls).toHaveLength(2);
        expect(calls[0].url).toBe(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`);
        expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
        expect(JSON.parse(String(calls[0].init.body)).tags).toHaveLength(100);
        expect(JSON.parse(String(calls[1].init.body)).tags).toHaveLength(50);
    });

    test('a refusal throws, so the CMS sends the notice again', async () => {
        const fetch = (async () =>
            Response.json({ success: false, errors: [{ code: 1134, message: 'rate limited' }] }, { status: 429 })) as unknown as typeof globalThis.fetch;
        await expect(cloudflarePurge({ zoneId, apiToken: 'tok', fetch })(['a'])).rejects.toThrow(/1134/);
    });

    test('a zone id that is not one is refused at once', () => {
        expect(() => cloudflarePurge({ zoneId: '../accounts', apiToken: 'tok' })).toThrow(/zone id/);
    });
});
