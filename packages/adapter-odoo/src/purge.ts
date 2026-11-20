/**
 * Odoo's change notice, read.
 *
 * An Odoo automation rule ("On update" of Product, action "Send Webhook Notification") posts the
 * record's fields as JSON: `{ "_model": "product.template", "_id": 42, "default_code": "SH-001",
 * ... }`. Odoo cannot sign it, so the route is authenticated with a token in the URL the rule
 * posts to (`https://site/api/odoo/purge?token=…`), compared in constant time.
 *
 *   // src/pages/api/odoo/purge.ts
 *   export const POST = odooPurgeRoute({ cache, token: () => env('INTI_ODOO_PURGE_TOKEN') });
 *
 * Include `default_code` in the rule's fields: the catalog addresses items by reference, so with
 * it only that product and the listings are dropped. Without it (a stock move, a price list),
 * the whole catalog is.
 */

import type { CacheManager } from '@intijs/core/cache';
import { catalogTags } from '@intijs/core/catalog';

export interface OdooNotice {
    /** Item ids (references) that changed. Empty: the whole source */
    ids: string[];
}

/** What a webhook body from Odoo says changed */
export function parseOdooNotice(body: unknown): OdooNotice {
    if (!body || typeof body !== 'object') return { ids: [] };
    const record = body as Record<string, unknown>;
    const model = String(record._model ?? record.model ?? '');
    const id = Number(record._id ?? record.id);
    const reference = typeof record.default_code === 'string' && record.default_code.trim() ? record.default_code.trim() : undefined;

    if (model === 'product.template') {
        if (reference) return { ids: [reference] };
        if (Number.isInteger(id)) return { ids: [`tmpl-${id}`] };
    }
    // A variant's reference is also how its product is found; its template is not in the body
    return { ids: [] };
}

/** Constant-time comparison: the token must not leak through timing */
function sameToken(a: string, b: string): boolean {
    const left = new TextEncoder().encode(a);
    const right = new TextEncoder().encode(b);
    let diff = left.length ^ right.length;
    for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
    return diff === 0;
}

export interface OdooPurgeOptions {
    cache: CacheManager;
    /** Shared token. A function, so it is read at request time */
    token: string | (() => string | undefined);
    /** Catalog name. Default `odoo` */
    source?: string;
}

export function odooPurgeRoute(options: OdooPurgeOptions) {
    const source = options.source ?? 'odoo';
    return async ({ request }: { request: Request }): Promise<Response> => {
        const token = typeof options.token === 'function' ? options.token() : options.token;
        if (!token) return new Response('Purge is not configured', { status: 503 });
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

        const given = new URL(request.url).searchParams.get('token') ?? request.headers.get('x-inti-token') ?? '';
        if (!sameToken(given, token)) return new Response('Invalid token', { status: 401 });

        let body: unknown = {};
        try {
            body = JSON.parse((await request.text()) || '{}');
        } catch {
            return new Response('Body is not JSON', { status: 400 });
        }

        const notice = parseOdooNotice(body);
        const tags = notice.ids.length
            ? [catalogTags.lists(source), ...notice.ids.map((id) => catalogTags.item(source, id))]
            : [catalogTags.source(source)];
        await options.cache.invalidateByTags(tags);
        return Response.json({ purged: tags });
    };
}
