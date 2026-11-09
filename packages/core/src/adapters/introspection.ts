/**
 * Introspection System - real introspection system for CMSs
 *
 * Provides:
 * - Real introspection via API
 * - Schema caching
 * - Automatic mapping of CMS types → Inti
 * - Fallback to mock in development
 */

import type { 
    SchemaDefinition, 
    SchemaCollection, 
    SchemaField, 
    FieldType 
} from './index.js';

// ============================================
// Introspection Configuration
// ============================================

export interface IntrospectionConfig {
    /** Introspection endpoint (may differ from the content one) */
    introspectionEndpoint?: string;
    /** Extra headers for the request */
    headers?: Record<string, string>;
    /** Timeout in ms */
    timeout?: number;
    /** Use mock if the API fails */
    fallbackToMock?: boolean;
    /** Cache the result */
    cache?: boolean;
    /** Cache TTL in ms (default: 5 minutes) */
    cacheTtl?: number;
}

export interface IntrospectionResult {
    success: boolean;
    schema: SchemaDefinition;
    /** Introspection timestamp */
    timestamp: number;
    /** Source: 'api', 'cache', 'mock', 'fallback' */
    source: 'api' | 'cache' | 'mock' | 'fallback';
    /** Error, if any */
    error?: string;
}

// ============================================
// Schema Cache
// ============================================

class SchemaCache {
    private cache = new Map<string, { schema: SchemaDefinition; timestamp: number }>();
    
    getKey(adapterName: string, endpoint: string): string {
        return `${adapterName}:${endpoint}`;
    }
    
    get(key: string, ttl: number): SchemaDefinition | null {
        const entry = this.cache.get(key);
        if (!entry) return null;
        
        const isExpired = Date.now() - entry.timestamp > ttl;
        if (isExpired) {
            this.cache.delete(key);
            return null;
        }
        
        return entry.schema;
    }
    
    set(key: string, schema: SchemaDefinition): void {
        this.cache.set(key, {
            schema,
            timestamp: Date.now()
        });
    }
    
    clear(): void {
        this.cache.clear();
    }
}

export const globalSchemaCache = new SchemaCache();

// ============================================
// Introspection Base Class
// ============================================

export abstract class IntrospectionAdapter {
    protected config: IntrospectionConfig;
    protected adapterName: string;
    
    constructor(adapterName: string, config: IntrospectionConfig = {}) {
        this.adapterName = adapterName;
        this.config = {
            timeout: 10000,
            fallbackToMock: true,
            cache: true,
            cacheTtl: 5 * 60 * 1000, // 5 minutes
            ...config
        };
    }

