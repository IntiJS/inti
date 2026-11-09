/**
 * SEO metadata extraction from any CMS's raw shape.
 *
 * WordPress and Strapi have conventions (Yoast, the `seo` component), and
 * their adapters implement them directly. Contentful, Sanity or a custom
 * CMS do not: each project names its fields however it likes, and the
 * declarative mapping here is for that case.
 */

import type { PageSeo } from '../types/index.js';

/**
 * Path to a field of the raw object. Accepts a dot-path and, as an
 * alternative, a list: the first path that yields a value is used.
 */
export type FieldPath = string | string[];

export interface SeoFieldMap {
    title?: FieldPath;
    description?: FieldPath;
    image?: FieldPath;
    canonical?: FieldPath;
    keywords?: FieldPath;
    publishedAt?: FieldPath;
    modifiedAt?: FieldPath;
    locale?: FieldPath;
    noindex?: FieldPath;
    nofollow?: FieldPath;
    ogTitle?: FieldPath;
    ogDescription?: FieldPath;
    ogImage?: FieldPath;
    twitterCard?: FieldPath;
    twitterTitle?: FieldPath;
    twitterDescription?: FieldPath;
    twitterImage?: FieldPath;
    jsonLd?: FieldPath;
}

/** Reads a dot-path tolerating missing values at any level */
export function readPath(source: unknown, path: string): unknown {
    if (!source || typeof source !== 'object') return undefined;

    let cursor: any = source;
    for (const key of path.split('.')) {
        if (cursor === null || cursor === undefined) return undefined;

        // Numeric indexes for arrays: 'images.0.url'
        cursor = cursor[key];
    }
    return cursor;
}

/** First path that produces a useful value */
function readFirst(source: unknown, path: FieldPath | undefined): unknown {
    if (!path) return undefined;

    for (const candidate of Array.isArray(path) ? path : [path]) {
        const value = readPath(source, candidate);
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
}

const asString = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value.trim() || undefined;
    if (typeof value === 'number') return String(value);
    return undefined;
};

/**
 * An image may come as a string, as `{ url }`, as `{ data: { attributes: { url } } }`
 * (Strapi) or as an array. It tries to get the URL from the usual shapes.
 */
export function asImageUrl(value: unknown): string | undefined {
    if (!value) return undefined;
    if (typeof value === 'string') return value.trim() || undefined;

    if (Array.isArray(value)) return asImageUrl(value[0]);

    if (typeof value === 'object') {
        const obj = value as Record<string, any>;
        return (
            asString(obj.url) ??
            asString(obj.src) ??
            asImageUrl(obj.data) ??
            asImageUrl(obj.attributes) ??
            asImageUrl(obj.fields) ??
            asString(obj.file?.url)
        );
    }
    return undefined;
}

const asBool = (value: unknown): boolean | undefined => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'noindex', 'nofollow'].includes(normalized)) return true;
        if (['false', '0', 'no', 'index', 'follow'].includes(normalized)) return false;
    }
    return undefined;
};

const asKeywords = (value: unknown): string[] | undefined => {
    if (Array.isArray(value)) {
        const list = value.map(asString).filter((k): k is string => !!k);
        return list.length > 0 ? list : undefined;
    }
    const text = asString(value);
    if (!text) return undefined;

    const list = text.split(',').map((k) => k.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
};

/** Drops empty keys so hollow objects are not carried along */
function compact<T extends Record<string, unknown>>(obj: T): T | undefined {
    const clean = Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''));
    return Object.keys(clean).length > 0 ? (clean as T) : undefined;
}

/**
 * Builds a `PageSeo` from a raw object and a field map.
 *
 * ```ts
 * extractSeo(entry.fields, {
 *   title: ['seoTitle', 'title'],
 *   description: 'seoDescription',
 *   image: 'ogImage',
 *   noindex: 'hideFromSearch'
 * }, 'contentful');
 * ```
 */
export function extractSeo(raw: unknown, map: SeoFieldMap, source?: string): PageSeo | undefined {
    if (!raw) return undefined;

    const noindex = asBool(readFirst(raw, map.noindex));
    const nofollow = asBool(readFirst(raw, map.nofollow));

    const seo: PageSeo = {
        title: asString(readFirst(raw, map.title)),
        description: asString(readFirst(raw, map.description)),
        image: asImageUrl(readFirst(raw, map.image)),
        canonical: asString(readFirst(raw, map.canonical)),
        keywords: asKeywords(readFirst(raw, map.keywords)),
        publishedAt: asString(readFirst(raw, map.publishedAt)),
        modifiedAt: asString(readFirst(raw, map.modifiedAt)),
        locale: asString(readFirst(raw, map.locale)),
        // index/follow are only set if the CMS says something: undefined means
        // "no opinion", and forcing true would emit redundant directives
        robots: compact({
            index: noindex === undefined ? undefined : !noindex,
            follow: nofollow === undefined ? undefined : !nofollow
        }),
        openGraph: compact({
            title: asString(readFirst(raw, map.ogTitle)),
            description: asString(readFirst(raw, map.ogDescription)),
            image: asImageUrl(readFirst(raw, map.ogImage))
        }),
        twitter: compact({
            card: asString(readFirst(raw, map.twitterCard)),
            title: asString(readFirst(raw, map.twitterTitle)),
            description: asString(readFirst(raw, map.twitterDescription)),
            image: asImageUrl(readFirst(raw, map.twitterImage))
        }),
        jsonLd: readFirst(raw, map.jsonLd),
        source
    };

    const compacted = compact(seo as Record<string, unknown>);
    // `source` alone does not count as content
    return compacted && Object.keys(compacted).some((k) => k !== 'source') ? (compacted as PageSeo) : undefined;
}

/**
 * Combines several sources, from highest to lowest priority.
 *
 * Useful for "use Yoast if present, otherwise the hand-made ACF fields",
 * without the adapter having to chain conditionals for each field.
 */
export function mergeSeo(...sources: Array<PageSeo | undefined>): PageSeo | undefined {
    const present = sources.filter((s): s is PageSeo => !!s);
    if (present.length === 0) return undefined;

    const merged: PageSeo = {};

    // Walked from lowest to highest priority so the first source wins
    for (const seo of [...present].reverse()) {
        Object.assign(merged, compact(seo as Record<string, unknown>) ?? {});
        if (seo.robots) merged.robots = { ...merged.robots, ...seo.robots };
        if (seo.openGraph) merged.openGraph = { ...merged.openGraph, ...seo.openGraph };
        if (seo.twitter) merged.twitter = { ...merged.twitter, ...seo.twitter };
    }

    return merged;
}
