/**
 * Ids and collections from the editor never address another Strapi route.
 *
 * `${entryBase}/${documentId}` and `/api/${collection}` took them as they came, so
 * `../articles/7` or `7?populate=*` reached other collections with the server's token
 * (2026-11 audit).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StrapiAdapter } from '../src/index.js';

let calls: string[] = [];
let originalFetch: typeof fetch;

beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
        calls.push(String(input));
        return new Response('{"data":[]}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

const adapter = () => new StrapiAdapter({ endpoint: 'https://strapi.test', apiToken: 't', contentType: 'pages', blocksField: 'blocks' });

describe('Strapi ids', () => {
    for (const bad of ['../articles/7', '7?populate=*', '7#x', 'a/b', '%2e%2e']) {
        test(`"${bad}" is refused before any request`, async () => {
            const result = await adapter().updateBlockField(bad, 0, 'heading', 'x');
            expect(result.success).toBe(false);
            expect(calls).toEqual([]);
        });
    }

    test('a v5 documentId is accepted', async () => {
        await adapter().updateBlockField('h3k2j1abc0xyz', 0, 'heading', 'x');
        expect(calls[0]).toStartWith('https://strapi.test/api/pages/h3k2j1abc0xyz');
    });

    test('a collection that is not an API name is refused', async () => {
        await expect(adapter().searchEntries('../users', 'a')).rejects.toThrow(/Invalid collection/);
        expect(calls).toEqual([]);
    });
});
