import { describe, it, expect } from 'bun:test';
import { StrapiAdapter } from '../src/index.js';
import type { IntiPage, IntiNavigation } from '@intijs/core/types';

describe('StrapiAdapter', () => {
    const config = {
        endpoint: 'https://api.strapi.io',
        apiToken: 'test-token'
    };

    describe('constructor', () => {
        it('should create adapter with config', () => {
            const adapter = new StrapiAdapter(config);
            expect(adapter.name).toBe('Strapi');
        });

        it('should apply default values', () => {
            const adapter = new StrapiAdapter({ endpoint: 'https://api.strapi.io' });
            expect(adapter).toBeDefined();
        });
    });

    describe('parsePage', () => {
        it('should parse basic page', () => {
            const adapter = new StrapiAdapter(config);
            const raw = {
                data: {
                    id: 1,
                    attributes: {
                        title: 'Test Page',
                        slug: 'test-page',
                        content: []
                    }
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.id).toBe('1');
            expect(page.slug).toBe('test-page');
            expect(page.title).toBe('Test Page');
            expect(page.blocks).toBeArray();
        });

        it('should parse page with blocks', () => {
            const adapter = new StrapiAdapter(config);
            const raw = {
                data: {
                    id: 2,
                    attributes: {
                        title: 'Page with Blocks',
                        slug: 'blocks',
                        blocks: [
                            {
                                __component: 'blocks.hero',
                                title: 'Hero Title',
                                subtitle: 'Hero Subtitle'
                            },
                            {
                                __component: 'blocks.text',
                                content: 'Some text'
                            }
                        ]
                    }
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.blocks).toHaveLength(2);
            expect(page.blocks[0].type).toBe('hero');
            expect(page.blocks[0].data.title).toBe('Hero Title');
            expect(page.blocks[1].type).toBe('text');
        });

        it('should parse SEO fields', () => {
            const adapter = new StrapiAdapter(config);
            const raw = {
                data: {
                    id: 3,
                    attributes: {
                        title: 'SEO Page',
                        slug: 'seo',
                        seo: {
                            metaTitle: 'Custom SEO Title',
                            metaDescription: 'SEO Description',
                            metaImage: {
                                data: {
                                    attributes: {
                                        url: 'https://cdn.strapi.io/og.jpg'
                                    }
                                }
                            }
                        }
                    }
                }
            };

            const page: IntiPage = adapter.parsePage(raw);

            expect(page.seo?.title).toBe('Custom SEO Title');
            expect(page.seo?.description).toBe('SEO Description');
            expect(page.seo?.image).toBe('https://cdn.strapi.io/og.jpg');
        });

        it('should handle media in blocks', () => {
            const adapter = new StrapiAdapter(config);
            const raw = {
                data: {
                    id: 4,
                    attributes: {
                        title: 'Media Page',
                        blocks: [
                            {
                                __component: 'blocks.gallery',
                                images: {
                                    data: [
                                        {
                                            id: 1,
                                            attributes: {
                                                url: '/uploads/image1.jpg',
                                                alternativeText: 'Image 1',
                                                width: 800,
                                                height: 600
                                            }
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                }
            };

            const page: IntiPage = adapter.parsePage(raw);
            const galleryBlock = page.blocks[0];

            expect(galleryBlock.data.images).toBeArray();
            expect(galleryBlock.data.images[0].url).toBe('/uploads/image1.jpg');
            expect(galleryBlock.data.images[0].alt).toBe('Image 1');
        });
    });

    describe('parseNavigation', () => {
        it('should parse navigation items', () => {
            const adapter = new StrapiAdapter(config);
            const raw = {
                data: [
                    {
                        attributes: {
                            label: 'Home',
                            url: '/',
                            children: { data: [] }
                        }
                    },
                    {
                        attributes: {
                            title: 'About',
                            slug: 'about',
                            children: { data: [] }
                        }
                    }
                ]
            };

            const nav: IntiNavigation = adapter.parseNavigation(raw);

            expect(nav.items).toHaveLength(2);
            expect(nav.items[0].label).toBe('Home');
            expect(nav.items[1].url).toBe('/about');
        });

        it('should handle nested navigation', () => {
            const adapter = new StrapiAdapter(config);
            const raw = {
                data: [
                    {
                        attributes: {
                            label: 'Products',
                            url: '/products',
                            children: {
                                data: [
                                    { attributes: { label: 'Category A', url: '/cat-a' } },
                                    { attributes: { label: 'Category B', url: '/cat-b' } }
                                ]
                            }
                        }
                    }
                ]
            };

            const nav: IntiNavigation = adapter.parseNavigation(raw);

            expect(nav.items[0].children).toHaveLength(2);
            expect(nav.items[0].children?.[0].label).toBe('Category A');
        });
    });

    describe('introspect', () => {
        it('should return schema definition', async () => {
            const adapter = new StrapiAdapter(config);
            
            // Mock fetch
            global.fetch = async () => ({
                ok: true,
                json: async () => ({
                    data: [
                        {
                            uid: 'api::article.article',
                            info: { singularName: 'article' },
                            attributes: {
                                title: { type: 'string', required: true },
                                content: { type: 'richtext' },
                                published: { type: 'boolean' },
                                category: {
                                    type: 'relation',
                                    relation: 'manyToOne'
                                }
                            }
                        }
                    ]
                })
            }) as any;

            const schema = await adapter.introspect();

            expect(schema.source).toBe('strapi');
            expect(schema.collections).toBeArray();
            expect(schema.collections[0].name).toBe('Article');
            expect(schema.collections[0].fields).toBeArray();
        });
    });

    describe('buildQueryParams', () => {
        it('should include populate parameter', () => {
            const adapter = new StrapiAdapter({
                ...config,
                populate: '*'
            });

            const params = adapter.buildQueryParams();
            expect(params.populate).toBe('*');
        });

        it('should handle array populate', () => {
            const adapter = new StrapiAdapter({
                ...config,
                populate: ['images', 'category']
            });

            const params = adapter.buildQueryParams();
            expect(params.populate).toBe('images,category');
        });

        it('should include publicationState for draft mode', () => {
            const adapter = new StrapiAdapter({
                ...config,
                draftMode: true
            });

            const params = adapter.buildQueryParams();
            expect(params.publicationState).toBe('preview');
        });
    });
});
