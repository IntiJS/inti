import { describe, test, expect } from 'bun:test';
import { adapterConformance } from '@intijs/core/testing';
import { isNotFound, isUnavailable } from '@intijs/core/errors';
import { WordPressAdapter, parseGutenberg, serializeGutenberg, removeGutenbergBlock, wordpressImage } from '../src/index.js';

// ============================================
// A WordPress double: wp/v2 pages, the inti-bridge routes, headers as WordPress sends them
// ============================================

interface FakePost {
    id: number;
    slug: string;
    link: string;
    status: string;
    modified_gmt: string;
    title: { rendered: string };
    content?: { raw?: string; rendered?: string };
    acf: Record<string, any>;
    [key: string]: any;
}

const NO_ROUTE = { code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } };

function fakeWordPress(options: { plugin?: boolean; posts?: FakePost[]; failNext?: number } = {}) {
    const posts: FakePost[] = options.posts ?? [
        {
            id: 7,
            slug: 'home',
            link: 'https://wp.test/',
            status: 'publish',
            modified_gmt: '2026-11-01T10:00:00',
            title: { rendered: 'Home' },
            acf: {
                content_blocks: [
                    { acf_fc_layout: 'hero', heading: 'Hello' },
                    { acf_fc_layout: 'text', body: 'Text' }
                ]
            }
        }
    ];
    const calls: Array<{ method: string; url: URL; body?: any; headers: Record<string, string> }> = [];
    let failures = options.failNext ?? 0;

    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

    const fetch = (async (input: string, init: RequestInit = {}) => {
        const url = new URL(String(input));
        const method = (init.method ?? 'GET').toUpperCase();
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ method, url, body, headers: (init.headers ?? {}) as Record<string, string> });

        if (failures > 0) {
            failures--;
            return json({ code: 'internal_server_error' }, 500);
        }

        if (url.pathname.startsWith('/wp-json/inti/v1/')) {
            if (!options.plugin) return json(NO_ROUTE, 404);
            const post = posts.find((candidate) => candidate.id === body?.post_id);
            if (!post) return json({ code: 'rest_post_invalid_id' }, 404);
            if (body.expected_modified && body.expected_modified !== `${post.modified_gmt}Z`) {
                return json({ code: 'inti_conflict', message: 'changed', data: { status: 409 } }, 409);
            }
            const rows = post.acf[body.blocks_field ?? 'content_blocks'];
            const route = url.pathname.split('/').pop();
            if (route === 'patch') {
                if (!rows) return json({ code: 'inti_no_rows' }, 422);
                if (!rows[body.block_index]) return json({ code: 'inti_unknown_field' }, 422);
                const parts = String(body.field).split('.');
                let cursor = rows[body.block_index];
                for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
                cursor[parts[parts.length - 1]] = body.value;
            } else if (route === 'rows') {
                if (body.op === 'move') {
                    const [moved] = rows.splice(body.from, 1);
                    rows.splice(body.to, 0, moved);
                } else if (body.op === 'insert') {
                    rows.splice(body.index, 0, ...body.rows);
                } else if (body.op === 'remove') {
                    rows.splice(body.index, 1);
                }
            } else if (route === 'content') {
                post.content = { raw: body.content };
            }
            post.modified_gmt = '2026-11-02T10:00:00';
            return json({ success: true, modified_gmt: `${post.modified_gmt}Z` });
        }

        if (url.pathname === '/wp-json/wp/v2/pages' && method === 'GET') {
            const slug = url.searchParams.get('slug');
            const list = slug ? posts.filter((post) => post.slug === slug) : posts;
            const perPage = Number(url.searchParams.get('per_page') ?? 10);
            const page = Number(url.searchParams.get('page') ?? 1);
            const slice = slug ? list : list.slice((page - 1) * perPage, page * perPage);
            return json(slice, 200, {
                'x-wp-total': String(list.length),
                'x-wp-totalpages': String(Math.max(1, Math.ceil(list.length / perPage)))
            });
        }

        const single = url.pathname.match(/^\/wp-json\/wp\/v2\/pages\/(\d+)$/);
        if (single) {
            const post = posts.find((candidate) => candidate.id === Number(single[1]));
            if (!post) return json({ code: 'rest_post_invalid_id' }, 404);
            if (method === 'POST') {
                if (body?.acf) post.acf = body.acf;
                if (body?.content !== undefined) post.content = { raw: body.content };
                return json(post);
            }
            return json(post);
        }

        return json(NO_ROUTE, 404);
    }) as unknown as typeof globalThis.fetch;

    return { fetch, calls, posts };
}

