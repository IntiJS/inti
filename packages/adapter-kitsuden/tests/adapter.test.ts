import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { KitsudenAdapter } from '../src/index.js';
import { isVersionRequest, compatibleVersionResponse } from './helpers/version.js';

// ============================================
// Fixtures: what GET /pages/:idOrSlug returns
// ============================================

const PAGE = {
    id: '11111111-2222-3333-4444-555555555555',
    title: 'Home',
    slug: 'home',
    description: 'The front page',
    status: 'published' as const,
    metaTitle: 'Home · Kitsuden',
    metaDescription: 'Description for search engines',
    ogImageId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    layout: 'default',
    isHomepage: true,
    requireAuth: false,
    updatedAt: '2026-09-01T10:00:00.000Z',
    blocks: [
        {
            id: 'b1',
            pageId: '11111111-2222-3333-4444-555555555555',
            type: 'hero',
            name: 'Cover',
            sortOrder: 0,
            content: { headline: 'Welcome', primaryButton: { label: 'Enter', url: '/enter' } }
        },
        {
            id: 'b2',
            pageId: '11111111-2222-3333-4444-555555555555',
            type: 'richtext',
            name: null,
            sortOrder: 5,
            content: { text: '<p>Hello</p>' }
        }
    ]
};

const BLOCK_TYPES = [
    {
        type: 'hero',
        name: 'Hero Section',
        category: 'layout',
        description: 'Large banner',
        schema: {
            headline: { type: 'string', required: true },
            alignment: { type: 'enum', options: ['left', 'center'], default: 'center' },
            focalPoint: { type: 'object', description: 'Smart cropping' },
            mediaId: { type: 'string' }
        }
    },
    {
        type: 'tier-list',
        name: 'Tier List',
        category: 'interactive',
        schema: { tierListId: { type: 'string', required: true } }
    }
];

