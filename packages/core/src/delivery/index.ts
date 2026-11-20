/**
 * How a page reaches a visitor: who gets a cached copy, what a CDN may keep,
 * what an editor sees, and what happens when the CMS is down.
 *
 *   // src/middleware.ts
 *   import { intiDelivery } from '@intijs/core/delivery';
 *   export const onRequest = intiDelivery({ cache });
 *
 * - Anonymous visitors: `Cache-Control: public, max-age=0, s-maxage=…,
 *   stale-while-revalidate=…, stale-if-error=…`, so a CDN keeps the page and
 *   the browser always asks the CDN. With `cache`, the HTML is also kept on the
 *   server, tagged by page, and emptied by `purgeRoute`.
 * - Editors: `private, no-store` and `Vary: Cookie`. Their HTML carries the
 *   editing markup and must never land in a shared cache.
 * - `data-inti-*` attributes are an editor's business: they are removed from
 *   what an anonymous visitor receives.
 * - When rendering throws, a stale copy is served if there is one; otherwise
 *   404 for `NotFoundError` and 503 with `Retry-After` for anything else.
 *
 * Only requests that carry a cookie are asked about a session, and the answer
 * is remembered for a few seconds: a visitor with no cookie cannot be an
 * editor, and asking an identity provider on every page view is what made
 * cached pages slow.
 */

import { isNotFound } from '../errors/index.js';
import type { CacheManager } from '../cache/cache-manager.js';
import { normalizeSlug, pageTags } from '../cache/pages.js';
import { resolveEditorSession } from '../server/editor-session.js';
import { pageErrorResponse } from '../server/responses.js';
import { isDevelopmentRuntime } from '../server/access.js';
import { verifySignature, signBody } from './signature.js';

export { signBody, verifySignature };

/** What the middleware reads from Astro's context; structural, so no Astro types are needed */
export interface DeliveryContext {
    request: Request;
    url: URL;
    cookies?: unknown;
    locals?: Record<string, unknown>;
    isPrerendered?: boolean;
}

export type Next = () => Promise<Response>;

export interface CdnOptions {
    /** Seconds a shared cache keeps the page. Default 60 */
    sMaxAge?: number;
    /** Seconds it may serve it stale while it asks again. Default 300 */
    staleWhileRevalidate?: number;
    /** Seconds it may serve it stale when the origin fails. Default 86400 */
    staleIfError?: number;
}

export interface DeliveryOptions {
    /** HTML cache on the server for anonymous visitors (memory or Valkey) */
    cache?: CacheManager;
    /** Seconds a cached page is served without rendering. Default 60 */
    htmlTtl?: number;
    /** Seconds a stale page is still served when rendering fails. Default 86400 */
    staleIfError?: number;
    /** Headers for a CDN. `false` leaves `Cache-Control` alone. Default: on */
    cdn?: CdnOptions | false;
    /** Is this request from an editor? Default: `resolveEditorSession` (the `resolveActor` plugins) */
    isEditor?: (context: DeliveryContext) => Promise<boolean>;
    /** Can this request be from an editor at all? Default: it carries a cookie */
    mayBeEditor?: (request: Request) => boolean;
    /** Seconds a session answer is remembered per cookie. Default 5 */
    sessionMemoSeconds?: number;
    /** Paths left alone. Default: assets, images, robots, sitemaps, `/_actions/`, `/api/` */
    skip?: (pathname: string) => boolean;
    /** The page a path shows, for its cache tag. Default: the path without slashes, `home` for `/` */
    slugOf?: (url: URL) => string;
    /** Query parameters that do not change the page (tracking). Default: `utm_*`, `gclid`, `fbclid`… */
    ignoreParams?: (name: string) => boolean;
    /** Remove `data-inti-*` from anonymous HTML. Default true */
    stripEditorMarkup?: boolean;
    /** The answer when rendering throws and there is nothing stale. Default: `pageErrorResponse` */
    onError?: (error: unknown) => Response;
}

interface StoredPage {
    status: number;
    headers: [string, string][];
    body: string;
}

const STATIC =
    /^\/(?:_astro\/|_image|_actions\/|_server-islands\/|api\/|img\/|media\/|favicon|robots\.txt$|sitemap[^/]*\.xml$|llms\.txt$|manifest\.webmanifest$|apple-touch-icon)/;

/** Tracking parameters: the same page under a thousand campaign links is one entry */
export const isTrackingParam = (name: string) =>
    /^(?:utm_.+|gclid|gbraid|wbraid|fbclid|msclkid|dclid|yclid|twclid|ttclid|li_fat_id|mc_cid|mc_eid|_ga|_gl|igshid|ref_src)$/i.test(name);

/** The cache key of a URL: path without trailing slash, query sorted and without tracking */
export function cacheKeyOf(url: URL, ignore: (name: string) => boolean = isTrackingParam): string {
    const params = [...url.searchParams.entries()].filter(([name]) => !ignore(name)).sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
    return `${url.pathname.replace(/\/+$/, '') || '/'}${query}`;
}

export const htmlTag = 'inti:html';