const credentials = { username: 'editor', appPassword: 'aaaa bbbb' };

// ============================================
// Conformance
// ============================================

adapterConformance(
    { describe, test, expect },
    {
        name: 'WordPressAdapter (with inti-bridge)',
        create: () => new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: fakeWordPress({ plugin: true }).fetch }),
        existingSlug: 'home',
        writableField: 'heading',
        unavailable: () =>
            new WordPressAdapter({
                endpoint: 'https://wp.test',
                fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch
            }),
        skip: ['drafts']
    }
);

adapterConformance(
    { describe, test, expect },
    {
        name: 'WordPressAdapter (REST only)',
        create: () => new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: fakeWordPress().fetch }),
        existingSlug: 'home',
        writableField: 'heading',
        skip: ['drafts']
    }
);

// ============================================
// The bridge
// ============================================

describe('writes through inti-bridge', () => {
    test('a structural change is one call to /rows, without reading the page', async () => {
        const wp = fakeWordPress({ plugin: true });
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: wp.fetch });
        const result = await adapter.moveBlock('7', 0, 1);
        expect(result.success).toBe(true);
        expect(wp.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(['POST /wp-json/inti/v1/rows']);
        expect(wp.calls[0].body).toMatchObject({ post_id: 7, op: 'move', from: 0, to: 1 });
        expect(wp.posts[0].acf.content_blocks[0].acf_fc_layout).toBe('text');
    });

    test('inserting a pattern sends every row at once', async () => {
        const wp = fakeWordPress({ plugin: true });
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: wp.fetch });
        await adapter.insertBlocks('7', 1, [{ nativeType: 'cta', data: { label: 'Go' } }, { nativeType: 'text', data: { body: 'B' } }]);
        expect(wp.posts[0].acf.content_blocks.map((row: any) => row.acf_fc_layout)).toEqual(['hero', 'cta', 'text', 'text']);
        expect(wp.calls).toHaveLength(1);
    });

    test('one failure of the plugin does not turn it off for good', async () => {
        const wp = fakeWordPress({ plugin: true, failNext: 1 });
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: wp.fetch });
        const first = await adapter.updateBlockField('7', 0, 'heading', 'A');
        expect(first.success).toBe(false);
        const second = await adapter.updateBlockField('7', 0, 'heading', 'B');
        expect(second.success).toBe(true);
        expect(second.source).toBe('wordpress-bridge');
        // Never the racy read-modify-write behind the user's back
        expect(wp.calls.every((call) => call.url.pathname.startsWith('/wp-json/inti/v1/'))).toBe(true);
    });

    test('a page that changed since it was read is a conflict the editor can act on', async () => {
        const wp = fakeWordPress({
            plugin: true,
            posts: [
                {
                    id: 9,
                    slug: 'g',
                    link: 'https://wp.test/g/',
                    status: 'publish',
                    modified_gmt: '2026-11-01T10:00:00',
                    title: { rendered: 'G' },
                    content: { raw: '<!-- wp:paragraph --><p>One</p><!-- /wp:paragraph -->' },
                    acf: {}
                }
            ]
        });
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, mode: 'gutenberg', fetch: wp.fetch });
        // Someone saves between the adapter's read and its write
        const original = wp.fetch;
        let reads = 0;
        const racing = (async (input: string, init?: RequestInit) => {
            const response = await original(input, init);
            if (String(input).includes('/wp/v2/pages/9') && ++reads === 1) wp.posts[0].modified_gmt = '2026-11-01T11:00:00';
            return response;
        }) as unknown as typeof fetch;
        const raced = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, mode: 'gutenberg', fetch: racing });
        const result = await raced.updateBlockField('9', 0, 'text', 'Two');
        expect(result.success).toBe(false);
        expect(result.error).toContain('changed in WordPress');
        expect(wp.posts[0].content?.raw).toContain('One');
        void adapter;
    });

    test('writes send exactly one Content-Type: application/json', async () => {
        const wp = fakeWordPress();
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', ...credentials, fetch: wp.fetch });
        await adapter.updateBlockField('7', 0, 'heading', 'X');
        const post = wp.calls.find((call) => call.method === 'POST' && call.url.pathname.startsWith('/wp-json/wp/v2/'))!;
        const types = Object.entries(post.headers).filter(([name]) => name.toLowerCase() === 'content-type');
        expect(types).toEqual([['Content-Type', 'application/json']]);
    });
});

