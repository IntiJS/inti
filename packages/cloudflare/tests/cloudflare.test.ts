/**
 * What does not need the Cloudflare runtime. D1, R2 and the Durable Objects are tested
 * for real, in workerd, in scripts/cloudflare-check.mjs.
 */

import { describe, test, expect } from 'bun:test';

import { cloudflareImageSrcset, cloudflareImageUrl, createCloudflareImageService } from '../src/images.js';
import { createWorkersAiProvider, WORKERS_AI_DEFAULT_MODEL } from '../src/ai.js';
import { detectImageType } from '../src/r2.js';
import { compose, defineVocabulary } from '../../genui/src/index.js';

describe('cloudflareImageUrl', () => {
    test('a path on the site itself', () => {
        expect(cloudflareImageUrl('/images/a.jpg', { width: 800, fit: 'cover', quality: 85 })).toBe(
            '/cdn-cgi/image/width=800,fit=cover,quality=85,format=auto/images/a.jpg'
        );
    });

    test('an image from another origin, in the given zone', () => {
        expect(cloudflareImageUrl('https://cms.x.com/a.jpg', { width: 320 }, { zone: 'https://x.com/' })).toBe(
            'https://x.com/cdn-cgi/image/width=320,format=auto/https://cms.x.com/a.jpg'
        );
    });

    test('rejects anything that is not a transformable image', () => {
        for (const src of ['javascript:alert(1)', 'data:image/png;base64,x', '//evil.com/a.jpg', 'a.jpg']) {
            expect(() => cloudflareImageUrl(src, {})).toThrow();
        }
    });

    test('an odd value does not slip into the URL options', () => {
        expect(cloudflareImageUrl('/a.jpg', { width: NaN, height: Infinity })).toBe('/cdn-cgi/image/format=auto/a.jpg');
    });

    test('srcset with the given widths', () => {
        expect(cloudflareImageSrcset('/a.jpg', {}, { breakpoints: [320, 640] })).toBe(
            '/cdn-cgi/image/width=320,format=auto/a.jpg 320w, /cdn-cgi/image/width=640,format=auto/a.jpg 640w'
        );
    });

    test('the service has what IntiImage calls', async () => {
        const service = createCloudflareImageService();
        const asset = { id: '1', url: '/a.jpg', width: 1000, height: 500, alt: 'A' };

        expect((await service.optimize(asset, { width: 100 })).src).toContain('width=100');

        const responsive = await service.generateResponsive(asset, { breakpoints: [320] });
        expect(responsive.srcset).toContain('320w');
        expect(responsive.alt).toBe('A');
        expect(await service.generatePlaceholder(asset)).toContain('width=32');
    });
});

describe('createWorkersAiProvider', () => {
    const vocabulary = defineVocabulary({ hero: { fields: { heading: { type: 'string' } } } });

    function ai(response: unknown) {
        const calls: any[] = [];
        return {
            calls,
            binding: {
                run: async (model: string, input: unknown) => {
                    calls.push({ model, input });
                    return { response };
                }
            } as unknown as Ai
        };
    }

    test('calls the model in JSON mode with the vocabulary schema', async () => {
        const { binding, calls } = ai({ blocks: [{ nativeType: 'hero', data: { heading: 'Hello' } }] });

        const result = await compose({ prompt: 'x', vocabulary, provider: createWorkersAiProvider(binding) });

        expect(result.blocks[0].data.heading).toBe('Hello');
        expect(calls[0].model).toBe(WORKERS_AI_DEFAULT_MODEL);
        expect(calls[0].input.response_format.type).toBe('json_schema');
        expect(JSON.stringify(calls[0].input.response_format.json_schema)).toContain('"const":"hero"');
    });

    test('whatever the model returns still goes through validation', async () => {
        const { binding } = ai({ blocks: [{ nativeType: 'made-up', data: {} }, { nativeType: 'hero', data: { heading: 'javascript:alert(1)' } }] });
        const result = await compose({ prompt: 'x', vocabulary, provider: createWorkersAiProvider(binding) });
        expect(result.blocks).toEqual([{ nativeType: 'hero', data: {} }]);
    });

    test('accepts the response as JSON text', async () => {
        const { binding } = ai('{"blocks":[]}');
        expect(await createWorkersAiProvider(binding).generate({ system: '', prompt: '', schema: {} })).toEqual({ blocks: [] });
    });

    test('non-JSON text or an empty response is a clear error', async () => {
        const generate = (response: unknown) => createWorkersAiProvider(ai(response).binding).generate({ system: '', prompt: '', schema: {} });
        await expect(generate('no json')).rejects.toThrow('malformed');
        await expect(generate(undefined)).rejects.toThrow('no response');
    });

    test('does not implement streaming: Workers AI JSON mode does not support it', () => {
        expect('stream' in createWorkersAiProvider(ai({}).binding)).toBe(false);
    });
});

describe('detectImageType', () => {
    const bytes = (...values: number[]) => new Uint8Array([...values, ...new Array(16).fill(0)]);

    test('recognizes the accepted formats by their bytes', () => {
        expect(detectImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.contentType).toBe('image/png');
        expect(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0))?.contentType).toBe('image/jpeg');
        expect(detectImageType(bytes(0x47, 0x49, 0x46, 0x38))?.contentType).toBe('image/gif');
    });

    test('HTML or SVG does not pass even if it claims to be an image', () => {
        const text = (value: string) => new TextEncoder().encode(value);
        expect(detectImageType(text('<html><script>alert(1)</script></html>'))).toBeNull();
        expect(detectImageType(text('<svg onload="alert(1)"></svg>'))).toBeNull();
    });
});
