import { describe, it, expect } from 'bun:test';
import type { IntiBlock, IntiPage, IntiNavigation, IntiSchema, IntiConfig } from '../src/types/index.js';

describe('Core Types', () => {
    describe('IntiBlock', () => {
        it('should create a valid block', () => {
            const block: IntiBlock = {
                type: 'hero',
                id: 'block-1',
                data: { title: 'Hello', subtitle: 'World' }
            };

            expect(block.type).toBe('hero');
            expect(block.id).toBe('block-1');
            expect(block.data.title).toBe('Hello');
        });

        it('should allow block without id', () => {
            const block: IntiBlock = {
                type: 'text',
                data: { content: 'Some text' }
            };

            expect(block.type).toBe('text');
            expect(block.id).toBeUndefined();
        });

        it('should accept any data shape', () => {
            const block: IntiBlock = {
                type: 'complex',
                data: {
                    nested: { deep: { value: 123 } },
                    array: [1, 2, 3],
                    boolean: true
                }
            };

            expect(block.data.nested.deep.value).toBe(123);
            expect(block.data.array).toHaveLength(3);
        });
    });

    describe('IntiPage', () => {
        it('should create a valid page', () => {
            const page: IntiPage = {
                id: 'page-1',
                slug: 'home',
                title: 'Home Page',
                blocks: [
                    { type: 'hero', data: { title: 'Welcome' } }
                ]
            };

            expect(page.id).toBe('page-1');
            expect(page.slug).toBe('home');
            expect(page.title).toBe('Home Page');
            expect(page.blocks).toHaveLength(1);
        });

        it('should support optional SEO fields', () => {
            const page: IntiPage = {
                id: 'page-2',
                slug: 'about',
                title: 'About Us',
                blocks: [],
                seo: {
                    title: 'About Our Company',
                    description: 'Learn more about us',
                    image: 'https://example.com/og.jpg'
                }
            };

            expect(page.seo?.title).toBe('About Our Company');
            expect(page.seo?.description).toBe('Learn more about us');
            expect(page.seo?.image).toBe('https://example.com/og.jpg');
        });

        it('should handle empty blocks array', () => {
            const page: IntiPage = {
                id: 'page-3',
                slug: 'empty',
                title: 'Empty Page',
                blocks: []
            };

            expect(page.blocks).toBeArray();
            expect(page.blocks).toHaveLength(0);
        });
    });

    describe('IntiNavigation', () => {
        it('should create valid navigation', () => {
            const nav: IntiNavigation = {
                items: [
                    { label: 'Home', url: '/' },
                    { label: 'About', url: '/about' }
                ]
            };

            expect(nav.items).toHaveLength(2);
            expect(nav.items[0].label).toBe('Home');
            expect(nav.items[1].url).toBe('/about');
        });

        it('should support nested navigation', () => {
            const nav: IntiNavigation = {
                items: [
                    {
                        label: 'Products',
                        url: '/products',
                        children: [
                            { label: 'Category A', url: '/products/a' },
                            { label: 'Category B', url: '/products/b' }
                        ]
                    }
                ]
            };

            expect(nav.items[0].children).toHaveLength(2);
            expect(nav.items[0].children?.[0].label).toBe('Category A');
        });
    });

    describe('IntiSchema', () => {
        it('should create valid schema with typed data', () => {
            interface ArticleData {
                title: string;
                content: string;
            }

            const schema: IntiSchema<ArticleData> = {
                id: 'article-1',
                type: 'article',
                slug: 'my-article',
                data: {
                    title: 'My Article',
                    content: 'Article content'
                },
                meta: {
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    source: 'cms'
                }
            };

            expect(schema.data.title).toBe('My Article');
            expect(schema.meta?.source).toBe('cms');
        });
    });

    describe('IntiConfig', () => {
        it('should accept valid configuration', () => {
            const config: IntiConfig = {
                adapter: 'strapi',
                adapterConfig: {
                    endpoint: 'https://api.strapi.io',
                    token: 'secret'
                },
                collections: ['articles', 'pages'],
                outputDir: './src/lib/inti',
                realtime: {
                    enabled: true,
                    endpoint: 'wss://realtime.api.io'
                }
            };

            expect(config.adapter).toBe('strapi');
            expect(config.collections).toContain('articles');
            expect(config.realtime?.enabled).toBe(true);
        });
    });
});
