/**
 * Pages. A web figure is one tall page; an image is a fixed canvas, so whatever does
 * not fit continues on the next image of the carousel.
 *
 * Fitting is measured, not guessed: each row is laid out with the real fonts and
 * its height read back. A long table or bar chart is split by rows, keeping one
 * scale across the pieces so a bar on image 2 is comparable with one on image 1.
 */

import type { Infographic, Section } from './data.js';
import { contentBox, type InfographicFormat } from './formats.js';
import { defaultSpan, renderSection, sliceSection, splitSize, text, type Ctx } from './sections.js';
import type { InfographicTheme } from './themes.js';
import { childrenOf, h, type Child, type VNode } from './vnode.js';

export type Measure = (node: VNode, width: number) => Promise<number>;

export interface Page {
    rows: Section[][];
}

export interface LayoutOptions {
    theme: InfographicTheme;
    format: InfographicFormat;
    /** Only `data:` URIs and URLs from these origins are drawn. Anything else is left out */
    imageOrigins?: string[];
}

const SOURCE: Record<string, string> = { es: 'Fuente', en: 'Source', pt: 'Fonte', fr: 'Source', de: 'Quelle', it: 'Fonte' };

export function createCtx(info: Infographic, options: LayoutOptions, mode: 'image' | 'web'): Ctx {
    const { format, theme } = options;
    return { theme, t: format.type, format, locale: info.locale, s: format.width / (format.columns === 2 ? 1500 : 1080), mode };
}

/** A logo is fetched by the renderer: only from where the developer said */
export function allowedImage(src: string | undefined, origins: string[] = []): string | undefined {
    if (!src) return undefined;
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) return src;
    try {
        const url = new URL(src);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
        return origins.some((origin) => new URL(origin).origin === url.origin) ? url.href : undefined;
    } catch {
        return undefined;
    }
}

function header(info: Infographic, ctx: Ctx, options: LayoutOptions, compact: boolean): VNode {
    const { t, theme } = ctx;
    const logo = allowedImage(info.logo, options.imageOrigins);
    const brandSize = Math.round(t.body * 1.5);

    if (compact) {
        return h(
            'div',
            { style: { flexDirection: 'column', gap: Math.round(t.gap * 0.15) } },
            text(info.eyebrow, { fontSize: t.eyebrow, fontWeight: 700, color: theme.accent, letterSpacing: 2, textTransform: 'uppercase' }),
            text(info.title, { fontSize: Math.round(t.heading * 1.1), fontWeight: 800, color: theme.text, lineHeight: 1.15 })
        );
    }

    return h(
        'div',
        { as: 'header', style: { flexDirection: 'column', gap: Math.round(t.gap * 0.35) } },
        logo || info.brand
            ? h(
                  'div',
                  { style: { alignItems: 'center', gap: Math.round(t.small * 0.6), marginBottom: Math.round(t.gap * 0.2) } },
                  logo ? h('img', { src: logo, height: brandSize, style: { height: brandSize, objectFit: 'contain' } }) : null,
                  text(info.brand, { fontSize: t.label, fontWeight: 800, color: theme.text, letterSpacing: 0.5 })
              )
            : null,
        h('div', { style: { width: Math.round(t.title * 1.1), height: Math.max(6, Math.round(t.gap * 0.22)), backgroundColor: theme.accent, borderRadius: 8 } }),
        text(info.eyebrow, { fontSize: t.eyebrow, fontWeight: 700, color: theme.accent, letterSpacing: 2, textTransform: 'uppercase', marginTop: Math.round(t.gap * 0.15) }),
        text(info.title, { fontSize: t.title, fontWeight: 800, color: theme.text, lineHeight: 1.08, letterSpacing: -1 }, 'h2'),
        text(info.subtitle, { fontSize: t.subtitle, color: theme.textSecondary, lineHeight: 1.35 }, 'p')
    );
}

