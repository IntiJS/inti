import { describe, test, expect } from 'bun:test';
import { auditPage, auditBlock, formatAudit, hasErrors } from '../src/seo/audit.js';
import { buildLlmsTxt, pageToMarkdown } from '../src/seo/llms.js';
import type { IntiPage } from '../src/types/index.js';

const codes = (findings: ReturnType<typeof auditPage>) => findings.map((f) => f.code);

const page = (overrides: Partial<IntiPage> = {}): Partial<IntiPage> => ({
    id: '1',
    slug: 'services',
    title: 'Technical consulting services',
    seo: {
        title: 'Technical consulting services',
        description: 'We help product teams build better software, with a strong focus on quality.',
        image: '/og.jpg'
    },
    blocks: [],
    ...overrides
});

// ============================================
// Metadata
// ============================================

describe('auditPage — metadata', () => {
    test('a well-configured page produces no findings', () => {
        expect(auditPage(page())).toEqual([]);
    });

    test('detects a missing title', () => {
        expect(codes(auditPage({ blocks: [] }))).toContain('meta-missing-title');
    });

    test('detects a missing description', () => {
        const findings = auditPage(page({ seo: { title: 'Technical consulting services' } }));

        expect(codes(findings)).toContain('meta-missing-description');
        expect(findings.find((f) => f.code === 'meta-missing-description')?.level).toBe('warning');
    });

    test('warns about titles that are too long or too short', () => {
        expect(codes(auditPage(page({ seo: { title: 'x'.repeat(90), description: 'y'.repeat(100) } })))).toContain(
            'meta-title-long'
        );
        expect(codes(auditPage(page({ seo: { title: 'Short', description: 'y'.repeat(100) } })))).toContain(
            'meta-title-short'
        );
    });

    test('warns about descriptions that will be truncated', () => {
        const findings = auditPage(page({ seo: { title: 'Consulting services', description: 'x'.repeat(200) } }));

        expect(codes(findings)).toContain('meta-description-long');
    });

    test('reports noindex instead of treating it as an error', () => {
        const findings = auditPage(page({ seo: { ...page().seo, robots: { index: false } } }));
        const noindex = findings.find((f) => f.code === 'meta-noindex');

        expect(noindex?.level).toBe('info');
    });

    test('honors custom ranges', () => {
        const findings = auditPage(page(), { titleLength: { min: 1, max: 10 } });

        expect(codes(findings)).toContain('meta-title-long');
    });

    test('ignore silences specific rules', () => {
        const bare = { blocks: [] };

        expect(codes(auditPage(bare))).toContain('meta-missing-title');
        expect(codes(auditPage(bare, { ignore: ['meta-missing-title'] }))).not.toContain('meta-missing-title');
    });
});

// ============================================
// Images
// ============================================

describe('auditPage — images', () => {
    test('detects images without alt and points at the field', () => {
        const findings = auditPage(
            page({ blocks: [{ type: 'Hero', data: { image: { url: '/a.jpg', width: 800, alt: '' } } }] })
        );

        const missing = findings.find((f) => f.code === 'image-missing-alt');
        expect(missing).toBeDefined();
        expect(missing?.field).toBe('image');
        expect(missing?.blockIndex).toBe(0);
        expect(missing?.blockType).toBe('Hero');
    });

    test('an image with alt produces no warning', () => {
        const findings = auditPage(
            page({ blocks: [{ type: 'Hero', data: { image: { url: '/a.jpg', alt: 'Team at work' } } }] })
        );

        expect(codes(findings)).not.toContain('image-missing-alt');
    });

    test('finds nested images and images in lists', () => {
        const findings = auditPage(
            page({
                blocks: [
                    {
                        type: 'Gallery',
                        data: {
                            items: [
                                { photo: { url: '/1.jpg', width: 100 } },
                                { photo: { url: '/2.jpg', width: 100, alt: 'ok' } }
                            ]
                        }
                    }
                ]
            })
        );

        const missing = findings.filter((f) => f.code === 'image-missing-alt');
        expect(missing).toHaveLength(1);
        expect(missing[0].field).toBe('items.0.photo');
    });

    test('accepts alternativeText, which is what Strapi calls it', () => {
        const findings = auditPage(
            page({ blocks: [{ type: 'Hero', data: { img: { url: '/a.jpg', width: 1, alternativeText: 'ok' } } }] })
        );

        expect(codes(findings)).not.toContain('image-missing-alt');
    });

    test('does not mistake an arbitrary object for an image', () => {
        const findings = auditPage(page({ blocks: [{ type: 'Cta', data: { link: { url: '/contact' } } }] }));

        expect(codes(findings)).not.toContain('image-missing-alt');
    });
});

// ============================================
// Headings
// ============================================

