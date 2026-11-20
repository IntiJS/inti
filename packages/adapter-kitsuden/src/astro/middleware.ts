/**
 * Everything a Kitsuden site needs per request, in one middleware:
 *
 *   // src/middleware.ts
 *   import { createCacheManager } from '@intijs/core/cache';
 *   import { kitsudenMiddleware } from '@intijs/adapter-kitsuden/astro';
 *   export const cache = createCacheManager({ staleIfError: 86_400 });
 *   export const onRequest = kitsudenMiddleware({ api: process.env.KITSUDEN_API_URL!, cache });
 *
 * 1. Registers, once, the plugin that recognises Kitsuden editors. Here and not in the actions
 *    module: Astro loads that one on the first action, and without the plugin nobody could open
 *    the editor to send one.
 * 2. Runs the request with its visitor's IP, which the adapter sends with `siteKey` (set
 *    `clientIp: currentVisitorIp` on it) so the API counts each visitor apart.
 * 3. Delivers through `intiDelivery` (`@intijs/core/delivery`): anonymous visitors get the HTML
 *    cache and CDN headers, editors get `private, no-store` with `Vary: Cookie`, the editor's
 *    `data-inti-*` attributes never reach a visitor, and tracking parameters do not split the
 *    cache.
 * 4. The session is asked about only when the request carries a Kitsuden session cookie, and the
 *    answer is remembered per cookie for a few seconds: a cached page used to cost one auth
 *    round-trip per view anyway.
 * 5. When Kitsuden cannot answer (`KitsudenUnavailableError`), a stale copy if there is one, or
 *    a 503 with `Retry-After`: "come back later" is the one answer that does not make a search
 *    engine forget the page.
 */

import type { CacheManager } from '@intijs/core/cache';
import { intiDelivery, type CdnOptions } from '@intijs/core/delivery';
import { isUnavailable, type UnavailableError } from '@intijs/core/errors';
import { registerIntiPlugin } from '@intijs/core/plugins';
import { pageErrorResponse } from '@intijs/core/server';

import { DEFAULT_EDITOR_ROLES, kitsudenEditorPlugin, resolveEditor, sessionCookies, type KitsudenEditor } from './session.js';
import { runWithVisitor, visitorIp } from './visitor.js';

/** What the middleware reads from Astro's context; structural, so no Astro types are needed */
export interface MiddlewareContextLike {
    request: Request;
    url: URL;
    clientAddress?: string;
    cookies?: unknown;
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
    /** HTML cache for anonymous visitors: the core's cache manager, in memory or on Valkey */
    cache?: CacheManager;
    /** Seconds a cached page is served without rendering. Default 60 */
    htmlTtl?: number;
    /** Seconds a stale page is served while Kitsuden cannot answer. Default 86400 */
    staleIfError?: number;
    /** Headers for a CDN, or `false`. Default: `s-maxage=60` and friends for anonymous pages */
    cdn?: CdnOptions | false;
    /** Seconds a session answer is remembered per session cookie. Default 5 */
    sessionMemoSeconds?: number;
    /** Paths that never need to know about sessions. Default: assets, `/img/`, `/media/`, robots, favicons */
    skip?: (pathname: string) => boolean;
    /** The page shown when Kitsuden cannot answer and nothing is cached */
    unavailable?: (error: UnavailableError) => Response;
    /** `false` to register the editor plugin yourself. Default: true */
    registerPlugin?: boolean;
    fetch?: typeof fetch;
}

const STATIC =
    /^\/(?:_astro\/|_image|_server-islands\/|img\/|media\/|favicon|robots\.txt$|sitemap[^/]*\.xml$|manifest\.webmanifest$|apple-touch-icon)/;

let registered = false;

/** Session answers per session cookie, for a few seconds, bounded */
function memoized(seconds: number, resolve: (cookie: string) => Promise<KitsudenEditor | null>) {
    const answers = new Map<string, { value: Promise<KitsudenEditor | null>; until: number }>();
    return (cookie: string): Promise<KitsudenEditor | null> => {
        if (!cookie) return Promise.resolve(null);
        if (seconds <= 0) return resolve(cookie).catch(() => null);
        const now = Date.now();
        const known = answers.get(cookie);
        if (known && known.until > now) return known.value;
        const value = resolve(cookie).catch(() => null);
        answers.set(cookie, { value, until: now + seconds * 1000 });
        if (answers.size > 1000) for (const [key, entry] of answers) if (entry.until <= now) answers.delete(key);
        return value;
    };
}

export function kitsudenMiddleware(options: KitsudenMiddlewareOptions) {
    const apiUrl = () => (typeof options.api === 'function' ? options.api() : options.api);
    const roles = options.roles ?? DEFAULT_EDITOR_ROLES;
    const skip = options.skip ?? ((pathname: string) => STATIC.test(pathname));
    const editorFor = memoized(options.sessionMemoSeconds ?? 5, (cookie) => resolveEditor(cookie, { api: apiUrl(), roles, fetch: options.fetch }));
    const editorOf = (request: Request | undefined) => editorFor(sessionCookies(request?.headers.get('cookie')));

    if (options.registerPlugin !== false && !registered) {
        registerIntiPlugin(kitsudenEditorPlugin(editorOf, roles) as Parameters<typeof registerIntiPlugin>[0]);
        registered = true;
    }

    const delivery = intiDelivery({
        cache: options.cache,
        htmlTtl: options.htmlTtl,
        staleIfError: options.staleIfError,
        cdn: options.cdn,
        // Static paths are left alone before delivery runs
        skip: () => false,
        // Only a Kitsuden session cookie can make an editor
        mayBeEditor: (request) => Boolean(sessionCookies(request.headers.get('cookie'))),
        // Remembered here instead, so `locals.kitsudenEditor` is set on every request
        sessionMemoSeconds: 0,
        isEditor: async (context) => {
            const editor = await editorOf(context.request);
            if (context.locals) context.locals.kitsudenEditor = editor;
            return Boolean(editor);
        },
        onError: (error) => {
            if (isUnavailable(error)) console.warn(`[kitsuden] ${(error as Error).message}`);
            return isUnavailable(error) && options.unavailable ? options.unavailable(error) : pageErrorResponse(error);
        }
    });

    return async (context: MiddlewareContextLike, next: Next): Promise<Response> => {
        let ip: string | undefined;
        try {
            ip = visitorIp(context.clientAddress, context.request.headers.get('x-forwarded-for'), options.trustProxy === true);
        } catch {
            // clientAddress throws while prerendering
        }

        return runWithVisitor(ip, async () => {
            if (skip(context.url.pathname)) return next();
            if (context.locals) context.locals.kitsudenEditor = null;
            return delivery(context, next);
        });
    };
}
