/**
 * Several catalog sources on one site, a cache in front of each, and the
 * route that empties the cache when the source says something changed.
 */

import type { CacheManager } from '../cache/cache-manager.js';
import { signBody, verifySignature } from '../delivery/signature.js';
import type { ProductInput, ProductOffer } from '../seo/product.js';
import type {
    CatalogItem,
    CatalogPage,
    CatalogPrice,
    CatalogQuery,
    CatalogSource
} from './types.js';

// ============================================
// Several sources
// ============================================

export interface Catalog {
    /** Throws when the name is not registered: a typo must not read as "no products" */
    source(name: string): CatalogSource;
    has(name: string): boolean;
    readonly names: string[];
}

export function createCatalog(sources: Record<string, CatalogSource> | CatalogSource[]): Catalog {
    const byName = new Map<string, CatalogSource>();
    const entries = Array.isArray(sources)
        ? sources.map((source) => [source.name, source] as const)
        : Object.entries(sources);

    for (const [name, source] of entries) {
        if (byName.has(name)) throw new Error(`Catalog source "${name}" is registered twice.`);
        byName.set(name, source);
    }

    return {
        source(name) {
            const found = byName.get(name);
            if (!found) {
                throw new Error(
                    `Catalog source "${name}" is not registered. Registered: ${[...byName.keys()].join(', ') || 'none'}.`
                );
            }
            return found;
        },
        has: (name) => byName.has(name),
        get names() {
            return [...byName.keys()];
        }
    };
}

// ============================================
// Cache
// ============================================

export interface CachedCatalogOptions {
    cache: CacheManager;
    /** Seconds an item is served as fresh. Default 60 */
    itemTtl?: number;
    /** Seconds a listing is served as fresh. Default 30 */
    listTtl?: number;
    /** Seconds a stale answer is still served while it is refreshed. Default 300 */
    swr?: number;
}

/** Tags an entry of this source carries. The purge route uses the same ones */
export const catalogTags = {
    source: (source: string) => `catalog:${source}`,
    lists: (source: string) => `catalog:${source}:lists`,
    item: (source: string, id: string) => `catalog:${source}:item:${id}`
};

/** Same query, same key: object key order must not create two entries */
function stableKey(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`)
        .join(',')}}`;
}

/**
 * Puts a cache in front of a source.
 *
 * Prices and stock change in the source at any time, so entries are short
 * lived and tagged: an item by its id, every listing under one tag. A
 * change notice drops the item and the listings, and nothing else.
 *
 * A missing item is cached too. Otherwise every request for a slug that
 * does not exist reaches the source, which is the cheapest way to take an
 * ERP down from outside.
 */
export function cachedCatalogSource(source: CatalogSource, options: CachedCatalogOptions): CatalogSource {
    const { cache } = options;
    const itemTtl = options.itemTtl ?? 60;
    const listTtl = options.listTtl ?? 30;
    const swr = options.swr ?? 300;
    const prefix = `catalog:${source.name}`;
    const sourceTag = catalogTags.source(source.name);
    const listTags = [sourceTag, catalogTags.lists(source.name)];

    return {
        name: source.name,
        idOf: source.idOf?.bind(source),

        async getItem(slug) {
            const known = source.idOf?.(slug);
            const key = `${prefix}:item:${slug}`;

            const wrapped = await cache.getOrSet<{ item: CatalogItem | null }>(
                key,
                async () => ({ item: await source.getItem(slug) }),
                {
                    ttl: itemTtl,
                    swr,
                    // The id is only known up front when the slug carries it. Without it the
                    // entry still falls with the whole source.
                    tags: known ? [sourceTag, catalogTags.item(source.name, known)] : [sourceTag]
                }
            );
            return wrapped.item;
        },

        list(query: CatalogQuery = {}): Promise<CatalogPage> {
            return cache.getOrSet(`${prefix}:list:${stableKey(query)}`, () => source.list(query), {
                ttl: listTtl,
                swr,
                tags: listTags
            });
        },

        listCollections: source.listCollections
            ? () =>
                  cache.getOrSet(`${prefix}:collections`, () => source.listCollections!(), {
                      ttl: listTtl,
                      swr,
                      tags: listTags
                  })
            : undefined,

        getCollection: source.getCollection
            ? (slug: string) =>
                  cache.getOrSet(`${prefix}:collection:${slug}`, () => source.getCollection!(slug), {
                      ttl: listTtl,
                      swr,
                      tags: listTags
                  })
            : undefined,

        // Sitemap enumeration is rare and large: caching it would hold the catalog in memory.
        listSummaries: source.listSummaries?.bind(source)
    };
}

