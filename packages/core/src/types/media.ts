/**
 * Media Asset Types - Image processing and optimization
 */

export interface MediaAsset {
    id: string;
    url: string;
    alt?: string;
    width?: number;
    height?: number;
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
