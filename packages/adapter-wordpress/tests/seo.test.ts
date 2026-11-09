import { describe, test, expect } from 'bun:test';
import { extractWordPressSeo } from '../src/seo.js';

// ============================================
// Fixtures — real shapes from each plugin
// ============================================

const yoastPost = {
    title: { rendered: 'Services' },
    yoast_head_json: {
        title: 'Consulting services | Acme',
        description: 'Technical consulting for teams',
        canonical: 'https://acme.com/services',
        robots: {
            index: 'index',
            follow: 'follow',
            'max-snippet': 'max-snippet:-1',
            'max-image-preview': 'max-image-preview:large'
        },
        og_locale: 'es_ES',
        og_title: 'Services — Acme',
        og_description: 'What we do',
        og_image: [{ url: 'https://acme.com/og.jpg' }],
        article_modified_time: '2026-02-20T10:00:00+00:00',
        twitter_card: 'summary_large_image',
        twitter_site: '@acme',
        schema: { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', name: 'Services' }] }
    }
};

describe('Yoast', () => {
    test('reads title, description and canonical', () => {
        const seo = extractWordPressSeo(yoastPost)!;

        expect(seo.source).toBe('yoast');
        expect(seo.title).toBe('Consulting services | Acme');
        expect(seo.description).toBe('Technical consulting for teams');
        expect(seo.canonical).toBe('https://acme.com/services');
    });

    test('translates the Yoast robots object', () => {
        const seo = extractWordPressSeo(yoastPost)!;

        expect(seo.robots).toEqual({
            index: true,
            follow: true,
            maxSnippet: -1,
            maxImagePreview: 'large'
        });
    });

    test('detects noindex', () => {
        const seo = extractWordPressSeo({
            ...yoastPost,
            yoast_head_json: { ...yoastPost.yoast_head_json, robots: { index: 'noindex', follow: 'nofollow' } }
        })!;

        expect(seo.robots?.index).toBe(false);
        expect(seo.robots?.follow).toBe(false);
    });

    test('keeps the social overrides', () => {
        const seo = extractWordPressSeo(yoastPost)!;

        expect(seo.openGraph?.title).toBe('Services — Acme');
        expect(seo.image).toBe('https://acme.com/og.jpg');
        expect(seo.twitter?.site).toBe('@acme');
        expect(seo.locale).toBe('es_ES');
    });

    test('passes through the @graph Yoast already computed', () => {
        const seo = extractWordPressSeo(yoastPost)!;

        expect((seo.jsonLd as any)['@graph'][0]['@type']).toBe('WebPage');
    });

    test('keeps the modification date', () => {
        expect(extractWordPressSeo(yoastPost)!.modifiedAt).toBe('2026-02-20T10:00:00+00:00');
    });
});

describe('RankMath', () => {
    test('is used when there is no Yoast', () => {
        const seo = extractWordPressSeo({
            title: { rendered: 'X' },
            rank_math_head_json: {
                title: 'RankMath Title',
                description: 'Desc',
                canonical: 'https://acme.com/x',
                schema: { '@type': 'Article' }
            }
        })!;

        expect(seo.source).toBe('rank-math');
        expect(seo.title).toBe('RankMath Title');
        expect(seo.jsonLd).toEqual({ '@type': 'Article' });
    });
});

describe('AIOSEO and SEOPress', () => {
    test('AIOSEO is detected', () => {
        const seo = extractWordPressSeo({
            title: { rendered: 'X' },
            aioseo_head_json: { title: 'AIOSEO Title', canonical_url: 'https://acme.com/x' }
        })!;

        expect(seo.source).toBe('aioseo');
        expect(seo.canonical).toBe('https://acme.com/x');
    });

    test('SEOPress is detected', () => {
        const seo = extractWordPressSeo({
            title: { rendered: 'X' },
            seopress: { seopress_titles_title: 'SEOPress Title', seopress_titles_desc: 'Desc' }
        })!;

        expect(seo.source).toBe('seopress');
        expect(seo.title).toBe('SEOPress Title');
    });
});

describe('priority and fallbacks', () => {
    test('Yoast wins over RankMath if both are present', () => {
        const seo = extractWordPressSeo({
            ...yoastPost,
            rank_math_head_json: { title: 'Should not win' }
        })!;

        expect(seo.source).toBe('yoast');
    });

    test('ACF fills in what the plugin does not define', () => {
        const seo = extractWordPressSeo(
            { title: { rendered: 'X' }, yoast_head_json: { title: 'From Yoast' } },
            { seo_keywords: 'astro, cms' }
        )!;

        expect(seo.title).toBe('From Yoast');
        expect(seo.keywords).toEqual(['astro', 'cms']);
    });

    test('without a plugin it uses the ACF fields', () => {
        const seo = extractWordPressSeo(
            { title: { rendered: 'Services' } },
            { seo_description: 'From ACF', seo_image: { url: '/og.jpg' } }
        )!;

        expect(seo.source).toBe('acf');
        expect(seo.description).toBe('From ACF');
        expect(seo.image).toBe('/og.jpg');
    });

    test('with nothing configured it falls back to the post title', () => {
        const seo = extractWordPressSeo({ title: { rendered: 'No SEO' } })!;

        expect(seo.title).toBe('No SEO');
        expect(seo.source).toBe('wordpress');
    });

    test('an empty post does not break', () => {
        expect(extractWordPressSeo({})).toBeUndefined();
        expect(extractWordPressSeo(null)).toBeUndefined();
    });

    test('an empty yoast_head_json is not taken as valid', () => {
        const seo = extractWordPressSeo({ title: { rendered: 'X' }, yoast_head_json: {} })!;

        expect(seo.source).toBe('wordpress');
    });
});