function footer(info: Infographic, ctx: Ctx, page?: { index: number; total: number }): VNode | null {
    const { t, theme } = ctx;
    const source = info.source ? { ...info.source, text: `${SOURCE[info.locale.slice(0, 2)] ?? SOURCE.en}: ${info.source.text}` } : undefined;
    const counter = page && page.total > 1 ? `${page.index + 1} / ${page.total}` : null;
    if (!source && !info.date && !info.footnote && !counter) return null;
    return h(
        'div',
        { as: 'footer', style: { flexDirection: 'column', gap: Math.round(t.gap * 0.2) } },
        text(info.footnote, { fontSize: t.small, color: theme.muted, lineHeight: 1.35 }),
        h(
            'div',
            { style: { justifyContent: 'space-between', alignItems: 'flex-end', gap: t.gap } },
            h(
                'div',
                { style: { gap: Math.round(t.small * 0.5), flexWrap: 'wrap', flexShrink: 1 } },
                text(source, { fontSize: t.small, color: theme.textSecondary, lineHeight: 1.3 }),
                source && info.date ? h('div', { style: { fontSize: t.small, color: theme.muted } }, '·') : null,
                text(info.date, { fontSize: t.small, color: theme.textSecondary, lineHeight: 1.3 })
            ),
            counter ? h('div', { style: { fontSize: t.small, fontWeight: 700, color: theme.textSecondary, flexShrink: 0 } }, counter) : null
        )
    );
}

function row(sections: Section[], ctx: Ctx, width: number): VNode {
    if (sections.length === 1) return renderSection(sections[0], ctx, width);
    const half = Math.floor((width - ctx.t.gap) / 2);
    return h('div', { style: { gap: ctx.t.gap, alignItems: 'stretch' } }, ...sections.map((section) => renderSection(section, ctx, half)));
}

/** Rows: on two-column canvases, consecutive half-width sections share one */
export function toRows(sections: Section[], format: InfographicFormat): Section[][] {
    if (format.columns === 1) return sections.map((section) => [section]);
    const rows: Section[][] = [];
    let pending: Section | null = null;
    for (const section of sections) {
        if (defaultSpan(section) === 'full') {
            if (pending) rows.push([pending]);
            pending = null;
            rows.push([section]);
        } else if (pending) {
            rows.push([pending, section]);
            pending = null;
        } else pending = section;
    }
    if (pending) rows.push([pending]);
    return rows;
}

function rootStyle(ctx: Ctx, image: boolean): Record<string, string | number> {
    const { format, theme } = ctx;
    const box = contentBox(format);
    return {
        flexDirection: 'column',
        width: format.width,
        ...(image ? { height: format.height } : {}),
        backgroundColor: theme.background,
        color: theme.text,
        fontFamily: ctx.mode === 'web' ? theme.fontStack : theme.fontFamily,
        lineHeight: 1.3,
        paddingTop: box.y,
        paddingLeft: box.x,
        paddingRight: format.width - box.x - box.width,
        paddingBottom: image ? format.height - box.y - box.height : format.padding
    };
}

/** The whole infographic as one tall figure, for the page */
export function buildWeb(info: Infographic, options: LayoutOptions): VNode {
    const ctx = createCtx(info, options, 'web');
    const { width } = contentBox(options.format);
    const rows = toRows(info.sections, options.format);
    return h(
        'div',
        { style: { ...rootStyle(ctx, false), gap: ctx.t.gap } },
        header(info, ctx, options, false),
        h('div', { style: { flexDirection: 'column', gap: ctx.t.gap } }, ...rows.map((r) => row(r, ctx, width))),
        footer(info, ctx)
    );
}

function pageNode(info: Infographic, ctx: Ctx, options: LayoutOptions, rows: Section[][], index: number, total: number): VNode {
    const { width } = contentBox(options.format);
    return h(
        'div',
        { style: { ...rootStyle(ctx, true), gap: ctx.t.gap } },
        header(info, ctx, options, index > 0),
        // Centred between header and footer: a half-full image looks deliberate, not unfinished
        h('div', { style: { flexDirection: 'column', justifyContent: 'center', gap: ctx.t.gap, flexGrow: 1, flexShrink: 1, overflow: 'hidden' } }, ...rows.map((r) => row(r, ctx, width))),
        footer(info, ctx, { index, total })
    );
}

export interface PaginateResult {
    pages: Page[];
    warnings: string[];
}

