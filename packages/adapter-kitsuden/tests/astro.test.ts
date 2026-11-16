import { describe, test, expect } from 'bun:test';
import { toComposerBlockTypes, KitsudenUnavailableError } from '../src/index.js';
import {
    blockAttributes,
    createPageCache,
    currentVisitorIp,
    fieldAttributes,
    imageSrc,
    kitsudenEditorPlugin,
    kitsudenMiddleware,
    markupFor,
    proxyMedia,
    purgeRoute,
    resolveEditor,
    sameOriginMediaUrl,
    sessionCookies,
    stripSecretsForBuild
} from '../src/astro/index.js';

/**
 * The glue every Kitsuden site copied (four copies that had drifted apart), now in one place.
 * These tests pin what each copy got right, plus what one of them got wrong.
 */

const SESSION = 'better-auth.session_token=abc.def';

function sessionApi(role: string | null, seen: string[] = []) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(`${String(input)} | ${(init?.headers as Record<string, string>)?.cookie ?? ''}`);
        if (!role) return new Response('null', { status: 200 });
        return Response.json({ user: { id: 'u1', role, email: 'e@x.test' } });
    }) as typeof fetch;
}

describe('editor session', () => {
    test('only better-auth cookies reach the API, and only when a session token is there', () => {
        expect(sessionCookies(`theme=dark; ${SESSION}; better-auth.dont_remember=1; _ga=x`)).toBe(`${SESSION}; better-auth.dont_remember=1`);
        expect(sessionCookies('better-auth.dont_remember=1; theme=dark')).toBe('');
        expect(sessionCookies(null)).toBe('');
    });

    test('the role is read without the cookie cache, so a demotion applies at once', async () => {
        const seen: string[] = [];
        const editor = await resolveEditor(`${SESSION}; theme=dark`, { api: 'https://cms.test/', fetch: sessionApi('editor', seen) });
        expect(editor).toMatchObject({ id: 'u1', role: 'editor' });
        expect(seen[0]).toBe(`https://cms.test/api/auth/get-session?disableCookieCache=true | ${SESSION}`);
    });

    test('a reader, no cookie, or a failing API is not an editor', async () => {
        expect(await resolveEditor(SESSION, { api: 'https://cms.test', fetch: sessionApi('reader') })).toBeNull();
        const seen: string[] = [];
        expect(await resolveEditor('theme=dark', { api: 'https://cms.test', fetch: sessionApi('admin', seen) })).toBeNull();
        expect(seen).toHaveLength(0);
        const broken = (async () => {
            throw new Error('down');
        }) as unknown as typeof fetch;
        expect(await resolveEditor(SESSION, { api: 'https://cms.test', fetch: broken })).toBeNull();
    });

    test('the plugin refuses a write without an editor, even when resolveActor said null', async () => {
        const plugin = kitsudenEditorPlugin(async () => null);
        expect(await plugin.beforeWrite({ operation: 'updateBlockField' })).toMatchObject({ allowed: false });
        const allowed = kitsudenEditorPlugin(async () => ({ id: 'u', role: 'admin' }));
        expect(await allowed.beforeWrite({ operation: 'updateBlockField' })).toEqual({ allowed: true });
    });
});

const ctx = (path: string, init: RequestInit & { clientAddress?: string } = {}) => ({
    request: new Request(`https://site.test${path}`, init),
    url: new URL(`https://site.test${path}`),
    clientAddress: init.clientAddress ?? '10.0.0.1',
    locals: {} as Record<string, unknown>
});
const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

