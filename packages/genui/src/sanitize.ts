/**
 * Content validation: what fits in a `string` is not always harmless.
 *
 * The schema guarantees the shape, not the content. A `javascript:` is a valid
 * string, and a block that prints a field with `set:html` would run whatever it carries.
 */

const DEFAULT_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];

/** A value that would be used as a link and would run something */
const DANGEROUS = /^(javascript|vbscript|data):/i;

/** Without the characters the browser ignores inside a scheme (`java\tscript:`) */
const compact = (value: string): string => value.replace(/[\u0000- \u007f-\u009f]/g, '');

export function isDangerousText(value: string): boolean {
    return DANGEROUS.test(compact(value));
}

/** The link if it is safe, or null */
export function safeUrl(value: unknown, schemes?: string[]): string | null {
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    const normalized = compact(trimmed);
    if (!normalized) return null;

    // Relative path, anchor or query. `//` and `/\` go to another domain
    if (/^[/#?]/.test(normalized) && !/^\/[/\\]/.test(normalized)) return trimmed;

    const allowed = (schemes ?? DEFAULT_SCHEMES).map((scheme) => (scheme.endsWith(':') ? scheme : `${scheme}:`).toLowerCase());
    try {
        return allowed.includes(new URL(normalized).protocol) ? trimmed : null;
    } catch {
        return null;
    }
}

const ALLOWED_TAGS = new Set([
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'h2', 'h3', 'h4', 'a'
]);
const VOID_TAGS = new Set(['br']);
/** Their content is not text either: it is dropped entirely */
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|svg|math|template|noscript)\b[\s\S]*?(<\/\1\s*>|$)/gi;

const escapeHtml = (text: string): string =>
    text
        .replace(/&(?!(?:[a-z][a-z0-9]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/**
 * Rebuilds the HTML instead of filtering it: what comes out is only allowed tags
 * written here and escaped text, with no attribute from the input except a
 * validated `href`. Whatever is not recognized cannot slip through.
 */
export function sanitizeRichText(input: string): string {
    const source = input.replace(DROP_WITH_CONTENT, '').replace(/<!--[\s\S]*?(-->|$)/g, '');
    const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

    let output = '';
    let position = 0;
    const open: string[] = [];

    for (let match = tag.exec(source); match; match = tag.exec(source)) {
        output += escapeHtml(source.slice(position, match.index));
        position = match.index + match[0].length;

        const name = match[2].toLowerCase();
        if (!ALLOWED_TAGS.has(name)) continue;

        if (match[1]) {
            const at = open.lastIndexOf(name);
            if (at >= 0) {
                while (open.length > at) output += `</${open.pop()}>`;
            }
            continue;
        }

        if (VOID_TAGS.has(name)) {
            output += `<${name}>`;
            continue;
        }

        if (name === 'a') {
            const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[3]);
            const url = safeUrl(href?.[1] ?? href?.[2] ?? href?.[3]);
            if (!url) continue;
            output += `<a href="${escapeHtml(url)}" rel="noopener nofollow">`;
        } else {
            output += `<${name}>`;
        }
        open.push(name);
    }

    output += escapeHtml(source.slice(position));
    while (open.length > 0) output += `</${open.pop()}>`;
    return output;
}
