import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { WordPressAdapter } from '../src/index.js';
import { globalSchemaCache } from '@intijs/core/adapters';

// ============================================
// Fixtures: WP post with ACF Flexible Content
// ============================================

const wpPost = {
    id: 123,
    slug: 'home',
    type: 'page',
    modified: '2026-07-01T10:00:00',
    title: { rendered: 'Home' },
    acf: {
        seo_description: 'A home page',
        content_blocks: [
            {
                acf_fc_layout: 'hero_banner',
                heading: 'Welcome',
                subheading: 'The best page',
                cta: { label: 'Get started', url: '/start' }
            },
            {
                acf_fc_layout: 'two_col_text',
                left: 'Left column',
                right: 'Right column'
            }
        ]
    }
};

// ============================================
// fetch mock that records calls
// ============================================

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let originalFetch: typeof fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: any }) {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });
        // The inti-bridge companion plugin is NOT installed in these tests
        // (the bridge tests mock it explicitly)
        if (url.includes('/wp-json/inti/v1/')) {
            return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        const result = handler(url, init);
        const status = result.status ?? 200;
        return new Response(JSON.stringify(result.body ?? {}), {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
    }) as typeof fetch;
}

beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

// ============================================
// Tests: Parsing (Agnostic Contract)
// ============================================

describe('WordPressAdapter.parsePage', () => {
    const adapter = new WordPressAdapter({ endpoint: 'https://cms.test.com' });

    test('maps a WP post with Flexible Content to an IntiPage', () => {
        const page = adapter.parsePage(wpPost as any);

        expect(page.id).toBe('123');
        expect(page.slug).toBe('home');
        expect(page.title).toBe('Home');
        expect(page.blocks).toHaveLength(2);
    });

    test('converts snake_case acf_fc_layout to a PascalCase type', () => {
        const page = adapter.parsePage(wpPost as any);

        expect(page.blocks[0].type).toBe('HeroBanner');
        expect(page.blocks[1].type).toBe('TwoColText');
    });

    test('honors an explicit blockTypeMap', () => {
        const mapped = new WordPressAdapter({
            endpoint: 'https://cms.test.com',
            blockTypeMap: { hero_banner: 'Hero' }
        });

        const page = mapped.parsePage(wpPost as any);
        expect(page.blocks[0].type).toBe('Hero');
    });

    test('block data excludes acf_fc_layout and meta carries index and documentId', () => {
        const page = adapter.parsePage(wpPost as any);
        const hero = page.blocks[0];

        expect(hero.data.acf_fc_layout).toBeUndefined();
        expect(hero.data.heading).toBe('Welcome');
        expect(hero.meta?.documentId).toBe('123');
        expect(hero.meta?.index).toBe(0);
        expect(hero.meta?.total).toBe(2);
    });

    test('an invalid payload uses the resilient fallback without throwing', () => {
        const page = adapter.parsePage(null as any);

        expect(page.title).toBe('Inti System Fallback');
        expect(page.blocks).toEqual([]);
    });
});

// ============================================
// Tests: Write-Back (read-modify-write)
// ============================================

