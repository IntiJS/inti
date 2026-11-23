import { describe, test, expect } from 'bun:test';
import {
    createCatalog,
    cachedCatalogSource,
    catalogPurgeRoute,
    signCatalogPurge,
    catalogSitemap,
    bindBlocks,
    parseBinding,
    readItem,
    readCollection
} from '../src/catalog/index.js';
import type { CatalogItem, CatalogSource } from '../src/catalog/index.js';
import { createCacheManager } from '../src/cache/index.js';
import { isNotFound } from '../src/errors/index.js';
import { buildSitemapXml, chunkSitemap, sitemapIndexRoute, sitemapFileRoute, toSitemapEntries, buildMetaTags, localeFromPath, localizedPath } from '../src/seo/index.js';

function shop(count = 2500) {
    const calls: string[] = [];
    const items: CatalogItem[] = Array.from({ length: count }, (_, i) => ({
        id: String(i + 1),
        slug: `p-${i + 1}`,
        title: `Product ${i + 1}`,
        price: { amount: 10 + i, currency: 'EUR' },
        updatedAt: '2026-11-01T00:00:00Z'
    }));
    const source: CatalogSource = {
        name: 'erp',
        idOf: (slug) => slug.replace(/^p-/, ''),
        async getItem(slug) {
            calls.push(`item:${slug}`);
            return items.find((item) => item.slug === slug) ?? null;
        },
        async list(query = {}) {
            calls.push(`list:${JSON.stringify(query)}`);
            const size = query.pageSize ?? 10;
            const page = query.page ?? 1;
            return { items: items.slice((page - 1) * size, page * size), total: items.length, page, pageSize: size };
        },
        async listCollections() {
            return [{ id: 'c1', slug: 'shirts', title: 'Shirts' }];
        },
        async listSummaries({ page, pageSize }) {
            calls.push(`summaries:${page}:${pageSize}`);
            return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length };
        }
    };
    return { source, calls, items };
}

describe('catalog', () => {
    test('a change notice drops the item and the listings, nothing else', async () => {
        const { source, calls } = shop();
        const cache = createCacheManager();
        const cached = cachedCatalogSource(source, { cache });
        await cached.getItem('p-1');
        await cached.getItem('p-2');
        await cached.list({ pageSize: 5 });

        const body = JSON.stringify({ source: 'erp', ids: [1] });
        const route = catalogPurgeRoute({ cache, sources: ['erp'], secret: 'k' });
        const response = await route({ request: new Request('https://s.test', { method: 'POST', body, headers: { 'x-inti-signature': await signCatalogPurge(body, 'k') } }) });
        expect(response.status).toBe(200);

        calls.length = 0;
        await cached.getItem('p-1');
        await cached.getItem('p-2');
        await cached.list({ pageSize: 5 });
        expect(calls).toEqual(['item:p-1', 'list:{"pageSize":5}']);
    });

    test('readItem and readCollection say 404 for what does not exist', async () => {
        const { source } = shop(3);
        expect((await readItem(source, 'p-2')).title).toBe('Product 2');
        expect(isNotFound(await readItem(source, 'nope').catch((e) => e))).toBe(true);
        expect((await readCollection(source, 'shirts')).collection.title).toBe('Shirts');
        expect(isNotFound(await readCollection(source, 'hats').catch((e) => e))).toBe(true);
    });

    test('bound blocks get live data and tags; a bad binding does not break the page', async () => {
        const { source } = shop(30);
        const catalog = createCatalog([source]);
        const { blocks, tags } = await bindBlocks(
            [
                { type: 'Hero', data: { heading: 'Hi' }, meta: { index: 0 } },
                { type: 'ProductCard', data: { inti_bind: 'item:erp/p-3' }, meta: { index: 1 } },
                { type: 'ProductGrid', data: { inti_bind: 'list:erp?pageSize=500&sort=newest' }, meta: { index: 2 } },
                { type: 'ProductCard', data: { inti_bind: 'item:other/x' }, meta: { index: 3 } }
            ],
            catalog,
            { onError: () => {} }
        );
        expect(blocks[1].data.bound.title).toBe('Product 3');
        expect(blocks[2].data.bound.pageSize).toBe(48);
        expect(blocks[3].data.bound).toBe(null);
        expect(blocks.map((block) => block.meta?.index)).toEqual([0, 1, 2, 3]);
        expect(tags).toEqual(['catalog:erp:item:3', 'catalog:erp:lists']);
        expect(parseBinding('nonsense')).toBe(null);
    });

    test('the catalog sitemap is read a file at a time, in batches', async () => {
        const { source, calls } = shop(2500);
        const section = catalogSitemap(source, { site: 'https://s.test', pathFor: (item) => `/products/${item.slug}`, batchSize: 1000 });
        expect(await section.count()).toBe(2500);
        calls.length = 0;
        const second = await section.entries(1, 1200);
        expect(second).toHaveLength(1200);
        expect(second[0].loc).toBe('https://s.test/products/p-1201');
        expect(calls).toEqual(['summaries:2:1000', 'summaries:3:1000']);
    });
});

