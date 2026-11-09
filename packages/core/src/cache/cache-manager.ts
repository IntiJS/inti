/**
 * Cache Manager for Inti.js
 * 
 * Orchestrates cache operations with TTL, stale-while-revalidate (SWR),
 * tag-based invalidation, and hit/miss statistics.
 * 
 * The `getOrSet` method is the primary entry point for adapters:
 * it transparently caches fetcher results and serves stale data
 * while revalidating in the background.
 */

import type { CacheConfig, CacheEntry, CacheSetOptions, CacheStats, CacheProvider } from './types.js';
import { MemoryCacheProvider } from './memory-provider.js';

/** Default configuration values */
const DEFAULTS = {
    defaultTtl: 120,
    swr: 60,
    maxEntries: 1000,
    enabled: true,
} as const;

/**
 * Central cache manager that wraps a `CacheProvider` and adds:
 * - TTL and SWR expiration logic
 * - Automatic statistics tracking (hits, misses, staleHits)
 * - `getOrSet` for transparent cache-aside with background revalidation
 * - Tag-based bulk invalidation
 */
export class CacheManager {
    private provider: CacheProvider;
    private defaultTtl: number;
    private defaultSwr: number;
    private enabled: boolean;

    /** In-flight revalidation promises keyed by cache key (dedup guard) */
    private pendingRevalidations = new Map<string, Promise<void>>();

    // Statistics counters
    private _hits = 0;
    private _misses = 0;
    private _staleHits = 0;

    constructor(config: CacheConfig = {}) {
        this.defaultTtl = config.defaultTtl ?? DEFAULTS.defaultTtl;
        this.defaultSwr = config.swr ?? DEFAULTS.swr;
        this.enabled = config.enabled ?? DEFAULTS.enabled;
        this.provider = config.provider ?? new MemoryCacheProvider(
            config.maxEntries ?? DEFAULTS.maxEntries
        );
    }

    // ============================================
    // Core Operations
    // ============================================

    /**
     * Retrieve cached data by key.
     * 
     * - If the entry is fresh, returns the data (counts as a hit).
     * - If the entry is expired but within the SWR window, returns stale data
     *   (counts as a staleHit). Callers can use `getOrSet` to trigger
     *   automatic background revalidation in this case.
     * - If the entry is missing or fully expired, returns null (counts as a miss).
     */
    async get<T>(key: string): Promise<T | null> {
        if (!this.enabled) return null;

        const entry = await this.provider.get<T>(key);
        if (!entry) {
            this._misses++;
            return null;
        }

        const now = Date.now();
        const age = (now - entry.createdAt) / 1000; // age in seconds

        // Fresh — within TTL
        if (age <= entry.ttl) {
            this._hits++;
            return entry.data;
        }

        // Stale but within SWR window
        if (age <= entry.ttl + entry.swr) {
            this._staleHits++;
            return entry.data;
        }

        // Fully expired — evict and miss
        await this.provider.delete(key);
        this._misses++;
        return null;
    }

    /**
     * Store data under a key with optional TTL, SWR, and tags.
     */
    async set<T>(key: string, data: T, options: CacheSetOptions = {}): Promise<void> {
        if (!this.enabled) return;

        const entry: CacheEntry<T> = {
            data,
            createdAt: Date.now(),
            ttl: options.ttl ?? this.defaultTtl,
            swr: options.swr ?? this.defaultSwr,
            tags: options.tags ?? [],
        };

        await this.provider.set(key, entry);
    }

    /**
     * Invalidate a specific cache key.
     */
    async invalidate(key: string): Promise<void> {
        await this.provider.delete(key);
    }

    /**
     * Invalidate all entries tagged with the given tag.
     */
    async invalidateByTag(tag: string): Promise<void> {
        await this.provider.deleteByTag(tag);
    }

    /**
     * Invalidate all entries matching any of the given tags.
     */
    async invalidateByTags(tags: string[]): Promise<void> {
        await Promise.all(tags.map(tag => this.provider.deleteByTag(tag)));
    }

    /**
     * Clear the entire cache.
     */
    async clear(): Promise<void> {
        await this.provider.clear();
        this._hits = 0;
        this._misses = 0;
        this._staleHits = 0;
        this.pendingRevalidations.clear();
    }

    // ============================================
    // getOrSet — The Primary Adapter Entry Point
    // ============================================

    /**
     * Cache-aside with automatic SWR revalidation.
     * 
     * 1. Tries the cache first.
     * 2. If fresh → returns cached data.
     * 3. If stale (within SWR window) → returns stale data AND triggers
     *    a background revalidation via the fetcher.
     * 4. If miss → calls fetcher, caches the result, returns it.
     * 
     * @param key     - Cache key
     * @param fetcher - Async function that produces the data on a miss
     * @param options - TTL, SWR, tags overrides
     */
    async getOrSet<T>(
        key: string,
        fetcher: () => Promise<T>,
        options: CacheSetOptions = {}
    ): Promise<T> {
        if (!this.enabled) {
            return fetcher();
        }

        const entry = await this.provider.get<T>(key);

        if (entry) {
            const now = Date.now();
            const age = (now - entry.createdAt) / 1000;

            // Fresh — within TTL
            if (age <= entry.ttl) {
                this._hits++;
                return entry.data;
            }

            // Stale but within SWR window — return stale + background revalidate
            if (age <= entry.ttl + entry.swr) {
                this._staleHits++;
                this.backgroundRevalidate(key, fetcher, options);
                return entry.data;
            }

            // Fully expired — fall through to fetch
            await this.provider.delete(key);
        }

        // Cache miss
        this._misses++;
        const data = await fetcher();
        await this.set(key, data, options);
        return data;
    }

    // ============================================
    // Statistics
    // ============================================

    /**
     * Returns current cache hit/miss statistics.
     */
    getStats(): CacheStats {
        const total = this._hits + this._misses + this._staleHits;
        return {
            hits: this._hits,
            misses: this._misses,
            staleHits: this._staleHits,
            size: total,
            hitRate: total > 0 ? this._hits / total : 0,
        };
    }

    // ============================================
    // Internal Helpers
    // ============================================

    /**
     * Runs the fetcher in the background to refresh a stale entry.
     * De-duplicates concurrent revalidations for the same key.
     */
    private backgroundRevalidate<T>(
        key: string,
        fetcher: () => Promise<T>,
        options: CacheSetOptions
    ): void {
        // Already revalidating this key — skip
        if (this.pendingRevalidations.has(key)) return;

        const revalidation = (async () => {
            try {
                const data = await fetcher();
                await this.set(key, data, options);
            } catch {
                // Silently swallow — stale data is already being served.
                // In production, adapters should log this via their own logger.
            } finally {
                this.pendingRevalidations.delete(key);
            }
        })();

        this.pendingRevalidations.set(key, revalidation);
    }
}

// ============================================
// Factory & Global Singleton
// ============================================

/** Global CacheManager singleton (lazy-initialized) */
let globalCacheInstance: CacheManager | null = null;

/**
 * Create a new CacheManager with the given config.
 */
export function createCacheManager(config?: CacheConfig): CacheManager {
    return new CacheManager(config);
}

/**
 * Get or create the global CacheManager singleton.
 * Useful for adapters that want a shared cache without explicit wiring.
 */
export function getGlobalCache(config?: CacheConfig): CacheManager {
    if (!globalCacheInstance) {
        globalCacheInstance = new CacheManager(config);
    }
    return globalCacheInstance;
}
