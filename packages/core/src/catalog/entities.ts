/**
 * Routes of entities that are not pages, and blocks fed by them.
 *
 * A product page:
 *
 *   // src/pages/products/[slug].astro
 *   let item;
 *   try {
 *       item = await readItem(catalog.source('odoo'), Astro.params.slug!);
 *   } catch (error) {
 *       return pageErrorResponse(error);     // 404 when it does not exist, 503 when the ERP is down
 *   }
 *   Astro.locals.intiCacheTags = itemCacheTags('odoo', item);
 *
 * A block bound to data: the CMS block has a text field `inti_bind` that says
 * what it shows (`item:odoo/blue-shirt`, `list:odoo?collection=shirts&pageSize=8`,
 * `collection:odoo/shirts`). The editor writes that string; the server fills
 * in `data.bound` with the current price and stock on every render. The
 * block's own fields (heading, layout) stay editable as usual.
 *
 *   const { blocks, tags } = await bindBlocks(page.blocks, catalog);
 *   Astro.locals.intiCacheTags = tags;     // a price change purges this page too
 */

import { NotFoundError } from '../errors/index.js';
import type { IntiBlock } from '../types/index.js';
import { catalogTags, type Catalog } from './catalog.js';
import type { CatalogCollection, CatalogItem, CatalogPage, CatalogQuery, CatalogSort, CatalogSource } from './types.js';

/** The item, or `NotFoundError` so the page answers 404 */
export async function readItem(source: CatalogSource, slug: string): Promise<CatalogItem> {
    const item = await source.getItem(slug);
    if (!item) throw new NotFoundError('product', slug);
    return item;
}

/** A collection and a page of its items, or `NotFoundError` */
export async function readCollection(
    source: CatalogSource,
    slug: string,
    query: Omit<CatalogQuery, 'collection'> = {}
): Promise<{ collection: CatalogCollection; page: CatalogPage }> {
    const collection = source.getCollection
        ? await source.getCollection(slug)
        : ((await source.listCollections?.())?.find((candidate) => candidate.slug === slug) ?? null);
    if (!collection) throw new NotFoundError('collection', slug);
    const page = await source.list({ ...query, collection: collection.slug });
    return { collection, page };
}

/** Cache tags of a rendered item: its own, so a notice for it purges the page */
export function itemCacheTags(sourceName: string, item: Pick<CatalogItem, 'id'>): string[] {
    return [catalogTags.item(sourceName, item.id)];
}

// ============================================
// Bound blocks
// ============================================

export type Binding =
    | { kind: 'item'; source: string; slug: string }
    | { kind: 'list'; source: string; query: CatalogQuery }
    | { kind: 'collection'; source: string; slug: string; query: CatalogQuery };

const SORTS: CatalogSort[] = ['relevance', 'name', 'price-asc', 'price-desc', 'newest'];

function queryFrom(params: URLSearchParams): CatalogQuery {
    const query: CatalogQuery = {};
    const number = (name: string) => {
        const value = Number(params.get(name));
        return params.has(name) && Number.isFinite(value) ? value : undefined;
    };
    if (params.get('search')) query.search = params.get('search')!;
    if (params.get('collection')) query.collection = params.get('collection')!;
    const sort = params.get('sort') as CatalogSort | null;
    if (sort && SORTS.includes(sort)) query.sort = sort;
    if (params.get('inStock') === '1' || params.get('inStock') === 'true') query.inStock = true;
    query.priceMin = number('priceMin');
    query.priceMax = number('priceMax');
    query.page = number('page');
    // A block shows a handful; a binding must not turn into a full listing of the ERP
    const size = number('pageSize');
    query.pageSize = size === undefined ? 12 : Math.max(1, Math.min(48, Math.floor(size)));
    for (const [name, value] of params) {
        const filter = name.match(/^filter\.(.+)$/)?.[1];
        if (filter) (query.filters ??= {})[filter] = value.split(',').filter(Boolean);
    }
    for (const key of Object.keys(query) as (keyof CatalogQuery)[]) if (query[key] === undefined) delete query[key];
    return query;
}

/**
 * `item:<source>/<slug>`, `list:<source>?…`, `collection:<source>/<slug>?…`.
 * Anything else is null: a typo in the CMS must not break the page.
 */
export function parseBinding(value: unknown): Binding | null {
    if (typeof value !== 'string') return null;
    const match = value.trim().match(/^(item|list|collection):([a-z0-9_-]+)(?:\/([^?]+))?(?:\?(.*))?$/i);
    if (!match) return null;
    const [, kind, source, slug, search] = match;
    const params = new URLSearchParams(search ?? '');
    if (kind === 'item') return slug ? { kind: 'item', source, slug: decodeURIComponent(slug) } : null;
    if (kind === 'collection') return slug ? { kind: 'collection', source, slug: decodeURIComponent(slug), query: queryFrom(params) } : null;
    return { kind: 'list', source, query: queryFrom(params) };
}

export interface BindBlocksOptions {
    /** Field holding the binding. Default `inti_bind` */
    field?: string;
    /** Called when a binding cannot be resolved; the block gets `bound: null` */
    onError?: (block: IntiBlock, error: unknown) => void;
}

export interface BoundBlocks {
    blocks: IntiBlock[];
    /** Cache tags of everything the blocks showed */
    tags: string[];
}

/**
 * Resolves every bound block in parallel. A binding that fails leaves
 * `bound: null` and the rest of the page renders: a product card is not
 * worth a 503. Order and `meta.index` are untouched.
 */
export async function bindBlocks(blocks: IntiBlock[], catalog: Catalog, options: BindBlocksOptions = {}): Promise<BoundBlocks> {
    const field = options.field ?? 'inti_bind';
    const tags = new Set<string>();

    const resolved = await Promise.all(
        blocks.map(async (block) => {
            const binding = parseBinding(block.data?.[field]);
            if (!binding) return block;
            try {
                if (!catalog.has(binding.source)) throw new Error(`Catalog source "${binding.source}" is not registered.`);
                const source = catalog.source(binding.source);
                let bound: unknown;
                if (binding.kind === 'item') {
                    const item = await source.getItem(binding.slug);
                    if (item) tags.add(catalogTags.item(binding.source, item.id));
                    bound = item;
                } else if (binding.kind === 'list') {
                    bound = await source.list(binding.query);
                    tags.add(catalogTags.lists(binding.source));
                } else {
                    bound = await readCollection(source, binding.slug, binding.query);
                    tags.add(catalogTags.lists(binding.source));
                }
                return { ...block, data: { ...block.data, bound } };
            } catch (error) {
                options.onError?.(block, error);
                if (!options.onError) console.warn(`[inti] Binding "${String(block.data?.[field])}" of a ${block.type} block failed:`, error);
                return { ...block, data: { ...block.data, bound: null } };
            }
        })
    );

    return { blocks: resolved, tags: [...tags] };
}
