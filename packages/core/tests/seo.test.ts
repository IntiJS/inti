import { describe, test, expect } from 'bun:test';

import { buildMetaTags } from '../src/seo/meta.js';
import { buildStructuredData, serializeJsonLd, faqFromBlock, howToFromBlock } from '../src/seo/structured-data.js';
import { buildSitemapXml, toSitemapEntries, buildRobotsTxt } from '../src/seo/sitemap.js';
import type { IntiPage } from '../src/types/index.js';

// ============================================
// Fixtures
// ============================================

const page = (overrides: Partial<IntiPage> = {}): Partial<IntiPage> => ({
    id: '42',
    slug: 'services',
    title: 'Services',
    blocks: [],
    seo: { title: 'Our services', description: 'What we do', image: '/og.jpg' },
    ...overrides
});

/** Finds a tag by attribute */
const find = (tags: ReturnType<typeof buildMetaTags>, key: string, value: string) =>
    tags.find((t) => t.attrs[key] === value);

// ============================================
// Meta tags
// ============================================

describe('buildMetaTags', () => {
    test('uses the CMS SEO for title and description', () => {
        const tags = buildMetaTags(page(), { url: 'https://x.com/services' });

        expect(tags.find((t) => t.tag === 'title')?.attrs.content).toBe('Our services');
        expect(find(tags, 'name', 'description')?.attrs.content).toBe('What we do');
    });

    test('falls back to the page title if the CMS has no SEO', () => {
        const tags = buildMetaTags(page({ seo: undefined }));

        expect(tags.find((t) => t.tag === 'title')?.attrs.content).toBe('Services');
    });

    test('appends the site name without duplicating it', () => {
        const withSuffix = buildMetaTags(page(), { siteName: 'Acme' });
        expect(withSuffix.find((t) => t.tag === 'title')?.attrs.content).toBe('Our services | Acme');

        // If the title already has it, it is not repeated
        const already = buildMetaTags(page({ seo: { title: 'Services — Acme' } }), { siteName: 'Acme' });
        expect(already.find((t) => t.tag === 'title')?.attrs.content).toBe('Services — Acme');
    });

    test('emits a canonical when there is a url', () => {
        const tags = buildMetaTags(page(), { url: 'https://x.com/services' });

        expect(tags.find((t) => t.tag === 'link')?.attrs).toEqual({
            rel: 'canonical',
            href: 'https://x.com/services'
        });
    });

    test('makes the relative image absolute against the canonical', () => {
        const tags = buildMetaTags(page(), { url: 'https://x.com/services' });

        expect(find(tags, 'property', 'og:image')?.attrs.content).toBe('https://x.com/og.jpg');
    });

    test('respects an already absolute image', () => {
        const tags = buildMetaTags(page({ seo: { image: 'https://cdn.com/a.jpg' } }), { url: 'https://x.com/s' });

        expect(find(tags, 'property', 'og:image')?.attrs.content).toBe('https://cdn.com/a.jpg');
    });

    test('without an image the Twitter card is summary, not the large one', () => {
        const tags = buildMetaTags(page({ seo: { title: 'X' } }), {});

        expect(find(tags, 'name', 'twitter:card')?.attrs.content).toBe('summary');
        expect(find(tags, 'name', 'twitter:image')).toBeUndefined();
    });

    test('emits full Open Graph', () => {
        const tags = buildMetaTags(page(), { url: 'https://x.com/s', siteName: 'Acme', locale: 'es_ES' });

        expect(find(tags, 'property', 'og:title')?.attrs.content).toContain('Our services');
        expect(find(tags, 'property', 'og:url')?.attrs.content).toBe('https://x.com/s');
        expect(find(tags, 'property', 'og:site_name')?.attrs.content).toBe('Acme');
        expect(find(tags, 'property', 'og:locale')?.attrs.content).toBe('es_ES');
        expect(find(tags, 'property', 'og:type')?.attrs.content).toBe('website');
    });

    test('noindex is emitted only if asked for', () => {
        expect(find(buildMetaTags(page(), {}), 'name', 'robots')).toBeUndefined();
        expect(find(buildMetaTags(page(), { noindex: true }), 'name', 'robots')?.attrs.content).toBe(
            'noindex, nofollow'
        );
    });

    test('overrides win over the CMS', () => {
        const tags = buildMetaTags(page(), { title: 'Manual', description: 'Other' });

        expect(tags.find((t) => t.tag === 'title')?.attrs.content).toBe('Manual');
        expect(find(tags, 'name', 'description')?.attrs.content).toBe('Other');
    });

    test('a null page does not break', () => {
        expect(() => buildMetaTags(null)).not.toThrow();
        expect(buildMetaTags(null).find((t) => t.tag === 'title')).toBeUndefined();
    });

    test('does not emit tags with empty values', () => {
        const tags = buildMetaTags(page({ seo: { title: 'Title only' } }), {});

        expect(find(tags, 'name', 'description')).toBeUndefined();
        expect(find(tags, 'property', 'og:image')).toBeUndefined();
    });
});

