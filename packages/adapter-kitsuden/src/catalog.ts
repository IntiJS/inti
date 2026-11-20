/**
 * A catalog served from Kitsuden: the entries of a dataset as `CatalogSource` items.
 *
 * Kitsuden has no product API; a dataset with one entry per product (title, slug, price,
 * stock…) is how a Kitsuden site keeps one. This reads its public entries
 * (`GET /api/data-sets/:id/entries`), maps each one with `fields`, and answers `getItem`,
 * `list` (search, filters, price range, stock, sort, facets, pages) and `listSummaries` for
 * the sitemap.
 *
 *   const products = cachedCatalogSource(kitsudenCatalogSource({ endpoint, datasetId: 'products' }), { cache });
 *
 * The API filters nothing but status, so the source reads the whole dataset (1,000 entries per
 * request) and keeps it for `snapshotSeconds`; put `cachedCatalogSource` in front for item and
 * listing caching. A Kitsuden action with an outbound webhook on `entry:updated` /
 * `entry:deleted` to the site's `purgeRoute` drops the item and its listings: the source is
 * named `kitsuden-<datasetId>`, which is what the purge route tags.
 */

import { createHttpClient, type HttpClient } from '@intijs/core/http';
import type {
    CatalogCollection,
    CatalogFacet,
    CatalogItem,
    CatalogItemSummary,
    CatalogPage,
    CatalogQuery,
    CatalogSource
} from '@intijs/core/catalog';

/** Where each item field lives in an entry's data. A dot-path, or a function */
export interface KitsudenCatalogFields {
    title?: string;
    slug?: string;
    description?: string;
    price?: string;
    compareAt?: string;
    currency?: string;
    sku?: string;
    barcode?: string;
    brand?: string;
    images?: string;
    /** Units that can be sold now. Absent: stock is not tracked */
    quantity?: string;
    /** Collection slug(s) */
    collections?: string;
    /** Fields offered as filters and facets: `{ Color: 'color', Size: 'sizes' }` */
    attributes?: Record<string, string>;
}

export interface KitsudenCatalogOptions {
    /** Origin of the Kitsuden API */
    endpoint: string;
    /** Id of the dataset whose entries are the products */
    datasetId: string;
    /** Catalog name. Default `kitsuden-<datasetId>` (what `purgeRoute` tags) */
    name?: string;
    fields?: KitsudenCatalogFields;
    /** Default currency (ISO 4217) when an entry has none */
    currency?: string;
    /** Counts the site's reads per visitor, as the adapter does */
    siteKey?: string;
    /** Seconds the whole dataset is kept between reads. Default 30 */
    snapshotSeconds?: number;
    fetch?: typeof fetch;
}

interface Entry {
    id: string;
    data?: Record<string, unknown>;
    status?: string;
    updatedAt?: string;
    createdAt?: string;
}

const DEFAULTS: Required<Omit<KitsudenCatalogFields, 'attributes'>> = {
    title: 'title',
    slug: 'slug',
    description: 'description',
    price: 'price',
    compareAt: 'compareAtPrice',
    currency: 'currency',
    sku: 'sku',
    barcode: 'barcode',
    brand: 'brand',
    images: 'images',
    quantity: 'stock',
    collections: 'collections'
};

