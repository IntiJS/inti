/**
 * Cache tags as a CDN accepts them.
 *
 * A CDN purges by the tags a response carried (`Cache-Tag` on Cloudflare,
 * `Vercel-Cache-Tag` on Vercel). Both take a comma-separated list, so a tag may
 * not hold a comma or a space; Cloudflare accepts printable ASCII only, Vercel
 * at most 128 tags of 256 bytes. A tag outside those rules (a slug with an
 * accent, a very long catalog id) is replaced by a stable hash of itself, so
 * the header and the purge compute the same value from the same Inti tag.
 */

/** Most tags one response may carry on Vercel; Cloudflare allows more */
export const CDN_MAX_TAGS = 128;

const SAFE = /^[\x21-\x2b\x2d-\x7e]{1,256}$/;

/** FNV-1a, 32 bits: synchronous and stable everywhere, which is all a tag name needs */
function hash(value: string): string {
    let h = 0x811c9dc5;
    const bytes = new TextEncoder().encode(value);
    for (const byte of bytes) {
        h ^= byte;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** One Inti tag as a CDN tag */
export function cdnTag(tag: string): string {
    return SAFE.test(tag) ? tag : `inti:h:${hash(tag)}`;
}

/** Inti tags as CDN tags: converted, without repeats, at most `CDN_MAX_TAGS` */
export function cdnTags(tags: readonly string[]): string[] {
    return [...new Set(tags.filter((tag) => typeof tag === 'string' && tag !== '').map(cdnTag))].slice(0, CDN_MAX_TAGS);
}

/**
 * Empties Vercel's CDN (and the Runtime Cache) by the tags `intiDelivery({ cdn: { platform:
 * 'vercel' } })` put on each page. Pass `invalidateByTag` from `@vercel/functions`:
 *
 *   export const POST = purgeRoute({ cache, secret, onPurge: vercelPurge(invalidateByTag) });
 *
 * Every tag goes, not only the first 128 a response may carry. `invalidateByTag` marks them
 * stale, so the next visitor still gets the page at once while it is rendered again.
 */
export function vercelPurge(invalidateByTag: (tags: string[]) => Promise<unknown>) {
    return async (tags: string[]): Promise<void> => {
        const all = [...new Set(tags.filter((tag) => typeof tag === 'string' && tag !== '').map(cdnTag))];
        if (all.length > 0) await invalidateByTag(all);
    };
}