// ============================================
// Structured data
// ============================================

describe('buildStructuredData', () => {
    test('emits an @graph with the page node', () => {
        const data = buildStructuredData(page(), { url: 'https://x.com/s', siteName: 'Acme' }) as any;

        expect(data['@context']).toBe('https://schema.org');
        expect(data['@graph'][0]['@type']).toBe('WebPage');
        expect(data['@graph'][0].name).toBe('Our services');
        expect(data['@graph'][0].url).toBe('https://x.com/s');
    });

    test('the Article type adds headline and dates', () => {
        const data = buildStructuredData(page(), {
            type: 'Article',
            modifiedAt: '2026-01-01T00:00:00Z',
            author: { name: 'Ana' }
        }) as any;

        const node = data['@graph'][0];
        expect(node['@type']).toBe('Article');
        expect(node.headline).toBe('Our services');
        expect(node.dateModified).toBe('2026-01-01T00:00:00Z');
        expect(node.author).toMatchObject({ '@type': 'Person', name: 'Ana' });
    });

    test('includes breadcrumbs with consecutive positions', () => {
        const data = buildStructuredData(page(), {
            breadcrumbs: [
                { name: 'Home', url: 'https://x.com/' },
                { name: 'Services', url: 'https://x.com/services' }
            ]
        }) as any;

        const crumbs = data['@graph'].find((n: any) => n['@type'] === 'BreadcrumbList');
        expect(crumbs.itemListElement).toHaveLength(2);
        expect(crumbs.itemListElement[1]).toMatchObject({ position: 2, name: 'Services' });
    });

    test('derives nodes from the blocks', () => {
        const withFaq = page({
            blocks: [
                { type: 'Hero', data: {} },
                { type: 'FaqSection', data: { items: [{ question: 'How much?', answer: 'It depends' }] } }
            ]
        });

        const data = buildStructuredData(withFaq, { blockSchemas: { FaqSection: faqFromBlock() } }) as any;

        const faq = data['@graph'].find((n: any) => n['@type'] === 'FAQPage');
        expect(faq.mainEntity).toHaveLength(1);
        expect(faq.mainEntity[0].name).toBe('How much?');
        expect(faq.mainEntity[0].acceptedAnswer.text).toBe('It depends');
    });

    test('a builder that throws does not bring down the rest', () => {
        const data = buildStructuredData(page({ blocks: [{ type: 'Broken', data: {} }] }), {
            blockSchemas: {
                Broken: () => {
                    throw new Error('boom');
                }
            }
        }) as any;

        expect(data['@graph'][0]['@type']).toBe('WebPage');
    });

    test('without meaningful data it returns null', () => {
        expect(buildStructuredData(null, {})).toBeNull();
        expect(buildStructuredData({ blocks: [] }, {})).toBeNull();
    });

    test('does not emit empty fields', () => {
        const data = buildStructuredData({ title: 'Title only', blocks: [] }, {}) as any;

        expect(data['@graph'][0]).not.toHaveProperty('description');
        expect(data['@graph'][0]).not.toHaveProperty('image');
    });

    test('makes the image absolute: schema.org does not resolve relative paths', () => {
        const data = buildStructuredData(page(), { url: 'https://x.com/services' }) as any;

        expect(data['@graph'][0].image).toBe('https://x.com/og.jpg');
    });

    test('without a url it does not invent a relative image', () => {
        const data = buildStructuredData(page(), {}) as any;

        expect(data['@graph'][0]).not.toHaveProperty('image');
    });
});

