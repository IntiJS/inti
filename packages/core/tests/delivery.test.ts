import { describe, test, expect } from 'bun:test';
import { intiDelivery, purgeRoute, signBody, stripEditorMarkup, cacheKeyOf, purgeTags } from '../src/delivery/index.js';
import { createCacheManager, cachePages, pageTags } from '../src/cache/index.js';
import { NotFoundError, UnavailableError } from '../src/errors/index.js';

const html = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

function context(path: string, headers: Record<string, string> = {}) {
    const url = new URL(`https://site.test${path}`);
    return { request: new Request(url, { headers }), url, locals: {} as Record<string, unknown> };
}

describe('intiDelivery', () => {
    test('anonymous visitors get CDN headers and no editor markup', async () => {
        const delivery = intiDelivery();
        const response = await delivery(context('/about'), async () =>
            html('<div class="inti-block-wrapper" data-inti-block="Hero" data-inti-block-index="0"><h1 data-inti-field="heading">Hi</h1><aside data-inti-why>why</aside></div>')
        );
        expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400');
        const body = await response.text();
        expect(body).toBe('<div class="inti-block-wrapper"><h1>Hi</h1><aside data-inti-why>why</aside></div>');
    });

    test('editors get private, no-store, Vary: Cookie and the markup intact', async () => {
        const delivery = intiDelivery({ isEditor: async () => true });
        const ctx = context('/about', { cookie: 'session=1' });
        const response = await delivery(ctx, async () => html('<h1 data-inti-field="heading">Hi</h1>'));
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('vary')).toContain('Cookie');
        expect(await response.text()).toContain('data-inti-field');
        expect(ctx.locals.intiEditor).toBe(true);
    });

    test('a request without cookies never asks for a session; one with cookies asks once per few seconds', async () => {
        let asked = 0;
        const delivery = intiDelivery({ isEditor: async () => (asked++, false) });
        await delivery(context('/'), async () => html('a'));
        expect(asked).toBe(0);
        await delivery(context('/', { cookie: 'x=1' }), async () => html('a'));
        await delivery(context('/', { cookie: 'x=1' }), async () => html('a'));
        expect(asked).toBe(1);
    });

    test('a page that sets its own Cache-Control (personalized) is neither cached nor made public', async () => {
        const cache = createCacheManager();
        const delivery = intiDelivery({ cache });
        let renders = 0;
        const render = async () => (renders++, html('mine', { 'cache-control': 'private, no-store' }));
        const first = await delivery(context('/p'), render);
        await delivery(context('/p'), render);
        expect(first.headers.get('cache-control')).toBe('private, no-store');
        expect(renders).toBe(2);
    });

    test('serves cached HTML, ignores tracking parameters, and a purge drops it', async () => {
        const cache = createCacheManager();
        const delivery = intiDelivery({ cache });
        let renders = 0;
        const render = async () => html(`v${++renders}`);

        expect(await (await delivery(context('/about'), render)).text()).toBe('v1');
        const hit = await delivery(context('/about/?utm_source=news&fbclid=x'), render);
        expect(hit.headers.get('x-inti-cache')).toBe('HIT');
        expect(await hit.text()).toBe('v1');

        const route = purgeRoute({ cache, secret: 's3cret' });
        const body = JSON.stringify({ slug: 'about' });
        const purged = await route({
            request: new Request('https://site.test/api/inti/purge', { method: 'POST', body, headers: { 'x-inti-signature': await signBody(body, 's3cret') } })
        });
        expect(purged.status).toBe(200);
        expect(await (await delivery(context('/about'), render)).text()).toBe('v2');
    });

    test('when rendering fails it serves the stale copy, else 503; a missing page is a 404', () => {
        const real = Date.now;
        let offset = 0;
        Date.now = () => real() + offset;
        return (async () => {
            const cache = createCacheManager();
            const delivery = intiDelivery({ cache, htmlTtl: 10 });
            await delivery(context('/home'), async () => html('good'));
            offset = 60_000;

            const stale = await delivery(context('/home'), async () => {
                throw new UnavailableError('CMS down', { retryAfter: 120 });
            });
            expect(stale.headers.get('x-inti-cache')).toBe('STALE');
            expect(await stale.text()).toBe('good');

            const down = await delivery(context('/other'), async () => {
                throw new UnavailableError('CMS down', { retryAfter: 120 });
            });
            expect(down.status).toBe(503);
            expect(down.headers.get('retry-after')).toBe('120');

            const missing = await delivery(context('/nope'), async () => {
                throw new NotFoundError('page', 'nope');
            });
            expect(missing.status).toBe(404);
        })().finally(() => {
            Date.now = real;
        });
    });
});

describe('development', () => {
    test('everybody is an editor: the markup stays and nothing is cached', async () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'development';
        try {
            const delivery = intiDelivery({ cache: createCacheManager() });
            const ctx = context('/about');
            const response = await delivery(ctx, async () => html('<h1 data-inti-field="heading">Hi</h1>'));
            expect(await response.text()).toContain('data-inti-field');
            expect(response.headers.get('cache-control')).toBe('private, no-store');
            expect(ctx.locals.intiEditor).toBe(true);
        } finally {
            process.env.NODE_ENV = previous;
        }
    });
});

describe('purgeRoute', () => {
    test('refuses a bad signature and answers 503 without a secret', async () => {
        const cache = createCacheManager();
        const request = () => new Request('https://s.test/p', { method: 'POST', body: '{}', headers: { 'x-inti-signature': 'sha256=' + '0'.repeat(64) } });
        expect((await purgeRoute({ cache, secret: 'k' })({ request: request() })).status).toBe(401);
        expect((await purgeRoute({ cache, secret: () => undefined })({ request: request() })).status).toBe(503);
    });

    test('drops a page from the data cache too', async () => {
        const cache = createCacheManager();
        const calls: string[] = [];
        const pages = cachePages({ fetchPageBySlug: async (slug) => (calls.push(slug), { id: slug, slug, title: slug, blocks: [] }) }, { cache });
        await pages.fetchPageBySlug('about');
        const body = JSON.stringify({ slugs: ['about'] });
        await purgeRoute({ cache, secret: 'k' })({
            request: new Request('https://s.test/p', { method: 'POST', body, headers: { 'x-inti-signature': await signBody(body, 'k') } })
        });
        await pages.fetchPageBySlug('about');
        expect(calls).toEqual(['about', 'about']);
    });

    test('a deletion drops everything', () => {
        expect(purgeTags({ slug: 'a', event: 'page.deleted' })).toContain(pageTags.all);
        expect(purgeTags({ slug: 'a' })).toEqual([pageTags.page('a'), pageTags.page('home')]);
    });
});

describe('helpers', () => {
    test('cacheKeyOf sorts the query and drops tracking', () => {
        expect(cacheKeyOf(new URL('https://s.test/a/?b=2&utm_medium=x&a=1&gclid=z'))).toBe('/a?a=1&b=2');
    });

    test('stripEditorMarkup removes block JSON islands and leaves text alone', () => {
        const input = '<p>data-inti-field="x"</p><div data-inti-block-index=3><script type="application/json" data-inti-block-json>{"a":1}</script></div>';
        expect(stripEditorMarkup(input)).toBe('<p>data-inti-field="x"</p><div></div>');
    });
});
