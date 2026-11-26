/**
 * The items of the 2026-11 security audit that needed validation, closed:
 * - the HTTP client refuses dot segments and other origins (ids that walk to other routes);
 * - the HTML cache keys on the host, stores only declared queries, never a request with
 *   credentials, and the editor is not rendered into a response marked public;
 * - preview mode needs the secret outside development; the preview socket authenticates
 *   before it delivers anything and refuses foreign origins;
 * - peers' presence and cursor frames are bounded before anything renders them;
 * - no token from adapterConfig reaches the editor's page config.
 */

import { describe, test, expect } from 'bun:test';
import { createHttpClient } from '../src/http/index.js';
import { intiDelivery, cacheKeyOf } from '../src/delivery/index.js';
import { createCacheManager } from '../src/cache/index.js';
import { usePreviewMode, previewMiddleware } from '../src/preview/astro.js';
import { PreviewServer, isAllowedOrigin, sameSecret } from '../src/preview/server.js';
import { sanitizePresence, sanitizeCursor, safeColor, safeAvatarUrl } from '../src/realtime/sanitize.js';
import { createVisualBridgeConfig } from '../src/visual-bridge/auto-detect.js';

describe('HTTP client paths', () => {
    const fetch = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
    const client = createHttpClient({ baseUrl: 'https://cms.test/wp-json/wp/v2', fetch });

    for (const path of ['/pages/5/../../users/1', '/pages/%2e%2e/users', '/pages/./5', 'pages/..']) {
        test(`"${path}" is refused`, async () => {
            await expect(client.get(path)).rejects.toThrow(/dot segments/);
        });
    }

    test('an absolute URL on another origin never receives the client headers', async () => {
        await expect(client.get('https://evil.test/collect')).rejects.toThrow(/another origin/);
    });

    test('an ordinary path still works', async () => {
        expect(await client.get('/pages/5')).toEqual({});
    });
});

const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
function context(href: string, headers: Record<string, string> = {}) {
    const url = new URL(href);
    return { request: new Request(url, { headers }), url, locals: {} as Record<string, unknown> };
}

describe('HTML cache keys', () => {
    test('a page rendered for a forged Host is not served on the real one', async () => {
        const cache = createCacheManager();
        const delivery = intiDelivery({ cache });
        await delivery(context('https://evil.test/about'), async () => html('<link rel="canonical" href="https://evil.test/about">'));
        const real = await delivery(context('https://site.test/about'), async () => html('<link rel="canonical" href="https://site.test/about">'));
        expect(await real.text()).toContain('site.test');
        expect(real.headers.get('x-inti-cache')).toBe('MISS');
    });

    test('made-up query parameters are rendered but not stored', async () => {
        const cache = createCacheManager();
        const delivery = intiDelivery({ cache });
        let renders = 0;
        const render = async () => (renders++, html('page'));
        for (let i = 0; i < 5; i++) {
            const response = await delivery(context(`https://site.test/about?x=${i}`), render);
            expect(response.headers.get('x-inti-cache')).toBeNull();
        }
        expect(renders).toBe(5);
        // Tracking parameters and declared ones still share or get their own entry
        await delivery(context('https://site.test/blog?page=2&utm_source=x'), render);
        const hit = await delivery(context('https://site.test/blog?page=2'), render);
        expect(hit.headers.get('x-inti-cache')).toBe('HIT');
    });

    test('cacheParams declares more parameters', async () => {
        const cache = createCacheManager();
        const delivery = intiDelivery({ cache, cacheParams: (name) => name === 'color' });
        await delivery(context('https://site.test/shirts?color=blue'), async () => html('blue'));
        const hit = await delivery(context('https://site.test/shirts?color=blue'), async () => html('other'));
        expect(hit.headers.get('x-inti-cache')).toBe('HIT');
    });

    test('a request with an Authorization header is asked about and never stored', async () => {
        const cache = createCacheManager();
        let asked = 0;
        const delivery = intiDelivery({ cache, isEditor: async () => (asked++, false) });
        const ctx = context('https://site.test/about', { authorization: 'Bearer abc' });
        const first = await delivery(ctx, async () => html('with credentials'));
        expect(asked).toBe(1);
        expect(first.headers.get('x-inti-cache')).toBeNull();
        expect(ctx.locals.intiEditor).toBe(false);
        const anonymous = await delivery(context('https://site.test/about'), async () => html('anonymous'));
        expect(await anonymous.text()).toBe('anonymous');
    });

    test('cacheKeyOf is unchanged for existing callers', () => {
        expect(cacheKeyOf(new URL('https://s.test/a/?b=2&utm_medium=x&a=1'))).toBe('/a?a=1&b=2');
    });
});

describe('preview mode', () => {
    const request = (query: string) => new Request(`https://site.test/page${query}`);

    test('?preview=1 alone is not preview mode', () => {
        expect(usePreviewMode(request('?preview=1')).isPreview).toBe(false);
        expect(usePreviewMode(request('?preview=1'), 's3cret').isPreview).toBe(false);
    });

    test('?preview=1 with the right token is', () => {
        expect(usePreviewMode(request('?preview=1&token=s3cret'), 's3cret').isPreview).toBe(true);
        expect(usePreviewMode(request('?preview=1&token=wrong'), 's3cret').isPreview).toBe(false);
    });

    test('the middleware answers 403 to a wrong token and passes the right one', async () => {
        const middleware = previewMiddleware({ enabled: true, cmsToken: 's3cret' });
        const wrong = await middleware({ request: request('?preview=1&token=nope'), locals: {} }, async () => new Response('ok'));
        expect(wrong.status).toBe(403);
        const locals: Record<string, any> = {};
        const right = await middleware({ request: request('?preview=1&token=s3cret'), locals }, async () => new Response('ok'));
        expect(right.status).toBe(200);
        expect(locals.preview.isPreview).toBe(true);
    });
});

