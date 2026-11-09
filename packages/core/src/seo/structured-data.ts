/**
 * JSON-LD from the page and its blocks.
 *
 * A block is already a self-contained content unit with a declared type,
 * which is exactly what structured data needs. A `FaqSection` block knows
 * it is an FAQ; it only has to be said in a format that search engines and
 * LLMs understand.
 */

import type { IntiBlock, IntiPage } from '../types/index.js';
import { buildProductSchema } from './product.js';
import type { ProductInput } from './product.js';

/** Any JSON-LD node */
export type JsonLdNode = Record<string, unknown>;

/**
 * Translates a block into one or more JSON-LD nodes.
 *
 * The developer provides it because only they know the shape of their
 * fields: guessing it from the core would produce incorrect data, which in
 * structured data is worse than having nothing.
 */
export type BlockSchemaBuilder = (block: IntiBlock, index: number) => JsonLdNode | JsonLdNode[] | null;

export interface BreadcrumbEntry {
    name: string;
    url: string;
}

export interface StructuredDataOptions {
    /** Absolute canonical URL */
    url?: string;
    siteName?: string;
    /** Type of the main node (default: WebPage) */
    type?: 'WebPage' | 'Article' | 'BlogPosting' | 'Product' | 'CollectionPage';
    /** ISO dates, if the CMS exposes them */
    publishedAt?: string;
    modifiedAt?: string;
    author?: { name: string; url?: string };
    publisher?: { name: string; logo?: string };
    breadcrumbs?: BreadcrumbEntry[];
    /**
     * Product data. When given, the graph's main node is a `Product` with
     * its offers instead of the `WebPage` derived from the page: on a
     * product page, the main entity is the product.
     *
     * Setting `type: 'Product'` without this produces a node with no price
     * or availability, which Google does not accept for rich results.
     */
    product?: ProductInput;
    /** ISO 4217 currency for the product's offers ('EUR', 'USD'…) */
    currency?: string;
    /** Builders per block type */
    blockSchemas?: Record<string, BlockSchemaBuilder>;
    /** Extra nodes, already built */
    extra?: JsonLdNode[];
    /**
     * By default, if the CMS brings its own JSON-LD that is used instead
     * of the derived node. Set it to false to ignore it and always build
     * from scratch.
     */
    preferCmsJsonLd?: boolean;
}

/**
 * Accepts the CMS JSON-LD whether it comes as `@graph`, as a single node
 * or as an array, and always returns it as a list of nodes.
 */
function normalizeCmsJsonLd(raw: unknown): JsonLdNode[] | null {
    if (!raw || typeof raw !== 'object') return null;

    if (Array.isArray(raw)) {
        const nodes = raw.filter((n): n is JsonLdNode => !!n && typeof n === 'object');
        return nodes.length > 0 ? nodes : null;
    }

    const node = raw as JsonLdNode;
    const graph = node['@graph'];

    if (Array.isArray(graph)) {
        const nodes = graph.filter((n): n is JsonLdNode => !!n && typeof n === 'object');
        return nodes.length > 0 ? nodes : null;
    }

    return Object.keys(node).length > 0 ? [node] : null;
}

/**
 * schema.org expects absolute URLs: a consumer reading the JSON outside
 * the page's context cannot resolve a relative image.
 */
function absolute(url: string | undefined, base: string | undefined): string | undefined {
    if (!url) return undefined;
    if (/^https?:\/\//i.test(url)) return url;
    if (!base) return undefined;

    try {
        return new URL(url, base).toString();
    } catch {
        return undefined;
    }
}

function omitEmpty(node: JsonLdNode): JsonLdNode {
    const clean: JsonLdNode = {};
    for (const [key, value] of Object.entries(node)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value) && value.length === 0) continue;
        clean[key] = value;
    }
    return clean;
}

/** Main node of the page */
function pageNode(page: Partial<IntiPage> | null | undefined, options: StructuredDataOptions): JsonLdNode {
    const seo = page?.seo ?? {};

    return omitEmpty({
        '@type': options.type ?? 'WebPage',
        name: seo.title ?? page?.title,
        headline: options.type && options.type !== 'WebPage' ? (seo.title ?? page?.title) : undefined,
        description: seo.description,
        image: absolute(seo.image, options.url),
        url: options.url,
        datePublished: options.publishedAt,
        dateModified: options.modifiedAt,
        inLanguage: undefined,
        author: options.author ? omitEmpty({ '@type': 'Person', ...options.author }) : undefined,
        publisher: options.publisher
            ? omitEmpty({
                  '@type': 'Organization',
                  name: options.publisher.name,
                  logo: options.publisher.logo
                      ? { '@type': 'ImageObject', url: options.publisher.logo }
                      : undefined
              })
            : options.siteName
              ? { '@type': 'Organization', name: options.siteName }
              : undefined
    });
}

