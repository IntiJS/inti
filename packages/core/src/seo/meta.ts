/**
 * Page metadata from what the CMS already returns.
 *
 * `IntiPage.seo` travels from WordPress or Strapi and until now nobody
 * read it. Here it becomes the tags that both Google and AI crawlers look
 * for — which, except for Gemini, do not run JavaScript, so all of this
 * has to be in the served HTML.
 */

import type { IntiPage } from '../types/index.js';

export interface MetaTag {
    /** Tag to emit */
    tag: 'title' | 'meta' | 'link';
    /** Attributes. For `title`, the text goes in `content` */
    attrs: Record<string, string>;
}

export interface SeoOptions {
    /** Absolute canonical URL of this page */
    url?: string;
    /** Site name, for og:site_name and the title suffix */
    siteName?: string;
    /** Separator between title and site name (default: ' | ') */
    titleSeparator?: string;
    /** Language in og format (e.g. 'es_ES') */
    locale?: string;
    /** og:type — 'website' by default, 'article' for posts */
    type?: 'website' | 'article';
    /** The site's Twitter/X @handle */
    twitterSite?: string;
    /** ISO date of the last modification, if the CMS exposes it */
    modifiedAt?: string;
    /** Prevents indexing (drafts, previews) */
    noindex?: boolean;
    /** Overrides whatever comes from the CMS */
    title?: string;
    description?: string;
    image?: string;
}

/** Makes a relative URL absolute against the origin of `base` */
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

/**
 * Builds a page's tags.
 *
 * Pure function: it touches neither the DOM nor Astro, so it can be tested
 * and reused from any renderer.
 */
export function buildMetaTags(page: Partial<IntiPage> | null | undefined, options: SeoOptions = {}): MetaTag[] {
    const seo = page?.seo ?? {};

    // The CMS title wins over the page's; the override wins over both
    const rawTitle = options.title ?? seo.title ?? page?.title;
    const description = options.description ?? seo.description;
    const image = absolute(options.image ?? seo.image, options.url);
    const separator = options.titleSeparator ?? ' | ';

    // The CMS canonical wins: if the editor set it, it was on purpose
    const canonical = seo.canonical ?? options.url;

    // Do not repeat the site name if the title already includes it
    const title =
        rawTitle && options.siteName && !rawTitle.includes(options.siteName)
            ? `${rawTitle}${separator}${options.siteName}`
            : rawTitle;

    const tags: MetaTag[] = [];
    const meta = (attrs: Record<string, string | undefined>) => {
        const clean: Record<string, string> = {};
        for (const [key, value] of Object.entries(attrs)) {
            if (value === undefined || value === '') return;
            clean[key] = value;
        }
        tags.push({ tag: 'meta', attrs: clean });
    };

    if (title) tags.push({ tag: 'title', attrs: { content: title } });
    meta({ name: 'description', content: description });

    if (canonical) {
        tags.push({ tag: 'link', attrs: { rel: 'canonical', href: canonical } });
    }

    const robots = robotsDirective(seo, options.noindex);
    meta({ name: 'robots', content: robots });

    if (seo.keywords?.length) {
        meta({ name: 'keywords', content: seo.keywords.join(', ') });
    }

    // Open Graph — the CMS overrides win over the general values
    const og = seo.openGraph ?? {};
    const ogImage = absolute(og.image, options.url) ?? image;

    meta({ property: 'og:type', content: og.type ?? options.type ?? 'website' });
    meta({ property: 'og:title', content: og.title ?? title });
    meta({ property: 'og:description', content: og.description ?? description });
    meta({ property: 'og:url', content: canonical });
    meta({ property: 'og:site_name', content: options.siteName });
    meta({ property: 'og:locale', content: options.locale ?? seo.locale });
    meta({ property: 'og:image', content: ogImage });

    const modifiedAt = options.modifiedAt ?? seo.modifiedAt;
    const isArticle = (og.type ?? options.type) === 'article';

    if (isArticle) {
        if (seo.publishedAt) meta({ property: 'article:published_time', content: seo.publishedAt });
        if (modifiedAt) meta({ property: 'article:modified_time', content: modifiedAt });
    }

    // Twitter/X: without an image, the large card is left empty
    const tw = seo.twitter ?? {};
    const twImage = absolute(tw.image, options.url) ?? ogImage;

    meta({ name: 'twitter:card', content: tw.card ?? (twImage ? 'summary_large_image' : 'summary') });
    meta({ name: 'twitter:title', content: tw.title ?? title });
    meta({ name: 'twitter:description', content: tw.description ?? description });
    meta({ name: 'twitter:image', content: twImage });
    meta({ name: 'twitter:site', content: tw.site ?? options.twitterSite });

    return tags;
}

/**
 * `robots` directive combining what the CMS says and the local override.
 * An explicit `noindex` always wins: it is the "do not publish this" signal.
 */
function robotsDirective(seo: NonNullable<Partial<IntiPage>['seo']>, noindex?: boolean): string | undefined {
    if (noindex) return 'noindex, nofollow';

    const robots = seo.robots;
    if (!robots) return undefined;

    const parts: string[] = [];

    // Only emitted if it differs from the crawler's implicit default
    if (robots.index === false) parts.push('noindex');
    if (robots.follow === false) parts.push('nofollow');
    if (robots.maxSnippet !== undefined) parts.push(`max-snippet:${robots.maxSnippet}`);
    if (robots.maxImagePreview) parts.push(`max-image-preview:${robots.maxImagePreview}`);

    return parts.length > 0 ? parts.join(', ') : undefined;
}