/** Splits the sections into images that each fit the canvas */
export async function paginate(info: Infographic, options: LayoutOptions, measure: Measure): Promise<PaginateResult> {
    const ctx = createCtx(info, options, 'image');
    const { format } = options;
    const { width, height } = contentBox(format);
    const warnings: string[] = [];
    const gap = ctx.t.gap;

    // The footer carries "n / total": measure it with a two-digit counter so it never grows later
    const footerNode = footer(info, ctx, { index: 9, total: 10 });
    const footerHeight = footerNode ? (await measure(footerNode, width)) + gap : 0;
    const firstHeader = (await measure(header(info, ctx, options, false), width)) + gap;
    const nextHeader = (await measure(header(info, ctx, options, true), width)) + gap;
    const room = (first: boolean) => height - (first ? firstHeader : nextHeader) - footerHeight;

    const heightOf = async (rowSections: Section[]) => measure(row(rowSections, ctx, width), width);

    const pages: Page[] = [];
    let current: Section[][] = [];
    let used = 0;
    const left = () => room(pages.length === 0) - used - (current.length ? gap : 0);
    const close = () => {
        pages.push({ rows: current });
        current = [];
        used = 0;
    };
    const place = (r: Section[], h: number) => {
        used += (current.length ? gap : 0) + h;
        current.push(r);
    };

    const queue = toRows(info.sections, format);
    while (queue.length) {
        const next = queue.shift()!;
        const rowHeight = await heightOf(next);
        if (rowHeight <= left()) {
            place(next, rowHeight);
            continue;
        }
        // Fits on an image of its own: start the next one rather than cut a short chart in two
        if (rowHeight <= room(false) && current.length) {
            close();
            place(next, rowHeight);
            continue;
        }
        // Two sections side by side, too tall even for an empty image: one under the other
        if (next.length === 2) {
            queue.unshift([next[0]], [next[1]]);
            continue;
        }

        // Taller than a whole image: a long table or list continues on the next one
        const section = next[0];
        const size = splitSize(section);
        if (size > 1) {
            // Use what is left of this image only when a fair share of the rows fits there
            const fit = await largestFit(section, size, left(), heightOf);
            if (current.length && fit < Math.max(2, Math.ceil(size * 0.25))) {
                close();
                queue.unshift(next);
                continue;
            }
            if (fit >= 1) {
                const head = sliceSection(section, 0, fit);
                place([head], await heightOf([head]));
                queue.unshift([sliceSection(section, fit, size)]);
                close();
                continue;
            }
        }
        if (current.length) {
            close();
            queue.unshift(next);
            continue;
        }

        // Taller than a whole image and cannot be split: drawn anyway, clipped at the bottom
        warnings.push(`Section ${section.index} (${section.kind}) is taller than one ${format.id} image and is cut off.`);
        place(next, rowHeight);
        close();
    }
    if (current.length || pages.length === 0) close();

    if (pages.length > format.maxSlides) {
        warnings.push(`${pages.length} images needed but ${format.id} takes ${format.maxSlides}: the last ${pages.length - format.maxSlides} were dropped.`);
        pages.length = format.maxSlides;
    }
    return { pages, warnings };
}

/** The most rows of a section that fit in `room` */
async function largestFit(section: Section, size: number, room: number, heightOf: (rows: Section[]) => Promise<number>): Promise<number> {
    let lo = 0;
    let hi = size;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if ((await heightOf([sliceSection(section, 0, mid)])) <= room) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

export function buildPage(info: Infographic, options: LayoutOptions, pages: Page[], index: number): VNode {
    const ctx = createCtx(info, options, 'image');
    return pageNode(info, ctx, options, pages[index].rows, index, pages.length);
}

/** What an image says, in words: for alt text on Instagram, TikTok or an <img> */
export function altText(node: Child, limit = 1000): string {
    const parts: string[] = [];
    const walk = (child: Child) => {
        if (!child) return;
        if (typeof child === 'string') {
            parts.push(child);
            return;
        }
        if (child.type === 'svg') return;
        const label = child.props['aria-label'];
        if (typeof label === 'string') {
            parts.push(label);
            return;
        }
        childrenOf(child).forEach(walk);
    };
    walk(node);
    const joined = parts
        .map((part) => part.trim())
        .filter(Boolean)
        .join('. ')
        .replace(/\.\s*\./g, '.')
        .replace(/:\./g, ':');
    return joined.length > limit ? `${joined.slice(0, limit - 1).trimEnd()}…` : joined;
}
