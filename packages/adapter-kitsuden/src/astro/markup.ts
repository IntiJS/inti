/**
 * The `data-inti-*` markup for sites that render Kitsuden blocks themselves instead of with
 * `BlockRenderer`.
 *
 * The editor finds blocks and fields through these attributes. They are written ONLY for a
 * request Inti recognises as an editor: for anyone else these helpers return an empty
 * object, so the public HTML is the same with and without Inti.
 *
 *   data-inti-block           block type (marks the wrapper)
 *   data-inti-block-id        the block's id: writes reach it even if the page changed since
 *   data-inti-document-id     page uuid, or `game:<uuid>` on a game page
 *   data-inti-content-type    "page" or "game"
 *   data-inti-block-label     native type, used by the composer palette
 *   data-inti-block-index     position in the page's visible block list
 *   data-inti-block-total     length of that list
 *   data-inti-field           the content key a text element shows
 *
 * The index is the position in the list the adapter returns (`getPage` / `getGame`), which is
 * the list it re-reads before every write. Nested blocks (inside a grid) have no row of their
 * own and are not marked.
 */

import type { IntiBlock, IntiPage } from '@intijs/core/types';

export type IntiAttributes = Record<string, string | undefined>;

/**
 * Always a NEW empty object, never a shared frozen one: Astro adds the scoped `class` to the
 * attributes spread on an element, and a frozen object makes that throw mid-stream.
 */
const none = (): IntiAttributes => ({});

export interface MarkupContext {
    editable: boolean;
    documentId: string;
    total: number;
    /** Default: "page" */
    contentType?: 'page' | 'game';
}

/** The context for a page the adapter returned, or null when the visitor is not an editor */
export function markupFor(page: Pick<IntiPage, 'id' | 'blocks'> & { meta?: { contentType?: string } }, editable: boolean): MarkupContext | null {
    if (!editable) return null;
    const documentId = page.blocks[0]?.meta?.documentId ?? page.id;
    return {
        editable: true,
        documentId,
        total: page.blocks.length,
        contentType: String(documentId).startsWith('game:') || page.meta?.contentType === 'game' ? 'game' : 'page'
    };
}

export function blockAttributes(ctx: MarkupContext | null | undefined, block: Pick<IntiBlock, 'id' | 'type' | 'meta'>, index?: number): IntiAttributes {
    if (!ctx?.editable || typeof block.id !== 'string' || typeof block.type !== 'string') return none();
    const position = index ?? block.meta?.index;
    if (typeof position !== 'number') return none();
    return {
        'data-inti-block': block.type,
        'data-inti-block-id': block.id,
        'data-inti-document-id': ctx.documentId,
        'data-inti-content-type': ctx.contentType ?? 'page',
        'data-inti-block-label': block.meta?.label ?? block.type,
        'data-inti-block-index': String(position),
        'data-inti-block-total': String(ctx.total)
    };
}

/**
 * `data-inti-field="<key>"` for an editor, nothing for everyone else. On game pages only
 * `title` and `description` are editable, and the adapter refuses any other key.
 */
export function fieldAttributes(editable: boolean | undefined, key: string): IntiAttributes {
    return editable ? { 'data-inti-field': key } : none();
}

/** The block data as JSON safe inside `<script>`, or null when not editing */
export function blockJson(editable: boolean | undefined, data: unknown): string | null {
    return editable ? JSON.stringify(data ?? {}).replace(/</g, '\\u003c') : null;
}
