/**
 * Cache provider on Vercel's Runtime Cache.
 *
 * On Vercel each function instance has its own memory, so the memory provider
 * keeps one copy per instance and a purge reaches only the instance that got
 * it. The Runtime Cache is shared by every instance in a region, survives
 * deployments, and expires a tag in every region at once.
 *
 *   import { getCache } from '@vercel/functions';
 *   const cache = createCacheManager({ provider: createVercelRuntimeCacheProvider({ cache: getCache() }) });
 *
 * The cache object is injected, so `@intijs/core` pulls in no Vercel package.
 * An entry needs one tag of its own to be cleared with the rest, and the
 * Runtime Cache keeps at most 128 tags of 256 bytes per entry: an entry with
 * more tags than that is not stored, because it could not be purged by all of
 * them. Tags pass through `cdnTag`, the same names the CDN gets, so one
 * `invalidateByTag` empties both.
 */

import type { CacheEntry, CacheProvider } from './types.js';
import { cdnTag, CDN_MAX_TAGS } from '../delivery/cdn-tags.js';

/** What the provider uses of `getCache()` from `@vercel/functions` */
export interface VercelRuntimeCache {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown, options?: { name?: string; tags?: string[]; ttl?: number }): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    expireTag(tag: string | string[]): Promise<unknown>;
}

export interface VercelRuntimeCacheProviderOptions {
    cache: VercelRuntimeCache;
    /** Separates sites or environments that share one cache (Hobby teams share one). Default `inti:` */
    prefix?: string;
}

/** Largest item the Runtime Cache keeps; anything larger is silently not cached */
const MAX_ITEM_BYTES = 2 * 1024 * 1024;

export function createVercelRuntimeCacheProvider(options: VercelRuntimeCacheProviderOptions): CacheProvider {
    const { cache } = options;
    const prefix = options.prefix ?? 'inti:';
    const allTag = cdnTag(`${prefix}all`);
    const key = (name: string) => `${prefix}${name}`;
    const isEntry = (value: unknown): value is CacheEntry =>
        Boolean(value) && typeof value === 'object' && 'createdAt' in (value as object) && 'data' in (value as object);

    return {
        name: 'vercel-runtime-cache',

        async get<T>(name: string): Promise<CacheEntry<T> | null> {
            const value = await cache.get(key(name));
            return isEntry(value) ? (value as CacheEntry<T>) : null;
        },

        async set<T>(name: string, entry: CacheEntry<T>): Promise<void> {
            const tags = [...new Set([allTag, ...entry.tags.map(cdnTag)])];
            if (tags.length > CDN_MAX_TAGS) {
                console.warn(`[inti] "${name}" has more than ${CDN_MAX_TAGS - 1} cache tags and is not stored: the Runtime Cache could not purge it by all of them.`);
                return;
            }
            if (new TextEncoder().encode(JSON.stringify(entry)).length > MAX_ITEM_BYTES) return;
            const ttl = Math.max(1, Math.ceil(entry.ttl + entry.swr + (entry.staleIfError ?? 0)));
            await cache.set(key(name), entry, { ttl, tags, name: 'inti' });
        },

        async delete(name: string): Promise<void> {
            await cache.delete(key(name));
        },

        async deleteByTag(tag: string): Promise<void> {
            await cache.expireTag(cdnTag(tag));
        },

        async clear(): Promise<void> {
            await cache.expireTag(allTag);
        },

        async has(name: string): Promise<boolean> {
            return isEntry(await cache.get(key(name)));
        }
    };
}
