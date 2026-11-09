/**
 * Gutenberg - Parser and serializer for the WordPress block format
 *
 * WordPress stores Gutenberg blocks as HTML delimited by
 * comments: <!-- wp:paragraph {"attr":1} -->...<!-- /wp:paragraph -->
 *
 * This module is deliberately conservative:
 * - It only parses TOP-LEVEL blocks (nested ones stay inside
 *   their parent's innerHTML, untouched)
 * - It preserves the content of unedited blocks byte for byte
 * - It only allows editing text in "simple" blocks (a single tag,
 *   no children), and rejects the rest with a clear error instead of
 *   risking corrupting the post
 *
 * IMPORTANT: block comments only exist in `content.raw`
 * (requires auth + context=edit). The public `content.rendered` does NOT
 * contain them.
 */

// ============================================
// Types
// ============================================

export interface GutenbergBlock {
    /** Full block name (e.g. 'core/paragraph', 'acme/team') */
    name: string;
    /** JSON attributes of the opening comment (if any) */
    attrs: Record<string, any>;
    /** Inner HTML between the opening and closing comments */
    innerHTML: string;
    /** Literal opening comment (exact preservation) */
    openComment: string;
    /** Literal closing comment ('' on self-closing blocks) */
    closeComment: string;
    /** Full raw content of the block (for a lossless round-trip) */
    raw: string;
}

// Block comment token: opening, closing or self-closing
const BLOCK_COMMENT = /<!--\s*(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)((?:\s+\{[\s\S]*?\})?)\s*(\/)?-->/g;

// ============================================
// Parser
// ============================================

/**
 * Parses the top-level blocks of a WordPress `content.raw`.
 * Content outside blocks (freeform) is ignored for editing but
 * preserved through the block indexes.
 */
export function parseGutenberg(content: string): GutenbergBlock[] {
    const blocks: GutenbergBlock[] = [];
    BLOCK_COMMENT.lastIndex = 0;

    let match: RegExpExecArray | null;
    let depth = 0;
    let current: { name: string; attrs: Record<string, any>; openComment: string; start: number; innerStart: number } | null = null;

    while ((match = BLOCK_COMMENT.exec(content)) !== null) {
        const [full, closer, namespace, shortName, attrsJson, selfClosing] = match;
        const name = `${namespace || 'core/'}${shortName}`;

        if (!closer && selfClosing) {
            // Self-closing block (e.g. <!-- wp:spacer /-->)
            if (depth === 0) {
                blocks.push({
                    name,
                    attrs: parseAttrs(attrsJson),
                    innerHTML: '',
                    openComment: full,
                    closeComment: '',
                    raw: full
                });
            }
            continue;
        }

        if (!closer) {
            // Opening
            if (depth === 0) {
                current = {
                    name,
                    attrs: parseAttrs(attrsJson),
                    openComment: full,
                    start: match.index,
                    innerStart: match.index + full.length
                };
            }
            depth++;
        } else {
            // Closing
            depth--;
            if (depth === 0 && current) {
                const innerHTML = content.slice(current.innerStart, match.index);
                blocks.push({
                    name: current.name,
                    attrs: current.attrs,
                    innerHTML,
                    openComment: current.openComment,
                    closeComment: full,
                    raw: content.slice(current.start, match.index + full.length)
                });
                current = null;
            }
        }
    }

    return blocks;
}

function parseAttrs(attrsJson: string): Record<string, any> {
    const trimmed = (attrsJson || '').trim();
    if (!trimmed) return {};
    try {
        return JSON.parse(trimmed);
    } catch {
        return {};
    }
}

// ============================================
// Text editing (conservative)
// ============================================

// "Simple" block: exactly one root tag whose content has no children
const SIMPLE_BLOCK = /^(\s*)<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)>([\s\S]*?)<\/\2>(\s*)$/;

/**
 * Can the block be text-edited inline safely?
 */
export function isTextEditable(block: GutenbergBlock): boolean {
    if (!block.innerHTML) return false;
    const match = block.innerHTML.match(SIMPLE_BLOCK);
    if (!match) return false;
    // The inner content must not have child tags (inline formatting included)
    return !/[<>]/.test(match[4]);
}

/**
 * Extracts the plain text of a simple block (or null if it is not editable)
 */
export function extractText(block: GutenbergBlock): string | null {
    const match = block.innerHTML.match(SIMPLE_BLOCK);
    if (!match || /[<>]/.test(match[4])) return null;
    return decodeEntities(match[4]);
}

/**
 * Replaces the text of a simple block, preserving the original tag, attributes
 * and whitespace. Throws if the block is not editable.
 */
export function patchBlockText(block: GutenbergBlock, newText: string): GutenbergBlock {
    const match = block.innerHTML.match(SIMPLE_BLOCK);

    if (!match || /[<>]/.test(match[4])) {
        throw new Error(
            `Block "${block.name}" is too complex for inline text editing ` +
            `(nested markup). Edit it in the WordPress editor instead.`
        );
    }

    const [, leadWs, tag, tagAttrs, , trailWs] = match;
    const escaped = escapeHtml(newText);
    const innerHTML = `${leadWs}<${tag}${tagAttrs}>${escaped}</${tag}>${trailWs}`;

    return {
        ...block,
        innerHTML,
        raw: `${block.openComment}${innerHTML}${block.closeComment}`
    };
}

// ============================================
// Serializer
// ============================================

/**
 * Serializes the block list back to `post_content`.
 * Untouched blocks use their original `raw` (lossless round-trip).
 */
export function serializeGutenberg(blocks: GutenbergBlock[]): string {
    return blocks.map(block => block.raw).join('\n\n');
}

// ============================================
// Entity helpers
// ============================================

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function decodeEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * Gutenberg block name → Inti block type.
 * 'core/paragraph' → 'Paragraph'; 'acme/team-list' → 'AcmeTeamList'
 */
export function gutenbergNameToType(name: string): string {
    const [namespace, short] = name.split('/');
    const pascal = (s: string) => s.split(/[_-]+/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
    return namespace === 'core' ? pascal(short) : `${pascal(namespace)}${pascal(short)}`;
}
