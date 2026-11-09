/**
 * `llms.txt` for the client's site.
 *
 * It is a Markdown index meant to let a model understand what the site is
 * about without crawling all of it. Inti can generate it well because the
 * blocks are already self-contained content units —exactly what these
 * formats ask for— instead of an HTML blob that has to be chopped up.
 */

import type { PageSummary } from '../adapters/index.js';
import type { IntiPage } from '../types/index.js';

export interface LlmsTxtSection {
    /** Section title, e.g. 'Docs' */
    title: string;
    entries: Array<{ title: string; url: string; description?: string }>;
}

export interface LlmsTxtOptions {
    /** Site name: the document heading */
    siteName: string;
    /** One-line summary of what the site is */
    summary?: string;
    /** Context paragraphs after the summary */
    details?: string[];
    /** Origin used to make paths absolute */
    site: string;
    /** Path from the slug */
    pathFor?: (page: PageSummary) => string;
    /** Title of the section with the pages (default: 'Pages') */
    sectionTitle?: string;
    /** Additional sections, already built */
    sections?: LlmsTxtSection[];
    /** Excludes pages from the index */
    filter?: (page: PageSummary) => boolean;
}

function joinUrl(site: string, path: string): string {
    const origin = site.replace(/\/+$/, '');
    if (!path || path === '/') return origin + '/';
    return origin + (path.startsWith('/') ? path : `/${path}`);
}

/**
 * Generates the content of `llms.txt`.
 *
 * It follows the proposal's format: a `#` with the name, a `>` with the
 * summary, and `##` sections with lists of links.
 */
export function buildLlmsTxt(pages: PageSummary[], options: LlmsTxtOptions): string {
    const pathFor = options.pathFor ?? ((page: PageSummary) => (page.slug === 'home' ? '/' : `/${page.slug}`));

    const lines: string[] = [`# ${options.siteName}`];

    if (options.summary) lines.push('', `> ${options.summary}`);
    if (options.details?.length) lines.push('', ...options.details);

    const entries = pages
        .filter((page) => !!page?.slug && (options.filter?.(page) ?? true))
        .map((page) => ({
            title: page.title || page.slug,
            url: joinUrl(options.site, pathFor(page))
        }));

    if (entries.length > 0) {
        lines.push('', `## ${options.sectionTitle ?? 'Pages'}`, '');
        for (const entry of entries) {
            lines.push(`- [${entry.title}](${entry.url})`);
        }
    }

    for (const section of options.sections ?? []) {
        if (section.entries.length === 0) continue;

        lines.push('', `## ${section.title}`, '');
        for (const entry of section.entries) {
            const suffix = entry.description ? `: ${entry.description}` : '';
            lines.push(`- [${entry.title}](${entry.url})${suffix}`);
        }
    }

    return lines.join('\n') + '\n';
}

/**
 * Dumps a page as Markdown, one block per section.
 *
 * Useful to expose `/something.md` next to `/something`: AI crawlers do not
 * run JavaScript and appreciate text without markup. Each block becomes an
 * independent section, which is how these systems chunk content.
 */
export function pageToMarkdown(
    page: Partial<IntiPage> | null | undefined,
    options: { textFields?: string[] } = {}
): string {
    if (!page) return '';

    const lines: string[] = [];
    if (page.title) lines.push(`# ${page.title}`, '');
    if (page.seo?.description) lines.push(`> ${page.seo.description}`, '');

    // Fields that usually hold a block's visible text
    const candidates = options.textFields ?? [
        'heading',
        'title',
        'subheading',
        'subtitle',
        'body',
        'text',
        'content',
        'description'
    ];

    for (const block of page.blocks ?? []) {
        const data = block.data ?? {};
        const chunk: string[] = [];

        for (const field of candidates) {
            const value = data[field];
            if (typeof value === 'string' && value.trim()) chunk.push(value.trim());
        }

        if (chunk.length === 0) continue;

        // The first field acts as the section heading
        lines.push(`## ${chunk[0]}`, '');
        if (chunk.length > 1) lines.push(chunk.slice(1).join('\n\n'), '');
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
