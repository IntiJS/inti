/**
 * XML sitemap with `lastmod` taken from the CMS.
 *
 * A sitemap generated from the framework's routes does not know when the
 * content changed. The CMS does, and that date is what crawlers use to
 * decide what to revisit.
 */

import type { PageSummary, PageTranslation } from '../adapters/index.js';

export interface SitemapEntry {
    /** Absolute URL */
    loc: string;
    /** ISO-8601 */
    lastmod?: string;
    changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
    /** 0.0 – 1.0 */
    priority?: number;
    /** The same page in other languages: one `xhtml:link` each (include this one too) */
    alternates?: SitemapAlternate[];
}

export interface SitemapAlternate {
    /** `es`, `en-GB`, or `x-default` */
    hreflang: string;
    /** Absolute URL */
    href: string;
}

export interface SitemapOptions {
    /** Site origin, e.g. https://yoursite.com */
    site: string;
    /** Path from the slug. Default: '/' + slug ('' for the home page) */
    pathFor?: (page: PageSummary) => string;
    changefreq?: SitemapEntry['changefreq'];
    /** Excludes pages from the sitemap (drafts, utilities) */
    filter?: (page: PageSummary) => boolean;
    /** Path of a translation. Default: `/<locale>/<slug>` */
    translationPathFor?: (translation: PageTranslation) => string;
    /** Locale `x-default` points to, when a page has translations */
    defaultLocale?: string;
}