    /**
     * Main introspection - tries the API, then the cache, then the mock
     */
    async introspect(): Promise<IntrospectionResult> {
        const cacheKey = this.getCacheKey();

        // 1. Try the cache
        if (this.config.cache) {
            const cached = globalSchemaCache.get(cacheKey, this.config.cacheTtl!);
            if (cached) {
                return {
                    success: true,
                    schema: cached,
                    timestamp: Date.now(),
                    source: 'cache'
                };
            }
        }
        
        // 2. Try the real API
        try {
            const schema = await this.fetchSchemaFromApi();

            // Store in the cache
            if (this.config.cache) {
                globalSchemaCache.set(cacheKey, schema);
            }
            
            return {
                success: true,
                schema,
                timestamp: Date.now(),
                source: 'api'
            };
        } catch (error) {
            console.warn(`[${this.adapterName}] API introspection failed:`, error);
            
            // 3. Fall back to the mock if allowed
            if (this.config.fallbackToMock) {
                const mockSchema = this.getMockSchema();
                return {
                    success: true,
                    schema: mockSchema,
                    timestamp: Date.now(),
                    source: 'mock',
                    error: error instanceof Error ? error.message : 'Unknown error'
                };
            }
            
            // 4. Return the error
            return {
                success: false,
                schema: this.getEmptySchema(),
                timestamp: Date.now(),
                source: 'fallback',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    
    /**
     * Force a fresh introspection (ignores the cache)
     */
    async introspectFresh(): Promise<IntrospectionResult> {
        // Clear the cache for this key, forcing a re-fetch
        const cacheKey = this.getCacheKey();
        globalSchemaCache.set(cacheKey, this.getEmptySchema());
        
        return this.introspect();
    }
    
    /**
     * Get the raw schema from the CMS
     * Every adapter must implement this
     */
    protected abstract fetchRawSchema(): Promise<any>;

    /**
     * Transform the CMS schema into Inti's SchemaDefinition
     * Every adapter must implement this
     */
    protected abstract transformSchema(rawSchema: any): SchemaDefinition;

    /**
     * Get a mock schema for development
     */
    protected abstract getMockSchema(): SchemaDefinition;

    // ============================================
    // Helper Methods
    // ============================================
    
    private async fetchSchemaFromApi(): Promise<SchemaDefinition> {
        const rawSchema = await this.fetchRawSchema();
        return this.transformSchema(rawSchema);
    }
    
    /**
     * The key identifies the whole configuration, not just the adapter.
     *
     * It used to be `adapter + introspectionEndpoint`, and the adapters
     * configured with `endpoint` (WordPress, Kitsuden, Strapi) all fell
     * into `<adapter>:default`: two sites in the same process —the MCP
     * server pointing at several, a multisite build— got the first one's
     * schema for the whole TTL, and options like `blockTypeMap` were ignored.
     *
     * The key only lives in memory, in the same process that already holds
     * the configuration with its credentials: it exposes nothing new.
     */
    private getCacheKey(): string {
        let identity: string;
        try {
            identity = JSON.stringify(this.config);
        } catch {
            identity = this.config.introspectionEndpoint || 'default';
        }
        return globalSchemaCache.getKey(this.adapterName, identity);
    }
    
    private getEmptySchema(): SchemaDefinition {
        return {
            source: this.adapterName,
            version: '0.0.0',
            collections: []
        };
    }
    
    /**
     * Helper to fetch with a timeout
     */
    protected async fetchWithTimeout(
        url: string, 
        options: RequestInit = {}
    ): Promise<Response> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
        
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    ...this.config.headers,
                    ...options.headers
                }
            });
            
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    }
    
    /**
     * Helper to map common CMS types to FieldType
     */
    protected mapType(cmsType: string): FieldType {
        const typeMap: Record<string, FieldType> = {
            // Strings
            'string': 'string',
            'str': 'string',
            'varchar': 'string',
            'char': 'string',
            'text': 'text',
            'longtext': 'text',
            
            // Numbers
            'number': 'number',
            'int': 'number',
            'integer': 'number',
            'float': 'number',
            'decimal': 'number',
            'double': 'number',
            
            // Booleans
            'boolean': 'boolean',
            'bool': 'boolean',
            
            // Dates
            'date': 'date',
            'datetime': 'datetime',
            'timestamp': 'datetime',
            'time': 'datetime',
            
            // Media
            'media': 'media',
            'image': 'media',
            'file': 'media',
            'asset': 'media',
            
            // Relations
            'relation': 'relation',
            'reference': 'relation',
            'ref': 'relation',
            'link': 'relation',
            
            // JSON
            'json': 'json',
            'object': 'json',
            'array': 'json',
            
            // Rich Text
            'richtext': 'richtext',
            'markdown': 'richtext',
            'html': 'richtext',
            
            // Blocks/Components
            'blocks': 'blocks',
            'component': 'component',
            'dynamiczone': 'blocks',
            'zone': 'blocks'
        };
        
        return typeMap[cmsType.toLowerCase()] || 'string';
    }
}

// ============================================
// Helpers for Specific Adapters
// ============================================

/**
 * Creates a SchemaField from a generic CMS field
 */
export function createSchemaField(
    name: string,
    type: FieldType,
    options: {
        required?: boolean;
        description?: string;
        relation?: { collection: string; multiple?: boolean };
    } = {}
): SchemaField {
    return {
        name,
        type,
        required: options.required ?? false,
        description: options.description,
        relation: options.relation
    };
}

/**
 * Creates a SchemaCollection
 */
export function createSchemaCollection(
    name: string,
    fields: SchemaField[],
    options: {
        description?: string;
        timestamps?: boolean;
    } = {}
): SchemaCollection {
    return {
        name,
        fields,
        description: options.description ?? `${name} collection`,
        timestamps: options.timestamps ?? true
    };
}

/**
 * Creates a SchemaDefinition
 */
export function createSchemaDefinition(
    source: string,
    collections: SchemaCollection[],
    version: string = '1.0.0'
): SchemaDefinition {
    return {
        source,
        version,
        collections
    };
}
