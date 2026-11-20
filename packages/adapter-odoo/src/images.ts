/**
 * Odoo images from the site's own origin.
 *
 * Odoo serves `/web/image/...` with a browser session, not with an API key, and only for what
 * the public user may see. The site reads the image field with its key instead and serves the
 * bytes itself:
 *
 *   // src/pages/media/odoo/[model]/[id]/[size].ts
 *   export const GET = odooImageRoute({ client });
 *
 * Only images of published products (and of categories) are served, so the proxy cannot be
 * used to read anything the shop does not show. The URL carries `?v=<write_date>`: with it the
 * answer is `immutable` for a year, and a new picture gets a new URL.
 */

import type { OdooClient } from './client.js';

const MODELS = new Set(['product.template', 'product.image', 'product.public.category', 'product.category']);
const SIZES = new Set(['image_128', 'image_256', 'image_512', 'image_1024', 'image_1920']);

/** The type from the first bytes. SVG is refused: it can carry script */
export function sniffImage(bytes: Uint8Array): string | null {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
    return null;
}

function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * The base64 of a binary field: a string up to Odoo 19, `{ content, size }` from Odoo 20 on.
 * Null when the field is empty.
 */
export function binaryContent(value: unknown): string | null {
    if (typeof value === 'string' && value) return value;
    const content = (value as { content?: unknown } | null)?.content;
    return typeof content === 'string' && content ? content : null;
}

export interface OdooImageRouteOptions {
    client: OdooClient;
    /** Also require `is_published` (when the website module is installed). Default true */
    publishedOnly?: boolean;
}

type RouteContext = { params: Record<string, string | undefined>; request: Request; url?: URL };

export function odooImageRoute(options: OdooImageRouteOptions) {
    const { client } = options;
    let website: Promise<boolean> | null = null;
    const hasWebsite = () => {
        website ??= client
            .fieldsGet('product.template', ['type'])
            .then((fields) => 'is_published' in fields)
            .catch(() => false);
        return website;
    };

    /** Is this template something the shop shows? */
    async function visible(templateId: number): Promise<boolean> {
        const published = options.publishedOnly !== false && (await hasWebsite());
        const count = await client.searchCount('product.template', [
            ['id', '=', templateId],
            ['sale_ok', '=', true],
            ...(published ? ([['is_published', '=', true]] as Array<[string, string, unknown]>) : [])
        ]);
        return count > 0;
    }

    return async ({ params, request, url }: RouteContext): Promise<Response> => {
        const model = params.model ?? '';
        const id = Number(params.id);
        const size = params.size ?? '';
        if (!MODELS.has(model) || !Number.isInteger(id) || id <= 0 || !SIZES.has(size)) return new Response(null, { status: 404 });

        try {
            const [record] = await client.read<Record<string, unknown>>(model, [id], [size, 'write_date', ...(model === 'product.image' ? ['product_tmpl_id'] : [])]);
            if (!record) return new Response(null, { status: 404 });

            if (model === 'product.template' && !(await visible(id))) return new Response(null, { status: 404 });
            if (model === 'product.image') {
                const template = record.product_tmpl_id as [number, string] | false;
                if (!template || !(await visible(template[0]))) return new Response(null, { status: 404 });
            }

            const data = binaryContent(record[size]);
            if (!data) return new Response(null, { status: 404 });
            const bytes = base64ToBytes(data);
            const type = sniffImage(bytes);
            if (!type) return new Response(null, { status: 404 });

            const etag = `"${model}-${id}-${size}-${String(record.write_date ?? '').replace(/\D/g, '')}"`;
            if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });

            const versioned = (url ?? new URL(request.url)).searchParams.has('v');
            return new Response(bytes as unknown as BodyInit, {
                headers: {
                    'content-type': type,
                    'content-length': String(bytes.byteLength),
                    etag,
                    'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600, stale-while-revalidate=86400',
                    'x-content-type-options': 'nosniff'
                }
            });
        } catch (error) {
            console.warn('[odoo] image proxy:', error instanceof Error ? error.message : error);
            return new Response(null, { status: 503, headers: { 'retry-after': '60' } });
        }
    };
}
