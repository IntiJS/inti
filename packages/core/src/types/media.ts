/**
 * Media Asset Types - Image processing and optimization
 */

/** One file of an image at one width */
export interface ImageCandidate {
    url: string;
    /** Intrinsic width in pixels: the `w` of `srcset` */
    width: number;
}

/** The same image in another format, for `<picture><source type>` */
export interface ImageSource {
    /** `image/avif`, `image/webp` */
    type: string;
    srcset: ImageCandidate[];
}

/**
 * An image as an adapter hands it to a block.
 *
 * `width` and `height` are the original's: without them the browser cannot
 * reserve the space and the page jumps (CLS). `srcset` and `sources` are the
 * sizes and formats the CMS already produced (WordPress's `sizes`, Kitsuden's
 * `/transform`); with them `IntiImage` uses them as they are instead of
 * transforming the image again.
 */
export interface MediaAsset {
    id: string;
    url: string;
    alt?: string;
    width?: number;
    height?: number;
    /** Sizes of the same image, in its own format */
    srcset?: ImageCandidate[];
    /** Other formats (AVIF, WebP), best first */
    sources?: ImageSource[];
    /**
     * The same image as a video (an animated GIF the CMS converted): far
     * lighter, and `IntiImage` plays it muted and looped in its place
     */
    video?: { url: string; type: string };
    format?: string;
    size?: number;
    mimeType?: string;
    filename?: string;
}

export interface OptimizedImage {
    src: string;
    srcset?: string;
    sizes?: string;
    width: number;
    height: number;
    alt?: string;
    placeholder?: 'blur' | 'empty' | 'color';
    blurDataURL?: string;
    loading?: 'eager' | 'lazy';
    decoding?: 'async' | 'sync' | 'auto';
}

export interface ImageTransformOptions {
    width?: number;
    height?: number;
    quality?: number;
    format?: 'auto' | 'webp' | 'avif' | 'jpeg' | 'png';
    fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
    position?: 'center' | 'top' | 'bottom' | 'left' | 'right' | 'faces';
    background?: string;
}

export interface ResponsiveImageOptions extends ImageTransformOptions {
    sizes?: string;
    breakpoints?: number[];
}

/** `url 400w, url 800w`, smallest first, without repeated widths */
export function srcsetAttribute(candidates: ImageCandidate[] | undefined): string | undefined {
    if (!candidates?.length) return undefined;
    const byWidth = new Map<number, string>();
    for (const candidate of candidates) {
        if (candidate?.url && Number.isFinite(candidate.width) && candidate.width > 0) byWidth.set(Math.round(candidate.width), candidate.url);
    }
    if (byWidth.size === 0) return undefined;
    return [...byWidth.entries()]
        .sort(([a], [b]) => a - b)
        .map(([width, url]) => `${url.replace(/ /g, '%20').replace(/,/g, '%2C')} ${width}w`)
        .join(', ');
}
