import { describe, test, expect } from 'bun:test';
import { extractStrapiSeo } from '../src/seo.js';

// Shape of Strapi's official SEO plugin
const withPlugin = {
    title: 'Services',
    updatedAt: '2026-02-20T10:00:00.000Z',
    locale: 'es',
    seo: {
        metaTitle: 'Consulting services',
        metaDescription: 'What we do',
        metaImage: { data: { attributes: { url: '/uploads/og.jpg' } } },
        canonicalURL: 'https://acme.com/services',
        keywords: 'astro, cms, headless',
        metaRobots: 'noindex, nofollow',
        structuredData: { '@type': 'Service' },
        metaSocial: [
            { socialNetwork: 'Facebook', title: 'FB title', description: 'FB desc' },
            { socialNetwork: 'Twitter', title: 'TW title', image: { data: { attributes: { url: '/tw.jpg' } } } }
        ]
    }
};

describe('Strapi seo component', () => {
    test('reads the official plugin fields', () => {
        const seo = extractStrapiSeo(withPlugin)!;

        expect(seo.source).toBe('strapi-seo');
        expect(seo.title).toBe('Consulting services');
        expect(seo.description).toBe('What we do');
        expect(seo.canonical).toBe('https://acme.com/services');
    });

    test('resolves the image through the data/attributes wrapper', () => {
        expect(extractStrapiSeo(withPlugin)!.image).toBe('/uploads/og.jpg');
    });

    test('parses free-text metaRobots', () => {
        expect(extractStrapiSeo(withPlugin)!.robots).toEqual({ index: false, follow: false });
    });

    test('splits the keywords', () => {
        expect(extractStrapiSeo(withPlugin)!.keywords).toEqual(['astro', 'cms', 'headless']);
    });

    test('maps metaSocial to Open Graph and Twitter', () => {
        const seo = extractStrapiSeo(withPlugin)!;

        expect(seo.openGraph?.title).toBe('FB title');
        expect(seo.twitter?.title).toBe('TW title');
        expect(seo.twitter?.image).toBe('/tw.jpg');
    });

    test('passes through the CMS structuredData', () => {
        expect(extractStrapiSeo(withPlugin)!.jsonLd).toEqual({ '@type': 'Service' });
    });
});

describe('without the SEO plugin', () => {
    test('falls back to loose fields on the entry', () => {
        const seo = extractStrapiSeo({
            title: 'Services',
            metaDescription: 'Custom description',
            ogImage: { url: '/custom.jpg' }
        })!;

        expect(seo.title).toBe('Services');
        expect(seo.description).toBe('Custom description');
        expect(seo.image).toBe('/custom.jpg');
        expect(seo.source).toBe('strapi');
    });

    test('uses updatedAt as the modification date', () => {
        expect(extractStrapiSeo({ title: 'X', updatedAt: '2026-01-01T00:00:00Z' })!.modifiedAt).toBe(
            '2026-01-01T00:00:00Z'
        );
    });

    test('the plugin wins over the loose fields', () => {
        const seo = extractStrapiSeo({
            title: 'From the entry',
            seo: { metaTitle: 'From the plugin' }
        })!;

        expect(seo.title).toBe('From the plugin');
    });

    test('empty attributes do not break', () => {
        expect(extractStrapiSeo(null)).toBeUndefined();
        expect(extractStrapiSeo({})).toBeUndefined();
    });

    test('missing or malformed metaSocial does not break', () => {
        const seo = extractStrapiSeo({ seo: { metaTitle: 'X', metaSocial: 'not a list' } })!;

        expect(seo.title).toBe('X');
        expect(seo.openGraph).toBeUndefined();
    });
});
