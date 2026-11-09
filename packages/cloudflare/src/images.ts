/**
 * Cloudflare Images: resizes and converts at the edge, from a URL. Image
 * Transformations must be enabled on the zone; without it those URLs return an error.
 */

export interface CloudflareImageOptions {
    width?: number;
    height?: number;
    fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
    quality?: number;
    format?: 'auto' | 'avif' | 'webp' | 'jpeg';
}

export interface CloudflareImagesConfig {
    /** Origin of the zone with transformations. Empty: paths relative to the site itself */
    zone?: string;
    /** Default: 85 */
    quality?: number;
    /** Default: 320, 640, 960, 1280, 1920 */
    breakpoints?: number[];
}

/** Known values only: this ends up inside a URL */
function serialize(options: CloudflareImageOptions): string {
    const parts: string[] = [];
    if (options.width && Number.isFinite(options.width)) parts.push(`width=${Math.round(options.width)}`);
    if (options.height && Number.isFinite(options.height)) parts.push(`height=${Math.round(options.height)}`);
    if (options.fit) parts.push(`fit=${options.fit}`);
    if (options.quality && Number.isFinite(options.quality)) parts.push(`quality=${Math.round(options.quality)}`);
    parts.push(`format=${options.format ?? 'auto'}`);
    return parts.join(',');
}

export function cloudflareImageUrl(src: string, options: CloudflareImageOptions, config: CloudflareImagesConfig = {}): string {
    if (!/^(https?:\/\/|\/(?!\/))/i.test(src)) {
        throw new Error(`cloudflareImageUrl: "${src}" has to be an absolute http(s) URL or a path on this site.`);
    }
    const zone = (config.zone ?? '').replace(/\/$/, '');
    const quality = options.quality ?? config.quality;
    return `${zone}/cdn-cgi/image/${serialize({ ...options, quality })}/${src.replace(/^\//, '')}`;
}

export function cloudflareImageSrcset(src: string, options: CloudflareImageOptions = {}, config: CloudflareImagesConfig = {}): string {
    return (config.breakpoints ?? [320, 640, 960, 1280, 1920])
        .map((width) => `${cloudflareImageUrl(src, { ...options, width }, config)} ${width}w`)
        .join(', ');
}

/** For `registerImageService` from `@intijs/core/image`: `<IntiImage>` uses it with no further changes */
export function createCloudflareImageService(config: CloudflareImagesConfig = {}) {
    const srcOf = (asset: { url?: string; src?: string; id?: string }) => asset.url ?? asset.src ?? String(asset.id);

    return {
        async optimize(asset: any, options: any) {
            return {
                src: cloudflareImageUrl(srcOf(asset), options, config),
                width: options.width ?? asset.width ?? 800,
                height: options.height ?? asset.height ?? 600,
                alt: asset.alt,
                loading: 'lazy',
                decoding: 'async'
            };
        },
        async generateResponsive(asset: any, options: any) {
            const breakpoints: number[] = options.breakpoints ?? config.breakpoints ?? [320, 640, 960, 1280, 1920];
            const width = options.width ?? breakpoints[Math.floor(breakpoints.length / 2)];
            return {
                src: cloudflareImageUrl(srcOf(asset), { ...options, width }, config),
                srcset: cloudflareImageSrcset(srcOf(asset), options, { ...config, breakpoints }),
                sizes: options.sizes ?? '100vw',
                width: asset.width ?? width,
                height: asset.height,
                alt: asset.alt,
                loading: 'lazy',
                decoding: 'async'
            };
        },
        async generatePlaceholder(asset: any) {
            return cloudflareImageUrl(srcOf(asset), { width: 32, quality: 20 }, config);
        }
    };
}