// ============================================
// Reading
// ============================================

describe('reading', () => {
    test('asks only for the fields a page needs; a missing page is a 404, a 503 is unavailable', async () => {
        const wp = fakeWordPress();
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', fetch: wp.fetch });
        await adapter.fetchPageBySlug('home');
        const fields = wp.calls[0].url.searchParams.get('_fields')!.split(',');
        expect(fields).toContain('acf');
        expect(fields).toContain('inti_blocks');
        expect(fields).not.toContain('guid');
        expect(isNotFound(await adapter.fetchPageBySlug('nope').catch((e) => e))).toBe(true);

        const down = new WordPressAdapter({ endpoint: 'https://wp.test', fetch: (async () => new Response('', { status: 503 })) as any });
        expect(isUnavailable(await down.fetchPageBySlug('home').catch((e) => e))).toBe(true);
    });

    test('listPages walks every page of the listing in parallel, with no cap', async () => {
        const posts = Array.from({ length: 5250 }, (_, i) => ({
            id: i + 1,
            slug: `p${i + 1}`,
            link: `https://wp.test/p${i + 1}/`,
            status: 'publish',
            modified_gmt: '2026-11-01T10:00:00',
            title: { rendered: `P${i + 1}` },
            acf: {}
        }));
        const wp = fakeWordPress({ posts });
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', fetch: wp.fetch });
        const pages = await adapter.listPages();
        expect(pages).toHaveLength(5250);
        expect(pages[5249].slug).toBe('p5250');
        expect(new Set(wp.calls.map((call) => call.url.searchParams.get('page'))).size).toBe(53);
    });

    test('language and translations come from the plugin fields', () => {
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test' });
        const page = adapter.parsePage({
            id: 1,
            slug: 'sobre',
            acf: {},
            inti_locale: 'es',
            inti_translations: [{ locale: 'en', slug: 'about', url: 'https://wp.test/en/about/' }]
        } as any);
        expect(page.locale).toBe('es');
        expect(page.translations).toEqual([{ locale: 'en', slug: 'about', url: 'https://wp.test/en/about/' }]);
    });

    test('a menu comes as a tree with the site paths', async () => {
        const fetch = (async () =>
            new Response(
                JSON.stringify({
                    items: [{ label: 'Services', url: 'https://wp.test/services/', path: '/services/', children: [{ label: 'Design', url: 'https://wp.test/services/design/', path: '/services/design/', children: [] }] }]
                }),
                { headers: { 'content-type': 'application/json' } }
            )) as unknown as typeof globalThis.fetch;
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', fetch });
        const nav = await adapter.fetchNavigation('primary');
        expect(nav.items[0]).toEqual({ label: 'Services', url: '/services/', children: [{ label: 'Design', url: '/services/design/' }] });
    });

    test('an archive filters by the term id and reports totals from the headers', async () => {
        const calls: URL[] = [];
        const fetch = (async (input: string) => {
            const url = new URL(input);
            calls.push(url);
            if (url.pathname.endsWith('/categories')) {
                return new Response(JSON.stringify([{ id: 4, slug: 'news', name: 'News', taxonomy: 'category' }]), { headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify([{ id: 1, slug: 'a', link: 'https://wp.test/a/', title: { rendered: 'A' } }]), {
                headers: { 'content-type': 'application/json', 'x-wp-total': '31', 'x-wp-totalpages': '4' }
            });
        }) as unknown as typeof globalThis.fetch;
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', fetch });
        const archive = await adapter.fetchArchive({ taxonomy: 'categories', term: 'news', page: 2 });
        expect(calls[1].searchParams.get('categories')).toBe('4');
        expect(archive).toMatchObject({ total: 31, totalPages: 4, page: 2, term: { name: 'News' } });
    });
});

// ============================================
// Gutenberg
// ============================================

describe('Gutenberg documents', () => {
    const doc =
        '<p>Classic intro</p>\n\n<!-- wp:paragraph --><p>One</p><!-- /wp:paragraph -->\n\n' +
        '<!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta","args":{"key":"price"}}}}} --><p>9</p><!-- /wp:paragraph -->\n' +
        '<!-- wp:heading {"metadata":{"ignoredHookedBlocks":["acme/like"]}} --><h2>Two</h2><!-- /wp:heading -->\ntrailing';

    test('an unchanged document serializes byte for byte, classic content and hooked-block metadata included', () => {
        expect(serializeGutenberg(parseGutenberg(doc))).toBe(doc);
    });

    test('removing a block keeps the classic content before it', () => {
        const blocks = parseGutenberg(doc);
        removeGutenbergBlock(blocks, 0);
        expect(serializeGutenberg(blocks)).toContain('<p>Classic intro</p>');
        expect(serializeGutenberg(blocks)).not.toContain('<p>One</p>');
    });

    test('a bound block is shown as WordPress renders it and is not editable', () => {
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test', mode: 'gutenberg' });
        const page = adapter.parsePage({
            id: 3,
            slug: 'x',
            content: { raw: doc },
            inti_blocks: [
                { name: 'core/paragraph', rendered: null },
                { name: 'core/paragraph', rendered: '<p>19.99</p>' },
                { name: 'core/heading', rendered: null }
            ]
        } as any);
        expect(page.blocks[1].data.html).toBe('<p>19.99</p>');
        expect(page.blocks[1].data.text).toBeUndefined();
        expect(page.blocks[1].data.bound).toBe(true);
        expect(page.blocks[0].data.text).toBe('One');
    });
});

// ============================================
// Media
// ============================================

describe('images', () => {
    test('an ACF image gets srcset from its sizes, modern formats and the GIF video', () => {
        const image = wordpressImage({
            ID: 5,
            type: 'image',
            mime_type: 'image/gif',
            url: 'https://wp.test/uploads/a.gif',
            width: 1200,
            height: 800,
            filesize: 54321,
            alt: 'A',
            sizes: { medium: 'https://wp.test/uploads/a-300x200.gif', 'medium-width': 300, 'medium-height': 200 },
            sources: {
                'image/avif': { file: 'a.avif', filesize: 1000 },
                'image/webp': { file: 'a.webp', filesize: 2000 },
                'video/mp4': { file: 'a.mp4' }
            }
        })!;
        expect(image).toMatchObject({ id: '5', width: 1200, height: 800, size: 54321, alt: 'A' });
        expect(image.srcset).toEqual([
            { url: 'https://wp.test/uploads/a-300x200.gif', width: 300 },
            { url: 'https://wp.test/uploads/a.gif', width: 1200 }
        ]);
        expect(image.sources?.map((source) => source.type)).toEqual(['image/avif', 'image/webp']);
        expect(image.video).toEqual({ url: 'https://wp.test/uploads/a.mp4', type: 'video/mp4' });
    });

    test('block data keeps its keys and gains the contract', () => {
        const adapter = new WordPressAdapter({ endpoint: 'https://wp.test' });
        const page = adapter.parsePage({
            id: 1,
            slug: 'x',
            acf: {
                content_blocks: [
                    { acf_fc_layout: 'hero', image: { ID: 2, type: 'image', mime_type: 'image/jpeg', url: 'https://wp.test/b.jpg', width: 800, height: 600, sizes: { large: 'https://wp.test/b-l.jpg', 'large-width': 640 } } }
                ]
            }
        } as any);
        const image = page.blocks[0].data.image;
        expect(image.ID).toBe(2);
        expect(image.sizes.large).toBe('https://wp.test/b-l.jpg');
        expect(image.srcset).toHaveLength(2);
    });
});
