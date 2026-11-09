/**
 * WordPress SEO metadata, whichever plugin it comes from.
 *
 * A real WordPress site almost never stores SEO in hand-made ACF fields:
 * Yoast, RankMath, SEOPress or AIOSEO stores it. Ignoring them means throwing
 * away years of the client's work, so they are detected in order and the
 * ACF fields are the fallback only if there is none.
 */

import { extractSeo, mergeSeo } from '@intijs/core/seo';
import type { PageSeo } from '@intijs/core/types';

/** Yoast exposes `yoast_head_json` in the REST API */
interface YoastHead {
    title?: string;
    description?: string;
    canonical?: string;
    robots?: Record<string, string>;
    og_title?: string;
    og_description?: string;
    og_image?: Array<{ url?: string }>;
    og_locale?: string;
    article_published_time?: string;
    article_modified_time?: string;
    twitter_card?: string;
    twitter_title?: string;
    twitter_description?: string;
    twitter_image?: string;
    twitter_site?: string;
    schema?: unknown;
}

/**
 * Yoast serializes robots as `{ index: 'index', follow: 'nofollow',
 * 'max-snippet': 'max-snippet:-1' }`.
 */
function parseYoastRobots(robots: Record<string, string> | undefined): PageSeo['robots'] {
    if (!robots) return undefined;

    const result: NonNullable<PageSeo['robots']> = {};

    if (robots.index) result.index = robots.index !== 'noindex';
    if (robots.follow) result.follow = robots.follow !== 'nofollow';

    const snippet = robots['max-snippet'];
    if (snippet) {
        const value = Number(snippet.replace('max-snippet:', ''));
        if (!Number.isNaN(value)) result.maxSnippet = value;
    }

    const preview = robots['max-image-preview']?.replace('max-image-preview:', '');
    if (preview === 'none' || preview === 'standard' || preview === 'large') {
        result.maxImagePreview = preview;
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

function fromYoast(raw: any): PageSeo | undefined {
    const head: YoastHead | undefined = raw?.yoast_head_json;
    if (!head || typeof head !== 'object') return undefined;

    const seo: PageSeo = {
        title: head.title,
        description: head.description,
        image: head.og_image?.[0]?.url,
        canonical: head.canonical,
        robots: parseYoastRobots(head.robots),
        locale: head.og_locale,
        publishedAt: head.article_published_time,
        modifiedAt: head.article_modified_time,
        openGraph: { title: head.og_title, description: head.og_description, image: head.og_image?.[0]?.url },
        twitter: {
            card: head.twitter_card,
            title: head.twitter_title,
            description: head.twitter_description,
            image: head.twitter_image,
            site: head.twitter_site
        },
        // Yoast's @graph already knows the organization, author and breadcrumbs
        jsonLd: head.schema,
        source: 'yoast'
    };

    return cleanup(seo);
}

/** RankMath exposes `rank_math_head_json` or the serialized head */
function fromRankMath(raw: any): PageSeo | undefined {
    const head = raw?.rank_math_head_json ?? raw?.rank_math;
    if (!head || typeof head !== 'object') return undefined;

    return cleanup({
        title: head.title,
        description: head.description,
        canonical: head.canonical,
        image: head.og_image?.[0]?.url ?? head.openGraph?.image,
        openGraph: { title: head.og_title, description: head.og_description },
        jsonLd: head.schema ?? head.richSnippet,
        source: 'rank-math'
    });
}

/** SEOPress exposes `seopress_*` or a `seopress` object */
function fromSeoPress(raw: any): PageSeo | undefined {
    const source = raw?.seopress ?? raw;

    return extractSeo(
        source,
        {
            title: ['seopress_titles_title', 'title'],
            description: ['seopress_titles_desc', 'description'],
            canonical: ['seopress_robots_canonical', 'canonical'],
            image: ['seopress_social_fb_img', 'og_image'],
            noindex: ['seopress_robots_index'],
            ogTitle: 'seopress_social_fb_title',
            ogDescription: 'seopress_social_fb_desc',
            twitterTitle: 'seopress_social_twitter_title',
            twitterDescription: 'seopress_social_twitter_desc',
            twitterImage: 'seopress_social_twitter_img'
        },
        'seopress'
    );
}

/** All in One SEO exposes `aioseo_head_json` or `aioseo_*` fields */
function fromAioseo(raw: any): PageSeo | undefined {
    const head = raw?.aioseo_head_json ?? raw?.aioseo;
    if (!head || typeof head !== 'object') return undefined;

    return cleanup({
        title: head.title,
        description: head.description,
        canonical: head.canonical_url ?? head.canonical,
        image: head.og_image ?? head.openGraph?.image,
        jsonLd: head.schema,
        source: 'aioseo'
    });
}

/** Hand-made ACF fields: the last resort, and the only thing Inti supported before */
function fromAcf(acf: any): PageSeo | undefined {
    return extractSeo(
        acf,
        {
            title: ['seo_title'],
            description: ['seo_description'],
            image: ['seo_image'],
            canonical: ['seo_canonical'],
            keywords: ['seo_keywords'],
            noindex: ['seo_noindex']
        },
        'acf'
    );
}

/** Drops empty branches so `mergeSeo` does not take them as a value */
function cleanup(seo: PageSeo): PageSeo | undefined {
    const prune = <T extends Record<string, unknown>>(obj: T | undefined): T | undefined => {
        if (!obj) return undefined;
        const clean = Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''));
        return Object.keys(clean).length > 0 ? (clean as T) : undefined;
    };

    const result = prune({
        ...seo,
        robots: prune(seo.robots),
        openGraph: prune(seo.openGraph),
        twitter: prune(seo.twitter)
    });

    return result && Object.keys(result).some((k) => k !== 'source') ? result : undefined;
}

/**
 * Extracts the SEO of a WordPress post.
 *
 * Priority: Yoast → RankMath → AIOSEO → SEOPress → ACF fields. The first
 * one that answers wins, and the ACF fields fill the gaps it leaves.
 */
export function extractWordPressSeo(raw: any, acf: any = {}): PageSeo | undefined {
    const fromPlugin =
        fromYoast(raw) ?? fromRankMath(raw) ?? fromAioseo(raw) ?? fromSeoPress(raw);

    const acfSeo = fromAcf(acf);

    // The plugin wins; ACF fills in what the plugin does not define
    const merged = mergeSeo(fromPlugin, acfSeo);
    if (merged) return merged;

    // With nothing configured, at least the page title
    const title = raw?.title?.rendered;
    return title ? { title, source: 'wordpress' } : undefined;
}
