/**
 * Cache provider on Valkey (or any server that speaks the Redis protocol).
 *
 * The memory provider is per process: behind a load balancer each instance
 * keeps its own copy, a purge reaches only the instance that received it, and
 * a restart starts cold. With Valkey every instance shares one cache and one
 * purge empties it for all of them.
 *
 *   import Valkey from 'iovalkey';
 *   const cache = createCacheManager({ provider: createValkeyCacheProvider({ client: new Valkey(url) }) });
 *
 * The client is injected: `iovalkey` and `ioredis` work as they are, and the
 * package pulls in no driver. A tag is a set of keys, so purging by tag is
 * one `SMEMBERS` and one `DEL`.
 */

import type { CacheEntry, CacheProvider } from './types.js';

/** The commands the provider uses, with the signatures of `iovalkey` / `ioredis` */
export interface ValkeyCacheClient {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'PX', milliseconds: number): Promise<unknown>;
    del(...keys: string[]): Promise<unknown>;
    exists(key: string): Promise<number>;
    sadd(key: string, ...members: string[]): Promise<unknown>;
    smembers(key: string): Promise<string[]>;
    pexpire(key: string, milliseconds: number): Promise<unknown>;
}

export interface ValkeyCacheProviderOptions {
    client: ValkeyCacheClient;
    /** Separates environments on one server. Default `inti:cache:` */
    prefix?: string;
    /** Longest life of a tag set, in seconds. Default 7 days */
    tagTtl?: number;
}

export function createValkeyCacheProvider(options: ValkeyCacheProviderOptions): CacheProvider {
    const { client } = options;
    const prefix = options.prefix ?? 'inti:cache:';
    const tagTtlMs = (options.tagTtl ?? 7 * 86_400) * 1000;
    const entryKey = (key: string) => `${prefix}e:${key}`;
    const tagKey = (tag: string) => `${prefix}t:${tag}`;
    const allKey = `${prefix}all`;

    async function deleteSet(setKey: string): Promise<void> {
        const members = await client.smembers(setKey);
        // In chunks: one DEL with a hundred thousand arguments blocks the server
        for (let index = 0; index < members.length; index += 500) {
            await client.del(...members.slice(index, index + 500));
        }
        await client.del(setKey);
    }

    return {
        name: 'valkey',

        async get<T>(key: string): Promise<CacheEntry<T> | null> {
            const raw = await client.get(entryKey(key));
            if (!raw) return null;
            try {
                return JSON.parse(raw) as CacheEntry<T>;
            } catch {
                await client.del(entryKey(key));
                return null;
            }
        },

        async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
            const lifeMs = Math.max(1, entry.ttl + entry.swr + (entry.staleIfError ?? 0)) * 1000;
            const stored = entryKey(key);
            await client.set(stored, JSON.stringify(entry), 'PX', lifeMs);
            for (const tag of [...entry.tags, '\u0000all']) {
                const setKey = tag === '\u0000all' ? allKey : tagKey(tag);
                await client.sadd(setKey, stored);
                await client.pexpire(setKey, Math.max(lifeMs, tagTtlMs));
            }
        },

        async delete(key: string): Promise<void> {
            await client.del(entryKey(key));
        },

        deleteByTag(tag: string): Promise<void> {
            return deleteSet(tagKey(tag));
        },

        clear(): Promise<void> {
            return deleteSet(allKey);
        },

        async has(key: string): Promise<boolean> {
            return (await client.exists(entryKey(key))) > 0;
        }
    };
}
