/**
 * The tree as HTML for the page. Every length is converted to container units
 * (`cqw`), so the figure keeps the exact proportions of the image at any width
 * without a single media query, and the text stays text: selectable, translatable,
 * indexable, editable with a double click.
 */

import { childrenOf, SVG_TAGS, type VNode } from './vnode.js';

const UNITLESS = new Set(['fontWeight', 'lineHeight', 'flexGrow', 'flexShrink', 'opacity', 'zIndex', 'order']);
const VOID = new Set(['img']);

export function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function length(value: number, base: number): string {
    if (value === 0) return '0';
    return `${Number(((value / base) * 100).toFixed(4))}cqw`;
}

function styleToCss(style: Record<string, unknown>, base: number, textOnly: boolean): string {
    const rules: string[] = [];
    for (const [key, raw] of Object.entries(style)) {
        if (raw === undefined || raw === null || raw === '') continue;
        let value: string;
        if (key === 'display' && raw === 'flex' && textOnly) value = 'block';
        else if (key === 'justifyContent' && textOnly) {
            // A text-only box is a block on the web: centre its text instead of its flex item
            if (raw === 'center' || raw === 'flex-end') rules.push(`text-align:${raw === 'center' ? 'center' : 'right'}`);
            continue;
        }
        else if (typeof raw === 'number') value = UNITLESS.has(key) ? String(raw) : length(raw, base);
        else value = String(raw).replace(/(-?\d*\.?\d+)px/g, (_, n) => length(Number(n), base));
        // Letter spacing is in px in the tree; scale it like everything else
        rules.push(`${kebab(key)}:${value}`);
    }
    return rules.join(';');
}

function attrs(node: VNode, base: number, inSvg: boolean): string {
    const out: string[] = [];
    const kids = childrenOf(node);
    const textOnly = kids.length > 0 && kids.every((child) => typeof child === 'string');
    for (const [key, value] of Object.entries(node.props)) {
        if (key === 'children' || key === 'as' || value === undefined || value === null || value === false) continue;
        if (key === 'style') {
            const css = styleToCss(value as Record<string, unknown>, base, textOnly);
            if (css) out.push(`style="${escapeHtml(css)}"`);
            continue;
        }
        if (key === 'field') {
            out.push(`data-inti-field="${escapeHtml(String(value))}"`);
            continue;
        }
        // The root <svg> scales with the figure; its viewBox keeps the drawing exact
        if (node.type === 'svg' && !inSvg && (key === 'width' || key === 'height')) continue;
        if (node.type === 'img' && key === 'height') continue;
        out.push(`${key}="${escapeHtml(String(value))}"`);
    }
    if (node.type === 'svg' && !inSvg) {
        const w = Number(node.props.width);
        const h = Number(node.props.height);
        const style = (node.props.style ?? {}) as Record<string, unknown>;
        const extra = `width:${length(w, base)};height:${length(h, base)};display:block;flex-shrink:0;overflow:visible`;
        const existing = out.findIndex((attr) => attr.startsWith('style='));
        const css = `${styleToCss(style, base, false)};${extra}`;
        if (existing >= 0) out[existing] = `style="${escapeHtml(css)}"`;
        else out.push(`style="${escapeHtml(extra)}"`);
    }
    return out.length ? ` ${out.join(' ')}` : '';
}

function render(node: VNode | string, base: number, inSvg: boolean): string {
    if (typeof node === 'string') return escapeHtml(node);
    const svg = inSvg || node.type === 'svg';
    const tag = !svg && typeof node.props.as === 'string' ? node.props.as : node.type;
    const open = `<${tag}${attrs(node, base, inSvg)}`;
    if (VOID.has(tag)) return `${open}>`;
    const kids = childrenOf(node).map((child) => render(child, base, svg)).join('');
    if (SVG_TAGS.has(tag) && !kids) return `${open}/>`;
    return `${open}>${kids}</${tag}>`;
}

const RESET = [
    '.inti-infographic{container-type:inline-size;width:100%;margin:0}',
    '.inti-infographic *{box-sizing:border-box;margin:0;padding:0;min-width:0}',
    '.inti-infographic ol,.inti-infographic ul{list-style:none}',
    '.inti-infographic table,.inti-infographic tr,.inti-infographic th,.inti-infographic td{border-collapse:collapse;text-align:inherit}',
    '.inti-infographic img{max-width:none}'
].join('');

export interface HtmlOptions {
    /** Accessible name of the figure. Default: the infographic's title */
    label?: string;
    /** Extra class on the <figure> */
    className?: string;
    /** Width of the canvas the tree was built for */
    width: number;
}

/**
 * `<figure>` with the infographic. Inline styles only, so it renders the same in any
 * site; the few reset rules are scoped to `.inti-infographic`.
 */
export function toHtml(node: VNode, options: HtmlOptions): string {
    // Padding was reset above; the root's own padding comes back through its inline style
    const body = render(node, options.width, false);
    const label = options.label ? ` aria-label="${escapeHtml(options.label)}"` : '';
    const className = options.className ? ` ${escapeHtml(options.className)}` : '';
    return `<figure class="inti-infographic${className}"${label}><style>${RESET}</style>${body}</figure>`;
}
