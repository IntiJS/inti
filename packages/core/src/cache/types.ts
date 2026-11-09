/**
 * Cache Layer Types for Inti.js
 * 
 * Defines the type system for the universal caching layer.
 * Inspired by Astro 7's cache API but designed to work across Astro versions.
 */

// ============================================
// Cache Configuration
// ============================================

export interface CacheConfig {
    /** Default TTL in seconds (default: 120) */
    defaultTtl?: number;
    /** Stale-while-revalidate window in seconds (default: 60) */
    swr?: number;
    /** Max entries in memory cache (default: 1000) */
    maxEntries?: number;
    /** Cache provider */
    provider?: CacheProvider;
    /** Enable/disable caching globally (default: true) */
    enabled?: boolean;
}

// ============================================
// Cache Entry
// ============================================

export interface CacheEntry<T = any> {
    data: T;
    createdAt: number;
    ttl: number;
    swr: number;
    tags: string[];
    etag?: string;
}

// ============================================
// Cache Provider Interface
// ============================================

export interface CacheProvider {
    name: string;
    get<T>(key: string): Promise<CacheEntry<T> | null>;
    set<T>(key: string, entry: CacheEntry<T>): Promise<void>;
    delete(key: string): Promise<void>;
    deleteByTag(tag: string): Promise<void>;
    clear(): Promise<void>;
    has(key: string): Promise<boolean>;
}

// ============================================
// Cache Operation Options
// ============================================

export interface CacheSetOptions {
    ttl?: number;
    swr?: number;
    tags?: string[];
}

// ============================================
// Cache Statistics
// ============================================

export interface CacheStats {
    hits: number;
    misses: number;
    staleHits: number;
    size: number;
    hitRate: number;
}
