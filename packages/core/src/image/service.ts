import type { MediaAsset, ImageTransformOptions, ResponsiveImageOptions, OptimizedImage } from '../types/media.js';

/**
 * Image Optimization Service
 * Handles image processing, transformation and optimization
 */
export class ImageService {
    private endpoint: string;
    private cdnUrl?: string;

    constructor(config: { endpoint: string; cdnUrl?: string }) {
        this.endpoint = config.endpoint;
        this.cdnUrl = config.cdnUrl;
    }

    /**
     * Transform a media asset to optimized image with options
     */
    async optimize(asset: MediaAsset, options: ImageTransformOptions): Promise<OptimizedImage> {
        const params = this.buildTransformParams(options);
        const baseUrl = this.cdnUrl || this.endpoint;
        
        // Build transformed URL
        const transformedUrl = `${baseUrl}/image/${asset.id}?${params}`;
        
        return {
            src: transformedUrl,
            width: options.width || asset.width || 800,
            height: options.height || asset.height || 600,
            alt: asset.alt,
            loading: 'lazy',
            decoding: 'async',
            placeholder: 'blur',
        };
    }

    /**
     * Generate responsive image with srcset
     */
    async generateResponsive(asset: MediaAsset, options: ResponsiveImageOptions): Promise<OptimizedImage> {
        const breakpoints = options.breakpoints || [320, 640, 960, 1280, 1920];
        const baseUrl = this.cdnUrl || this.endpoint;
        
        // Generate srcset
        const srcset = breakpoints
            .map(w => {
                const params = this.buildTransformParams({ ...options, width: w });
                return `${baseUrl}/image/${asset.id}?${params} ${w}w`;
            })
            .join(', ');

        // Default to middle breakpoint
        const defaultWidth = options.width || breakpoints[Math.floor(breakpoints.length / 2)];
        const defaultParams = this.buildTransformParams({ ...options, width: defaultWidth });

        return {
            src: `${baseUrl}/image/${asset.id}?${defaultParams}`,
            srcset,
            sizes: options.sizes || '100vw',
            width: asset.width || defaultWidth,
            height: asset.height || Math.round((defaultWidth / (asset.width || defaultWidth)) * (asset.height || defaultWidth * 0.75)),
            alt: asset.alt,
            loading: 'lazy',
            decoding: 'async',
            placeholder: 'blur',
        };
    }

    /**
     * Generate blur placeholder for progressive loading
     */
    async generatePlaceholder(asset: MediaAsset): Promise<string> {
        // Return a low-quality placeholder URL
        const baseUrl = this.cdnUrl || this.endpoint;
        return `${baseUrl}/image/${asset.id}?w=20&q=10&blur=10`;
    }

    private buildTransformParams(options: ImageTransformOptions): string {
        const params = new URLSearchParams();
        
        if (options.width) params.set('w', options.width.toString());
        if (options.height) params.set('h', options.height.toString());
        if (options.quality) params.set('q', options.quality.toString());
        if (options.format && options.format !== 'auto') params.set('f', options.format);
        if (options.fit) params.set('fit', options.fit);
        if (options.position) params.set('pos', options.position);
        if (options.background) params.set('bg', options.background);
        
        return params.toString();
    }
}

// Global image service instance
let globalImageService: ImageService | null = null;

export function configureImageService(config: { endpoint: string; cdnUrl?: string }): ImageService {
    globalImageService = new ImageService(config);
    return globalImageService;
}

/**
 * Registers a custom service: anything that understands `optimize`, `generateResponsive`
 * and `generatePlaceholder`. `<IntiImage>` uses it with no further changes.
 */
export function registerImageService(service: Pick<ImageService, 'optimize' | 'generateResponsive' | 'generatePlaceholder'>): void {
    globalImageService = service as ImageService;
}

export function getImageService(): ImageService {
    if (!globalImageService) {
        throw new Error('ImageService not configured. Call configureImageService() first.');
    }
    return globalImageService;
}
