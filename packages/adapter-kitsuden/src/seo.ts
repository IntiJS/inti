import type { PageSeo } from '@intijs/core/types';

import type { KitsudenPageResponse, MediaPreset } from './types.js';

export interface SeoContext {
    /** Origin of the CMS, without a trailing slash */
    endpoint: string;
    /** kon-media preset the social image is served with */
    mediaPreset: MediaPreset;
    /** Public URL of a media file; default: the CMS's own preset route on `endpoint` */
    mediaUrl?: (id: string, preset: MediaPreset) => string;
}

/** `<endpoint>/api/media/preset/:id/:preset`: the CMS's own route for a media preset */
export function defaultMediaUrl(endpoint: string, id: string, preset: MediaPreset): string {
    return `${endpoint.replace(/\/+$/, '')}/api/media/preset/${encodeURIComponent(id)}/${preset}`;
}

/**
 * Normalizes the SEO fields of a Kitsuden page to `PageSeo`.
 *
 * Kitsuden stores `ogImageId` —the media id—, not a URL. Whoever renders needs an absolute URL,
 * so it is built against the CMS endpoint with the kon-media presets
 * (`/api/media/preset/:id/:preset`).
 */
export function extractKitsudenSeo(page: KitsudenPageResponse, ctx: SeoContext): PageSeo {
    const seo: PageSeo = {};

    const title = trimmed(page.metaTitle) ?? trimmed(page.title);
    if (title) seo.title = title;

    const description = trimmed(page.metaDescription) ?? trimmed(page.description);
    if (description) seo.description = description;

    const ogImageId = trimmed(page.ogImageId);
    if (ogImageId) {
        seo.image = ctx.mediaUrl ? ctx.mediaUrl(ogImageId, ctx.mediaPreset) : defaultMediaUrl(ctx.endpoint, ogImageId, ctx.mediaPreset);
    }

    /**
     * A draft and a page with `requireAuth` are NOT indexed.
     *
     * Both facts already live in the row and did not leave the CMS: a frontend that only read
     * the title and the blocks published `index,follow` over a private or half-written page. It
     * is cheaper to say it here than to ask the search engine to drop it afterwards.
     */
    const publishable = page.status === 'published' && page.requireAuth !== true;
    if (!publishable) seo.robots = { index: false, follow: false };

    return seo;
}

function trimmed(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const t = value.trim();
    return t.length > 0 ? t : undefined;
}
