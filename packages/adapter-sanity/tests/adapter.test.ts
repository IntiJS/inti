import { describe, it, expect } from 'bun:test';
import { SanityAdapter } from '../src/index.js';
import type { IntiPage, IntiNavigation } from '@intijs/core/types';

describe('SanityAdapter', () => {
    const config = {
        projectId: 'abc123',
        dataset: 'production'
    };

    describe('constructor', () => {
        it('should create adapter with config', () => {
            const adapter = new SanityAdapter(config);
            expect(adapter.name).toBe('Sanity');
        });

        it('should use CDN for published content', () => {
            const adapter = new SanityAdapter({
                ...config,
                useCdn: true,
                draftMode: false
            });

            expect(adapter).toBeDefined();
        });
    });

    describe('parsePage', () => {
        it('should parse basic page', () => {
            const adapter = new SanityAdapter(config);
            const raw = {
                result: {
                    _id: 'page-1',
                    _type: 'page',
                    title: 'Test Page',
                    slug: { current: 'test-page' }
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.id).toBe('page-1');
            expect(page.slug).toBe('test-page');
            expect(page.title).toBe('Test Page');
        });

        it('should parse page with content sections', () => {
            const adapter = new SanityAdapter(config);
            const raw = {
                result: {
                    _id: 'page-2',
                    title: 'Page with Sections',
                    sections: [
                        {
                            _type: 'hero',
                            _key: 'hero-1',
                            heading: 'Welcome',
                            tagline: 'To our site'
                        },
                        {
                            _type: 'featureGrid',
                            _key: 'features-1',
                            features: []
                        }
                    ]
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.blocks).toHaveLength(2);
            expect(page.blocks[0].type).toBe('Hero');
            expect(page.blocks[1].type).toBe('FeatureGrid');
        });

        it('should parse portable text blocks', () => {
            const adapter = new SanityAdapter(config);
            const raw = {
                result: {
                    _id: 'page-3',
                    title: 'Rich Text Page',
                    body: [
                        {
                            _type: 'block',
                            _key: 'block-1',
                            style: 'h1',
                            children: [{ _type: 'span', text: 'Heading' }]
                        },
                        {
                            _type: 'block',
                            _key: 'block-2',
                            style: 'normal',
                            children: [{ _type: 'span', text: 'Paragraph' }]
                        }
                    ]
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.blocks).toHaveLength(2);
            expect(page.blocks[0].type).toBe('rich-text');
            expect(page.blocks[1].type).toBe('rich-text');
        });

        it('should parse images with hotspot', () => {
            const adapter = new SanityAdapter(config);
            const raw = {
                result: {
                    _id: 'page-4',
                    title: 'Image Page',
                    content: [
                        {
                            _type: 'image',
                            _key: 'img-1',
                            asset: { _ref: 'image-abc123-1200x800-jpg' },
                            alt: 'Description',
                            hotspot: { x: 0.5, y: 0.3 },
                            crop: { left: 0, right: 0, top: 0, bottom: 0 }
                        }
                    ]
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.blocks[0].type).toBe('image');
            expect(page.blocks[0].data.asset).toBeDefined();
            expect(page.blocks[0].data.hotspot).toBeDefined();
        });

        it('should parse SEO fields', () => {
            const adapter = new SanityAdapter(config);
            const raw = {
                result: {
                    _id: 'page-5',
                    title: 'Page Title',
                    seo: {
                        title: 'SEO Title',
                        description: 'SEO Description'
                    }
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.seo?.title).toBe('SEO Title');
            expect(page.seo?.description).toBe('SEO Description');
        });

        it('should handle slugs', () => {
            const adapter = new SanityAdapter(config);
            const raw = {
                result: {
                    _id: 'page-6',
                    title: 'Slug Test',
                    slug: { current: 'my-custom-slug', _type: 'slug' }
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.slug).toBe('my-custom-slug');
        });
    });

    describe('parseNavigation', () => {
        it('should parse navigation items', () => {
            const adapter = new SanityAdapter(config);
            const raw = {
                result: {
                    items: [
                        { label: 'Home', link: { url: '/' } },
                        { label: 'About', link: { internal: { slug: { current: 'about' } } } }
                    ]
                }
            };

            const nav: IntiNavigation = adapter.parseNavigation(raw);

            expect(nav.items).toHaveLength(2);
            expect(nav.items[0].label).toBe('Home');
            expect(nav.items[1].url).toBe('about');
        });
    });

    describe('buildPageQuery', () => {
        it('should generate GROQ query for content type', () => {
            const adapter = new SanityAdapter(config);
            const query = adapter.buildPageQuery('page');

            expect(query).toContain('_type == "page"');
            expect(query).toContain('slug');
            expect(query).toContain('content');
            expect(query).toContain('seo');
        });

        it('should include slug filter when provided', () => {
            const adapter = new SanityAdapter(config);
            const query = adapter.buildPageQuery('page', 'home');

            expect(query).toContain('slug.current == "home"');
        });

        it('should filter drafts in published mode', () => {
            const adapter = new SanityAdapter({
                ...config,
                draftMode: false
            });
            const query = adapter.buildPageQuery('page');

            expect(query).toContain('!(_id in path("drafts.**"))');
        });
    });

    describe('getQueryUrl', () => {
        it('should encode query parameters', () => {
            const adapter = new SanityAdapter(config);
            const query = '*[_type == "page"]';
            const url = adapter.getQueryUrl(query);

            expect(url).toContain(encodeURIComponent(query));
            expect(url).toContain('perspective=published');
        });

        it('should use preview perspective in draft mode', () => {
            const adapter = new SanityAdapter({
                ...config,
                draftMode: true
            });
            const url = adapter.getQueryUrl('*[]');

            expect(url).toContain('perspective=previewDrafts');
        });
    });

    describe('introspect', () => {
        it('should return mock schema', async () => {
            const adapter = new SanityAdapter(config);
            const schema = await adapter.introspect();

            expect(schema.source).toBe('sanity');
            expect(schema.collections).toBeArray();
            expect(schema.collections.length).toBeGreaterThan(0);
        });
    });
});
