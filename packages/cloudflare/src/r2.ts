/**
 * R2: a site's media. The type is checked by the bytes, not by what the uploader
 * claims: an HTML file renamed to .png would be served from your domain. SVG is not accepted
 * for the same reason: it can carry scripts.
 *
 * Deciding who may upload is the caller's job: check the editor session first.
 */

export interface R2MediaConfig {
    /** Public origin of the bucket. Without it, URLs point to `routePrefix` */
    publicUrl?: string;
    /** Route on your site that serves the media with `serve()`. Default: `/media` */
    routePrefix?: string;
    /** Default: 10 MB */
    maxBytes?: number;
    /** Folder inside the bucket. Default: `media` */
    prefix?: string;
}

export interface R2MediaItem {
    id: string;
    url: string;
    alt?: string;
    contentType: string;
    size: number;
}

export type UploadResult = { ok: true; item: R2MediaItem } | { ok: false; status: 400 | 413 | 415; error: string };

interface Signature {
    contentType: string;
    extension: string;
    matches(bytes: Uint8Array): boolean;
}

const starts = (bytes: Uint8Array, signature: number[], offset = 0) =>
    signature.every((byte, i) => bytes[offset + i] === byte);

const SIGNATURES: Signature[] = [
    { contentType: 'image/png', extension: 'png', matches: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { contentType: 'image/jpeg', extension: 'jpg', matches: (b) => starts(b, [0xff, 0xd8, 0xff]) },
    { contentType: 'image/gif', extension: 'gif', matches: (b) => starts(b, [0x47, 0x49, 0x46, 0x38]) },
    {
        contentType: 'image/webp',
        extension: 'webp',
        matches: (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8)
    },
    {
        contentType: 'image/avif',
        extension: 'avif',
        matches: (b) => starts(b, [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 4)
    }
];

export function detectImageType(bytes: Uint8Array): Signature | null {
    return SIGNATURES.find((signature) => signature.matches(bytes)) ?? null;
}

export function createR2MediaStore(bucket: R2Bucket, config: R2MediaConfig = {}) {
    const prefix = (config.prefix ?? 'media').replace(/\/$/, '');
    const routePrefix = (config.routePrefix ?? '/media').replace(/\/$/, '');
    const maxBytes = config.maxBytes ?? 10 * 1024 * 1024;

    const urlFor = (id: string) =>
        config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/${prefix}/${id}` : `${routePrefix}/${id}`;

    const toItem = (id: string, object: { size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): R2MediaItem => ({
        id,
        url: urlFor(id),
        alt: object.customMetadata?.alt || undefined,
        contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
        size: object.size
    });

    return {
        /** Stores under a generated name: the uploaded file's name never reaches the key */
        async upload(file: Blob, options: { alt?: string } = {}): Promise<UploadResult> {
            if (file.size === 0) return { ok: false, status: 400, error: 'Empty file' };
            if (file.size > maxBytes) return { ok: false, status: 413, error: `Larger than ${maxBytes} bytes` };

            const bytes = new Uint8Array(await file.arrayBuffer());
            const type = detectImageType(bytes);
            if (!type) return { ok: false, status: 415, error: 'Only PNG, JPEG, GIF, WebP and AVIF images are accepted' };

            const id = `${crypto.randomUUID()}.${type.extension}`;
            const object = await bucket.put(`${prefix}/${id}`, bytes, {
                httpMetadata: { contentType: type.contentType },
                customMetadata: options.alt ? { alt: options.alt.slice(0, 500) } : undefined
            });

            return { ok: true, item: toItem(id, object as R2Object) };
        },

        async list(options: { limit?: number } = {}): Promise<R2MediaItem[]> {
            const listing = await bucket.list({
                prefix: `${prefix}/`,
                limit: options.limit ?? 100,
                include: ['httpMetadata', 'customMetadata']
            } as R2ListOptions);
            return listing.objects.map((object) => toItem(object.key.slice(prefix.length + 1), object));
        },

        /**
         * Data source for `@intijs/genui`: a model picks from what exists, and
         * an invented id fails validation.
         */
        async asData(options: { limit?: number } = {}) {
            const items = await this.list(options);
            return items.map((item) => ({
                id: item.id,
                summary: item.alt ?? item.id,
                value: { id: item.id, url: item.url, alt: item.alt }
            }));
        },

        /** Response for a route that serves media. Only keys with the shape `upload` generates */
        async serve(id: string): Promise<Response> {
            if (!/^[0-9a-f-]{36}\.[a-z]+$/.test(id)) return new Response('Not found', { status: 404 });

            const object = await bucket.get(`${prefix}/${id}`);
            if (!object) return new Response('Not found', { status: 404 });

            return new Response(object.body, {
                headers: {
                    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'X-Content-Type-Options': 'nosniff',
                    ETag: object.httpEtag
                }
            });
        },

        async remove(id: string): Promise<void> {
            if (!/^[0-9a-f-]{36}\.[a-z]+$/.test(id)) throw new Error(`Invalid media id "${id}"`);
            await bucket.delete(`${prefix}/${id}`);
        }
    };
}
