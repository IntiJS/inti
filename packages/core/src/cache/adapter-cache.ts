import type { CacheSetOptions } from './types.js';
import type { CacheManager } from './cache-manager.js';
import { getGlobalCache } from './cache-manager.js';

export class CachedAdapter {
    private adapter: any; // Type should be IntiAdapter but avoiding circular dependency
    private cache: CacheManager;
    private adapterName: string;

    constructor(adapter: any, cacheManager?: CacheManager) {
        this.adapter = adapter;
        this.cache = cacheManager || getGlobalCache();
        this.adapterName = adapter.name || 'unknown';
    }

    /**
     * Get unique cache key for a page
     */
    getPageKey(slug: string, collection: string = 'pages'): string {
        return `page:${this.adapterName}:${collection}:${slug}`;
    }

    /**
     * Get unique cache key for a collection
     */
    getCollectionKey(collection: string, query?: any): string {
        const queryStr = query ? JSON.stringify(query) : 'all';
        return `collection:${this.adapterName}:${collection}:${queryStr}`;
    }

    /**
     * Get tags for a page entry
     */
    getPageTags(slug: string, collection: string = 'pages'): string[] {
        return [
            `adapter:${this.adapterName}`,
            `collection:${collection}`,
            `slug:${slug}`,
            `page`
        ];
    }

    /**
     * Get tags for a collection entry
     */
    getCollectionTags(collection: string): string[] {
        return [
            `adapter:${this.adapterName}`,
            `collection:${collection}`,
            `list`
        ];
    }

    /**
     * Fetch a page with caching
     */
    async cachedFetchPage(slug: string, collection: string = 'pages', options?: CacheSetOptions) {
        const key = this.getPageKey(slug, collection);
        const tags = this.getPageTags(slug, collection);
        
        return this.cache.getOrSet(
            key,
            () => this.adapter.fetchPage(slug, collection),
            { tags, ...options }
        );
    }

    /**
     * Fetch a collection with caching
     */
    async cachedFetchCollection(collection: string, query?: any, options?: CacheSetOptions) {
        const key = this.getCollectionKey(collection, query);
        const tags = this.getCollectionTags(collection);
        
        return this.cache.getOrSet(
            key,
            () => this.adapter.fetchCollection(collection, query),
            { tags, ...options }
        );
    }

    /**
     * Invalidate cache entries based on a CMS webhook payload
     */
    async invalidateOnWebhook(payload: any, cmsType?: string): Promise<void> {
        const type = cmsType || this.detectCmsFromPayload(payload);
        
        switch (type) {
            case 'strapi':
                await this.handleStrapiWebhook(payload);
                break;
            case 'contentful':
                await this.handleContentfulWebhook(payload);
                break;
            case 'sanity':
                await this.handleSanityWebhook(payload);
                break;
            default:
                // Generic invalidation if CMS unknown
                console.warn(`[Inti Cache] Unknown CMS webhook type: ${type}. Invalidating entire adapter cache.`);
                await this.cache.invalidateByTag(`adapter:${this.adapterName}`);
        }
    }

    private detectCmsFromPayload(payload: any): string {
        if (payload.event && payload.model) return 'strapi';
        if (payload.sys && payload.sys.space) return 'contentful';
        if (payload._type && payload._id) return 'sanity';
        return 'unknown';
    }

    private async handleStrapiWebhook(payload: any): Promise<void> {
        const { model, entry } = payload;
        if (!model) return;
        
        // Invalidate specific page if it has a slug
        if (entry && entry.slug) {
            await this.cache.invalidateByTag(`slug:${entry.slug}`);
        }
        
        // Always invalidate the collection lists
        await this.cache.invalidateByTag(`collection:${model}`);
    }

    private async handleContentfulWebhook(payload: any): Promise<void> {
        const contentType = payload.sys?.contentType?.sys?.id;
        if (!contentType) return;
        
        // Contentful usually sends fields
        const slug = payload.fields?.slug?.['en-US'] || payload.fields?.slug;
        if (slug) {
            await this.cache.invalidateByTag(`slug:${slug}`);
        }
        
        await this.cache.invalidateByTag(`collection:${contentType}`);
    }

    private async handleSanityWebhook(payload: any): Promise<void> {
        const type = payload._type;
        if (!type) return;
        
        const slug = payload.slug?.current || payload.slug;
        if (slug) {
            await this.cache.invalidateByTag(`slug:${slug}`);
        }
        
        await this.cache.invalidateByTag(`collection:${type}`);
    }
}