describe('middleware', () => {
    test('an image or an asset never costs a session lookup', async () => {
        const seen: string[] = [];
        const onRequest = kitsudenMiddleware({ api: 'https://cms.test', fetch: sessionApi('admin', seen), registerPlugin: false });
        for (const path of ['/img/aaaa/large', '/media/a.png', '/_astro/x.js', '/favicon.svg', '/robots.txt']) {
            await onRequest(ctx(path, { headers: { cookie: SESSION } }), async () => new Response('x'));
        }
        expect(seen).toHaveLength(0);
    });

    test("an editor's response is private and varies by cookie", async () => {
        const onRequest = kitsudenMiddleware({ api: 'https://cms.test', fetch: sessionApi('editor'), registerPlugin: false });
        const response = await onRequest(ctx('/about', { headers: { cookie: SESSION } }), async () => html('<p>editing</p>', { 'cache-control': 'public, max-age=60' }));
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('vary')).toContain('Cookie');
    });

    test('anonymous HTML is served from the cache; editors always get a fresh render', async () => {
        const cache = createPageCache({ ttlSeconds: 60 });
        let renders = 0;
        const render = async () => html(`<p>render ${++renders}</p>`);

        const anonymous = kitsudenMiddleware({ api: 'https://cms.test', fetch: sessionApi(null), cache, registerPlugin: false });
        const first = await anonymous(ctx('/about'), render);
        const second = await anonymous(ctx('/about'), render);
        expect(first.headers.get('x-inti-cache')).toBe('MISS');
        expect(second.headers.get('x-inti-cache')).toBe('HIT');
        expect(await second.text()).toBe('<p>render 1</p>');

        const editor = kitsudenMiddleware({ api: 'https://cms.test', fetch: sessionApi('editor'), cache, registerPlugin: false });
        expect(await (await editor(ctx('/about', { headers: { cookie: SESSION } }), render)).text()).toBe('<p>render 2</p>');
    });

    test('responses that set cookies or say private are not cached', async () => {
        const cache = createPageCache();
        const onRequest = kitsudenMiddleware({ api: 'https://cms.test', fetch: sessionApi(null), cache, registerPlugin: false });
        await onRequest(ctx('/a'), async () => html('x', { 'set-cookie': 'a=1' }));
        await onRequest(ctx('/b'), async () => html('x', { 'cache-control': 'private' }));
        expect(cache.size).toBe(0);
    });

    test('when Kitsuden cannot answer: a stale copy if there is one, a 503 otherwise', async () => {
        const cache = createPageCache({ ttlSeconds: 0 });
        const onRequest = kitsudenMiddleware({ api: 'https://cms.test', fetch: sessionApi(null), cache, registerPlugin: false });
        await onRequest(ctx('/about'), async () => html('<p>old</p>'));
        await new Promise((resolve) => setTimeout(resolve, 5));

        const down = async () => {
            throw new KitsudenUnavailableError('GET /pages/about → 503', 503, 30);
        };
        const stale = await onRequest(ctx('/about'), down);
        expect(stale.headers.get('x-inti-cache')).toBe('STALE');
        expect(await stale.text()).toBe('<p>old</p>');

        const none = await onRequest(ctx('/never-seen'), down);
        expect(none.status).toBe(503);
        expect(none.headers.get('retry-after')).toBe('30');
    });

    test("the adapter can read the visitor's IP during the request; behind a proxy, the last X-Forwarded-For entry", async () => {
        const direct = kitsudenMiddleware({ api: 'https://cms.test', fetch: sessionApi(null), registerPlugin: false });
        let seen: string | undefined;
        await direct(ctx('/a', { clientAddress: '203.0.113.9', headers: { 'x-forwarded-for': '1.1.1.1' } }), async () => ((seen = currentVisitorIp()), html('x')));
        expect(seen).toBe('203.0.113.9');

        const proxied = kitsudenMiddleware({ api: 'https://cms.test', fetch: sessionApi(null), trustProxy: true, registerPlugin: false });
        await proxied(ctx('/a', { clientAddress: '10.0.0.2', headers: { 'x-forwarded-for': 'spoofed, 198.51.100.4' } }), async () => ((seen = currentVisitorIp()), html('x')));
        expect(seen).toBe('198.51.100.4');
        expect(currentVisitorIp()).toBeUndefined();
    });
});

describe('purge webhook', () => {
    const secret = 'purge-secret';
    const sign = async (body: string, key = secret) => {
        const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)));
        return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    };
    const post = async (body: string, signature: string | null) =>
        new Request('https://site.test/api/kitsuden/purge', { method: 'POST', body, headers: signature ? { 'x-kitsuden-signature': signature } : {} });

    function seeded() {
        const cache = createPageCache();
        for (const path of ['/', '/about', '/about?ref=x', '/pricing']) cache.store(new URL(`https://site.test${path}`), { status: 200, headers: [], body: path });
        return cache;
    }

    test('a page:updated with a slug purges that page and the home page', async () => {
        const cache = seeded();
        const body = JSON.stringify({ event: 'page:updated', data: { id: 'p1', slug: 'about' } });
        const response = await purgeRoute(cache, secret)({ request: await post(body, await sign(body)) });
        expect(await response.json()).toEqual({ purged: 3 });
        expect(cache.fresh(new URL('https://site.test/pricing'))).toBeDefined();
    });

    test('a deletion purges everything', async () => {
        const cache = seeded();
        const body = JSON.stringify({ event: 'page:deleted', slug: 'about' });
        await purgeRoute(cache, secret)({ request: await post(body, await sign(body)) });
        expect(cache.size).toBe(0);
    });

    test('without the right signature nothing is purged', async () => {
        const cache = seeded();
        const body = JSON.stringify({ slug: 'about' });
        expect((await purgeRoute(cache, secret)({ request: await post(body, null) })).status).toBe(401);
        expect((await purgeRoute(cache, secret)({ request: await post(body, await sign(body, 'wrong')) })).status).toBe(401);
        expect((await purgeRoute(cache, () => undefined)({ request: await post(body, await sign(body)) })).status).toBe(503);
        expect(cache.size).toBe(4);
    });
});

