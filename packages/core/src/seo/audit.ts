/**
 * SEO audit over the block structure.
 *
 * A plugin like Yoast analyzes already rendered HTML, after the fact.
 * Here the blocks are still typed data, so the exact block and field can
 * be pointed out —and shown above the block while it is being edited—
 * instead of giving a diagnosis about a whole page.
 *
 * Only what can be known for certain from the data is checked.
 * Guessing produces false positives, and a warning that gets ignored is useless.
 */

import type { IntiBlock, IntiPage } from '../types/index.js';

export type AuditLevel = 'error' | 'warning' | 'info';

export interface AuditFinding {
    level: AuditLevel;
    /** Stable identifier, to silence specific rules */
    code: string;
    message: string;
    /** Affected block, if any */
    blockIndex?: number;
    blockType?: string;
    /** Field inside the block, as a dot-path */
    field?: string;
}

export interface AuditOptions {
    /**
     * Heading level each block type renders.
     * Without this, hierarchies cannot be checked: the core does not know
     * what markup a component produces.
     */
    headings?: Record<string, number>;
    /** Rules to ignore, by code */
    ignore?: string[];
    /** Recommended meta description length */
    descriptionLength?: { min: number; max: number };
    /** Recommended title length */
    titleLength?: { min: number; max: number };
    /**
     * `false` skips the title, description and social image checks.
     * That is what fits when the full page is not available: an unknown
     * title is not a missing title, and reporting it as an error teaches
     * people to ignore the audit.
     */
    metadata?: boolean;
}

const DEFAULT_DESCRIPTION = { min: 70, max: 160 };
const DEFAULT_TITLE = { min: 15, max: 60 };

/** Detects image-shaped values inside a block's data */
function findImages(data: Record<string, any>, prefix = ''): Array<{ path: string; value: any }> {
    const found: Array<{ path: string; value: any }> = [];
    if (!data || typeof data !== 'object') return found;

    for (const [key, value] of Object.entries(data)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (!value || typeof value !== 'object') continue;

        if (Array.isArray(value)) {
            value.forEach((entry, i) => found.push(...findImages(entry, `${path}.${i}`)));
            continue;
        }

        // It counts as an image if it has url/src and looks like media
        const hasUrl = typeof value.url === 'string' || typeof value.src === 'string';
        const looksLikeMedia = hasUrl && ('alt' in value || 'width' in value || 'mimeType' in value || 'height' in value);

        if (looksLikeMedia) {
            found.push({ path, value });
        } else {
            found.push(...findImages(value, path));
        }
    }

    return found;
}

function auditImages(block: IntiBlock, index: number): AuditFinding[] {
    return findImages(block.data ?? {})
        .filter(({ value }) => {
            const alt = value.alt ?? value.alternativeText;
            return typeof alt !== 'string' || alt.trim() === '';
        })
        .map(({ path }) => ({
            level: 'warning' as const,
            code: 'image-missing-alt',
            message: `Image without alternative text. Add alt in the CMS, or alt="" if it is decorative.`,
            blockIndex: index,
            blockType: block.type,
            field: path
        }));
}

/** Checks for a single H1 and that no levels are skipped */
function auditHeadings(blocks: IntiBlock[], headings: Record<string, number>): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const levels: Array<{ level: number; index: number; type: string }> = [];

    blocks.forEach((block, index) => {
        const level = headings[block.type];
        if (typeof level === 'number') levels.push({ level, index, type: block.type });
    });

    if (levels.length === 0) return findings;

    const h1s = levels.filter((l) => l.level === 1);

    if (h1s.length === 0) {
        findings.push({
            level: 'error',
            code: 'heading-missing-h1',
            message: 'The page has no H1.'
        });
    } else if (h1s.length > 1) {
        // The second one onwards is the problem; the first is legitimate
        for (const extra of h1s.slice(1)) {
            findings.push({
                level: 'warning',
                code: 'heading-duplicate-h1',
                message: `Duplicate H1: the page already has one in block ${h1s[0].index}.`,
                blockIndex: extra.index,
                blockType: extra.type
            });
        }
    }

    // Level jumps: going from H2 to H4 breaks the hierarchy that screen
    // readers and crawlers read
    for (let i = 1; i < levels.length; i++) {
        const previous = levels[i - 1];
        const current = levels[i];

        if (current.level - previous.level > 1) {
            findings.push({
                level: 'warning',
                code: 'heading-skipped-level',
                message: `Jump from H${previous.level} to H${current.level}: do not skip levels.`,
                blockIndex: current.index,
                blockType: current.type
            });
        }
    }

    return findings;
}