describe('WordPressAdapter.updateBlockField', () => {
    const adapter = new WordPressAdapter({
        endpoint: 'https://cms.test.com',
        username: 'editor',
        appPassword: 'aaaa bbbb cccc dddd'
    });

    test('patches the block field and sends the whole ACF array back', async () => {
        let posted: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'POST') {
                posted = JSON.parse(String(init.body));
                return { body: { id: 123 } };
            }
            return { body: wpPost };
        });

        const result = await adapter.updateBlockField('123', 0, 'heading', 'Hello World');

        expect(result.success).toBe(true);
        expect(result.source).toBe('wordpress');

        // The POST carries the acf object with the FULL array (ACF REST requirement)
        expect(posted.acf.content_blocks).toHaveLength(2);
        expect(posted.acf.content_blocks[0].heading).toBe('Hello World');
        // The layout is preserved (without it, ACF drops the block)
        expect(posted.acf.content_blocks[0].acf_fc_layout).toBe('hero_banner');
        // The other blocks stay intact
        expect(posted.acf.content_blocks[1].left).toBe('Left column');
    });

    test('supports dot-paths for nested fields (ACF groups)', async () => {
        let posted: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'POST') {
                posted = JSON.parse(String(init.body));
                return { body: { id: 123 } };
            }
            return { body: wpPost };
        });

        const result = await adapter.updateBlockField('123', 0, 'cta.label', 'Buy now');

        expect(result.success).toBe(true);
        expect(posted.acf.content_blocks[0].cta.label).toBe('Buy now');
        expect(posted.acf.content_blocks[0].cta.url).toBe('/start');
    });

    test('blockIndex -1 updates a page-level ACF field', async () => {
        let posted: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'POST') {
                posted = JSON.parse(String(init.body));
                return { body: { id: 123 } };
            }
            return { body: wpPost };
        });

        const result = await adapter.updateBlockField('123', -1, 'seo_description', 'New description');

        expect(result.success).toBe(true);
        expect(posted.acf.seo_description).toBe('New description');
    });

    test('an out-of-range index fails without throwing', async () => {
        mockFetch(() => ({ body: wpPost }));

        const result = await adapter.updateBlockField('123', 99, 'heading', 'x');

        expect(result.success).toBe(false);
        expect(result.error).toContain('out of range');
    });

    test('without credentials returns a clear error', async () => {
        const noAuth = new WordPressAdapter({ endpoint: 'https://cms.test.com' });
        const result = await noAuth.updateBlockField('123', 0, 'heading', 'x');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Application Password');
    });

    test('the write carries Basic auth with the Application Password without spaces', async () => {
        mockFetch((url, init) => {
            if (init?.method === 'POST') return { body: { id: 123 } };
            return { body: wpPost };
        });

        await adapter.updateBlockField('123', 0, 'heading', 'x');

        const post = fetchCalls.find(c => c.init?.method === 'POST');
        const auth = (post?.init?.headers as Record<string, string>)['Authorization'];

        expect(auth).toStartWith('Basic ');
        const decoded = atob(auth.replace('Basic ', ''));
        expect(decoded).toBe('editor:aaaabbbbccccdddd');
    });

    test('a WordPress rejection is reported as a failure', async () => {
        mockFetch((url, init) => {
            if (init?.method === 'POST') return { status: 403, body: { message: 'forbidden' } };
            return { body: wpPost };
        });

        const result = await adapter.updateBlockField('123', 0, 'heading', 'x');

        expect(result.success).toBe(false);
        expect(result.error).toContain('403');
    });
});

// ============================================
// Tests: moveBlock (drag & drop)
// ============================================

describe('WordPressAdapter.moveBlock', () => {
    const adapter = new WordPressAdapter({
        endpoint: 'https://cms.test.com',
        username: 'editor',
        appPassword: 'aaaa bbbb',
        useBridgePlugin: false
    });

    test('reorders the Flexible Content array and sends it whole', async () => {
        let posted: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'POST') {
                posted = JSON.parse(String(init.body));
                return { body: { id: 123 } };
            }
            return { body: wpPost };
        });

        const result = await adapter.moveBlock('123', 0, 1);

        expect(result.success).toBe(true);
        expect(posted.acf.content_blocks[0].acf_fc_layout).toBe('two_col_text');
        expect(posted.acf.content_blocks[1].acf_fc_layout).toBe('hero_banner');
        // The block data travels intact
        expect(posted.acf.content_blocks[1].heading).toBe('Welcome');
    });

    test('out-of-range indexes fail without throwing', async () => {
        mockFetch(() => ({ body: wpPost }));

        const result = await adapter.moveBlock('123', 0, 99);

        expect(result.success).toBe(false);
        expect(result.error).toContain('out of range');
    });
});

// ============================================
// Tests: composition (insert / remove / duplicate)
// ============================================