describe('auditPage — headings', () => {
    const headings = { Hero: 1, Section: 2, Sub: 3, Deep: 4 };

    test('without declared levels nothing is checked', () => {
        const findings = auditPage(page({ blocks: [{ type: 'Section', data: {} }] }));

        expect(codes(findings)).not.toContain('heading-missing-h1');
    });

    test('detects that the H1 is missing', () => {
        const findings = auditPage(page({ blocks: [{ type: 'Section', data: {} }] }), { headings });

        expect(codes(findings)).toContain('heading-missing-h1');
        expect(findings.find((f) => f.code === 'heading-missing-h1')?.level).toBe('error');
    });

    test('detects a duplicate H1 and points at the second one', () => {
        const findings = auditPage(
            page({ blocks: [{ type: 'Hero', data: {} }, { type: 'Hero', data: {} }] }),
            { headings }
        );

        const duplicate = findings.filter((f) => f.code === 'heading-duplicate-h1');
        expect(duplicate).toHaveLength(1);
        expect(duplicate[0].blockIndex).toBe(1);
    });

    test('detects skipped levels', () => {
        const findings = auditPage(
            page({ blocks: [{ type: 'Hero', data: {} }, { type: 'Deep', data: {} }] }),
            { headings }
        );

        const skip = findings.find((f) => f.code === 'heading-skipped-level');
        expect(skip?.message).toContain('H1 to H4');
        expect(skip?.blockIndex).toBe(1);
    });

    test('a correct hierarchy produces no findings', () => {
        const findings = auditPage(
            page({
                blocks: [
                    { type: 'Hero', data: {} },
                    { type: 'Section', data: {} },
                    { type: 'Sub', data: {} },
                    { type: 'Section', data: {} }
                ]
            }),
            { headings }
        );

        expect(findings).toEqual([]);
    });
});

// ============================================
// Utilities
// ============================================

describe('auditBlock, formatAudit, hasErrors', () => {
    test('auditBlock checks a single block', () => {
        const findings = auditBlock({ type: 'Hero', data: { img: { url: '/a.jpg', width: 1 } } }, 3);

        expect(findings[0].blockIndex).toBe(3);
        expect(findings[0].code).toBe('image-missing-alt');
    });

    test('formatAudit gives block and field', () => {
        const text = formatAudit(auditBlock({ type: 'Hero', data: { img: { url: '/a.jpg', width: 1 } } }, 2));

        expect(text).toContain('block 2');
        expect(text).toContain('Hero');
        expect(text).toContain('img');
    });

    test('formatAudit says so when there are no findings', () => {
        expect(formatAudit([])).toContain('no findings');
    });

    test('hasErrors only with errors, not with warnings', () => {
        expect(hasErrors(auditPage(page({ blocks: [{ type: 'S', data: {} }] }), { headings: { S: 2 } }))).toBe(true);
        expect(hasErrors(auditPage(page()))).toBe(false);
    });

    test('a null page does not break', () => {
        expect(auditPage(null)).toEqual([]);
    });
});

// ============================================
// llms.txt
// ============================================

describe('buildLlmsTxt', () => {
    const pages = [
        { slug: 'home', title: 'Home' },
        { slug: 'services', title: 'Services' }
    ];

    test('emits the format with heading, summary and links', () => {
        const txt = buildLlmsTxt(pages, {
            siteName: 'Acme',
            summary: 'Technical consulting',
            site: 'https://acme.com'
        });

        expect(txt.startsWith('# Acme')).toBe(true);
        expect(txt).toContain('> Technical consulting');
        expect(txt).toContain('## Pages');
        expect(txt).toContain('- [Home](https://acme.com/)');
        expect(txt).toContain('- [Services](https://acme.com/services)');
    });

    test('allows additional sections', () => {
        const txt = buildLlmsTxt(pages, {
            siteName: 'Acme',
            site: 'https://acme.com',
            sections: [
                { title: 'Docs', entries: [{ title: 'API', url: 'https://acme.com/api', description: 'Reference' }] }
            ]
        });

        expect(txt).toContain('## Docs');
        expect(txt).toContain('- [API](https://acme.com/api): Reference');
    });

    test('filters pages and uses the slug if there is no title', () => {
        const txt = buildLlmsTxt([{ slug: 'hidden' }, { slug: 'visible' }], {
            siteName: 'Acme',
            site: 'https://acme.com',
            filter: (p) => p.slug !== 'hidden'
        });

        expect(txt).not.toContain('hidden');
        expect(txt).toContain('- [visible]');
    });
});

describe('pageToMarkdown', () => {
    test('dumps the page with one block per section', () => {
        const md = pageToMarkdown(
            page({
                blocks: [
                    { type: 'Hero', data: { heading: 'We build software', subheading: 'With small teams' } },
                    { type: 'Text', data: { body: 'We have been doing this for ten years.' } }
                ]
            })
        );

        expect(md).toContain('# Technical consulting services');
        expect(md).toContain('## We build software');
        expect(md).toContain('With small teams');
        expect(md).toContain('## We have been doing this for ten years.');
    });

    test('omits blocks without text', () => {
        const md = pageToMarkdown(page({ blocks: [{ type: 'Spacer', data: { height: 40 } }] }));

        expect(md).not.toContain('40');
    });

    test('a null page produces an empty string', () => {
        expect(pageToMarkdown(null)).toBe('');
    });
});