function auditMetadata(page: Partial<IntiPage>, options: AuditOptions): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const seo = page.seo ?? {};

    const title = seo.title ?? page.title;
    const titleRange = options.titleLength ?? DEFAULT_TITLE;
    const descriptionRange = options.descriptionLength ?? DEFAULT_DESCRIPTION;

    if (!title) {
        findings.push({ level: 'error', code: 'meta-missing-title', message: 'The page has no title.' });
    } else if (title.length > titleRange.max) {
        findings.push({
            level: 'info',
            code: 'meta-title-long',
            message: `Title of ${title.length} characters: Google usually cuts it at about ${titleRange.max}.`
        });
    } else if (title.length < titleRange.min) {
        findings.push({
            level: 'info',
            code: 'meta-title-short',
            message: `Title of ${title.length} characters: below ${titleRange.min} it gives little context.`
        });
    }

    if (!seo.description) {
        findings.push({
            level: 'warning',
            code: 'meta-missing-description',
            message: 'No meta description: the search engine will improvise the snippet.'
        });
    } else if (seo.description.length > descriptionRange.max) {
        findings.push({
            level: 'info',
            code: 'meta-description-long',
            message: `Description of ${seo.description.length} characters: it is cut at about ${descriptionRange.max}.`
        });
    }

    if (!seo.image) {
        findings.push({
            level: 'info',
            code: 'meta-missing-image',
            message: 'No social image: it will show no preview when shared.'
        });
    }

    if (seo.robots?.index === false) {
        findings.push({
            level: 'info',
            code: 'meta-noindex',
            message: 'This page is marked as noindex in the CMS.'
        });
    }

    return findings;
}

/**
 * Audits a full page.
 *
 * Pure function: it is used both by the server render and by the editor
 * overlay, so the editor sees exactly the same as the build.
 */
export function auditPage(page: Partial<IntiPage> | null | undefined, options: AuditOptions = {}): AuditFinding[] {
    if (!page) return [];

    const blocks = page.blocks ?? [];
    const findings: AuditFinding[] = [
        ...(options.metadata === false ? [] : auditMetadata(page, options)),
        ...(options.headings ? auditHeadings(blocks, options.headings) : []),
        ...blocks.flatMap((block, index) => auditImages(block, index))
    ];

    const ignore = new Set(options.ignore ?? []);
    return findings.filter((f) => !ignore.has(f.code));
}

/** Audits a single block. The overlay uses it to render over each block */
export function auditBlock(block: IntiBlock, index = 0, options: AuditOptions = {}): AuditFinding[] {
    const ignore = new Set(options.ignore ?? []);
    return auditImages(block, index).filter((f) => !ignore.has(f.code));
}

/** Readable summary for the console or CI */
export function formatAudit(findings: AuditFinding[]): string {
    if (findings.length === 0) return 'SEO: no findings.';

    const icon = { error: '✕', warning: '!', info: 'i' } as const;

    return findings
        .map((f) => {
            const where =
                f.blockIndex !== undefined
                    ? ` [block ${f.blockIndex}${f.blockType ? ` ${f.blockType}` : ''}${f.field ? `.${f.field}` : ''}]`
                    : '';
            return `  ${icon[f.level]} ${f.message}${where}`;
        })
        .join('\n');
}

/** Is there anything that should break the build? */
export function hasErrors(findings: AuditFinding[]): boolean {
    return findings.some((f) => f.level === 'error');
}
