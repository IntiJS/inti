/**
 * XML sitemap with `lastmod` taken from the CMS.
 *
 * A sitemap generated from the framework's routes does not know when the
 * content changed. The CMS does, and that date is what crawlers use to
 * decide what to revisit.
 */

import type { PageSummary } from '../adapters/index.js';

export interface SitemapEntry {
    /** Absolute URL */
    loc: string;
    /** ISO-8601 */
    lastmod?: string;
    changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
    /** 0.0 – 1.0 */
    priority?: number;
}

export interface SitemapOptions {
    /** Site origin, e.g. https://yoursite.com */
    site: string;
    /** Path from the slug. Default: '/' + slug ('' for the home page) */
    pathFor?: (page: PageSummary) => string;
    changefreq?: SitemapEntry['changefreq'];
    /** Excludes pages from the sitemap (drafts, utilities) */
    filter?: (page: PageSummary) => boolean;
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
        .map((page) => ({
            loc: joinUrl(options.site, pathFor(page)),
            lastmod: isoDate(page.updatedAt),
            changefreq: options.changefreq
        }));
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
            return `  <url>\n${parts.join('\n')}\n  </url>`;
        })
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
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
