import { describe, test, expect } from 'bun:test';
import { createCacheManager, } from '@intijs/core/cache';
import { cachedCatalogSource } from '@intijs/core/catalog';
import { KitsudenAdapter, kitsudenCatalogSource } from '../src/index.js';
import { kitsudenImage, mediaTransformRoute, parseKitsudenNotice } from '../src/astro/index.js';
import { compatibleVersionResponse, isVersionRequest } from './helpers/version.js';

const ENDPOINT = 'https://cms.test';
const PAGE_ID = '11111111-2222-3333-4444-555555555555';

/** A Kitsuden that declares page-builder-patch: an edit sends only the field */
const withPatch = () =>
    new Response(JSON.stringify({ product: 'kitsuden', version: '0.10.0', contracts: { 'page-builder': 1, 'page-builder-patch': 1 } }), {
        headers: { 'content-type': 'application/json' }
    });

function fakeKitsuden(handler: (url: URL, init: RequestInit) => { status?: number; body?: unknown }, options: { patch?: boolean } = { patch: true }) {
    const calls: Array<{ method: string; url: URL; headers: Record<string, string>; body?: any }> = [];
    const fetch = (async (input: string, init: RequestInit = {}) => {
        const url = new URL(String(input));
        if (isVersionRequest(url.toString())) return options.patch ? withPatch() : compatibleVersionResponse();
        calls.push({ method: init.method ?? 'GET', url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
        const result = handler(url, init);
        return new Response(JSON.stringify(result.body ?? {}), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
}

const adapter = (fetch: typeof globalThis.fetch) => new KitsudenAdapter({ endpoint: ENDPOINT, token: 'kitsuden_agent_tests', fetch });

describe('writing a block the editor rendered', () => {
    test('goes straight to the block with If-Match, without reading the page, and returns the new version', async () => {
        const cms = fakeKitsuden(() => ({ body: { id: 'b2', updatedAt: '2026-11-20T10:00:01.000Z' } }));
        const result = await adapter(cms.fetch).updateBlockField(PAGE_ID, 1, 'headline', 'New', {
            blockId: 'b2',
            blockVersion: '2026-11-20T10:00:00.000Z'
        });
        expect(result.success).toBe(true);
        expect(result.version).toBe('2026-11-20T10:00:01.000Z');
        expect(cms.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(['PATCH /api/page-builder/blocks/b2']);
        expect(cms.calls[0].headers['If-Match']).toBe('"2026-11-20T10:00:00.000Z"');
        expect(cms.calls[0].body).toEqual({ contentPatch: [{ path: 'headline', value: 'New' }] });
    });

    test('a block that changed since the page loaded is a conflict the editor can act on', async () => {
        const cms = fakeKitsuden(() => ({ status: 409, body: { error: 'Conflict', code: 'KITSUDEN_E_CONFLICT' } }));
        const result = await adapter(cms.fetch).updateBlockField(PAGE_ID, 0, 'headline', 'X', { blockId: 'b1', blockVersion: 'old' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('changed in Kitsuden since this page loaded');
    });

    test('blocks carry their version and their style fields', () => {
        const page = adapter(fakeKitsuden(() => ({})).fetch).parsePage({
            id: PAGE_ID,
            title: 'Home',
            slug: 'home',
            blocks: [{ id: 'b1', type: 'hero', sortOrder: 0, content: {}, updatedAt: '2026-11-01T00:00:00Z', cssClass: 'wide', textColor: '#fff', columnSpan: 6 }]
        } as any);
        expect(page.blocks[0].meta).toMatchObject({ version: '2026-11-01T00:00:00Z', style: { className: 'wide', textColor: '#fff', columnSpan: 6 } });
    });
});

describe('reading for visitors', () => {
    test('getRenderedPage reads /render/:slug, with media URLs and styles', async () => {
        const cms = fakeKitsuden(() => ({
            body: {
                page: { id: PAGE_ID, title: 'Home', slug: 'home', metaTitle: 'Home | Site', publishedAt: '2026-11-01T00:00:00Z' },
                blocks: [{ id: 'b1', type: 'hero', content: { headline: 'Hi' }, backgroundColor: '#000', mediaUrls: { image: '/api/media/preset/x/hero' } }]
            }
        }));
        const page = await adapter(cms.fetch).getRenderedPage('home');
        expect(cms.calls[0].url.pathname).toBe('/api/page-builder/render/home');
        expect(page.blocks[0].data).toEqual({ headline: 'Hi', mediaUrls: { image: '/api/media/preset/x/hero' } });
        expect(page.blocks[0].meta?.style).toEqual({ backgroundColor: '#000' });
        expect(page.seo?.title).toBe('Home | Site');
    });

    test('the navigation comes from the site settings', async () => {
        const cms = fakeKitsuden(() => ({ body: { siteName: 'S', mainNav: [{ label: 'Blog', url: '/blog', openInNewTab: false }, { label: 'Broken' }] } }));
        const nav = await adapter(cms.fetch).fetchNavigation();
        expect(cms.calls[0].url.pathname).toBe('/api/settings');
        expect(nav).toEqual({ items: [{ label: 'Blog', url: '/blog' }] });
    });

    test('search posts to /api/search without an idempotency key', async () => {
        const cms = fakeKitsuden(() => ({ body: { results: [], total: 0, query: 'shoes', type: 'hybrid' } }));
        await adapter(cms.fetch).search('shoes', { limit: 500, datasetId: 'products' });
        expect(cms.calls[0]).toMatchObject({ method: 'POST', body: { query: 'shoes', type: 'hybrid', limit: 100, offset: 0, datasetId: 'products' } });
        expect(cms.calls[0].headers['Idempotency-Key']).toBeUndefined();
    });

    test('more than 100 pages are revalidated with their ETag (the map is not fixed at 100)', async () => {
        let downloads = 0;
        const fetch = (async (input: string, init: RequestInit = {}) => {
            const etag = `"${new URL(input).pathname}"`;
            if ((init.headers as Record<string, string>)['If-None-Match'] === etag) return new Response(null, { status: 304 });
            downloads++;
            return new Response(JSON.stringify({ id: PAGE_ID, title: 't', slug: 's', blocks: [] }), { headers: { 'content-type': 'application/json', etag } });
        }) as unknown as typeof globalThis.fetch;
        const a = new KitsudenAdapter({ endpoint: ENDPOINT, fetch, revalidationEntries: 300 });
        for (let round = 0; round < 2; round++) for (let i = 0; i < 150; i++) await a.fetchPage(`p${i}`);
        expect(downloads).toBe(150);
    });
});

describe('images through /transform', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

    test('kitsudenImage offers srcset plus AVIF and WebP, on the site origin, never wider than the original', () => {
        const image = kitsudenImage(`/api/media/preset/${id}/large`, { width: 1000, height: 500, alt: 'A' })!;
        expect(image.srcset?.map((c) => c.width)).toEqual([320, 640, 960]);
        expect(image.sources?.map((s) => s.type)).toEqual(['image/avif', 'image/webp']);
        expect(image.sources?.[0].srcset[0].url).toBe(`/img/t/${id}/320.avif`);
        expect(kitsudenImage('https://elsewhere.test/a.png')).toBeNull();
    });

    test('the route proxies the transform and marks it immutable', async () => {
        let asked = '';
        const fetch = (async (input: string) => {
            asked = String(input);
            return new Response('img', { headers: { 'content-type': 'image/avif' } });
        }) as unknown as typeof globalThis.fetch;
        const route = mediaTransformRoute(ENDPOINT, { fetch });
        const response = await route({ params: { id, file: '640.avif' }, request: new Request('https://site.test/x') });
        expect(asked).toBe(`${ENDPOINT}/api/media/transform/${id}?w=640&f=avif`);
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect((await route({ params: { id, file: '640.svg' }, request: new Request('https://site.test/x') })).status).toBe(404);
    });
});

describe('a catalog served from a Kitsuden dataset', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
        id: `e${i}`,
        updatedAt: `2026-11-0${i + 1}T00:00:00Z`,
        data: { title: `Shirt ${i}`, price: 10 + i, stock: i % 2, color: i < 3 ? 'red' : 'blue', collections: ['shirts'] }
    }));

    const source = () => {
        const cms = fakeKitsuden(() => ({ body: { docs: entries, totalDocs: entries.length, hasMore: false } }));
        return { cms, catalog: kitsudenCatalogSource({ endpoint: ENDPOINT, datasetId: 'products', currency: 'EUR', fields: { attributes: { Color: 'color' } }, fetch: cms.fetch }) };
    };

    test('items, filters, facets and a snapshot shared between calls', async () => {
        const { cms, catalog } = source();
        expect((await catalog.getItem('shirt-2'))?.price).toEqual({ amount: 12, currency: 'EUR', compareAt: undefined });
        const page = await catalog.list({ filters: { Color: ['red'] }, inStock: true, sort: 'price-desc', facets: ['Color'] });
        expect(page.items.map((item) => item.slug)).toEqual(['shirt-1']);
        expect(page.facets?.[0]).toEqual({ name: 'Color', values: [{ value: 'red', count: 1 }] });
        expect(cms.calls).toHaveLength(1);
        expect(cms.calls[0].url.pathname).toBe('/api/data-sets/products/entries');
    });

    test('an entry:updated notice drops that item and the listings', async () => {
        const { catalog } = source();
        const cache = createCacheManager();
        const cached = cachedCatalogSource(catalog, { cache });
        expect(cached.name).toBe('kitsuden-products');
        const notice = parseKitsudenNotice({ event: 'entry:updated', data: { id: 'e1', datasetId: 'products' } });
        expect(notice).toEqual({ tags: ['catalog:kitsuden-products:item:e1', 'catalog:kitsuden-products:lists'] });
    });
});