let calls: Array<{ url: string; method: string; body?: any }> = [];
let originalFetch: typeof fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: any }) {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (isVersionRequest(url)) return compatibleVersionResponse();
        calls.push({
            url,
            method: init?.method ?? 'GET',
            body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        const result = handler(url, init);
        return new Response(JSON.stringify(result.body ?? {}), {
            status: result.status ?? 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }) as typeof fetch;
}

function adapter(extra: Record<string, unknown> = {}) {
    return new KitsudenAdapter({ endpoint: 'https://cms.test', ...extra });
}

beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

// ============================================
// Reading
// ============================================

describe('KitsudenAdapter.parsePage', () => {
    test('turns the block rows into IntiBlocks keeping uuid and position', () => {
        const page = adapter().parsePage(PAGE);

        expect(page.id).toBe(PAGE.id);
        expect(page.slug).toBe('home');
        expect(page.title).toBe('Home');
        expect(page.blocks).toHaveLength(2);

        expect(page.blocks[0]).toMatchObject({
            id: 'b1',
            type: 'hero',
            data: { headline: 'Welcome' }
        });
        // The block's uuid and the page's travel in meta: they are what the write needs so as
        // not to depend on the position alone.
        expect(page.blocks[0].meta).toMatchObject({ documentId: PAGE.id, index: 0, total: 2 });
        expect(page.blocks[1].meta).toMatchObject({ index: 1, total: 2, label: 'richtext' });
    });

    test('a block without content does not break the render', () => {
        const page = adapter().parsePage({
            ...PAGE,
            blocks: [{ id: 'b9', type: 'divider', sortOrder: 0, content: null }]
        });

        expect(page.blocks[0].data).toEqual({});
    });

    test('a payload that is not a page is rejected instead of inventing one', () => {
        // The previous adapter returned a "fallback" page with a fake title: the site was
        // published with invented content and no visible error.
        expect(() => adapter().parsePage({} as any)).toThrow(/Invalid page payload/);
    });
});

describe('KitsudenAdapter SEO', () => {
    test('prefers the meta fields and builds the social image from ogImageId', () => {
        const seo = adapter().parsePage(PAGE).seo!;

        expect(seo.title).toBe('Home · Kitsuden');
        expect(seo.description).toBe('Description for search engines');
        expect(seo.image).toBe(`https://cms.test/api/media/preset/${PAGE.ogImageId}/large`);
        expect(seo.robots).toBeUndefined();
    });

    test("falls back to the page's title and description when there is no meta", () => {
        const seo = adapter().parsePage({ ...PAGE, metaTitle: null, metaDescription: '  ' }).seo!;

        expect(seo.title).toBe('Home');
        expect(seo.description).toBe('The front page');
    });

    test('a draft and a private page come out with noindex', () => {
        const draft = adapter().parsePage({ ...PAGE, status: 'draft' }).seo!;
        const privatePage = adapter().parsePage({ ...PAGE, requireAuth: true }).seo!;

        expect(draft.robots).toEqual({ index: false, follow: false });
        expect(privatePage.robots).toEqual({ index: false, follow: false });
    });

    test("the image's preset is configurable", () => {
        const seo = adapter({ mediaPreset: 'hero' }).parsePage(PAGE).seo!;
        expect(seo.image).toContain('/hero');
    });
});

describe('KitsudenAdapter.parseNavigation', () => {
    test('the home page hangs from the root and the rest from their slug', () => {
        const nav = adapter().parseNavigation({
            docs: [
                { id: '1', title: 'Home', slug: 'home', isHomepage: true },
                { id: '2', title: 'Guides', slug: 'guides' }
            ],
            totalDocs: 2,
            limit: 50,
            offset: 0
        });

        expect(nav.items).toEqual([
            { label: 'Home', url: '/' },
            { label: 'Guides', url: '/guides' }
        ]);
    });
});

// ============================================
// Listing and search
// ============================================

describe('KitsudenAdapter.listPages', () => {
    test('walks the pages and returns the real date for <lastmod>', async () => {
        mockFetch((url) => {
            const offset = new URL(url).searchParams.get('offset');
            if (offset === '0') {
                return {
                    body: {
                        docs: Array.from({ length: 100 }, (_, i) => ({
                            id: `p${i}`,
                            title: `Page ${i}`,
                            slug: `page-${i}`,
                            updatedAt: '2026-08-30T00:00:00.000Z'
                        })),
                        totalDocs: 101,
                        limit: 100,
                        offset: 0
                    }
                };
            }
            return {
                body: {
                    docs: [
                        {
                            id: 'p100',
                            title: 'Last',
                            slug: 'last',
                            updatedAt: '2026-09-02T00:00:00.000Z'
                        }
                    ],
                    totalDocs: 101,
                    limit: 100,
                    offset: 100
                }
            };
        });

        const pages = await adapter().listPages();

        expect(pages).toHaveLength(101);
        expect(pages[100]).toEqual({
            slug: 'last',
            title: 'Last',
            updatedAt: '2026-09-02T00:00:00.000Z'
        });
        expect(calls).toHaveLength(2);
        expect(calls[0].url).toContain('status=published');
    });
});

describe('KitsudenAdapter.searchEntries', () => {
    test('searches pages by text', async () => {
        mockFetch(() => ({
            body: {
                docs: [{ id: 'p1', title: 'Getting started guide', slug: 'guide', isHomepage: false }],
                totalDocs: 1,
                limit: 20,
                offset: 0
            }
        }));

        const results = await adapter().searchEntries('pages', 'guíde');

        expect(results).toEqual([{ id: 'p1', title: 'Getting started guide', subtitle: '/guide' }]);
        expect(calls[0].url).toContain('search=gu');
    });

    test('a collection the API does not expose returns empty instead of failing', async () => {
        mockFetch(() => ({ body: {} }));

        expect(await adapter().searchEntries('products', 'x')).toEqual([]);
        expect(calls).toHaveLength(0);
    });
});

// ============================================
// Introspection
// ============================================

describe('KitsudenAdapter.introspect', () => {
    test('generates the Page collection and one per palette type', async () => {
        mockFetch(() => ({ body: BLOCK_TYPES }));

        const schema = await adapter().introspect();

        expect(schema.source).toBe('kitsuden');
        expect(schema.collections.map((c) => c.name)).toEqual(['Page', 'HeroBlock', 'TierListBlock']);
    });

    test('an empty palette does not fail: it returns only the Page collection', async () => {
        mockFetch(() => ({ body: [] }));

        const schema = await adapter().introspect();

        expect(schema.collections.map((c) => c.name)).toEqual(['Page']);
    });

    test('each block collection carries the type parsePage assigns', async () => {
        // It is what lets `inti sync` generate IntiTypedBlock: the collection's name
        // (`HeroBlock`) does not serve to discriminate blocks.
        mockFetch(() => ({ body: BLOCK_TYPES }));

        const schema = await adapter().introspect();
        const types = Object.fromEntries(schema.collections.map((c) => [c.name, c.blockType]));

        expect(types).toEqual({ Page: undefined, HeroBlock: 'hero', TierListBlock: 'tier-list' });

        const page = adapter().parsePage(PAGE);
        expect(page.blocks[0].type).toBe(types.HeroBlock);
    });

    test("translates Kitsuden's field types to Inti's", async () => {
        mockFetch(() => ({ body: BLOCK_TYPES }));

        const schema = await adapter().introspect();
        const hero = schema.collections.find((c) => c.name === 'HeroBlock')!;

        expect(hero.fields).toEqual([
            { name: 'headline', type: 'string', required: true },
            // enum is a string with options: no type of its own in Inti
            { name: 'alignment', type: 'string' },
            { name: 'focalPoint', type: 'json', description: 'Smart cropping' },
            { name: 'mediaId', type: 'string' }
        ]);
    });

    test('reads the palette as Kitsuden returns it: wrapped in `blockTypes`', async () => {
        // Real shape of `GET /api/page-builder/block-types` (seen against the API on 2026-10-13):
        // with a bare array in the mock, the adapter read 0 types in production.
        mockFetch(() => ({ body: { blockTypes: BLOCK_TYPES } }));

        const types = await adapter().blockTypes();

        expect(types).toHaveLength(BLOCK_TYPES.length);
        expect(types.map((t) => t.type)).toEqual(BLOCK_TYPES.map((t) => t.type));
    });

    test('the palette is requested once and reused', async () => {
        mockFetch(() => ({ body: BLOCK_TYPES }));

        const a = adapter();
        await a.introspect();
        await a.introspect();

        expect(calls.filter((l) => l.url.includes('/block-types'))).toHaveLength(1);
    });
});

// ============================================
// Configuration
// ============================================

describe('KitsudenAdapter configuration', () => {
    test('an endpoint that is not an absolute origin is rejected when building', () => {
        expect(() => new KitsudenAdapter({ endpoint: 'cms.test' })).toThrow(/absolute origin/);
    });

    test("the kon's mount point is configurable", async () => {
        mockFetch(() => ({ body: PAGE }));

        await adapter({ mountPath: '/api/pages-kon' }).fetchPage('home');

        expect(calls[0].url).toBe('https://cms.test/api/pages-kon/pages/home');
    });

    test('an option present but undefined does not override the default', async () => {
        // That is how `getWriteAdapter` builds it when INTI_KITSUDEN_MOUNT_PATH is not set: the
        // first write of a page used to blow up with
        // "Cannot read properties of undefined (reading 'replace')".
        mockFetch(() => ({ body: PAGE }));

        await adapter({ mountPath: undefined, status: undefined }).fetchPage('home');

        expect(calls[0].url).toBe('https://cms.test/api/page-builder/pages/home');
    });
});