describe('sitemaps', () => {
    test('the index lists one file per 50,000 URLs and each file serves its slice', async () => {
        const { source } = shop(120_000);
        const section = catalogSitemap(source, { site: 'https://s.test', batchSize: 50_000 });
        const index = await (await sitemapIndexRoute({ site: 'https://s.test', sections: [section] })()).text();
        expect(index.match(/<sitemap>/g)).toHaveLength(3);
        expect(index).toContain('https://s.test/sitemap-erp-3.xml');

        const file = sitemapFileRoute({ site: 'https://s.test', sections: [section] });
        const third = await (await file({ params: { section: 'erp', file: '3' } })).text();
        expect(third.match(/<url>/g)).toHaveLength(20_000);
        expect((await file({ params: { section: 'erp', file: '4' } })).status).toBe(404);
    });

    test('chunkSitemap also splits by size', () => {
        const entries = Array.from({ length: 10 }, (_, i) => ({ loc: `https://s.test/${'x'.repeat(1000)}${i}` }));
        expect(chunkSitemap(entries, { maxBytes: 3000 }).length).toBeGreaterThan(3);
    });

    test('translations become xhtml:link alternates with x-default', () => {
        const entries = toSitemapEntries(
            [{ slug: 'about', locale: 'es', translations: [{ locale: 'en', slug: 'about-us' }] }],
            { site: 'https://s.test', defaultLocale: 'es' }
        );
        const xml = buildSitemapXml(entries);
        expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
        expect(xml).toContain('hreflang="en" href="https://s.test/en/about-us"');
        expect(xml).toContain('hreflang="x-default" href="https://s.test/about"');
    });
});

describe('languages', () => {
    test('hreflang links list every version, itself included', () => {
        const tags = buildMetaTags(
            { title: 'Sobre', locale: 'es', translations: [{ locale: 'en', slug: 'about' }] },
            { url: 'https://s.test/sobre', defaultLocale: 'es' }
        );
        const links = tags.filter((tag) => tag.attrs.rel === 'alternate').map((tag) => `${tag.attrs.hreflang} ${tag.attrs.href}`);
        expect(links).toEqual(['es https://s.test/sobre', 'en https://s.test/en/about', 'x-default https://s.test/sobre']);
    });

    test('localeFromPath and localizedPath are inverses', () => {
        const routing = { locales: ['es', 'en'], defaultLocale: 'es' };
        expect(localeFromPath('/en/about', routing)).toEqual({ locale: 'en', slug: 'about', prefixed: true });
        expect(localeFromPath('/about', routing)).toEqual({ locale: 'es', slug: 'about', prefixed: false });
        expect(localeFromPath('/en', routing).slug).toBe('home');
        expect(localizedPath('about', 'en', routing)).toBe('/en/about');
        expect(localizedPath('home', 'es', routing)).toBe('/');
    });
});
