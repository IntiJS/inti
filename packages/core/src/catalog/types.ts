/**
 * Catalog contract: entities that are not pages.
 *
 * `IntiAdapter` models a page as a list of blocks an editor composes. A
 * product, a listing or a record is something else: it has a fixed schema,
 * there are thousands of them, and they are found by filtering, not by
 * slug alone. They live in another system (an ERP, a shop, a search
 * engine) that stays the owner of the data.
 *
 * A `CatalogSource` reads them. A site may have several sources next to its
 * CMS adapter: pages from the CMS, products from the ERP.
 */

import type { ProductAvailability, ProductCondition } from '../seo/product.js';

export interface CatalogPrice {
    /** Decimal amount. A string is kept as the source formatted it */
    amount: number | string;
    /** ISO 4217 */
    currency?: string;
    /** Price before a discount, when the source knows one */
    compareAt?: number | string;
}

export interface CatalogVariant {
    id: string;
    sku?: string;
    title?: string;
    /** Option name to value: `{ Condition: 'Near Mint', Finish: 'Foil' }` */
    options: Record<string, string>;
    price?: CatalogPrice;
    availability?: ProductAvailability;
    /** Units the source says can be sold now. Absent when the source does not track stock */
    quantity?: number;
    condition?: ProductCondition;
    barcode?: string;
}

export interface CatalogCollectionRef {
    id: string;
    slug: string;
    title: string;
}

export interface CatalogItem {
    /** The source's own id, as a string */
    id: string;
    /** Unique within its source; what the route receives */
    slug: string;
    title: string;
    /** Plain text or HTML, as the source stores it */
    description?: string;
    /** Absolute URLs, or paths the site resolves */
    images?: string[];
    sku?: string;
    barcode?: string;
    brand?: string;
    collections?: CatalogCollectionRef[];
    /** Lowest price among what can be bought; a single price when there are no variants */
    price?: CatalogPrice;
    availability?: ProductAvailability;
    quantity?: number;
    variants?: CatalogVariant[];
    /** Descriptive attributes: `{ Rarity: ['Mythic'], Color: ['Red', 'Green'] }` */
    attributes?: Record<string, string[]>;
    /** ISO-8601. Feeds `<lastmod>` and cache validation */
    updatedAt?: string;
    /** Whatever else the source returned, for the page that needs it */
    extra?: Record<string, unknown>;
}

export type CatalogSort = 'relevance' | 'name' | 'price-asc' | 'price-desc' | 'newest';

export interface CatalogQuery {
    /** Free text */
    search?: string;
    /** Collection slug or id */
    collection?: string;
    /** Attribute name to accepted values. Values of one attribute are OR, attributes are AND */
    filters?: Record<string, string[]>;
    priceMin?: number;
    priceMax?: number;
    /** Only what can be bought now */
    inStock?: boolean;
    sort?: CatalogSort;
    /** 1-based */
    page?: number;
    pageSize?: number;
    /** Facet names to count. A source ignores the ones it cannot compute */
    facets?: string[];
}

export interface CatalogFacetValue {
    value: string;
    label?: string;
    count: number;
}

export interface CatalogFacet {
    name: string;
    label?: string;
    values: CatalogFacetValue[];
}

export interface CatalogPage {
    items: CatalogItem[];
    /** Matches across all pages */
    total: number;
    page: number;
    pageSize: number;
    facets?: CatalogFacet[];
}

export interface CatalogCollection extends CatalogCollectionRef {
    parentId?: string;
    /** Items directly in it, when the source can count them cheaply */
    count?: number;
    updatedAt?: string;
}

/** What a sitemap needs from an item, without loading it */
export interface CatalogItemSummary {
    slug: string;
    updatedAt?: string;
}

export interface CatalogSummaryPage {
    items: CatalogItemSummary[];
    total: number;
}

/**
 * Read contract of a catalog.
 *
 * Only `getItem` and `list` are required. A source that cannot enumerate
 * (a search engine with a result cap, for instance) leaves `listSummaries`
 * out and its items stay out of the sitemap, which is better than a
 * sitemap that silently stops at the cap.
 */
export interface CatalogSource {
    readonly name: string;
    /** The item, or null when it does not exist or is not for sale */
    getItem(slug: string): Promise<CatalogItem | null>;
    list(query?: CatalogQuery): Promise<CatalogPage>;
    listCollections?(): Promise<CatalogCollection[]>;
    /** One collection by slug, or null. Without it `readCollection` searches `listCollections` */
    getCollection?(slug: string): Promise<CatalogCollection | null>;
    /** Enumerates everything, a page at a time, in a stable order */
    listSummaries?(options: { page: number; pageSize: number }): Promise<CatalogSummaryPage>;
    /**
     * Cache tags of an item given the source's id for it.
     *
     * A change notice from the source carries its id, not the slug the site
     * built; this is how the notice finds what to drop.
     */
    idOf?(slug: string): string | undefined;
}
