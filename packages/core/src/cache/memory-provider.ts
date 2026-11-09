/**
 * In-Memory Cache Provider for Inti.js
 * 
 * LRU-evicting, tag-aware in-memory cache provider.
 * Suitable for single-process deployments and development.
 */

import type { CacheProvider, CacheEntry } from './types.js';

/**
 * In-memory cache provider with LRU eviction and tag-based invalidation.
 * 
 * - Uses a `Map<string, CacheEntry>` for O(1) lookups.
 * - Maintains a separate `Map<string, Set<string>>` for tag → keys indexing.
 * - Tracks access order via a doubly-linked approach (Map insertion order + re-insertion).
 * - Thread-safe for single-threaded JS runtimes; concurrent async reads/writes
 *   are handled gracefully since all mutations are synchronous on the Map.
 */
export class MemoryCacheProvider implements CacheProvider {
    public readonly name = 'memory';

    /** Primary key → entry storage */
    private store = new Map<string, CacheEntry>();

    /** Tag → set of keys index for tag-based invalidation */
    private tagIndex = new Map<string, Set<string>>();

    /** Maximum number of entries before LRU eviction kicks in */
    private maxEntries: number;

    constructor(maxEntries: number = 1000) {
        this.maxEntries = maxEntries;
    }

    async get<T>(key: string): Promise<CacheEntry<T> | null> {
        const entry = this.store.get(key) as CacheEntry<T> | undefined;
        if (!entry) {
            return null;
        }

        // Promote to most-recently-used by re-inserting
        this.store.delete(key);
        this.store.set(key, entry);

        return entry;
    }

    async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
        // If the key already exists, remove it first (resets LRU position)
        if (this.store.has(key)) {
            this.removeTagReferences(key);
            this.store.delete(key);
        }

        // Evict LRU entries if at capacity
        while (this.store.size >= this.maxEntries) {
            this.evictLRU();
        }

        this.store.set(key, entry);
        this.indexTags(key, entry.tags);
    }

    async delete(key: string): Promise<void> {
        this.removeTagReferences(key);
        this.store.delete(key);
    }

    async deleteByTag(tag: string): Promise<void> {
        const keys = this.tagIndex.get(tag);
        if (!keys) return;

        // Copy the set to avoid mutation during iteration
        const keysToDelete = [...keys];
        for (const key of keysToDelete) {
            this.removeTagReferences(key);
            this.store.delete(key);
        }

        this.tagIndex.delete(tag);
    }

    async clear(): Promise<void> {
        this.store.clear();
        this.tagIndex.clear();
    }

    async has(key: string): Promise<boolean> {
        return this.store.has(key);
    }

    // ============================================
    // Internal Helpers
    // ============================================

    /**
     * Evicts the least-recently-used entry.
     * Map iteration order is insertion order, so the first key is the LRU.
     */
    private evictLRU(): void {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey !== undefined) {
            this.removeTagReferences(oldestKey);
            this.store.delete(oldestKey);
        }
    }

    /**
     * Adds a key to the tag index for each of its tags.
     */
    private indexTags(key: string, tags: string[]): void {
        for (const tag of tags) {
            let tagSet = this.tagIndex.get(tag);
            if (!tagSet) {
                tagSet = new Set();
                this.tagIndex.set(tag, tagSet);
            }
            tagSet.add(key);
        }
    }

    /**
     * Removes a key from all tag index sets it belongs to.
     * Cleans up empty tag sets.
     */
    private removeTagReferences(key: string): void {
        const entry = this.store.get(key);
        if (!entry) return;

        for (const tag of entry.tags) {
            const tagSet = this.tagIndex.get(tag);
            if (tagSet) {
                tagSet.delete(key);
                if (tagSet.size === 0) {
                    this.tagIndex.delete(tag);
                }
            }
        }
    }
}
