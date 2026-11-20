/**
 * Kitsuden media served from the site's own origin.
 *
 *   /img/<media id>/<preset>   → API /api/media/preset/<id>/<preset>
 *   /media/<key>               → API /media/<key> (files of the local storage driver)
 *
 * Why not link the API: it answers everything under `/api/*` with
 * `Cross-Origin-Resource-Policy: same-origin`, so a browser downloads a preset image from
 * another origin and then refuses to paint it. It also keeps the API address private: the
 * server may reach it on an internal address the browser cannot see.
 *
 * Pair it with the adapter's `mediaUrl: sameOriginMediaUrl(siteUrl)`, so `og:image` and
 * generated blocks point at the same routes.
 */

import type { MediaPreset } from '../types.js';

/** The presets kon-media defines (`transform.routes.ts`) */
export const MEDIA_PRESETS = ['thumbnail', 'small', 'medium', 'large', 'hero'] as const satisfies readonly MediaPreset[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isMediaId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export const isMediaPreset = (value: unknown): value is MediaPreset =>
    typeof value === 'string' && (MEDIA_PRESETS as readonly string[]).includes(value);

/** A `/media/<key>` path the proxy accepts: no `..`, no odd characters */
export const MEDIA_KEY = /^(?!.*\.\.)[A-Za-z0-9._\-/]{1,300}$/;

/** Same-origin path of a media item at a preset, or null when the id is not one */
export function mediaPath(id: unknown, preset: MediaPreset = 'large'): string | null {
    return isMediaId(id) ? `/img/${id.toLowerCase()}/${preset}` : null;
}

/**
 * The adapter's `mediaUrl` for a site that mounts the proxy routes: absolute, because
 * `og:image` has to be.
 */
export function sameOriginMediaUrl(siteUrl: string): (id: string, preset: MediaPreset) => string {
    const base = siteUrl.replace(/\/+$/, '');
    return (id, preset) => `${base}/img/${encodeURIComponent(id.toLowerCase())}/${preset}`;
}

/**
 * Any image reference a block may hold, as something the browser can load: a media id, an
 * API `/media/...` or `/api/media/preset/...` path, or an absolute https URL the editor linked
 * on purpose. Anything else (javascript:, data:, plain http, relative junk) is dropped.
 */
export function imageSrc(value: unknown, preset: MediaPreset = 'large'): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (!v) return null;
    const byId = mediaPath(v, preset);
    if (byId) return byId;

    const presetPath = v.match(/^\/api\/media\/preset\/([^/?#]+)\/([a-z]+)/);
    if (presetPath) return isMediaPreset(presetPath[2]) ? mediaPath(presetPath[1], presetPath[2]) : null;

    if (v.startsWith('/media/')) {
        const key = v.slice('/media/'.length).split(/[?#]/)[0];
        return MEDIA_KEY.test(key) ? `/media/${key}` : null;
    }

    try {
        const url = new URL(v);
        // Plain http would be mixed content on an https site
        if (url.protocol === 'https:') return url.href;
    } catch {
        // not a URL
    }
    return null;
}

const ALLOWED_TYPES = /^(image\/(?!svg)[\w.+-]+|video\/[\w.+-]+|application\/pdf)(;|$)/i;
const COPIED = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const FORWARDED = ['range', 'if-range', 'if-none-match', 'if-modified-since'];

export interface ProxyMediaOptions {
    /** The visitor's request: its Range and validators are forwarded */
    request?: Request;
    fetch?: typeof fetch;
    /** Default: a day, and a week stale while revalidating */
    cacheControl?: string;
}

/**
 * A media file of the API, served from the site. Only GET, only image, video or PDF (no SVG,
 * which can carry script), only a few headers copied. Range requests pass through, so a video
 * can be sought; validators pass through, so a 304 is a 304.
 */
export async function proxyMedia(apiUrl: string, path: string, options: ProxyMediaOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: 'image/avif,image/webp,image/*,video/*,*/*;q=0.5' };
    for (const name of FORWARDED) {
        const value = options.request?.headers.get(name);
        if (value) headers[name] = value;
    }

    let upstream: Response;
    try {
        upstream = await (options.fetch ?? fetch)(`${apiUrl.replace(/\/+$/, '')}${path}`, {
            headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(20_000)
        });
    } catch {
        return new Response(null, { status: 502 });
    }

    if (upstream.status === 304) return new Response(null, { status: 304, headers: copy(upstream, options) });
    if (upstream.status === 404 || upstream.status === 400) return new Response(null, { status: 404 });
    if (upstream.status === 416) return new Response(null, { status: 416, headers: copy(upstream, options) });
    if (!upstream.ok) {
        await upstream.body?.cancel();
        return new Response(null, { status: upstream.status === 429 ? 503 : 502, headers: { 'retry-after': '60' } });
    }

    const type = upstream.headers.get('content-type') ?? '';
    if (!ALLOWED_TYPES.test(type)) {
        await upstream.body?.cancel();
        return new Response(null, { status: 404 });
    }
    return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers: copy(upstream, options) });
}

function copy(upstream: Response, options: ProxyMediaOptions): Headers {
    const headers = new Headers();
    for (const name of COPIED) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
    }
    headers.set('cache-control', options.cacheControl ?? 'public, max-age=86400, stale-while-revalidate=604800');
    headers.set('x-content-type-options', 'nosniff');
    return headers;
}

type RouteContext = { params: Record<string, string | undefined>; request: Request };

/** `src/pages/img/[id]/[preset].ts`: `export const GET = mediaPresetRoute(API_URL)` */
export function mediaPresetRoute(apiUrl: string | (() => string), options: Omit<ProxyMediaOptions, 'request'> = {}) {
    return ({ params, request }: RouteContext): Promise<Response> | Response => {
        const { id, preset } = params;
        if (!isMediaId(id) || !isMediaPreset(preset)) return new Response(null, { status: 404 });
        const api = typeof apiUrl === 'function' ? apiUrl() : apiUrl;
        return proxyMedia(api, `/api/media/preset/${id.toLowerCase()}/${preset}`, { ...options, request });
    };
}

/** `src/pages/media/[...key].ts`: `export const GET = mediaFileRoute(API_URL)` */
export function mediaFileRoute(apiUrl: string | (() => string), options: Omit<ProxyMediaOptions, 'request'> = {}) {
    return ({ params, request }: RouteContext): Promise<Response> | Response => {
        const key = params.key ?? '';
        if (!MEDIA_KEY.test(key)) return new Response(null, { status: 404 });
        const api = typeof apiUrl === 'function' ? apiUrl() : apiUrl;
        return proxyMedia(api, `/media/${key.split('/').map(encodeURIComponent).join('/')}`, { ...options, request });
    };
}

// ============================================
// Transformed images: AVIF, WebP and srcset from /api/media/transform
// ============================================

/** Widths a transformed image is offered at. Kitsuden rounds to its own steps anyway */
export const TRANSFORM_WIDTHS = [320, 640, 960, 1280, 1920] as const;
export const TRANSFORM_FORMATS = ['avif', 'webp', 'jpeg', 'png', 'auto'] as const;
export type TransformFormat = (typeof TRANSFORM_FORMATS)[number];

const FILE = /^(\d{2,4})\.(avif|webp|jpeg|png|auto)$/;

/** `/img/t/<id>/<width>.<format>`: one size of a media in one format, from the site's origin */
export function transformPath(id: string, width: number, format: TransformFormat = 'auto'): string {
    return `/img/t/${id.toLowerCase()}/${Math.round(width)}.${format}`;
}

/** The media id behind a value a block holds: an id, or a preset URL of the API */
function mediaIdOf(value: unknown): string | null {
    if (isMediaId(value)) return value.toLowerCase();
    if (typeof value !== 'string') return null;
    const id = value.match(/\/api\/media\/(?:preset|transform)\/([0-9a-f-]{36})/i)?.[1];
    return id && isMediaId(id) ? id.toLowerCase() : null;
}

export interface KitsudenImageOptions {
    /** Intrinsic size of the original, when the block knows it: `IntiImage` reserves the space */
    width?: number;
    height?: number;
    alt?: string;
    /** Widths to offer. Default 320 to 1920, never wider than `width` */
    widths?: readonly number[];
    /** Modern formats, best first. Default AVIF then WebP */
    formats?: Array<'avif' | 'webp'>;
}

/**
 * A Kitsuden media as Inti's image contract: `srcset` in the original format plus AVIF and WebP
 * `sources`, every URL on the site's origin (`mediaTransformRoute`). `<IntiImage src={…} />`
 * uses them as they are. Null when the value is not a Kitsuden media.
 */
export function kitsudenImage(value: unknown, options: KitsudenImageOptions = {}) {
    const id = mediaIdOf(value);
    if (!id) return null;
    const max = options.width ?? Infinity;
    const widths = [...(options.widths ?? TRANSFORM_WIDTHS)].filter((w) => w <= max);
    if (widths.length === 0) widths.push(Math.min(...(options.widths ?? TRANSFORM_WIDTHS)));
    const largest = widths[widths.length - 1];
    const candidates = (format: TransformFormat) => widths.map((width) => ({ url: transformPath(id, width, format), width }));
    return {
        id,
        url: transformPath(id, largest, 'auto'),
        alt: options.alt,
        width: options.width,
        height: options.height,
        srcset: candidates('auto'),
        sources: (options.formats ?? ['avif', 'webp']).map((format) => ({ type: `image/${format}`, srcset: candidates(format) }))
    };
}

/**
 * `src/pages/img/t/[id]/[file].ts`: `export const GET = mediaTransformRoute(KITSUDEN_API)`.
 *
 * Proxies `/api/media/transform/:id?w=&f=` from the site's origin. Kitsuden stores every
 * transformed file and never changes it for the same id and parameters, so it is served as
 * `immutable` for a year: a visitor downloads each size once.
 */
export function mediaTransformRoute(apiUrl: string | (() => string), options: Omit<ProxyMediaOptions, 'request' | 'cacheControl'> = {}) {
    return ({ params, request }: { params: Record<string, string | undefined>; request: Request }): Promise<Response> | Response => {
        const id = params.id;
        const file = (params.file ?? '').match(FILE);
        if (!isMediaId(id) || !file) return new Response(null, { status: 404 });
        const width = Math.min(4096, Number(file[1]));
        const api = typeof apiUrl === 'function' ? apiUrl() : apiUrl;
        return proxyMedia(api, `/api/media/transform/${id.toLowerCase()}?w=${width}&f=${file[2]}`, {
            ...options,
            request,
            cacheControl: 'public, max-age=31536000, immutable'
        });
    };
}
