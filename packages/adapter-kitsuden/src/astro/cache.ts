/**
 * An in-process cache of the HTML anonymous visitors get, emptied when Kitsuden says a page
 * changed.
 *
 * Every SSR page view used to cost a couple of API reads. With this cache a page is rendered
 * once per `ttlSeconds`; when the CMS changes it, a Kitsuden action with an outbound webhook on
 * `page:updated` / `page:deleted` calls `purgeRoute`, and the next visitor gets the new version.
 * When the API is down, a stale copy is served instead of an error.
 *
 * Editors, cookies that set state, non-GET requests and non-HTML answers are never cached.
 * One process only: behind several instances, give each its own purge call or use a CDN.
 */

export interface PageCacheOptions {
    /** Served as fresh for this long. Default 60 */
    ttlSeconds?: number;
    /** Served when the API is down, for this long after it went stale. Default 86400 */
    staleSeconds?: number;
    /** Default 500 */
    maxEntries?: number;
}

export interface CachedPage {
    status: number;
    headers: [string, string][];
    body: string;
    storedAt: number;
}

export interface PageCache {
    /** Fresh copy for this URL, or undefined */
    fresh(url: URL): CachedPage | undefined;
    /** Any copy still within the stale window, for when the API cannot answer */
    stale(url: URL): CachedPage | undefined;
    store(url: URL, page: Omit<CachedPage, 'storedAt'>): void;
    /** A page's path (`/about`), a slug (`about`), or everything */
    purge(pathOrSlug?: string): number;
    readonly size: number;
}

const key = (url: URL) => `${url.pathname.replace(/\/+$/, '') || '/'}${url.search}`;

export function createPageCache(options: PageCacheOptions = {}): PageCache {
    const ttl = (options.ttlSeconds ?? 60) * 1000;
    const stale = (options.staleSeconds ?? 86_400) * 1000;
    const max = options.maxEntries ?? 500;
    const entries = new Map<string, CachedPage>();

    const read = (url: URL, window: number) => {
        const entry = entries.get(key(url));
        if (!entry) return undefined;
        if (Date.now() - entry.storedAt > window) {
            if (window === ttl + stale) entries.delete(key(url));
            return undefined;
        }
        return entry;
    };

    return {
        fresh: (url) => read(url, ttl),
        stale: (url) => read(url, ttl + stale),
        store(url, page) {
            const k = key(url);
            entries.delete(k);
            entries.set(k, { ...page, storedAt: Date.now() });
            while (entries.size > max) entries.delete(entries.keys().next().value as string);
        },
        purge(pathOrSlug) {
            if (!pathOrSlug) {
                const n = entries.size;
                entries.clear();
                return n;
            }
            const path = `/${pathOrSlug.replace(/^\/+|\/+$/g, '')}`;
            let n = 0;
            for (const k of [...entries.keys()]) {
                const pathname = k.split('?')[0];
                // The page itself, its query variants, and the home page (any page may be it)
                if (pathname === path || pathname === '/') {
                    entries.delete(k);
                    n++;
                }
            }
            return n;
        },
        get size() {
            return entries.size;
        }
    };
}

/** Is this response safe to give to another anonymous visitor? */
export function isCacheable(request: Request, response: Response): boolean {
    if (request.method !== 'GET' || response.status !== 200) return false;
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) return false;
    if (response.headers.has('set-cookie')) return false;
    const control = response.headers.get('cache-control') ?? '';
    return !/\b(private|no-store|no-cache)\b/i.test(control);
}

/**
 * `src/pages/api/kitsuden/purge.ts`: `export const POST = purgeRoute(cache, SECRET)`.
 *
 * Point a Kitsuden action's outbound webhook here, with the same secret. The request is
 * accepted only with a valid `X-Kitsuden-Signature` (HMAC-SHA256 of the body); the body's
 * `slug` (top level, or under `data` / `payload`) purges that page and the home page, a
 * deletion or a body without a slug purges everything.
 */
export function purgeRoute(cache: PageCache, secret: string | (() => string | undefined)) {
    return async ({ request }: { request: Request }): Promise<Response> => {
        const key = typeof secret === 'function' ? secret() : secret;
        if (!key) return new Response('Purge is not configured', { status: 503 });

        const body = await request.text();
        if (!(await validSignature(body, request.headers.get('x-kitsuden-signature'), key))) {
            return new Response('Invalid signature', { status: 401 });
        }

        let parsed: Record<string, unknown> = {};
        try {
            parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
            // an empty or non-JSON body purges everything
        }
        const nested = (field: string) => (parsed[field] && typeof parsed[field] === 'object' ? (parsed[field] as Record<string, unknown>) : {});
        const event = String(parsed.event ?? parsed.type ?? nested('data').event ?? '');
        const slug = [parsed.slug, nested('data').slug, nested('payload').slug].find((value) => typeof value === 'string' && value) as string | undefined;

        const purged = event.includes('deleted') || !slug ? cache.purge() : cache.purge(slug);
        return Response.json({ purged });
    };
}

async function validSignature(body: string, header: string | null, secret: string): Promise<boolean> {
    const hex = header?.match(/^sha256=([0-9a-f]{64})$/i)?.[1];
    if (!hex) return false;
    const signature = new Uint8Array(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    // verify() compares in constant time
    return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(body));
}