/**
 * The attributes only the editor reads. Visitor-facing ones (`data-inti-why`,
 * `data-inti-preferences`) stay: their own styles and scripts use them.
 */
const EDITOR_ATTRIBUTE =
    /\s+data-inti-(?:block|block-[a-z-]+|document-id|content-type|locale|field|field-[a-z-]+|adaptive)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?(?=[\s/>])/gi;

/**
 * Removes the editor's attributes and JSON islands from HTML. Only inside
 * tags: text that happens to say `data-inti-` is left alone.
 */
export function stripEditorMarkup(html: string): string {
    return html
        .replace(/<script\b[^>]*\bdata-inti-block-json\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[a-zA-Z][^<>]*\sdata-inti-[^<>]*>/g, (tag) => tag.replace(EDITOR_ATTRIBUTE, ''));
}

/** Is this response safe to give to another anonymous visitor? */
export function isShareable(request: Request, response: Response): boolean {
    if (request.method !== 'GET' || response.status !== 200) return false;
    if (response.headers.has('set-cookie')) return false;
    const control = response.headers.get('cache-control') ?? '';
    return !/\b(private|no-store|no-cache)\b/i.test(control);
}


/** `Headers` as pairs; `entries()` needs the DOM.Iterable lib */
function headerPairs(headers: Headers): [string, string][] {
    const pairs: [string, string][] = [];
    headers.forEach((value, name) => pairs.push([name, value]));
    return pairs;
}

function cdnHeader(options: CdnOptions): string {
    return [
        'public',
        'max-age=0',
        `s-maxage=${options.sMaxAge ?? 60}`,
        `stale-while-revalidate=${options.staleWhileRevalidate ?? 300}`,
        `stale-if-error=${options.staleIfError ?? 86_400}`
    ].join(', ');
}

function withHeaders(response: Response, body: BodyInit | null, set: Record<string, string>, append: Record<string, string> = {}): Response {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(set)) headers.set(name, value);
    for (const [name, value] of Object.entries(append)) {
        if (!new RegExp(`\\b${value}\\b`, 'i').test(headers.get(name) ?? '')) headers.append(name, value);
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function fromStore(page: StoredPage, state: 'HIT' | 'STALE'): Response {
    const headers = new Headers(page.headers);
    headers.set('x-inti-cache', state);
    return new Response(page.body, { status: page.status, headers });
}

/**
 * Tags a page added while rendering (`Astro.locals.intiCacheTags`): the
 * catalog items it showed, so a price change also purges this page's HTML.
 */
function extraTags(locals: Record<string, unknown> | undefined): string[] {
    const tags = locals?.intiCacheTags;
    return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 200) : [];
}

/** Remembers a session answer per cookie for a few seconds, bounded */
function memoize(seconds: number, resolve: (context: DeliveryContext) => Promise<boolean>) {
    const answers = new Map<string, { value: Promise<boolean>; until: number }>();
    return (context: DeliveryContext) => {
        if (seconds <= 0) return resolve(context);
        const cookie = context.request.headers.get('cookie') ?? '';
        const now = Date.now();
        const known = answers.get(cookie);
        if (known && known.until > now) return known.value;
        const value = resolve(context).catch(() => false);
        answers.set(cookie, { value, until: now + seconds * 1000 });
        if (answers.size > 1000) {
            for (const [key, entry] of answers) if (entry.until <= now || answers.size > 1000) answers.delete(key);
        }
        return value;
    };
}

const defaultIsEditor = async (context: DeliveryContext) =>
    (await resolveEditorSession({ request: context.request, cookies: context.cookies, prerendered: context.isPrerendered })).allowed;

