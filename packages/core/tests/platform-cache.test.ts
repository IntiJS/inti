/**
 * Delivery on Cloudflare and Vercel: each CDN's own header (so stale-while-revalidate and
 * stale-if-error hold on Cloudflare, which ignores both next to s-maxage), page tags a purge
 * can target, and the Vercel Runtime Cache as a provider shared by every instance.
 */

import { describe, test, expect } from 'bun:test';
import { intiDelivery, cdnTag, cdnTags, vercelPurge, htmlTag } from '../src/delivery/index.js';
import { createCacheManager, createVercelRuntimeCacheProvider, pageTags } from '../src/cache/index.js';
import type { VercelRuntimeCache } from '../src/cache/index.js';

const html = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
function context(href: string, locals: Record<string, unknown> = {}) {
    const url = new URL(href);
    return { request: new Request(url), url, locals };
}

describe('CDN headers per platform', () => {
    test('cloudflare: its own header with max-age, and Cache-Tag', async () => {
        const delivery = intiDelivery({ cdn: { platform: 'cloudflare', sMaxAge: 120 } });
        const response = await delivery(context('https://site.test/about'), async () => html('page'));
        expect(response.headers.get('cache-control')).toContain('s-maxage=120');
        expect(response.headers.get('cloudflare-cdn-cache-control')).toBe('public, max-age=120, stale-while-revalidate=300, stale-if-error=86400');
        expect(response.headers.get('cache-tag')).toBe(`${htmlTag},${pageTags.page('about')}`);
    });

    test('vercel: Vercel-CDN-Cache-Control and Vercel-Cache-Tag, with the tags the page added', async () => {
        const delivery = intiDelivery({ cdn: { platform: 'vercel' } });
        const response = await delivery(context('https://site.test/shirts', { intiCacheTags: ['catalog:odoo:item:blue-shirt'] }), async () => html('page'));
        expect(response.headers.get('vercel-cdn-cache-control')).toContain('max-age=60');
        expect(response.headers.get('vercel-cache-tag')).toBe(`${htmlTag},${pageTags.page('shirts')},catalog:odoo:item:blue-shirt`);
    });

    test('no platform: no tags and no targeted header, as before', async () => {
        const response = await intiDelivery()(context('https://site.test/about'), async () => html('page'));
        expect(response.headers.get('cache-tag')).toBeNull();
        expect(response.headers.get('cloudflare-cdn-cache-control')).toBeNull();
    });

    test('a page that is not shareable gets neither', async () => {
        const delivery = intiDelivery({ cdn: { platform: 'cloudflare' } });
        const response = await delivery(context('https://site.test/account'), async () => html('mine', { 'cache-control': 'private' }));
        expect(response.headers.get('cache-tag')).toBeNull();
        expect(response.headers.get('cloudflare-cdn-cache-control')).toBeNull();
    });

    test('a page that set its own Cache-Control keeps it, and is still tagged', async () => {
        const delivery = intiDelivery({ cdn: { platform: 'cloudflare' } });
        const response = await delivery(context('https://site.test/news'), async () => html('news', { 'cache-control': 'public, s-maxage=5' }));
        expect(response.headers.get('cache-control')).toBe('public, s-maxage=5');
        expect(response.headers.get('cloudflare-cdn-cache-control')).toBeNull();
        expect(response.headers.get('cache-tag')).toContain(pageTags.page('news'));
    });

    test('tagHeader overrides or turns tags off', async () => {
        const custom = await intiDelivery({ cdn: { tagHeader: 'Surrogate-Key' } })(context('https://site.test/a'), async () => html('a'));
        expect(custom.headers.get('surrogate-key')).toContain(pageTags.page('a'));
        const off = await intiDelivery({ cdn: { platform: 'vercel', tagHeader: false } })(context('https://site.test/a'), async () => html('a'));
        expect(off.headers.get('vercel-cache-tag')).toBeNull();
    });
});

describe('CDN tag names', () => {
    test('safe tags pass; others become a stable hash', () => {
        expect(cdnTag('inti:page:about')).toBe('inti:page:about');
        for (const bad of ['inti:page:café', 'a,b', 'a b', 'x'.repeat(300)]) {
            expect(cdnTag(bad)).toMatch(/^inti:h:[0-9a-f]{8}$/);
            expect(cdnTag(bad)).toBe(cdnTag(bad));
        }
        expect(cdnTag('a,b')).not.toBe(cdnTag('a b'));
    });

    test('a response carries at most 128; a purge sends them all', async () => {
        const many = Array.from({ length: 200 }, (_, i) => `t${i}`);
        expect(cdnTags(many)).toHaveLength(128);
        let sent: string[] = [];
        await vercelPurge(async (tags) => (sent = tags))(many);
        expect(sent).toHaveLength(200);
    });
});

function fakeRuntimeCache() {
    const items = new Map<string, { value: unknown; tags: string[]; ttl?: number }>();
    const cache: VercelRuntimeCache & { items: typeof items } = {
        items,
        async get(key) {
            return items.get(key)?.value ?? null;
        },
        async set(key, value, options) {
            items.set(key, { value: structuredClone(value), tags: options?.tags ?? [], ttl: options?.ttl });
        },
        async delete(key) {
            items.delete(key);
        },
        async expireTag(tag) {
            const tags = Array.isArray(tag) ? tag : [tag];
            for (const [key, item] of items) if (item.tags.some((t) => tags.includes(t))) items.delete(key);
        }
    };
    return cache;
}

describe('Vercel Runtime Cache provider', () => {
    test('entries are shared, tagged, and purged by tag and by clear', async () => {
        const runtime = fakeRuntimeCache();
        const one = createCacheManager({ provider: createVercelRuntimeCacheProvider({ cache: runtime }) });
        const other = createCacheManager({ provider: createVercelRuntimeCacheProvider({ cache: runtime }) });

        await one.set('page:about', { title: 'About' }, { ttl: 60, tags: [pageTags.page('about')] });
        await one.set('page:café', { title: 'Café' }, { ttl: 60, tags: [pageTags.page('café')] });
        expect(await other.get('page:about')).toEqual({ title: 'About' });
        expect(runtime.items.get('inti:page:about')?.ttl).toBeGreaterThanOrEqual(60);

        await other.invalidateByTag(pageTags.page('about'));
        expect(await one.get('page:about')).toBeNull();
        // A tag with an accent is purged under the same name the CDN got
        await other.invalidateByTag(pageTags.page('café'));
        expect(await one.get('page:café')).toBeNull();

        await one.set('x', 1, { ttl: 60 });
        await other.clear();
        expect(await one.get('x')).toBeNull();
    });

    test('an entry with more tags than the Runtime Cache keeps is not stored', async () => {
        const runtime = fakeRuntimeCache();
        const cache = createCacheManager({ provider: createVercelRuntimeCacheProvider({ cache: runtime }) });
        await cache.set('big', 1, { ttl: 60, tags: Array.from({ length: 200 }, (_, i) => `t${i}`) });
        expect(runtime.items.size).toBe(0);
    });

    test('the HTML cache of intiDelivery works on it', async () => {
        const cache = createCacheManager({ provider: createVercelRuntimeCacheProvider({ cache: fakeRuntimeCache() }) });
        const delivery = intiDelivery({ cache, cdn: { platform: 'vercel' } });
        await delivery(context('https://site.test/about'), async () => html('first'));
        const hit = await delivery(context('https://site.test/about'), async () => html('second'));
        expect(hit.headers.get('x-inti-cache')).toBe('HIT');
        expect(await hit.text()).toBe('first');
    });
});
