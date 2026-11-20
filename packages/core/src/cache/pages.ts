/**
 * A cache of pages in front of an adapter.
 *
 *   const pages = cachePages(adapter, { cache: createCacheManager({ staleIfError: 86_400 }) });
 *   const page = await pages.fetchPageBySlug(slug);
 *
 * - Fresh for `ttl` seconds, then served stale for `swr` more while one
 *   background request refreshes it.
 * - Concurrent misses for the same slug share one request to the CMS.
 * - With `staleIfError` on the cache manager, a CMS that is down gets the
 *   last good copy instead of an error.
 * - Every entry is tagged: `pageTags.page(slug)` and `pageTags.all`. A purge
 *   (`purgeRoute`, a CMS webhook) drops exactly what changed.
 * - A page that does not exist is remembered for `notFoundTtl` seconds: a
 *   crawler asking for a thousand missing URLs must not become a thousand
 *   requests to the CMS.
 *
 * It replaces `CachedAdapter`, which called `adapter.fetchPage()` — a method
 * no adapter has.
 */

import { NotFoundError, isNotFound } from '../errors/index.js';
import type { IntiPage } from '../types/index.js';
import type { CacheManager } from './cache-manager.js';

/** The cache tags of pages. `purgeRoute` and the adapters' purge notices use the same */
export const pageTags = {
    all: 'inti:pages',
    page: (slug: string) => `inti:page:${normalizeSlug(slug)}`
};

/** `/about/`, `about` and `/about` are the same page */
export function normalizeSlug(slug: string): string {
    return slug.replace(/^\/+|\/+$/g, '') || 'home';
}

export interface PageSource {
    name?: string;
    fetchPageBySlug(slug: string): Promise<IntiPage>;
}

export interface CachePagesOptions {
    cache: CacheManager;
    /** Seconds a page is fresh. Default: the cache manager's */
    ttl?: number;
    /** Seconds it is served stale while refreshed. Default: the cache manager's */
    swr?: number;
    /** Seconds a missing page is remembered. Default 30 */
    notFoundTtl?: number;
    /** Separates two adapters that share a cache. Default: the adapter's name */
    namespace?: string;
}

export interface CachedPages {
    fetchPageBySlug(slug: string): Promise<IntiPage>;
    /** Drops one page, or every page */
    purge(slug?: string): Promise<void>;
}

type Stored = { page: IntiPage } | { missing: string };

export function cachePages(source: PageSource, options: CachePagesOptions): CachedPages {
    const { cache } = options;
    const namespace = options.namespace ?? source.name ?? 'pages';
    const notFoundTtl = options.notFoundTtl ?? 30;

    return {
        async fetchPageBySlug(slug) {
            const normalized = normalizeSlug(slug);
            const key = `inti:page:${namespace}:${normalized}`;
            const tags = [pageTags.all, pageTags.page(normalized)];

            let missing = false;
            const stored = await cache.getOrSet<Stored>(
                key,
                async () => {
                    try {
                        return { page: await source.fetchPageBySlug(slug) };
                    } catch (error) {
                        if (!isNotFound(error)) throw error;
                        missing = true;
                        return { missing: error instanceof Error ? error.message : `No page "${slug}".` };
                    }
                },
                { ttl: options.ttl, swr: options.swr, tags }
            );

            if ('missing' in stored) {
                // A fresh miss is stored with the short TTL, not the page TTL
                if (missing) await cache.set(key, stored, { ttl: notFoundTtl, swr: 0, staleIfError: 0, tags });
                throw new NotFoundError('page', slug, stored.missing);
            }
            return stored.page;
        },

        purge(slug) {
            return cache.invalidateByTag(slug === undefined ? pageTags.all : pageTags.page(slug));
        }
    };
}
