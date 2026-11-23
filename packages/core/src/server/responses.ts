/**
 * What a page answers when it cannot be read.
 *
 *   try {
 *       page = await readPage(slug);
 *   } catch (error) {
 *       return pageErrorResponse(error);
 *   }
 *
 * 404 only when the CMS said the page does not exist (`NotFoundError`).
 * Anything else —a timeout, a 500, a 429, a bug in a parser— is a 503 with
 * `Retry-After`: "come back later" is the one answer that does not make a
 * search engine drop a page that exists.
 */

import { isNotFound, isUnavailable } from '../errors/index.js';

export interface ErrorResponseOptions {
    /** Seconds in `Retry-After` when the source did not say. Default 60 */
    retryAfter?: number;
    /** HTML of the page. Default: a minimal "back in a moment" page */
    html?: string;
    /** Adds the error's message to the body. Default: development only */
    detail?: boolean;
}

const escape = (text: string) =>
    text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const isDev = () =>
    (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') ||
    (typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true);

function page(title: string, text: string, detail?: string): string {
    return (
        '<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">' +
        `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
        '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">' +
        `<h1>${title}</h1><p>${text}</p>${detail ? `<pre style="white-space:pre-wrap">${escape(detail)}</pre>` : ''}</body></html>`
    );
}

/** 503 with `Retry-After`, `no-store` and `noindex` */
export function unavailableResponse(error?: unknown, options: ErrorResponseOptions = {}): Response {
    const fromSource = isUnavailable(error) ? error.retryAfter : undefined;
    const retry = Math.max(30, Math.min(600, fromSource ?? options.retryAfter ?? 60));
    const detail = (options.detail ?? isDev()) && error instanceof Error ? error.message : undefined;
    return new Response(options.html ?? page('Back in a moment', 'This page cannot be shown right now. Please try again in a minute.', detail), {
        status: 503,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'retry-after': String(retry),
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex'
        }
    });
}

/** 404 when the error says the page does not exist, 503 for anything else */
export function pageErrorResponse(error: unknown, options: ErrorResponseOptions & { notFoundHtml?: string } = {}): Response {
    if (isNotFound(error)) {
        const detail = (options.detail ?? isDev()) && error instanceof Error ? error.message : undefined;
        return new Response(options.notFoundHtml ?? page('Page not found', 'There is no page at this address.', detail), {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, s-maxage=60' }
        });
    }
    console.error('[inti] The page could not be read; answering 503.', error);
    return unavailableResponse(error, options);
}