function breadcrumbNode(entries: BreadcrumbEntry[]): JsonLdNode {
    return {
        '@type': 'BreadcrumbList',
        itemListElement: entries.map((entry, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: entry.name,
            item: entry.url
        }))
    };
}

/**
 * Builds a page's full JSON-LD graph.
 *
 * Returns a `@graph` so that every node lives in a single script, which is
 * the recommended form when there is more than one entity.
 */
export function buildStructuredData(
    page: Partial<IntiPage> | null | undefined,
    options: StructuredDataOptions = {}
): JsonLdNode | null {
    // If the CMS already computed its graph (Yoast, RankMath), that one is
    // used: it knows the organization, the author and the breadcrumbs better
    // than we do. The nodes derived from blocks are added on top.
    const fromCms = options.preferCmsJsonLd === false ? null : normalizeCmsJsonLd(page?.seo?.jsonLd);

    // On a product page the main entity is the product, not the page that
    // wraps it.
    const mainNode = options.product
        ? buildProductSchema(options.product, {
              currency: options.currency,
              baseUrl: options.url
          })
        : pageNode(page, options);

    const graph: JsonLdNode[] = fromCms ?? [mainNode];

    if (options.breadcrumbs?.length) {
        graph.push(breadcrumbNode(options.breadcrumbs));
    }

    // Nodes derived from the blocks
    if (options.blockSchemas && page?.blocks?.length) {
        page.blocks.forEach((block, index) => {
            const builder = options.blockSchemas?.[block.type];
            if (!builder) return;

            try {
                const produced = builder(block, index);
                if (!produced) return;
                for (const node of Array.isArray(produced) ? produced : [produced]) {
                    if (node && Object.keys(node).length > 0) graph.push(node);
                }
            } catch {
                // A broken builder must not take down the page render
            }
        });
    }

    if (options.extra?.length) graph.push(...options.extra);

    const meaningful = graph.filter((node) => Object.keys(node).length > 1);
    if (meaningful.length === 0) return null;

    return { '@context': 'https://schema.org', '@graph': meaningful };
}

/**
 * Serializes JSON-LD safely for embedding in a `<script>`.
 * Without escaping `<`, a value with `</script>` would close the tag early
 * and allow markup injection.
 */
export function serializeJsonLd(data: JsonLdNode | null): string {
    if (!data) return '';
    return JSON.stringify(data).replace(/</g, '\\u003c');
}

// ============================================
// Convenience builders
// ============================================

/**
 * FAQPage from a block with question/answer pairs.
 *
 * @param items  Block field that holds the list (default: 'items')
 * @param keys   Names of the question and answer fields
 */
export function faqFromBlock(
    items = 'items',
    keys: { question?: string; answer?: string } = {}
): BlockSchemaBuilder {
    const questionKey = keys.question ?? 'question';
    const answerKey = keys.answer ?? 'answer';

    return (block) => {
        const list = block.data?.[items];
        if (!Array.isArray(list) || list.length === 0) return null;

        const mainEntity = list
            .filter((entry: any) => entry?.[questionKey] && entry?.[answerKey])
            .map((entry: any) => ({
                '@type': 'Question',
                name: String(entry[questionKey]),
                acceptedAnswer: { '@type': 'Answer', text: String(entry[answerKey]) }
            }));

        return mainEntity.length > 0 ? { '@type': 'FAQPage', mainEntity } : null;
    };
}

/** HowTo from a block with steps */
export function howToFromBlock(steps = 'steps', nameField = 'title'): BlockSchemaBuilder {
    return (block) => {
        const list = block.data?.[steps];
        if (!Array.isArray(list) || list.length === 0) return null;

        return {
            '@type': 'HowTo',
            name: block.data?.[nameField] ? String(block.data[nameField]) : undefined,
            step: list.map((entry: any, i: number) => ({
                '@type': 'HowToStep',
                position: i + 1,
                name: entry?.title ? String(entry.title) : undefined,
                text: entry?.text ? String(entry.text) : String(entry ?? '')
            }))
        };
    };
}
