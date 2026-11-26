/**
 * Caching on Cloudflare: a cache provider on Workers KV, and a CDN purge by tag.
 *
 * A Worker has no memory shared between isolates, so the memory provider keeps
 * one copy per isolate and a purge reaches only the one that received it. KV is
 * read from every data center:
 *
 *   import { env } from 'cloudflare:workers';
 *   const cache = createCacheManager({ provider: createKvCacheProvider(env.INTI_CACHE) });
 *
 * A purge is one write whatever the size of the site. Deleting every entry of a
 * tag would cost one operation per entry, and a Worker invocation may make 1000
 * KV operations at most: a site with a few thousand pages could not be purged.
 * So a tag keeps the time it was last purged, and an entry stored before that
 * time is treated as gone. A read is two calls: the entry, and the purge times
 * of its tags in one bulk `get`.
 *
 * KV is eventually consistent: other data centers see a write, or a purge, up
 * to 60 seconds later. Keep `htmlTtl` and the page TTLs in the same order, and
 * keep KV off the paths that must be exact (the editor never reads the cache).
 */

import type { CacheEntry, CacheProvider } from '@intijs/core/cache';
import { cdnTag } from '@intijs/core/delivery';

export interface KvCacheProviderOptions {
    /** Separates sites or environments that share a namespace. Default `inti:` */
    prefix?: string;
    /**
     * Seconds a data center may keep a value it read (KV's `cacheTtl`, at least 30).
     * Faster reads, slower purges. Default: none, so a purge is seen within KV's own 60 s
     */
    cacheTtl?: number;
    /**
     * Seconds before a purge that still count as after it. A render that began before
     * the purge and was stored just after it holds the old content; this margin also
     * covers clocks that differ between data centers. Default 10
     */
    purgeMargin?: number;
}

/** KV keys are at most 512 bytes; longer cache keys are stored under their hash */
const MAX_KEY_BYTES = 480;
/** Bulk `get` takes at most 100 keys */
const BULK = 100;
/** KV refuses an expiry less than 60 seconds away */
const MIN_TTL = 60;

const bytes = (value: string) => new TextEncoder().encode(value).length;

async function sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createKvCacheProvider(namespace: KVNamespace, options: KvCacheProviderOptions = {}): CacheProvider {
    const prefix = options.prefix ?? 'inti:';
    const marginMs = (options.purgeMargin ?? 10) * 1000;
    const cacheTtl = options.cacheTtl === undefined ? undefined : Math.max(30, Math.floor(options.cacheTtl));
    const allKey = `${prefix}p:*`;

    async function entryKey(key: string): Promise<string> {
        const plain = `${prefix}e:${key}`;
        return bytes(plain) <= MAX_KEY_BYTES ? plain : `${prefix}e#${await sha256(key)}`;
    }

    async function purgeKey(tag: string): Promise<string> {
        const plain = `${prefix}p:${tag}`;
        return bytes(plain) <= MAX_KEY_BYTES && tag !== '*' ? plain : `${prefix}p#${await sha256(tag)}`;
    }

    /** The latest purge time among these keys, 0 when none was purged */
    async function lastPurge(keys: string[]): Promise<number> {
        let latest = 0;
        for (let index = 0; index < keys.length; index += BULK) {
            const chunk = keys.slice(index, index + BULK);
            const found = cacheTtl ? await namespace.get(chunk, { type: 'text', cacheTtl }) : await namespace.get(chunk, 'text');
            for (const value of found.values()) {
                const time = Number(value);
                if (Number.isFinite(time) && time > latest) latest = time;
            }
        }
        return latest;
    }

    async function read<T>(key: string): Promise<CacheEntry<T> | null> {
        const stored = await entryKey(key);
        const entry = (cacheTtl ? await namespace.get(stored, { type: 'json', cacheTtl }) : await namespace.get(stored, 'json')) as CacheEntry<T> | null;
        if (!entry || typeof entry !== 'object' || typeof entry.createdAt !== 'number') return null;
        const keys = [allKey, ...(await Promise.all([...new Set(entry.tags ?? [])].map(purgeKey)))];
        return entry.createdAt > (await lastPurge(keys)) + marginMs ? entry : null;
    }

    async function markPurged(key: string): Promise<void> {
        // Kept longer than any entry it outdates; KV drops it afterwards
        await namespace.put(key, String(Date.now()), { expirationTtl: 30 * 86_400 });
    }

    return {
        name: 'cloudflare-kv',

        get: read,

        async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
            const life = Math.ceil(entry.ttl + entry.swr + (entry.staleIfError ?? 0));
            try {
                await namespace.put(await entryKey(key), JSON.stringify(entry), { expirationTtl: Math.max(MIN_TTL, life) });
            } catch (error) {
                // KV takes one write per key per second: when several isolates miss the same
                // page at once, the first write wins and the others are refused. Not an error
                if (!/\b429\b/.test(String(error))) console.warn('[inti] KV did not store a cache entry.', error);
            }
        },

        async delete(key: string): Promise<void> {
            await namespace.delete(await entryKey(key));
        },

        async deleteByTag(tag: string): Promise<void> {
            await markPurged(await purgeKey(tag));
        },

        clear(): Promise<void> {
            return markPurged(allKey);
        },

        async has(key: string): Promise<boolean> {
            return (await read(key)) !== null;
        }
    };
}

export interface CloudflarePurgeOptions {
    /** The zone the site is served from */
    zoneId: string;
    /** An API token with the "Cache Purge" permission. A function, so it is read at request time */
    apiToken: string | (() => string | undefined);
    /** For tests */
    fetch?: typeof fetch;
}

/**
 * Empties Cloudflare's CDN by the tags `intiDelivery({ cdn: { platform: 'cloudflare' } })`
 * put on each page. Pass it to `purgeRoute` as `onPurge`.
 *
 * Tag purges are available on every plan. Cloudflare takes 100 tags per call, and the Free
 * plan allows 5 calls a minute: one notice is one call unless it names more than 100 tags.
 * Throws when Cloudflare refuses, so the CMS sees an error and sends the notice again.
 */
export function cloudflarePurge(options: CloudflarePurgeOptions) {
    const fetcher = options.fetch ?? fetch;
    if (!/^[0-9a-f]{32}$/i.test(options.zoneId)) throw new Error('cloudflarePurge: zoneId is not a Cloudflare zone id');
    const url = `https://api.cloudflare.com/client/v4/zones/${options.zoneId}/purge_cache`;

    return async (tags: string[]): Promise<void> => {
        const token = typeof options.apiToken === 'function' ? options.apiToken() : options.apiToken;
        if (!token) throw new Error('cloudflarePurge: no API token configured');
        // Every tag, not the first 128 a response carries: a purge must reach them all
        const all = [...new Set(tags.filter((tag) => typeof tag === 'string' && tag !== '').map(cdnTag))];
        for (let index = 0; index < all.length; index += 100) {
            const response = await fetcher(url, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ tags: all.slice(index, index + 100) })
            });
            const body = (await response.json().catch(() => null)) as { success?: boolean; errors?: { code?: number; message?: string }[] } | null;
            if (!response.ok || body?.success !== true) {
                const reason = body?.errors?.map((error) => `${error.code}: ${error.message}`).join('; ') || `HTTP ${response.status}`;
                throw new Error(`Cloudflare did not purge the CDN (${reason})`);
            }
        }
    };
}
