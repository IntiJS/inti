/**
 * The items of a catalog as a sitemap section, read a file at a time with
 * `listSummaries`: a million products are never loaded at once.
 *
 *   const products = catalogSitemap(catalog.source('odoo'), { site, pathFor: (item) => `/products/${item.slug}` });
 *   export const GET = sitemapIndexRoute({ site, sections: [pagesSection, products] });
 */

import type { SitemapEntry, SitemapSection } from '../seo/sitemap.js';
import type { CatalogItemSummary, CatalogSource } from './types.js';

export interface CatalogSitemapOptions {
    /** Site origin */
    site: string;
    /** Path of an item. Default `/<source>/<slug>` */
    pathFor?: (item: CatalogItemSummary) => string;
    /** Section name, in the file name. Default: the source's name */
    name?: string;
    /** Items asked of the source per request. Default 1000 */
    batchSize?: number;
}

export function catalogSitemap(source: CatalogSource, options: CatalogSitemapOptions): SitemapSection {
    const name = options.name ?? source.name;
    const batch = options.batchSize ?? 1000;
    const pathFor = options.pathFor ?? ((item: CatalogItemSummary) => `/${source.name}/${item.slug}`);
    const origin = options.site.replace(/\/+$/, '');

    const list = source.listSummaries?.bind(source);
    if (!list) {
        // Without enumeration the items stay out: better than a sitemap that silently stops at a cap
        return { name, count: async () => 0, entries: async () => [] };
    }

    const toEntry = (item: CatalogItemSummary): SitemapEntry => {
        const path = pathFor(item);
        const date = item.updatedAt ? new Date(item.updatedAt) : undefined;
        return {
            loc: `${origin}${path.startsWith('/') ? path : `/${path}`}`,
            lastmod: date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined
        };
    };

    return {
        name,
        async count() {
            return (await list({ page: 1, pageSize: 1 })).total;
        },
        async entries(file, size) {
            // A sitemap file is `size` items starting at `file * size`; the source pages by `batch`
            const first = file * size;
            const entries: SitemapEntry[] = [];
            let page = Math.floor(first / batch) + 1;
            let skip = first % batch;
            while (entries.length < size) {
                const { items } = await list({ page, pageSize: batch });
                if (items.length === 0) break;
                for (const item of items.slice(skip)) {
                    if (entries.length >= size) break;
                    entries.push(toEntry(item));
                }
                if (items.length < batch) break;
                skip = 0;
                page++;
            }
            return entries;
        }
    };
}
