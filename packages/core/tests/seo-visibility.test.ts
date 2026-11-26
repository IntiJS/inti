import { describe, test, expect } from 'bun:test';
import { buildStructuredData, faqFromBlock } from '../src/seo/structured-data.js';
import { pageToMarkdown } from '../src/seo/llms.js';
import type { IntiPage } from '../src/types/index.js';

/**
 * A hidden or scheduled block never reaches the structured data or llms.txt
 * (AGENTS.md, Scheduled visibility). Until a 2026-11 audit only BlockRenderer
 * filtered: the JSON-LD and markdown builders read every block, so an FAQ
 * scheduled for next month was already in the page head.
 */

const faq = (question: string) => [{ question, answer: `${question} answer` }];

const page: IntiPage = {
    id: 'faq',
    slug: 'faq',
    title: 'FAQ',
    blocks: [
        { type: 'FaqSection', data: { heading: 'Public', items: faq('Public question?') }, meta: { index: 0 } },
        { type: 'FaqSection', data: { heading: 'Hidden', items: faq('Hidden question?') }, meta: { index: 1, visible: false } },
        { type: 'FaqSection', data: { heading: 'Scheduled', items: faq('Scheduled question?') }, meta: { index: 2, visibleFrom: '2999-01-01T00:00:00Z' } },
        { type: 'FaqSection', data: { heading: 'Expired', items: faq('Expired question?') }, meta: { index: 3, visibleUntil: '2000-01-01T00:00:00Z' } }
    ]
} as IntiPage;

describe('builders honour block visibility', () => {
    test('JSON-LD only describes visible blocks', () => {
        const graph = JSON.stringify(
            buildStructuredData(page, { url: 'https://example.test/faq', blockSchemas: { FaqSection: faqFromBlock('items') } })
        );
        expect(graph).toContain('Public question?');
        expect(graph).not.toContain('Hidden question?');
        expect(graph).not.toContain('Scheduled question?');
        expect(graph).not.toContain('Expired question?');
    });

    test('markdown only contains visible blocks', () => {
        const markdown = pageToMarkdown(page);
        expect(markdown).toContain('Public');
        expect(markdown).not.toContain('Hidden');
        expect(markdown).not.toContain('Scheduled');
        expect(markdown).not.toContain('Expired');
    });
});