export function intiDelivery(options: DeliveryOptions = {}) {
    const skip = options.skip ?? ((pathname: string) => STATIC.test(pathname));
    const mayBeEditor = options.mayBeEditor ?? ((request: Request) => Boolean(request.headers.get('cookie')));
    const isEditor = memoize(options.sessionMemoSeconds ?? 5, options.isEditor ?? defaultIsEditor);
    const slugOf = options.slugOf ?? ((url: URL) => normalizeSlug(url.pathname));
    const htmlTtl = options.htmlTtl ?? 60;
    const staleIfError = options.staleIfError ?? 86_400;
    const strip = options.stripEditorMarkup !== false;
    const cdn = options.cdn === false ? null : cdnHeader(options.cdn ?? {});
    const onError = options.onError ?? ((error: unknown) => pageErrorResponse(error));

    return async (context: DeliveryContext, next: Next): Promise<Response> => {
        if (skip(context.url.pathname)) return next();

        // In development everybody edits, as `resolveEditorSession` says: no session to ask about
        const editor = isDevelopmentRuntime() || (mayBeEditor(context.request) ? await isEditor(context) : false);
        if (context.locals) context.locals.intiEditor = editor;

        const cache = !editor && context.request.method === 'GET' ? options.cache : undefined;
        const key = cache ? `inti:html:${cacheKeyOf(context.url, options.ignoreParams)}` : '';
        const stored = cache ? await cache.getEntry<StoredPage>(key).catch(() => null) : null;
        const age = stored ? (Date.now() - stored.createdAt) / 1000 : Infinity;
        if (stored && age <= stored.ttl) return fromStore(stored.data, 'HIT');
        const stale = stored && age <= stored.ttl + (stored.staleIfError ?? 0) ? stored.data : undefined;

        let response: Response;
        try {
            response = await next();
        } catch (error) {
            if (stale && !isNotFound(error)) {
                console.warn('[inti] Rendering failed; serving a stale copy.', error);
                return fromStore(stale, 'STALE');
            }
            return onError(error);
        }

        if (editor) {
            return withHeaders(response, response.body, { 'cache-control': 'private, no-store' }, { vary: 'Cookie' });
        }

        if (stale && response.status >= 500) return fromStore(stale, 'STALE');

        const isHtml = (response.headers.get('content-type') ?? '').includes('text/html');
        const shareable = isShareable(context.request, response);
        const extra: Record<string, string> = {};
        if (cdn && shareable && !response.headers.has('cache-control')) extra['cache-control'] = cdn;

        if (!isHtml || (!strip && !(cache && shareable))) {
            return Object.keys(extra).length ? withHeaders(response, response.body, extra) : response;
        }

        // Buffered: the markup is stripped and the copy stored as one string
        const raw = await response.text();
        const body = strip ? stripEditorMarkup(raw) : raw;
        const out = withHeaders(response, body, extra);

        if (cache && shareable) {
            const page: StoredPage = { status: out.status, headers: headerPairs(out.headers), body };
            await cache
                .set(key, page, { ttl: htmlTtl, swr: 0, staleIfError, tags: [htmlTag, pageTags.page(slugOf(context.url)), ...extraTags(context.locals)] })
                .catch((error) => console.warn('[inti] The page could not be stored in the cache.', error));
            out.headers.set('x-inti-cache', 'MISS');
        }
        return out;
    };
}

// ============================================
// Purge
// ============================================

export interface PurgeNotice {
    /** One page that changed */
    slug?: string;
    /** Several pages that changed */
    slugs?: string[];
    /** Raw cache tags, for content that is not a page */
    tags?: string[];
    /** Drop every page */
    all?: boolean;
    /** `*.deleted` drops everything: a deleted page may be linked from any other */
    event?: string;
}

export interface PurgeRouteOptions {
    /** The cache the pages (`cachePages`) and the HTML (`intiDelivery`) live in */
    cache: CacheManager;
    /** Shared secret. A function, so it is read at request time and not at import */
    secret: string | (() => string | undefined);
    /** Header with `sha256=<hex>` of the body. Default `x-inti-signature` */
    signatureHeader?: string;
    /** Reads a notice from a body in another shape (a CMS's own webhook) */
    parse?: (body: unknown) => PurgeNotice | null;
    /** Also drop the home page, which usually lists the others. Default true */
    purgeHome?: boolean;
    /** Called with the tags after they are dropped: purge a CDN here */
    onPurge?: (tags: string[], notice: PurgeNotice) => Promise<void> | void;
}

/** The tags a notice drops */
export function purgeTags(notice: PurgeNotice, options: { purgeHome?: boolean } = {}): string[] {
    const slugs = [notice.slug, ...(notice.slugs ?? [])].filter((slug): slug is string => typeof slug === 'string' && slug !== '');
    const tags = (notice.tags ?? []).filter((tag) => typeof tag === 'string' && tag !== '');
    const everything = notice.all === true || /deleted|trashed|unpublished/i.test(notice.event ?? '') || (slugs.length === 0 && tags.length === 0);
    if (everything) return [pageTags.all, htmlTag, ...tags];
    const pages = slugs.map((slug) => pageTags.page(slug));
    if (options.purgeHome !== false && pages.length > 0) pages.push(pageTags.page('home'));
    return [...new Set([...pages, ...tags])];
}

/**
 * `src/pages/api/inti/purge.ts`: `export const POST = purgeRoute({ cache, secret: () => env('INTI_PURGE_SECRET') })`.
 *
 * Accepts a notice only with a valid HMAC-SHA256 of the body. Without a
 * configured secret it answers 503 instead of accepting anything.
 */
export function purgeRoute(options: PurgeRouteOptions) {
    const header = (options.signatureHeader ?? 'x-inti-signature').toLowerCase();

    return async ({ request }: { request: Request }): Promise<Response> => {
        const secret = typeof options.secret === 'function' ? options.secret() : options.secret;
        if (!secret) return new Response('Purge is not configured', { status: 503 });
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });

        const text = await request.text();
        if (!(await verifySignature(text, request.headers.get(header), secret))) {
            return new Response('Invalid signature', { status: 401 });
        }

        let raw: unknown = {};
        if (text.trim()) {
            try {
                raw = JSON.parse(text);
            } catch {
                return new Response('Body is not JSON', { status: 400 });
            }
        }
        const notice = options.parse ? options.parse(raw) : (raw as PurgeNotice);
        if (!notice || typeof notice !== 'object') return new Response('Nothing to purge', { status: 400 });

        const tags = purgeTags(notice, options);
        await options.cache.invalidateByTags(tags);
        await options.onPurge?.(tags, notice);
        return Response.json({ purged: tags });
    };
}
