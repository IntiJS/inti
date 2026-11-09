/**
 * Scheduled block visibility.
 *
 * Several CMSs let you hide a block or give it a date window:
 * Kitsuden has it in the row itself (`isVisible`, `visibleFrom`,
 * `visibleUntil`), WordPress through plugins, Contentful with scheduled
 * publishing. It is content data, so the adapter normalizes it into
 * `meta` and this module decides what it means.
 *
 * It matters more than it seems: publishing a promotion before its date
 * is not a layout bug, it is a commercial promise the customer had not
 * made yet. And a hidden block that reaches the HTML also reaches the
 * structured data, `llms.txt` and the search engine's index.
 */

import type { IntiBlock } from '../types/index.js';

/** Parses an ISO date; `null` if it cannot be interpreted */
function parseInstant(value: string | undefined | null): number | null {
    if (!value) return null;
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
}

/**
 * Should this block be visible right now?
 *
 * An unreadable date is treated as absent, not as a restriction. Hiding
 * live content because of malformed data is a worse regression than
 * showing it: the explicit switch is `meta.visible`, and that one is
 * respected without interpretation.
 */
export function isBlockVisible(block: IntiBlock, now: Date = new Date()): boolean {
    const meta = block.meta;
    if (!meta) return true;

    if (meta.visible === false) return false;

    const reference = now.getTime();

    const from = parseInstant(meta.visibleFrom);
    if (from !== null && reference < from) return false;

    const until = parseInstant(meta.visibleUntil);
    if (until !== null && reference > until) return false;

    return true;
}

/**
 * Filters out the blocks that should not be visible now.
 *
 * `meta.index` is kept intact: it is the address the editor and the
 * actions use to locate the block in the CMS, so filtering for rendering
 * cannot renumber anything. If it were reassigned, editing a block that
 * comes after a hidden one would write to the wrong block.
 */
export function visibleBlocks(blocks: IntiBlock[], now: Date = new Date()): IntiBlock[] {
    return blocks.filter((block) => isBlockVisible(block, now));
}

/**
 * The hidden blocks of a list, to warn in development about why something
 * does not appear. A block that does not render and does not explain why
 * is half an hour of debugging.
 */
export function hiddenBlocks(blocks: IntiBlock[], now: Date = new Date()): IntiBlock[] {
    return blocks.filter((block) => !isBlockVisible(block, now));
}

/** Why a block is hidden, in one readable line */
export function hiddenReason(block: IntiBlock, now: Date = new Date()): string | null {
    const meta = block.meta;
    if (!meta) return null;

    if (meta.visible === false) return 'marked as hidden in the CMS';

    const reference = now.getTime();

    const from = parseInstant(meta.visibleFrom);
    if (from !== null && reference < from) return `scheduled from ${meta.visibleFrom}`;

    const until = parseInstant(meta.visibleUntil);
    if (until !== null && reference > until) return `expired on ${meta.visibleUntil}`;

    return null;
}
