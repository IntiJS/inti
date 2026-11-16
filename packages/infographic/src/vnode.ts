/**
 * One tree, two outputs. Satori turns it into an image; `toHtml` turns it into
 * markup for the page. Same layout, same numbers, so the image shared on Instagram
 * and the figure in the blog post never disagree.
 */

export type Child = VNode | string | null | undefined | false;

export interface VNode {
    type: string;
    props: Record<string, unknown> & { children?: Child | Child[]; style?: Style };
}

export type Style = Record<string, string | number | undefined>;

/**
 * Props only the web output keeps. Satori ignores what it does not know, but these are
 * stripped anyway so an image never depends on that.
 */
export const WEB_ONLY = new Set(['as', 'field', 'title', 'role', 'aria-label', 'aria-hidden']);

export function h(type: string, props: Record<string, unknown> | null, ...children: (Child | Child[])[]): VNode {
    const flat = children.flat().filter((child): child is VNode | string => child !== null && child !== undefined && child !== false && child !== '');
    const style = (props?.style ?? {}) as Style;
    const isSvg = SVG_TAGS.has(type);
    return {
        type,
        props: {
            ...props,
            // Satori lays out every element as flex and needs it said whenever there is more than one child
            // Widths include padding and border, as on the web with the reset in html.ts
            ...(isSvg ? {} : { style: { display: 'flex', boxSizing: 'border-box', ...style } }),
            children: flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat
        }
    };
}

export const SVG_TAGS = new Set(['svg', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'g', 'title', 'defs', 'linearGradient', 'stop']);

export function childrenOf(node: VNode): (VNode | string)[] {
    const { children } = node.props;
    if (children === undefined || children === null || children === false) return [];
    return (Array.isArray(children) ? children : [children]).filter((c): c is VNode | string => typeof c === 'string' || (typeof c === 'object' && c !== null));
}

/** The tree Satori gets: web-only props and elements removed */
export function forImage(node: VNode): VNode {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.props)) {
        if (key === 'children' || WEB_ONLY.has(key) || key.startsWith('data-')) continue;
        props[key] = value;
    }
    const kids = childrenOf(node)
        .filter((child) => typeof child === 'string' || child.type !== 'title')
        .map((child) => (typeof child === 'string' ? child : forImage(child)));
    props.children = kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids;
    return { type: node.type, props };
}

/** Plain text of a subtree, for alt text and accessible labels */
export function textOf(node: Child): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.type === 'title' || node.type === 'svg') return '';
    return childrenOf(node).map(textOf).filter(Boolean).join(' ');
}