const read = (data: Record<string, unknown> | undefined, path: string): unknown =>
    path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), data);

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : undefined);
const number = (value: unknown) => {
    const n = typeof value === 'string' ? Number(value.replace(',', '.')) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const list = (value: unknown): string[] =>
    (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : value === undefined || value === null ? [] : [value])
        .map((item) => (typeof item === 'object' && item ? text((item as Record<string, unknown>).url ?? (item as Record<string, unknown>).slug ?? (item as Record<string, unknown>).id) : text(item)))
        .filter((item): item is string => Boolean(item));
const slugify = (value: string) =>
    value
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

export function kitsudenCatalogSource(options: KitsudenCatalogOptions): CatalogSource {
    const name = options.name ?? `kitsuden-${options.datasetId}`;
    const fields = { ...DEFAULTS, ...options.fields };
    const snapshotMs = (options.snapshotSeconds ?? 30) * 1000;
    const http: HttpClient = createHttpClient({
        name: 'kitsuden',
        baseUrl: options.endpoint.replace(/\/+$/, ''),
        headers: options.siteKey ? { 'x-kitsuden-site': options.siteKey } : undefined,
        fetch: options.fetch
    });

    let snapshot: { items: CatalogItem[]; at: number } | null = null;
    let loading: Promise<CatalogItem[]> | null = null;

    const toItem = (entry: Entry): CatalogItem | null => {
        const data = entry.data ?? {};
        const title = text(read(data, fields.title));
        if (!title) return null;
        const quantity = number(read(data, fields.quantity));
        const amount = number(read(data, fields.price));
        const attributes = Object.fromEntries(
            Object.entries(fields.attributes ?? {})
                .map(([label, path]) => [label, list(read(data, path))] as const)
                .filter(([, values]) => values.length > 0)
        );
        return {
            id: entry.id,
            slug: text(read(data, fields.slug)) ?? slugify(title),
            title,
            description: text(read(data, fields.description)),
            images: list(read(data, fields.images)),
            sku: text(read(data, fields.sku)),
            barcode: text(read(data, fields.barcode)),
            brand: text(read(data, fields.brand)),
            collections: list(read(data, fields.collections)).map((slug) => ({ id: slug, slug, title: slug })),
            price:
                amount === undefined
                    ? undefined
                    : {
                          amount,
                          currency: text(read(data, fields.currency)) ?? options.currency,
                          compareAt: number(read(data, fields.compareAt))
                      },
            availability: quantity === undefined ? undefined : quantity > 0 ? 'InStock' : 'OutOfStock',
            quantity,
            attributes: Object.keys(attributes).length ? attributes : undefined,
            updatedAt: entry.updatedAt ?? entry.createdAt,
            extra: data
        };
    };

    async function load(): Promise<CatalogItem[]> {
        const items: CatalogItem[] = [];
        for (let offset = 0; ; offset += 1000) {
            const page = await http.get<{ docs?: Entry[]; hasMore?: boolean }>(`/api/data-sets/${encodeURIComponent(options.datasetId)}/entries`, {
                query: { limit: 1000, offset, status: 'published' },
                resource: 'dataset'
            });
            const docs = Array.isArray(page?.docs) ? page.docs : [];
            for (const entry of docs) {
                const item = toItem(entry);
                if (item) items.push(item);
            }
            if (!page?.hasMore || docs.length === 0) break;
        }
        return items;
    }

    async function all(): Promise<CatalogItem[]> {
        if (snapshot && Date.now() - snapshot.at < snapshotMs) return snapshot.items;
        loading ??= load()
            .then((items) => {
                snapshot = { items, at: Date.now() };
                return items;
            })
            .finally(() => {
                loading = null;
            });
        return loading;
    }

    const matches = (item: CatalogItem, query: CatalogQuery) => {
        if (query.search) {
            const needle = query.search.toLowerCase();
            if (![item.title, item.description, item.sku, item.brand].some((value) => value?.toLowerCase().includes(needle))) return false;
        }
        if (query.collection && !item.collections?.some((collection) => collection.slug === query.collection || collection.id === query.collection)) return false;
        const amount = number(item.price?.amount);
        if (query.priceMin !== undefined && (amount === undefined || amount < query.priceMin)) return false;
        if (query.priceMax !== undefined && (amount === undefined || amount > query.priceMax)) return false;
        if (query.inStock && item.availability === 'OutOfStock') return false;
        for (const [attribute, accepted] of Object.entries(query.filters ?? {})) {
            if (accepted.length && !item.attributes?.[attribute]?.some((value) => accepted.includes(value))) return false;
        }
        return true;
    };

    return {
        name,
        idOf: (slug) => snapshot?.items.find((item) => item.slug === slug)?.id,

        async getItem(slug) {
            return (await all()).find((item) => item.slug === slug) ?? null;
        },

        async list(query: CatalogQuery = {}): Promise<CatalogPage> {
            const found = (await all()).filter((item) => matches(item, query));
            const price = (item: CatalogItem) => number(item.price?.amount) ?? Infinity;
            const sorted = [...found].sort((a, b) => {
                switch (query.sort) {
                    case 'name':
                        return a.title.localeCompare(b.title);
                    case 'price-asc':
                        return price(a) - price(b);
                    case 'price-desc':
                        return price(b) - price(a);
                    case 'newest':
                        return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
                    default:
                        return 0;
                }
            });
            const pageSize = Math.max(1, Math.min(100, query.pageSize ?? 24));
            const page = Math.max(1, query.page ?? 1);
            const facets: CatalogFacet[] = (query.facets ?? [])
                .filter((facet) => fields.attributes?.[facet])
                .map((facet) => {
                    const counts = new Map<string, number>();
                    for (const item of found) for (const value of item.attributes?.[facet] ?? []) counts.set(value, (counts.get(value) ?? 0) + 1);
                    return { name: facet, values: [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count) };
                });
            return { items: sorted.slice((page - 1) * pageSize, page * pageSize), total: found.length, page, pageSize, facets };
        },

        async listCollections(): Promise<CatalogCollection[]> {
            const counts = new Map<string, number>();
            for (const item of await all()) for (const collection of item.collections ?? []) counts.set(collection.slug, (counts.get(collection.slug) ?? 0) + 1);
            return [...counts].map(([slug, count]) => ({ id: slug, slug, title: slug, count }));
        },

        async listSummaries({ page, pageSize }): Promise<{ items: CatalogItemSummary[]; total: number }> {
            const items = await all();
            return {
                items: items.slice((page - 1) * pageSize, page * pageSize).map((item) => ({ slug: item.slug, updatedAt: item.updatedAt })),
                total: items.length
            };
        }
    };
}
