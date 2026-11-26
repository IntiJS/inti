/**
 * Ids the editor sends never leave the post they name, and password-protected pages are
 * never rendered for visitors.
 *
 * documentId, draftId and collection reached REST URLs as they came: `5/../../users/1`
 * collapsed into another route, read and written with the service credential. And with
 * that credential the adapter reads with context=edit, which returns a protected page's
 * raw content: the password gate was bypassed on the headless site (2026-11 audit).
 */

import { describe, test, expect } from 'bun:test';
import { WordPressAdapter } from '../src/index.js';

const credentials = { username: 'svc', appPassword: 'dummy dummy dummy' };

function fakeWordPress(pages: Record<string, unknown>[]) {
    const calls: string[] = [];
    const fetch = (async (url: string, init: RequestInit = {}) => {
        const parsed = new URL(url);
        calls.push(`${init.method ?? 'GET'} ${parsed.pathname}${parsed.search}`);
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-wp-total': String(pages.length), 'x-wp-totalpages': '1' } });
        if (parsed.searchParams.has('slug')) return json(pages.filter((p) => p.slug === parsed.searchParams.get('slug')));
        const id = parsed.pathname.split('/').pop();
        const page = pages.find((p) => String(p.id) === id);
        if (page) return json(page);
        return json(pages);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
}

const page = (id: number, slug: string, extra: Record<string, unknown> = {}) => ({
    id,
    slug,
    status: 'publish',
    modified_gmt: '2026-11-01T00:00:00',
    title: { rendered: slug, raw: slug },
    content: { rendered: '<p>Secret plans</p>', raw: '<!-- wp:paragraph --><p>Secret plans</p><!-- /wp:paragraph -->', protected: false },
    acf: {},
    ...extra
});

describe('WordPress ids are post ids', () => {
    for (const bad of ['5/../../users/1', '5?context=edit', '../settings', '5#x', '0', '-1', 'abc', '1e3']) {
        test(`"${bad}" is refused before any request`, async () => {
            const wp = fakeWordPress([page(5, 'about')]);
            const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: wp.fetch });
            const result = await adapter.updateBlockField(bad, 0, 'heading', 'x');
            expect(result.success).toBe(false);
            expect(wp.calls).toEqual([]);
        });
    }

    test('a collection that is not a REST base is refused', async () => {
        const wp = fakeWordPress([]);
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: wp.fetch });
        await expect(adapter.searchEntries?.('../users', 'a') ?? Promise.reject(new Error('no search'))).rejects.toThrow();
        expect(wp.calls).toEqual([]);
    });
});

describe('WordPress password-protected pages', () => {
    test('a page with a password is not found, even with the edit credential', async () => {
        const wp = fakeWordPress([page(9, 'board', { password: 'hunter2', content: { rendered: '', raw: '<p>Secret plans</p>', protected: true } })]);
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: wp.fetch });
        await expect(adapter.fetchPageBySlug('board')).rejects.toMatchObject({ name: 'NotFoundError' });
    });

    test('content.protected alone is enough', async () => {
        const wp = fakeWordPress([page(9, 'board', { content: { rendered: '', protected: true } })]);
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', fetch: wp.fetch });
        await expect(adapter.fetchPageBySlug('board')).rejects.toMatchObject({ name: 'NotFoundError' });
    });

    test('an open page still renders', async () => {
        const wp = fakeWordPress([page(5, 'about')]);
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: wp.fetch });
        expect((await adapter.fetchPageBySlug('about')).slug).toBe('about');
    });
});
