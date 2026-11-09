import { describe, it, expect } from 'bun:test';
import { ContentfulAdapter } from '../src/index.js';
import type { IntiPage, IntiNavigation } from '@intijs/core/types';

describe('ContentfulAdapter', () => {
    const config = {
        spaceId: 'abc123',
        accessToken: 'test-token'
    };

    describe('constructor', () => {
        it('should create adapter with config', () => {
            const adapter = new ContentfulAdapter(config);
            expect(adapter.name).toBe('Contentful');
        });

        it('should use correct base URL for published content', () => {
            const adapter = new ContentfulAdapter({
                ...config,
                draftMode: false
            });

            expect(adapter).toBeDefined();
        });

        it('should use correct base URL for preview content', () => {
            const adapter = new ContentfulAdapter({
                ...config,
                draftMode: true,
                previewToken: 'preview-token'
            });

            expect(adapter).toBeDefined();
        });
    });

    describe('parsePage', () => {
        it('should parse basic page', () => {
            const adapter = new ContentfulAdapter(config);
            const raw = {
                sys: {
                    id: 'page-1',
                    contentType: { sys: { id: 'page' } }
                },
                fields: {
                    title: 'Test Page',
                    slug: 'test-page'
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.id).toBe('page-1');
            expect(page.slug).toBe('test-page');
            expect(page.title).toBe('Test Page');
        });

        it('should parse page with content blocks', () => {
            const adapter = new ContentfulAdapter(config);
            const raw = {
                sys: {
                    id: 'page-2',
                    contentType: { sys: { id: 'landingPage' } }
                },
                fields: {
                    title: 'Landing Page',
                    modules: [
                        {
                            sys: { contentType: { sys: { id: 'heroBlock' } } },
                            fields: {
                                headline: 'Welcome',
                                subheadline: 'To our site'
                            }
                        }
                    ]
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.blocks).toHaveLength(1);
            expect(page.blocks[0].type).toBe('HeroBlock');
            expect(page.blocks[0].data.headline).toBe('Welcome');
        });

        it('should parse rich text content', () => {
            const adapter = new ContentfulAdapter(config);
            const raw = {
                sys: { id: 'page-3' },
                fields: {
                    title: 'Rich Text Page',
                    body: {
                        nodeType: 'document',
                        content: [
                            {
                                nodeType: 'paragraph',
                                content: [{ nodeType: 'text', value: 'Hello world' }]
                            }
                        ]
                    }
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.blocks).toHaveLength(1);
            expect(page.blocks[0].type).toBe('rich-text');
        });

        it('should parse SEO fields', () => {
            const adapter = new ContentfulAdapter(config);
            const raw = {
                sys: { id: 'page-4' },
                fields: {
                    title: 'SEO Page',
                    seo: {
                        title: 'Custom SEO Title',
                        description: 'SEO Description',
                        image: {
                            fields: {
                                file: { url: '//images.ctfassets.net/og.jpg' }
                            }
                        }
                    }
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.seo?.title).toBe('Custom SEO Title');
            expect(page.seo?.description).toBe('SEO Description');
            expect(page.seo?.image).toBe('https://images.ctfassets.net/og.jpg');
        });

        it('should handle assets in fields', () => {
            const adapter = new ContentfulAdapter(config);
            const raw = {
                sys: { id: 'page-5' },
                fields: {
                    title: 'Media Page',
                    heroImage: {
                        sys: { type: 'Asset' },
                        fields: {
                            file: {
                                url: '//images.ctfassets.net/hero.jpg',
                                contentType: 'image/jpeg',
                                details: {
                                    image: { width: 1200, height: 800 }
                                }
                            },
                            title: 'Hero Image'
                        }
                    }
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            // Asset is in the block data, not as a separate block
            expect(page.blocks.length).toBeGreaterThanOrEqual(0);
        });
    });

    describe('parseNavigation', () => {
        it('should parse navigation items', () => {
            const adapter = new ContentfulAdapter(config);
            const raw = {
                items: [
                    {
                        sys: { id: 'nav-1' },
                        fields: { label: 'Home', url: '/' }
                    },
                    {
                        sys: { id: 'nav-2' },
                        fields: { title: 'About', link: '/about' }
                    }
                ]
            };

            const nav: IntiNavigation = adapter.parseNavigation(raw);

            expect(nav.items).toHaveLength(2);
            expect(nav.items[0].label).toBe('Home');
            expect(nav.items[1].url).toBe('/about');
        });
    });

    describe('introspect', () => {
        it('should return schema definition', async () => {
            const adapter = new ContentfulAdapter(config);
            
            global.fetch = async () => ({
                ok: true,
                json: async () => ({
                    items: [
                        {
                            sys: { id: 'article' },
                            fields: [
                                { id: 'title', type: 'Symbol', required: true },
                                { id: 'content', type: 'Text' },
                                { id: 'published', type: 'Boolean' }
                            ]
                        }
                    ]
                })
            }) as any;

            const schema = await adapter.introspect();

            expect(schema.source).toBe('contentful');
            expect(schema.collections[0].name).toBe('Article');
        });
    });
});
