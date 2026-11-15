/**
 * Everything a Kitsuden site needs per request, in one middleware:
 *
 *   // src/middleware.ts
 *   import { kitsudenMiddleware } from '@intijs/adapter-kitsuden/astro';
 *   export const onRequest = kitsudenMiddleware({ api: process.env.KITSUDEN_API_URL! });
 *
 * 1. Registers, once, the plugin that recognises Kitsuden editors. Here and not in the actions
 *    module: Astro loads that one on the first action, and without the plugin nobody could open
 *    the editor to send one.
 * 2. Runs the request with its visitor's IP, which the adapter sends with `siteKey` (set
 *    `clientIp: currentVisitorIp` on it) so the API counts each visitor apart.
 * 3. Marks an editor's response `private, no-store` with `Vary: Cookie`: it carries the editing
 *    markup, and a shared cache must never give it to anyone else.
 * 4. With `cache`, serves anonymous visitors from the HTML cache (see `createPageCache`).
 * 5. When Kitsuden cannot answer (`KitsudenUnavailableError`), serves a stale copy if there is
 *    one, or a 503 with `Retry-After`: "come back later" is the one answer that does not make a
 *    search engine forget the page.
 *
 * Static files and the media proxy are not asked about sessions: an image does not need to
 * know who is looking, and the old starters spent one auth round-trip per image.
 */

import { registerIntiPlugin } from '@intijs/core/plugins';

import { KitsudenUnavailableError } from '../index.js';
import { isCacheable, type CachedPage, type PageCache } from './cache.js';
import { DEFAULT_EDITOR_ROLES, kitsudenEditorPlugin, perRequest, resolveEditor, type KitsudenEditor } from './session.js';
import { runWithVisitor, visitorIp } from './visitor.js';

/** What the middleware reads from Astro's context; structural, so no Astro types are needed */
export interface MiddlewareContextLike {
    request: Request;
    url: URL;
    clientAddress?: string;
    locals?: Record<string, unknown>;
}

export type Next = () => Promise<Response>;

export interface KitsudenMiddlewareOptions {
    /** Origin of the Kitsuden API as the server reaches it (it may be internal) */
    api: string | (() => string);
    /** Roles that may edit. Default: admin, editor */
    roles?: readonly string[];
    /** Read the visitor's IP from the last `X-Forwarded-For` entry (see `visitorIp`) */
    trustProxy?: boolean;
    /** HTML cache for anonymous visitors */
    cache?: PageCache;
    /** Paths that never need to know about sessions. Default: assets, `/img/`, `/media/`, robots, favicons */
    skip?: (pathname: string) => boolean;
    /** The page shown when Kitsuden cannot answer and nothing is cached */
    unavailable?: (error: KitsudenUnavailableError) => Response;
    /** `false` to register the editor plugin yourself. Default: true */
    registerPlugin?: boolean;
    fetch?: typeof fetch;
}

const STATIC = /^\/(?:_astro\/|_image|img\/|media\/|favicon|robots\.txt$|sitemap[^/]*\.xml$|manifest\.webmanifest$|apple-touch-icon)/;

let registered = false;

function defaultUnavailable(error: KitsudenUnavailableError): Response {
    const retry = String(Math.max(30, Math.min(600, error.retryAfter ?? 60)));
    return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Back in a moment</title></head>' +
            '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">' +
            '<h1>Back in a moment</h1><p>This page cannot be shown right now. Please try again in a minute.</p></body></html>',
        { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': retry, 'cache-control': 'no-store' } }
    );
}

const fromCache = (page: CachedPage, state: 'HIT' | 'STALE') => {
    const headers = new Headers(page.headers);
    headers.set('x-inti-cache', state);
    return new Response(page.body, { status: page.status, headers });
};

export function kitsudenMiddleware(options: KitsudenMiddlewareOptions) {
    const apiUrl = () => (typeof options.api === 'function' ? options.api() : options.api);
    const roles = options.roles ?? DEFAULT_EDITOR_ROLES;
    const skip = options.skip ?? ((pathname: string) => STATIC.test(pathname));
    const editorOf = perRequest((cookie) => resolveEditor(cookie, { api: apiUrl(), roles, fetch: options.fetch }));

    if (options.registerPlugin !== false && !registered) {
        registerIntiPlugin(kitsudenEditorPlugin(editorOf, roles) as Parameters<typeof registerIntiPlugin>[0]);
        registered = true;
    }

    return async (context: MiddlewareContextLike, next: Next): Promise<Response> => {
        let ip: string | undefined;
        try {
            ip = visitorIp(context.clientAddress, context.request.headers.get('x-forwarded-for'), options.trustProxy === true);
        } catch {
            // clientAddress throws while prerendering
        }

        return runWithVisitor(ip, async () => {
            if (skip(context.url.pathname)) return next();

            const editor: KitsudenEditor | null = await editorOf(context.request);
            if (context.locals) context.locals.kitsudenEditor = editor;

            const cache = !editor && context.request.method === 'GET' ? options.cache : undefined;
            const hit = cache?.fresh(context.url);
            if (hit) return fromCache(hit, 'HIT');

            let response: Response;
            try {
                response = await next();
            } catch (error) {
                if (error instanceof KitsudenUnavailableError) {
                    console.warn(`[kitsuden] ${error.message}`);
                    const stale = options.cache?.stale(context.url);
                    if (stale && !editor) return fromCache(stale, 'STALE');
                    return (options.unavailable ?? defaultUnavailable)(error);
                }
                throw error;
            }

            if (editor) {
                const headers = new Headers(response.headers);
                headers.set('cache-control', 'private, no-store');
                if (!/\bcookie\b/i.test(headers.get('vary') ?? '')) headers.append('vary', 'Cookie');
                return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
            }

            if (cache && isCacheable(context.request, response)) {
                const body = await response.text();
                const headers = [...response.headers.entries()];
                cache.store(context.url, { status: response.status, headers, body });
                const fresh = new Headers(headers);
                fresh.set('x-inti-cache', 'MISS');
                return new Response(body, { status: response.status, headers: fresh });
            }
            return response;
        });
    };
}
