/**
 * An endpoint that serves a page's infographic blocks as images, so n8n, a scheduler
 * or a social tool can fetch them by URL:
 *
 *   /infographics/<slug>/<block>.jpg?format=instagram-portrait&slide=2
 *   /infographics/<slug>/<block>.json?format=tiktok        → how many images, their URLs and alt text
 *
 * It reads the published page only (never a draft), renders only the block types you
 * list, and honours scheduled visibility: a hidden block is a 404, like on the page.
 * Rendering is CPU work, so results are cached and renders run a few at a time.
 */

import type { IntiBlock } from '@intijs/core/types';
import { isBlockVisible } from '@intijs/core/blocks';
import { FORMATS, resolveFormat } from './formats.js';
import { planInfographic, renderInfographic, type RenderOptions } from './render.js';

export interface InfographicRouteOptions extends Omit<RenderOptions, 'format' | 'output'> {
    /** The published page. Return null when it does not exist */
    readPage: (slug: string) => Promise<{ blocks: IntiBlock[] } | null>;
    /** Block types rendered as infographics, as Inti names them (`Infographic`, `infographic`) */
    blockTypes: string[];
    /** Format ids this route serves. Default: every built-in and every custom format */
    allowFormats?: string[];
    /** Default: an hour in browsers, a day in shared caches */
    cacheControl?: string;
    /** Rendered images kept in memory. Default 64 */
    maxCacheEntries?: number;
    /** Renders at the same time. Default 2 */
    concurrency?: number;
}

type RouteContext = { params: Record<string, string | undefined>; request: Request; url?: URL };

const EXTENSIONS: Record<string, 'png' | 'jpeg' | 'json'> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', json: 'json' };

export function createInfographicRoute(options: InfographicRouteOptions) {
    const cache = new Map<string, { body: Uint8Array | string; type: string; etag: string }>();
    const maxEntries = options.maxCacheEntries ?? 64;
    const cacheControl = options.cacheControl ?? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';
    const allowed = new Set(options.allowFormats ?? [...Object.keys(FORMATS), ...(options.formats ?? []).map((f) => f.id)]);

    let running = 0;
    const waiting: (() => void)[] = [];
    const limit = Math.max(1, options.concurrency ?? 2);
    const withSlot = async <T>(work: () => Promise<T>): Promise<T> => {
        if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
        running++;
        try {
            return await work();
        } finally {
            running--;
            waiting.shift()?.();
        }
    };

    const remember = (key: string, entry: { body: Uint8Array | string; type: string; etag: string }) => {
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
    };

    return async function GET(context: RouteContext): Promise<Response> {
        const url = context.url ?? new URL(context.request.url);
        const path = (context.params.path ?? context.params.slug ?? '').replace(/^\/+|\/+$/g, '');
        const segments = path.split('/');
        const last = segments.pop() ?? '';
        const match = last.match(/^(\d{1,4})\.([a-z]+)$/i);
        if (!match || !segments.length) return text(404, 'Not found');
        const blockIndex = Number(match[1]);
        const kind = EXTENSIONS[match[2].toLowerCase()];
        if (!kind) return text(404, 'Not found');

        const formatId = url.searchParams.get('format') ?? 'blog';
        if (!allowed.has(formatId)) return text(400, `Unknown format. Use one of: ${[...allowed].join(', ')}`);
        const format = resolveFormat(formatId, options.formats);
        const themeParam = url.searchParams.get('theme') ?? undefined;
        const slideParam = url.searchParams.get('slide');
        const slide = slideParam === null ? 0 : Number(slideParam) - 1;
        if (!Number.isInteger(slide) || slide < 0 || slide > 99) return text(400, 'slide is a number from 1');

        const page = await options.readPage(segments.join('/'));
        const block = page?.blocks.find((b, i) => (b.meta?.index ?? i) === blockIndex);
        if (!block || !options.blockTypes.includes(block.type) || !isBlockVisible(block)) return text(404, 'Not found');

        const output = kind === 'json' ? 'json' : kind;
        const key = await digest(JSON.stringify([block.data, formatId, themeParam, slide, output]));
        const etag = `"${key}"`;
        if (context.request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl } });

        const hit = cache.get(key);
        if (hit) return respond(hit.body, hit.type, etag, cacheControl);

        const renderOptions = { ...options, format, theme: themeParam ?? options.theme };
        try {
            if (output === 'json') {
                const plan = await withSlot(() => planInfographic(block.data, renderOptions));
                const ext = format.output === 'jpeg' ? 'jpg' : 'png';
                const base = new URL(`${url.pathname.replace(/\.json$/i, `.${ext}`)}`, url);
                const body = JSON.stringify({
                    format: format.id,
                    width: format.width,
                    height: format.height,
                    contentType: format.output === 'jpeg' ? 'image/jpeg' : 'image/png',
                    slides: plan.slides.map((s) => {
                        const slideUrl = new URL(base);
                        slideUrl.searchParams.set('format', format.id);
                        if (themeParam) slideUrl.searchParams.set('theme', themeParam);
                        slideUrl.searchParams.set('slide', String(s.index + 1));
                        return { url: slideUrl.href, alt: s.alt };
                    })
                });
                remember(key, { body, type: 'application/json; charset=utf-8', etag });
                return respond(body, 'application/json; charset=utf-8', etag, cacheControl);
            }

            const result = await withSlot(() => renderInfographic(block.data, { ...renderOptions, output, slide }));
            const rendered = result.slides[0];
            if (!rendered) return text(404, 'No such slide');
            remember(key, { body: rendered.bytes, type: rendered.contentType, etag });
            return respond(rendered.bytes, rendered.contentType, etag, cacheControl);
        } catch (error) {
            console.error('[inti] infographic render failed:', error);
            return text(500, 'Render failed');
        }
    };
}

function respond(body: Uint8Array | string, type: string, etag: string, cacheControl: string): Response {
    return new Response(body as BodyInit, { status: 200, headers: { 'Content-Type': type, ETag: etag, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' } });
}

function text(status: number, message: string): Response {
    return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function digest(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
