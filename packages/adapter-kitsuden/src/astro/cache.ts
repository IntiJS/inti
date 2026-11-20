/**
 * The webhook that empties the cache when Kitsuden says a page changed.
 *
 * The cache itself is the core's (`createCacheManager` from `@intijs/core/cache`, in memory
 * or on Valkey): the same one `kitsudenMiddleware` keeps the HTML in and `cachePages` keeps
 * the pages in. A Kitsuden action with an outbound webhook on `page:updated` / `page:deleted`
 * posts here, and the next visitor gets the new version.
 */

import type { CacheManager } from '@intijs/core/cache';
import { purgeRoute as corePurgeRoute, type PurgeNotice } from '@intijs/core/delivery';

/** A Kitsuden webhook body: `{ event, data: { id, slug }, timestamp, action }` */
export function parseKitsudenNotice(body: unknown): PurgeNotice | null {
    if (!body || typeof body !== 'object') return {};
    const parsed = body as Record<string, unknown>;
    const nested = (field: string) =>
        parsed[field] && typeof parsed[field] === 'object' ? (parsed[field] as Record<string, unknown>) : {};
    const event = String(parsed.event ?? parsed.type ?? nested('data').event ?? '');
    const slug = [parsed.slug, nested('data').slug, nested('payload').slug].find(
        (value): value is string => typeof value === 'string' && value !== ''
    );
    // A dataset entry (a catalog item) is purged by its catalog tags, not as a page
    if (/^entry:/.test(event)) {
        const id = nested('data').id ?? parsed.id;
        const datasetId = nested('data').datasetId ?? parsed.datasetId;
        return typeof id === 'string' && typeof datasetId === 'string'
            ? { tags: [`catalog:kitsuden-${datasetId}:item:${id}`, `catalog:kitsuden-${datasetId}:lists`] }
            : {};
    }
    return { event, ...(slug ? { slug } : {}) };
}

/**
 * `src/pages/api/kitsuden/purge.ts`: `export const POST = purgeRoute(cache, () => env('INTI_KITSUDEN_PURGE_SECRET'))`.
 *
 * Point a Kitsuden action's outbound webhook here, with the same secret. The request is
 * accepted only with a valid `X-Kitsuden-Signature` (HMAC-SHA256 of the body). The body's
 * `slug` (top level, or under `data` / `payload`) purges that page and the home page; a
 * deletion, or a body without a slug, purges every page. An `entry:*` event of a dataset
 * served as a catalog purges that item and its listings.
 */
export function purgeRoute(cache: CacheManager, secret: string | (() => string | undefined)) {
    return corePurgeRoute({ cache, secret, signatureHeader: 'x-kitsuden-signature', parse: parseKitsudenNotice });
}