describe('media from the site origin', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

    test('imageSrc keeps ids, API paths and https; drops everything else', () => {
        expect(imageSrc(id)).toBe(`/img/${id}/large`);
        expect(imageSrc(`/api/media/preset/${id}/hero`)).toBe(`/img/${id}/hero`);
        expect(imageSrc('/media/uploads/a.png')).toBe('/media/uploads/a.png');
        expect(imageSrc('https://cdn.test/a.png')).toBe('https://cdn.test/a.png');
        for (const bad of ['javascript:alert(1)', 'http://plain.test/a.png', 'data:image/png;base64,AA', '/media/../etc/passwd', `/api/media/preset/${id}/huge`]) {
            expect(imageSrc(bad)).toBeNull();
        }
    });

    test('sameOriginMediaUrl gives the adapter absolute URLs on the site', () => {
        expect(sameOriginMediaUrl('https://www.example.com/')(id, 'large')).toBe(`https://www.example.com/img/${id}/large`);
    });

    test('Range passes through, so a video can be sought', async () => {
        let forwarded: string | undefined;
        const upstream = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            forwarded = (init?.headers as Record<string, string>).range;
            return new Response(new Uint8Array(10), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-9/100', 'accept-ranges': 'bytes' } });
        }) as typeof fetch;
        const response = await proxyMedia('https://cms.test', '/media/v.mp4', { fetch: upstream, request: new Request('https://site.test/media/v.mp4', { headers: { range: 'bytes=0-9' } }) });
        expect(forwarded).toBe('bytes=0-9');
        expect(response.status).toBe(206);
        expect(response.headers.get('content-range')).toBe('bytes 0-9/100');
    });

    test('SVG and HTML are never served from the site origin', async () => {
        for (const type of ['image/svg+xml', 'text/html']) {
            const upstream = (async () => new Response('<svg onload=alert(1)>', { headers: { 'content-type': type } })) as unknown as typeof fetch;
            expect((await proxyMedia('https://cms.test', '/media/x', { fetch: upstream })).status).toBe(404);
        }
    });
});

describe('editing markup', () => {
    const page = { id: 'p1', blocks: [{ id: 'b1', type: 'hero', data: {}, meta: { documentId: 'p1', index: 0, label: 'hero' } }] };

    test('nothing for a visitor; the full set, with the block id, for an editor', () => {
        expect(blockAttributes(markupFor(page, false), page.blocks[0])).toEqual({});
        expect(fieldAttributes(false, 'title')).toEqual({});
        expect(blockAttributes(markupFor(page, true), page.blocks[0])).toEqual({
            'data-inti-block': 'hero',
            'data-inti-block-id': 'b1',
            'data-inti-document-id': 'p1',
            'data-inti-content-type': 'page',
            'data-inti-block-label': 'hero',
            'data-inti-block-index': '0',
            'data-inti-block-total': '1'
        });
    });

    test('a game page is marked as such', () => {
        const game = { id: 'g', blocks: [{ id: 'x', type: 'smart-grid', data: {}, meta: { documentId: 'game:g', index: 0 } }] };
        expect(blockAttributes(markupFor(game, true), game.blocks[0])['data-inti-content-type']).toBe('game');
    });
});

describe('composer palette from /block-types', () => {
    test('defaults from schema defaults, variants from options; undescribed types left out', () => {
        const palette = toComposerBlockTypes([
            { type: 'hero', name: 'Hero', schema: { headline: { type: 'string', default: 'Title' }, align: { type: 'enum', options: ['left', 'center'], default: 'center' }, cta: { type: 'object', properties: { label: { type: 'string', default: 'Go' } } } } },
            { type: 'tier-list', name: 'Tier list', schema: {}, described: false } as never
        ]);
        expect(palette).toEqual([{ nativeType: 'hero', label: 'Hero', defaults: { headline: 'Title', align: 'center', cta: { label: 'Go' } }, variants: { align: ['left', 'center'] } }]);
        expect(toComposerBlockTypes([{ type: 'hero', name: 'Hero', schema: { a: { default: 1 } } }], { labels: { hero: 'Cover' } })[0].label).toBe('Cover');
    });
});

describe('build', () => {
    test('secrets are removed from the build environment only', () => {
        const env: Record<string, string> = { INTI_KITSUDEN_TOKEN: 't', KITSUDEN_SITE_KEY: 'k', KITSUDEN_API_URL: 'u' };
        expect(stripSecretsForBuild([], ['node', 'astro', 'dev'], env)).toEqual([]);
        expect(stripSecretsForBuild([], ['node', 'astro', 'build'], env)).toEqual(['INTI_KITSUDEN_TOKEN', 'KITSUDEN_SITE_KEY']);
        expect(env).toEqual({ KITSUDEN_API_URL: 'u' });
    });
});