// ============================================
// Purge
// ============================================

export interface CatalogPurgeBody {
    /** Source name. Without it the notice applies to every listed source */
    source?: string;
    /** Ids of the items that changed, as the source knows them */
    ids?: Array<string | number>;
    /** Drop everything of the source */
    all?: boolean;
}

export interface CatalogPurgeOptions {
    cache: CacheManager;
    /** Sources this route may purge */
    sources: string[];
    /** Shared secret. A function so it is read at request time, not at import */
    secret: string | (() => string | undefined);
    /** Header that carries `sha256=<hex>` of the body. Default `x-inti-signature` */
    signatureHeader?: string;
    /** Reads the purge request out of a body in another shape (an ERP's own webhook payload) */
    parse?: (body: unknown) => CatalogPurgeBody | null;
    /** A notice with more ids than this drops the whole source instead. Default 500 */
    maxIds?: number;
}

/** `sha256=<hex>` of a body, for whoever sends the notice and for tests */
export const signCatalogPurge = signBody;

/**
 * `src/pages/api/catalog/purge.ts`: `export const POST = catalogPurgeRoute({...})`.
 *
 * The source (or whatever sits between it and the site) calls this when a
 * price or a stock level changes. The request is accepted only with a valid
 * HMAC-SHA256 of the body; without a configured secret the route answers
 * 503 instead of accepting everything.
 *
 * Dropping an item also drops the listings: a listing shows the price and
 * the availability of the items in it.
 */
export function catalogPurgeRoute(options: CatalogPurgeOptions) {
    const header = (options.signatureHeader ?? 'x-inti-signature').toLowerCase();
    const maxIds = options.maxIds ?? 500;

    return async ({ request }: { request: Request }): Promise<Response> => {
        const secret = typeof options.secret === 'function' ? options.secret() : options.secret;
        if (!secret) return new Response('Purge is not configured', { status: 503 });

        const text = await request.text();
        if (!(await verifySignature(text, request.headers.get(header), secret))) {
            return new Response('Invalid signature', { status: 401 });
        }

        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            return new Response('Body is not JSON', { status: 400 });
        }

        const body = options.parse ? options.parse(raw) : (raw as CatalogPurgeBody | null);
        if (!body || typeof body !== 'object') return new Response('Nothing to purge', { status: 400 });

        const targets = body.source ? [body.source] : options.sources;
        const unknown = targets.find((name) => !options.sources.includes(name));
        if (unknown) return new Response(`Unknown source "${unknown}"`, { status: 400 });

        const ids = (Array.isArray(body.ids) ? body.ids : [])
            .filter((id) => typeof id === 'string' || typeof id === 'number')
            .map(String);
        const everything = body.all === true || ids.length === 0 || ids.length > maxIds;

        const tags: string[] = [];
        for (const name of targets) {
            if (everything) {
                tags.push(catalogTags.source(name));
            } else {
                tags.push(catalogTags.lists(name), ...ids.map((id) => catalogTags.item(name, id)));
            }
        }
        await options.cache.invalidateByTags(tags);

        return Response.json({ purged: everything ? 'all' : ids.length, sources: targets });
    };
}

// ============================================
// Structured data
// ============================================

function offerOf(
    price: CatalogPrice | undefined,
    rest: Pick<ProductOffer, 'availability' | 'condition'>
): ProductOffer | undefined {
    if (!price && !rest.availability) return undefined;
    return { price: price?.amount, currency: price?.currency, ...rest };
}

/**
 * From a catalog item to the input of `buildProductSchema`.
 *
 * One offer per variant, so a product with variants gets the price range
 * Google shows as "from X".
 */
export function catalogItemToProduct(item: CatalogItem, options: { url?: string } = {}): ProductInput {
    const variantOffers = (item.variants ?? [])
        .map((variant) => offerOf(variant.price, { availability: variant.availability, condition: variant.condition }))
        .filter((offer): offer is ProductOffer => !!offer);

    const single = offerOf(item.price, { availability: item.availability });

    return {
        name: item.title,
        description: item.description,
        images: item.images,
        url: options.url,
        sku: item.sku,
        gtin: item.barcode,
        brand: item.brand,
        category: item.collections?.[0]?.title,
        offers: variantOffers.length > 1 ? variantOffers : (variantOffers[0] ?? single)
    };
}
