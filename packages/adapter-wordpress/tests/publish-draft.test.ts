/**
 * publishDraft publishes drafts, and nothing else.
 *
 * Without an Inti draft prefix in the slug, publishDraft used to POST status=publish to
 * whatever post id it received: a private, pending or scheduled page went public, while
 * discardDraft already refused anything that is not a draft (2026-11 audit).
 */

import { describe, test, expect } from 'bun:test';
import { WordPressAdapter } from '../src/index.js';

const credentials = { username: 'svc', appPassword: 'dummy dummy dummy' };

function fakeWordPress(posts: Record<string, Record<string, unknown>>) {
    const calls: string[] = [];
    const fetch = (async (url: string, init: RequestInit = {}) => {
        const { pathname } = new URL(url);
        calls.push(`${init.method ?? 'GET'} ${pathname}`);
        const id = pathname.split('/').pop() ?? '';
        const post = posts[id];
        if (!post) return new Response('{"code":"rest_post_invalid_id"}', { status: 404, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ id: Number(id), title: { rendered: 'T' }, content: { raw: '' }, acf: {}, ...post }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
}

describe('WordPress publishDraft', () => {
    test('a private post is not published', async () => {
        const wp = fakeWordPress({ '7': { status: 'private', slug: 'internal-memo' } });
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: wp.fetch });

        const result = await adapter.publishDraft('7');
        expect(result.success).toBe(false);
        expect(wp.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    });

    test('a new page that is still a draft is published as is', async () => {
        const wp = fakeWordPress({ '8': { status: 'draft', slug: 'new-page' } });
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: wp.fetch });

        expect((await adapter.publishDraft('8')).success).toBe(true);
        expect(wp.calls).toContain('POST /wp-json/wp/v2/pages/8');
    });

    test('draftOriginId names the page a working copy overwrites', async () => {
        const wp = fakeWordPress({ '9': { status: 'draft', slug: 'inti-draft-of-5' }, '8': { status: 'draft', slug: 'new-page' } });
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: wp.fetch });

        expect(await adapter.draftOriginId('9')).toBe('5');
        expect(await adapter.draftOriginId('8')).toBeNull();
        expect(await adapter.draftOriginId('404')).toBeNull();
    });
});