describe('WordPressAdapter block composition', () => {
    const adapter = new WordPressAdapter({
        endpoint: 'https://cms.test.com',
        username: 'editor',
        appPassword: 'aaaa bbbb',
        useBridgePlugin: false
    });

    function capturePost() {
        let posted: any = null;
        mockFetch((url, init) => {
            if (init?.method === 'POST') {
                posted = JSON.parse(String(init.body));
                return { body: { id: 123 } };
            }
            return { body: wpPost };
        });
        return () => posted;
    }

    test('insertBlock adds a new layout with its acf_fc_layout at the given position', async () => {
        const posted = capturePost();

        const result = await adapter.insertBlock('123', 1, 'cta_banner', { heading: 'Buy' });

        expect(result.success).toBe(true);
        const blocks = posted().acf.content_blocks;
        expect(blocks).toHaveLength(3);
        expect(blocks[1]).toEqual({ acf_fc_layout: 'cta_banner', heading: 'Buy' });
        expect(blocks[0].acf_fc_layout).toBe('hero_banner');
        expect(blocks[2].acf_fc_layout).toBe('two_col_text');
    });

    test('removeBlock removes the layout at the given position', async () => {
        const posted = capturePost();

        const result = await adapter.removeBlock('123', 0);

        expect(result.success).toBe(true);
        const blocks = posted().acf.content_blocks;
        expect(blocks).toHaveLength(1);
        expect(blocks[0].acf_fc_layout).toBe('two_col_text');
    });

    test('duplicateBlock clones the layout right after the original', async () => {
        const posted = capturePost();

        const result = await adapter.duplicateBlock('123', 0);

        expect(result.success).toBe(true);
        const blocks = posted().acf.content_blocks;
        expect(blocks).toHaveLength(3);
        expect(blocks[0].acf_fc_layout).toBe('hero_banner');
        expect(blocks[1].acf_fc_layout).toBe('hero_banner');
        expect(blocks[1].heading).toBe('Welcome');
        // Deep copy, not a reference
        expect(blocks[1]).not.toBe(blocks[0]);
    });

    test('removeBlock works in Gutenberg mode (splice of parsed blocks)', async () => {
        const gutenbergPost = {
            id: 55,
            slug: 'about',
            title: { rendered: 'About' },
            content: {
                raw: '<!-- wp:heading -->\n<h2>One</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p>Two</p>\n<!-- /wp:paragraph -->'
            },
            acf: {}
        };
        let posted: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'POST') {
                posted = JSON.parse(String(init.body));
                return { body: { id: 55 } };
            }
            return { body: gutenbergPost };
        });

        const result = await adapter.removeBlock('55', 0);

        expect(result.success).toBe(true);
        expect(result.source).toBe('wordpress-gutenberg');
        expect(posted.content).not.toContain('One');
        expect(posted.content).toContain('<p>Two</p>');
    });

    test('insertBlock in Gutenberg mode fails with a clear error', async () => {
        const gutenbergPost = { id: 55, slug: 'x', title: { rendered: 'X' }, content: { raw: '<!-- wp:paragraph --><p>a</p><!-- /wp:paragraph -->' }, acf: {} };
        mockFetch(() => ({ body: gutenbergPost }));

        const result = await adapter.insertBlock('55', 0, 'anything');

        expect(result.success).toBe(false);
        expect(result.error).toContain('ACF mode');
    });
});

// ============================================
// Tests: inti-bridge companion plugin
// ============================================

describe('WordPressAdapter + inti-bridge', () => {
    test('uses the plugin atomic patch when it answers 200', async () => {
        const adapter = new WordPressAdapter({
            endpoint: 'https://cms.test.com',
            username: 'editor',
            appPassword: 'aaaa bbbb'
        });

        let bridgeBody: any = null;

        // Manual mock (without the helper's automatic 404)
        globalThis.fetch = (async (input: any, init?: RequestInit) => {
            const url = String(input);
            fetchCalls.push({ url, init });
            if (url.includes('/wp-json/inti/v1/patch')) {
                bridgeBody = JSON.parse(String(init?.body));
                return new Response(JSON.stringify({ success: true }), { status: 200 });
            }
            return new Response(JSON.stringify(wpPost), { status: 200 });
        }) as typeof fetch;

        const result = await adapter.updateBlockField('123', 1, 'left', 'New');

        expect(result.success).toBe(true);
        expect(result.source).toBe('wordpress-bridge');
        expect(bridgeBody).toEqual({
            post_id: 123,
            blocks_field: 'content_blocks',
            block_index: 1,
            field: 'left',
            value: 'New'
        });
        // No round-trip: a single call (the patch)
        expect(fetchCalls).toHaveLength(1);
    });

    test('with the plugin missing (404) it falls back to the REST path and remembers it', async () => {
        const adapter = new WordPressAdapter({
            endpoint: 'https://cms.test.com',
            username: 'editor',
            appPassword: 'aaaa bbbb'
        });

        mockFetch((url, init) => {
            if (init?.method === 'POST') return { body: { id: 123 } };
            return { body: wpPost };
        });

        const first = await adapter.updateBlockField('123', 0, 'heading', 'a');
        expect(first.success).toBe(true);
        expect(first.source).toBe('wordpress');

        const bridgeCallsFirst = fetchCalls.filter(c => c.url.includes('/inti/v1/')).length;
        expect(bridgeCallsFirst).toBe(1);

        // Second write: it no longer tries the bridge (feature-detect cached)
        await adapter.updateBlockField('123', 0, 'heading', 'b');
        const bridgeCallsTotal = fetchCalls.filter(c => c.url.includes('/inti/v1/')).length;
        expect(bridgeCallsTotal).toBe(1);
    });
});

// ============================================
// Tests: Gutenberg mode
// ============================================