describe('faqFromBlock / howToFromBlock', () => {
    test('faq ignores incomplete entries', () => {
        const build = faqFromBlock();
        const result = build(
            { type: 'F', data: { items: [{ question: 'A', answer: 'B' }, { question: 'No answer' }] } },
            0
        ) as any;

        expect(result.mainEntity).toHaveLength(1);
    });

    test('faq returns null if there is no list', () => {
        expect(faqFromBlock()({ type: 'F', data: {} }, 0)).toBeNull();
        expect(faqFromBlock()({ type: 'F', data: { items: [] } }, 0)).toBeNull();
    });

    test('faq accepts custom field names', () => {
        const build = faqFromBlock('questions', { question: 'p', answer: 'r' });
        const result = build({ type: 'F', data: { questions: [{ p: 'What?', r: 'This' }] } }, 0) as any;

        expect(result.mainEntity[0].name).toBe('What?');
    });

    test('howTo numbers the steps', () => {
        const result = howToFromBlock()(
            { type: 'H', data: { title: 'Install', steps: [{ title: 'One' }, { title: 'Two' }] } },
            0
        ) as any;

        expect(result['@type']).toBe('HowTo');
        expect(result.name).toBe('Install');
        expect(result.step[1].position).toBe(2);
    });
});

describe('serializeJsonLd', () => {
    test('escapes < so the script cannot be closed early', () => {
        const payload = serializeJsonLd({ '@type': 'WebPage', name: '</script><img src=x onerror=alert(1)>' });

        expect(payload).not.toContain('</script>');
        expect(payload).toContain('\\u003c');
    });

    test('null produces an empty string', () => {
        expect(serializeJsonLd(null)).toBe('');
    });
});

// ============================================
// Sitemap
// ============================================

describe('toSitemapEntries', () => {
    const pages = [
        { slug: 'home', updatedAt: '2026-01-15T10:00:00Z' },
        { slug: 'services', updatedAt: '2026-02-20T10:00:00Z' }
    ];

    test('the home page sits at the root', () => {
        const entries = toSitemapEntries(pages, { site: 'https://x.com' });

        expect(entries[0].loc).toBe('https://x.com/');
        expect(entries[1].loc).toBe('https://x.com/services');
    });

    test('keeps the CMS lastmod in ISO', () => {
        expect(toSitemapEntries(pages, { site: 'https://x.com' })[1].lastmod).toBe('2026-02-20T10:00:00.000Z');
    });

    test('drops invalid dates instead of emitting garbage', () => {
        const entries = toSitemapEntries([{ slug: 'a', updatedAt: 'not a date' }], { site: 'https://x.com' });

        expect(entries[0].lastmod).toBeUndefined();
    });

    test('normalizes the trailing slash of the site', () => {
        expect(toSitemapEntries(pages, { site: 'https://x.com/' })[1].loc).toBe('https://x.com/services');
    });

    test('accepts custom paths and a filter', () => {
        const entries = toSitemapEntries(pages, {
            site: 'https://x.com',
            pathFor: (p) => `/es/${p.slug}`,
            filter: (p) => p.slug !== 'home'
        });

        expect(entries).toHaveLength(1);
        expect(entries[0].loc).toBe('https://x.com/es/services');
    });

    test('ignores pages without a slug', () => {
        expect(toSitemapEntries([{ slug: '' } as any], { site: 'https://x.com' })).toHaveLength(0);
    });
});

describe('buildSitemapXml', () => {
    test('generates valid XML with lastmod', () => {
        const xml = buildSitemapXml([{ loc: 'https://x.com/', lastmod: '2026-01-15T10:00:00.000Z' }]);

        expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
        expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
        expect(xml).toContain('<loc>https://x.com/</loc>');
        expect(xml).toContain('<lastmod>2026-01-15T10:00:00.000Z</lastmod>');
    });

    test('escapes characters that would break the XML', () => {
        const xml = buildSitemapXml([{ loc: 'https://x.com/a?b=1&c=2' }]);

        expect(xml).toContain('&amp;');
        expect(xml).not.toContain('?b=1&c=2');
    });

    test('omits lastmod and changefreq when there are none', () => {
        const xml = buildSitemapXml([{ loc: 'https://x.com/' }]);

        expect(xml).not.toContain('<lastmod>');
        expect(xml).not.toContain('<changefreq>');
    });
});

describe('buildRobotsTxt', () => {
    test('allows everything and points to the sitemap by default', () => {
        const txt = buildRobotsTxt({ site: 'https://x.com' });

        expect(txt).toContain('User-agent: *\nAllow: /');
        expect(txt).toContain('Sitemap: https://x.com/sitemap.xml');
        expect(txt).not.toContain('Disallow: /');
    });

    test('only blocks AI bots if explicitly asked', () => {
        const txt = buildRobotsTxt({ site: 'https://x.com', disallowAi: ['GPTBot'] });

        expect(txt).toContain('User-agent: GPTBot\nDisallow: /');
    });
});
