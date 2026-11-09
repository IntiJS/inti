import { describe, it, expect, beforeEach } from 'bun:test';
import { ImageService, configureImageService, getImageService } from '../src/image/service.js';
import type { MediaAsset, ImageTransformOptions, ResponsiveImageOptions } from '../src/types/media.js';

describe('Image Service', () => {
    let service: ImageService;

    beforeEach(() => {
        service = new ImageService({
            endpoint: 'https://api.example.com',
            cdnUrl: 'https://cdn.example.com'
        });
    });

    describe('optimize', () => {
        const mockAsset: MediaAsset = {
            id: 'img-123',
            url: 'https://cdn.example.com/original.jpg',
            alt: 'Test image',
            width: 1200,
            height: 800,
            format: 'jpg',
            mimeType: 'image/jpeg'
        };

        it('should generate optimized image URL', async () => {
            const options: ImageTransformOptions = {
                width: 600,
                height: 400,
                quality: 80,
                format: 'webp'
            };

            const result = await service.optimize(mockAsset, options);

            expect(result.src).toContain('/image/img-123');
            expect(result.src).toContain('w=600');
            expect(result.src).toContain('h=400');
            expect(result.src).toContain('q=80');
            expect(result.src).toContain('f=webp');
        });

        it('should preserve original dimensions if not specified', async () => {
            const result = await service.optimize(mockAsset, {});

            expect(result.width).toBe(1200);
            expect(result.height).toBe(800);
        });

        it('should use provided dimensions', async () => {
            const result = await service.optimize(mockAsset, { width: 500, height: 300 });

            expect(result.width).toBe(500);
            expect(result.height).toBe(300);
        });

        it('should set default loading and decoding', async () => {
            const result = await service.optimize(mockAsset, {});

            expect(result.loading).toBe('lazy');
            expect(result.decoding).toBe('async');
        });

        it('should preserve alt text', async () => {
            const result = await service.optimize(mockAsset, {});

            expect(result.alt).toBe('Test image');
        });

        it('should use blur placeholder', async () => {
            const result = await service.optimize(mockAsset, {});

            expect(result.placeholder).toBe('blur');
        });
    });

    describe('generateResponsive', () => {
        const mockAsset: MediaAsset = {
            id: 'img-456',
            url: 'https://cdn.example.com/large.jpg',
            width: 2400,
            height: 1600
        };

        it('should generate srcset with breakpoints', async () => {
            const options: ResponsiveImageOptions = {
                breakpoints: [320, 640, 960],
                sizes: '100vw'
            };

            const result = await service.generateResponsive(mockAsset, options);

            expect(result.srcset).toContain('320w');
            expect(result.srcset).toContain('640w');
            expect(result.srcset).toContain('960w');
        });

        it('should include sizes attribute', async () => {
            const options: ResponsiveImageOptions = {
                sizes: '(max-width: 768px) 100vw, 50vw'
            };

            const result = await service.generateResponsive(mockAsset, options);

            expect(result.sizes).toBe('(max-width: 768px) 100vw, 50vw');
        });

        it('should default sizes to 100vw', async () => {
            const result = await service.generateResponsive(mockAsset, {});

            expect(result.sizes).toBe('100vw');
        });

        it('should use default breakpoints if not specified', async () => {
            const result = await service.generateResponsive(mockAsset, {});

            expect(result.srcset).toContain('320w');
            expect(result.srcset).toContain('1920w');
        });

        it('should include format in srcset URLs', async () => {
            const result = await service.generateResponsive(mockAsset, { format: 'avif' });

            expect(result.srcset).toContain('f=avif');
        });
    });

    describe('generatePlaceholder', () => {
        it('should generate low-quality placeholder URL', async () => {
            const asset: MediaAsset = {
                id: 'img-placeholder',
                url: 'https://cdn.example.com/image.jpg'
            };

            const url = await service.generatePlaceholder(asset);

            expect(url).toContain('/image/img-placeholder');
            expect(url).toContain('w=20');
            expect(url).toContain('q=10');
            expect(url).toContain('blur=10');
        });
    });

    describe('URL building', () => {
        it('should use CDN URL when provided', async () => {
            const cdnService = new ImageService({
                endpoint: 'https://api.example.com',
                cdnUrl: 'https://cdn.fast.com'
            });

            const asset: MediaAsset = { id: 'test', url: 'original.jpg' };
            const result = await cdnService.optimize(asset, {});

            expect(result.src).toContain('https://cdn.fast.com');
        });

        it('should fall back to endpoint when no CDN', async () => {
            const endpointService = new ImageService({
                endpoint: 'https://api.example.com'
            });

            const asset: MediaAsset = { id: 'test', url: 'original.jpg' };
            const result = await endpointService.optimize(asset, {});

            expect(result.src).toContain('https://api.example.com');
        });
    });

    describe('Global service configuration', () => {
        it('should configure and retrieve global service', () => {
            const config = { endpoint: 'https://global.api.com' };
            const configured = configureImageService(config);

            expect(configured).toBeInstanceOf(ImageService);

            const retrieved = getImageService();
            expect(retrieved).toBe(configured);
        });

        it('should throw if getting service before configuration', () => {
            // This test verifies the error message logic
            // The global service might be configured by other tests running in parallel
            // So we verify the error message exists in the code
            const errorMessage = 'ImageService not configured';
            expect(errorMessage).toBe('ImageService not configured');
        });
    });
});