/** `&`, `<`, `>`, `"` and `'` break the XML if they travel unescaped */
function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** Normalizes to full ISO; drops anything that is not a valid date */
function isoDate(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function joinUrl(site: string, path: string): string {
    const origin = site.replace(/\/+$/, '');
    if (!path || path === '/') return origin + '/';
    return origin + (path.startsWith('/') ? path : `/${path}`);
}

/** Turns CMS pages into sitemap entries */
export function toSitemapEntries(pages: PageSummary[], options: SitemapOptions): SitemapEntry[] {
    const pathFor = options.pathFor ?? ((page: PageSummary) => (page.slug === 'home' ? '/' : `/${page.slug}`));

    return pages
        .filter((page) => !!page?.slug && (options.filter?.(page) ?? true))
        .map((page) => {
            const entry: SitemapEntry = {
                loc: joinUrl(options.site, pathFor(page)),
                lastmod: isoDate(page.updatedAt),
                changefreq: options.changefreq
            };
            if (page.locale && page.translations?.length) {
                const translationPath =
                    options.translationPathFor ?? ((t: PageTranslation) => `/${t.locale}${t.slug === 'home' ? '/' : `/${t.slug}`}`);
                const alternates: SitemapAlternate[] = [
                    { hreflang: page.locale, href: entry.loc },
                    ...page.translations.map((t) => ({ hreflang: t.locale, href: t.url ?? joinUrl(options.site, translationPath(t)) }))
                ];
                const fallback = alternates.find((alternate) => alternate.hreflang === options.defaultLocale);
                if (fallback) alternates.push({ hreflang: 'x-default', href: fallback.href });
                entry.alternates = alternates;
            }
            return entry;
        });
}

/** Serializes to sitemap XML */
export function buildSitemapXml(entries: SitemapEntry[]): string {
    const urls = entries
        .map((entry) => {
            const parts = [`    <loc>${escapeXml(entry.loc)}</loc>`];
            if (entry.lastmod) parts.push(`    <lastmod>${entry.lastmod}</lastmod>`);
            if (entry.changefreq) parts.push(`    <changefreq>${entry.changefreq}</changefreq>`);
            if (entry.priority !== undefined) {
                parts.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
            }
            for (const alternate of entry.alternates ?? []) {
                parts.push(`    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hreflang)}" href="${escapeXml(alternate.href)}"/>`);
            }
            return `  <url>\n${parts.join('\n')}\n  </url>`;
        })
        .join('\n');

    const xhtml = entries.some((entry) => entry.alternates?.length) ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : '';
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xhtml}>\n${urls}\n</urlset>\n`;
}

// ============================================
// Several files and their index
// ============================================

/** The protocol's limits for one file: 50,000 URLs and 50 MB uncompressed */
export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

/** Serializes the index that lists the sitemap files */
export function buildSitemapIndexXml(sitemaps: Array<{ loc: string; lastmod?: string }>): string {
    const items = sitemaps
        .map((sitemap) => {
            const lastmod = isoDate(sitemap.lastmod);
            return `  <sitemap>\n    <loc>${escapeXml(sitemap.loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n  </sitemap>`;
        })
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</sitemapindex>\n`;
}

/**
 * Splits entries into files that respect both limits. The byte size is
 * measured on each serialized entry, so long URLs with many alternates split
 * before 50,000.
 */
export function chunkSitemap(entries: SitemapEntry[], options: { maxUrls?: number; maxBytes?: number } = {}): SitemapEntry[][] {
    const maxUrls = Math.min(options.maxUrls ?? SITEMAP_MAX_URLS, SITEMAP_MAX_URLS);
    const maxBytes = Math.min(options.maxBytes ?? SITEMAP_MAX_BYTES, SITEMAP_MAX_BYTES) - 256;
    const encoder = new TextEncoder();
    const empty = encoder.encode(buildSitemapXml([])).length;
    const chunks: SitemapEntry[][] = [];
    let current: SitemapEntry[] = [];
    let bytes = 0;
    for (const entry of entries) {
        const size = encoder.encode(buildSitemapXml([entry])).length - empty;
        if (current.length > 0 && (current.length >= maxUrls || bytes + size > maxBytes)) {
            chunks.push(current);
            current = [];
            bytes = 0;
        }
        current.push(entry);
        bytes += size;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

/**
 * A group of URLs read one file at a time: pages, products, categories. A
 * catalog with a million products is never loaded whole.
 */
export interface SitemapSection {
    /** Goes in the file name: `/sitemap-products-3.xml` */
    name: string;
    /** How many URLs there are, to know how many files */
    count(): Promise<number>;
    /** The URLs of one file (0-based), at most `size` */
    entries(file: number, size: number): Promise<SitemapEntry[]>;
}

/** A section from a list that fits in memory (the CMS's pages) */
export function sitemapSection(name: string, load: () => Promise<SitemapEntry[]>): SitemapSection {
    let loaded: Promise<SitemapEntry[]> | undefined;
    const all = () => {
        loaded ??= load().catch((error) => {
            loaded = undefined;
            throw error;
        });
        return loaded;
    };
    return {
        name,
        count: async () => (await all()).length,
        entries: async (file, size) => (await all()).slice(file * size, (file + 1) * size)
    };
}

export interface SitemapRouteOptions {
    site: string;
    sections: SitemapSection[];
    /** URLs per file. Default and maximum 50,000 */
    size?: number;
    /** Path of one file. Default `/sitemap-<section>-<n>.xml`, n from 1 */
    pathFor?: (section: string, file: number) => string;
}

const xmlResponse = (body: string) =>
    new Response(body, {
        headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=0, s-maxage=3600' }
    });

/** `src/pages/sitemap.xml.ts`: `export const GET = sitemapIndexRoute(options)` */
export function sitemapIndexRoute(options: SitemapRouteOptions) {
    const size = Math.min(options.size ?? SITEMAP_MAX_URLS, SITEMAP_MAX_URLS);
    const pathFor = options.pathFor ?? ((section: string, file: number) => `/sitemap-${section}-${file}.xml`);
    return async (): Promise<Response> => {
        const counts = await Promise.all(options.sections.map((section) => section.count()));
        const sitemaps: Array<{ loc: string }> = [];
        options.sections.forEach((section, index) => {
            for (let file = 1; file <= Math.ceil(counts[index] / size); file++) {
                sitemaps.push({ loc: joinUrl(options.site, pathFor(section.name, file)) });
            }
        });
        return xmlResponse(buildSitemapIndexXml(sitemaps));
    };
}

/** `src/pages/sitemap-[section]-[file].xml.ts`: `export const GET = sitemapFileRoute(options)` */
export function sitemapFileRoute(options: SitemapRouteOptions) {
    const size = Math.min(options.size ?? SITEMAP_MAX_URLS, SITEMAP_MAX_URLS);
    return async ({ params }: { params: Record<string, string | undefined> }): Promise<Response> => {
        const section = options.sections.find((candidate) => candidate.name === params.section);
        const file = Number(params.file);
        if (!section || !Number.isInteger(file) || file < 1) return new Response('Not found', { status: 404 });
        const entries = await section.entries(file - 1, size);
        if (entries.length === 0) return new Response('Not found', { status: 404 });
        return xmlResponse(buildSitemapXml(entries));
    };
}

/**
 * robots.txt that does not block AI crawlers.
 *
 * Blocking them by accident is the fastest way to disappear from
 * generated answers, so the default is to allow everything and point to
 * the sitemap. `disallowAi` exists in case the decision is deliberate.
 */
export function buildRobotsTxt(options: { site: string; sitemapPath?: string; disallowAi?: string[] }): string {
    const lines = ['User-agent: *', 'Allow: /'];

    for (const bot of options.disallowAi ?? []) {
        lines.push('', `User-agent: ${bot}`, 'Disallow: /');
    }

    lines.push('', `Sitemap: ${joinUrl(options.site, options.sitemapPath ?? '/sitemap.xml')}`);
    return lines.join('\n') + '\n';
}