describe('WordPressAdapter in Gutenberg mode', () => {
    const gutenbergPost = {
        id: 55,
        slug: 'about',
        type: 'page',
        title: { rendered: 'About' },
        content: {
            rendered: '<h2>Story</h2><p>Our team.</p>',
            raw: '<!-- wp:heading -->\n<h2>Story</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p>Our team.</p>\n<!-- /wp:paragraph -->'
        },
        acf: {}
    };

    const adapter = new WordPressAdapter({
        endpoint: 'https://cms.test.com',
        username: 'editor',
        appPassword: 'aaaa bbbb',
        useBridgePlugin: false
    });

    test('parsePage maps Gutenberg blocks when there is no ACF', () => {
        const page = adapter.parsePage(gutenbergPost as any);

        expect(page.blocks).toHaveLength(2);
        expect(page.blocks[0].type).toBe('Heading');
        expect(page.blocks[0].data.text).toBe('Story');
        expect(page.blocks[1].type).toBe('Paragraph');
        expect(page.blocks[1].meta?.label).toBe('gutenberg:core/paragraph');
    });

    test('without content.raw it exposes a single renderable RichText block', () => {
        const publicPost = { ...gutenbergPost, content: { rendered: '<h2>Story</h2>' } };
        const page = adapter.parsePage(publicPost as any);

        expect(page.blocks).toHaveLength(1);
        expect(page.blocks[0].type).toBe('RichText');
        expect(page.blocks[0].data.html).toBe('<h2>Story</h2>');
    });

    test('updateBlockField patches the text and sends the serialized content', async () => {
        let posted: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'POST') {
                posted = JSON.parse(String(init.body));
                return { body: { id: 55 } };
            }
            return { body: gutenbergPost };
        });

        const result = await adapter.updateBlockField('55', 0, 'text', 'Our Story');

        expect(result.success).toBe(true);
        expect(result.source).toBe('wordpress-gutenberg');
        expect(posted.content).toContain('<h2>Our Story</h2>');
        expect(posted.content).toContain('<p>Our team.</p>');
        expect(posted.content).toContain('<!-- wp:heading -->');
    });

    test('rejects fields other than "text" with a clear error', async () => {
        mockFetch(() => ({ body: gutenbergPost }));

        const result = await adapter.updateBlockField('55', 0, 'html', '<h2>x</h2>');

        expect(result.success).toBe(false);
        expect(result.error).toContain('"text"');
    });
});

// ============================================
// Introspection: typed blocks
// ============================================

describe('WordPressAdapter.introspect — Flexible Content layouts', () => {
    // The schema cache is process-global: each test starts from scratch
    beforeEach(() => globalSchemaCache.clear());

    /** /types answers the list of post types; /pages, the sample post */
    function mockIntrospection(sample = wpPost) {
        mockFetch((url) => {
            if (url.includes('/wp-json/wp/v2/types')) {
                return { body: { page: { rest_base: 'pages' } } };
            }
            return { body: [sample] };
        });
    }

    test('describes each layout as a collection with the type parsePage assigns', async () => {
        mockIntrospection();
        const adapter = new WordPressAdapter({ endpoint: 'https://cms.test', collections: ['page'] });

        const schema = await adapter.introspect();
        const hero = schema.collections.find((c) => c.name === 'HeroBannerBlock');

        expect(hero?.blockType).toBe('HeroBanner');
        expect(adapter.parsePage(wpPost as any).blocks[0].type).toBe(hero?.blockType);
        expect(hero?.fields.map((f) => f.name)).toEqual(['heading', 'subheading', 'cta']);
    });

    test('honors blockTypeMap, like parsePage', async () => {
        mockIntrospection();
        const adapter = new WordPressAdapter({
            endpoint: 'https://cms.test',
            collections: ['page'],
            blockTypeMap: { hero_banner: 'Cover' }
        });

        const schema = await adapter.introspect();
        const hero = schema.collections.find((c) => c.name === 'HeroBannerBlock');

        expect(hero?.blockType).toBe('Cover');
        expect(adapter.parsePage(wpPost as any).blocks[0].type).toBe('Cover');
    });

    test('two different sites do not share the cached schema', async () => {
        // The key used to be `WordPress:default` for everyone: the second
        // site got the first one's schema for 5 minutes.
        mockIntrospection();
        await new WordPressAdapter({ endpoint: 'https://one.test', collections: ['page'] }).introspect();

        mockIntrospection({ ...wpPost, acf: { content_blocks: [{ acf_fc_layout: 'pricing', plans: [] }] } } as any);
        const other = await new WordPressAdapter({ endpoint: 'https://two.test', collections: ['page'] }).introspect();

        expect(other.collections.map((c) => c.name)).toContain('PricingBlock');
        expect(other.collections.map((c) => c.name)).not.toContain('HeroBannerBlock');
    });

    test('does not clash with the post type of the same name', async () => {
        const withPageLayout = {
            ...wpPost,
            acf: { content_blocks: [{ acf_fc_layout: 'page', title: 'x' }] }
        };
        mockIntrospection(withPageLayout as any);

        const schema = await new WordPressAdapter({ endpoint: 'https://cms.test', collections: ['page'] }).introspect();
        const names = schema.collections.map((c) => c.name);

        expect(new Set(names).size).toBe(names.length);
        expect(names).toContain('Page');
        expect(names).toContain('PageBlock');
    });
});
