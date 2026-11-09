import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StrapiAdapter } from '../src/index.js';

let urls: string[] = [];
let headers: Array<Record<string, string>> = [];
let original: typeof fetch;

function respond(body: unknown, status = 200) {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        urls.push(String(input));
        headers.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
}

beforeEach(() => {
    urls = [];
    headers = [];
    original = globalThis.fetch;
});
afterEach(() => {
    globalThis.fetch = original;
});

const adapter = (extra: Record<string, unknown> = {}) =>
    new StrapiAdapter({ endpoint: 'https://strapi.test/', contentType: 'pages', ...extra } as any);

describe('StrapiAdapter.fetchPageBySlug', () => {
    test('filters by slug and parses the entry (v5, flat fields)', async () => {
        respond({ data: [{ id: 7, documentId: 'abc', slug: 'home', title: 'Inicio', blocks: [] }] });

        const page = await adapter().fetchPageBySlug('home');

        expect(page.slug).toBe('home');
        expect(page.title).toBe('Inicio');
        const url = new URL(urls[0]);
        expect(url.origin + url.pathname).toBe('https://strapi.test/api/pages');
        expect(url.searchParams.get('filters[slug][$eq]')).toBe('home');
        expect(url.searchParams.get('populate')).toBe('*');
    });

    test('accepts the v4 shape with attributes', async () => {
        respond({ data: [{ id: 7, attributes: { slug: 'home', title: 'Inicio', blocks: [] } }] });
        expect((await adapter().fetchPageBySlug('home')).title).toBe('Inicio');
    });

    test('a slug with no results is an explicit error, not an invented page', async () => {
        respond({ data: [] });
        await expect(adapter().fetchPageBySlug('missing')).rejects.toThrow(/Page not found for slug: missing/);
    });

    test('an HTTP error propagates with its status', async () => {
        respond({ error: {} }, 403);
        await expect(adapter().fetchPageBySlug('home')).rejects.toThrow(/403/);
    });

    test('sends the token if there is one', async () => {
        respond({ data: [{ id: 1, slug: 'home', title: 'x', blocks: [] }] });
        await adapter({ apiToken: 'secret' }).fetchPageBySlug('home');
        expect(headers[0].Authorization).toBe('Bearer secret');
    });
});