function fakeSocket() {
    const listeners: Record<string, (event: any) => void> = {};
    const socket = {
        readyState: 1,
        sent: [] as string[],
        closed: false,
        send(data: string) {
            socket.sent.push(data);
        },
        close() {
            socket.closed = true;
        },
        addEventListener(type: string, listener: (event: any) => void) {
            listeners[type] = listener;
        }
    };
    return socket;
}

describe('preview socket', () => {
    const update = JSON.stringify({ type: 'content.update', timestamp: 1, payload: { documentId: '1', data: { secret: 'draft' } } });

    test('origins: loopback by default, the declared list otherwise, none for non-browsers', () => {
        expect(isAllowedOrigin(undefined)).toBe(true);
        expect(isAllowedOrigin('http://localhost:4321')).toBe(true);
        expect(isAllowedOrigin('https://evil.test')).toBe(false);
        expect(isAllowedOrigin('https://preview.acme.com', ['https://preview.acme.com'])).toBe(true);
        expect(isAllowedOrigin('http://localhost:4321', ['https://preview.acme.com'])).toBe(false);
    });

    test('a page on another origin is closed at once', () => {
        const server = new PreviewServer({ enabled: true });
        const socket = fakeSocket();
        server.handleConnection(socket, 'https://evil.test');
        expect(socket.closed).toBe(true);
    });

    test('with a token, nothing is delivered before auth and only an authenticated client relays', () => {
        const server = new PreviewServer({ enabled: true, cmsToken: 's3cret' });
        const listener = fakeSocket();
        const sender = fakeSocket();
        server.handleConnection(listener);
        server.handleConnection(sender);

        server.notifyUpdate('page', '1', { secret: 'draft' });
        expect(listener.sent.some((m) => m.includes('draft'))).toBe(false);

        // An unauthenticated client cannot speak for the CMS
        server.handleMessage(sender, update);
        expect(listener.sent.some((m) => m.includes('draft'))).toBe(false);

        server.handleMessage(listener, JSON.stringify({ type: 'auth', timestamp: 1, payload: { token: 's3cret' } }));
        server.handleMessage(sender, JSON.stringify({ type: 'auth', timestamp: 1, payload: { token: 'wrong' } }));
        expect(sender.closed).toBe(true);

        server.notifyUpdate('page', '1', { secret: 'draft' });
        expect(listener.sent.some((m) => m.includes('draft'))).toBe(true);
    });

    test('sameSecret compares the whole string', () => {
        expect(sameSecret('abc', 'abc')).toBe(true);
        expect(sameSecret('ab', 'abc')).toBe(false);
        expect(sameSecret('abcd', 'abc')).toBe(false);
        expect(sameSecret(undefined, 'abc')).toBe(false);
    });
});

describe('realtime frames from peers', () => {
    test('colour, avatar, status and name are bounded', () => {
        const presence = sanitizePresence({
            userId: 'u1',
            name: '<img src=x onerror=alert(1)>'.repeat(10),
            color: 'red;background:url(https://evil.test)',
            avatar: 'javascript:alert(1)',
            status: '<b>'
        })!;
        expect(presence.color).toBe('#6b7280');
        expect(presence.avatar).toBeUndefined();
        expect(presence.status).toBe('online');
        expect(String(presence.name).length).toBeLessThanOrEqual(80);
    });

    test('valid values pass', () => {
        expect(safeColor('#3b82f6')).toBe('#3b82f6');
        expect(safeColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
        expect(safeAvatarUrl('https://cdn.test/a.png')).toBe('https://cdn.test/a.png');
        expect(safeAvatarUrl('/avatars/a.png')).toBe('/avatars/a.png');
        expect(safeAvatarUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBeNull();
    });

    test('a frame without a user is dropped; cursors are finite numbers', () => {
        expect(sanitizePresence({ name: 'x' })).toBeNull();
        expect(sanitizeCursor({ userId: 'u', cursor: { x: 'calc(1px)', y: Infinity } })!.cursor).toEqual({ x: 0, y: 0 });
    });
});

describe('editor page config', () => {
    test('adapterConfig.token and previewToken are never copied into it', () => {
        const config = createVisualBridgeConfig({
            adapter: 'kitsuden',
            adapterConfig: { endpoint: 'https://cms.test', token: 'kitsuden_agent_SECRET', previewToken: 'PREVIEW_SECRET' }
        } as never);
        const serialized = JSON.stringify(config);
        expect(serialized).not.toContain('SECRET');
    });

    test('identifiers for the admin links still pass', () => {
        const config = createVisualBridgeConfig({ adapter: 'contentful', adapterConfig: { spaceId: 'space1' } } as never);
        expect(config.cmsConfig?.spaceId).toBe('space1');
    });
});
