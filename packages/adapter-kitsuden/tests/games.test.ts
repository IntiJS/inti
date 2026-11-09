import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { KitsudenAdapter, GAME_BLOCK_INSERT_ERROR } from '../src/index.js';
import type { KitsudenGameBlock } from '../src/index.js';
import { isVersionRequest, compatibleVersionResponse } from './helpers/version.js';

/**
 * Game pages (`game:<uuid>`).
 *
 * The mock has the REAL shape of `GET /api/games/slug/crimson-desert`: the game without an
 * envelope, with `blocks: [{ id, data, type, order, editorial }]` and the loader's deterministic
 * ids. Keys are those of the `games` contract v2 (Kitsuden 0.9): `title`, `description` in
 * `data`, and `title`, `description`, `hidden`, `order` in the editorial layer.
 *
 * What is watched, as with pages: Inti's index is the one of the VISIBLE, sorted list; if it is
 * translated to the wrong id, another block gets edited.
 */

const GAME_ID = '01bd1555-580d-4f8b-8f64-f11eecdd97b1';
const DOC = `game:${GAME_ID}`;
const TOKEN = 'kitsuden_agent_tests';

function game(blocks?: any[]) {
    return {
        id: GAME_ID,
        title: 'Crimson Desert',
        slug: 'crimson-desert',
        subtitle: 'Kliff, the Greymanes and the continent of Pywel',
        description: null,
        excerpt: 'Crimson Desert wiki: the story chapter by chapter.',
        releaseDate: null,
        status: 'published',
        developer: 'Pearl Abyss',
        publisher: 'Pearl Abyss',
        metacriticScore: null,
        userRating: null,
        coverArtId: null,
        coverFocalPoint: null,
        trailerUrl: null,
        externalIds: {},
        specs: {},
        screenshots: [],
        isFeaturedOnHome: false,
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-14T05:15:52.882Z',
        platforms: [],
        tags: [],
        media: {},
        blocks: blocks ?? baseBlocks()
    };
}

/**
 * Four blocks. With the editorial layer, what is visible ends up like this:
 *   0: smart-grid-3 (editorial.order 0, title edited)
 *   1: smart-grid-1 (editorial.order 1, although its loader `order` is 0)
 *   2: progress-checklist-4
 * and smart-grid-2 (editorial.order 2) is hidden.
 */
function baseBlocks() {
    return [
        {
            id: 'crimson-desert-smart-grid-1',
            data: {
                anchor: 'weapons',
                title: 'Weapons with unique effects',
                columns: ['name', 'type', 'effect', 'how_to_get'],
                datasetId: '465eb674-36d7-49f1-b99a-2998ba77e552',
                description: 'Weapons and shields with their own effect.',
                initialSort: '',
                rowCount: 10
            },
            type: 'smart-grid',
            order: 0,
            editorial: { order: 1 }
        },
        {
            id: 'crimson-desert-smart-grid-2',
            data: {
                anchor: 'abyss-gear',
                title: 'Abyss gear',
                columns: ['name'],
                datasetId: 'cb6759e8-90eb-4fa2-bbd8-5bcf6244849b',
                description: 'Abyss gear pieces.',
                initialSort: '',
                rowCount: 15
            },
            type: 'smart-grid',
            order: 1,
            editorial: { hidden: true, order: 2 }
        },
        {
            id: 'crimson-desert-smart-grid-3',
            data: {
                anchor: 'bosses',
                title: 'Bosses',
                columns: ['name'],
                datasetId: 'aaaaaaaa-0000-0000-0000-000000000003',
                description: 'The bosses of the game.',
                initialSort: '',
                rowCount: 40
            },
            type: 'smart-grid',
            order: 2,
            editorial: { order: 0, title: 'Bosses of Pywel' }
        },
        {
            id: 'crimson-desert-progress-checklist-4',
            data: { title: 'Progress' },
            type: 'progress-checklist',
            order: 3,
            editorial: { order: 3 }
        }
    ];
}

let calls: Array<{ url: string; method: string; body?: any; auth?: string | null }> = [];
let originalFetch: typeof fetch;

function mockGame(
    blocks?: any[],
    extra?: (url: string, init?: RequestInit) => { status?: number; body?: any } | undefined
) {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (isVersionRequest(url)) return compatibleVersionResponse();
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({
            url,
            method: init?.method ?? 'GET',
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
            auth: headers['Authorization'] ?? null
        });
        const own = extra?.(url, init);
        const r =
            own ??
            ((init?.method ?? 'GET') === 'GET' &&
            (url.endsWith(`/api/games/${GAME_ID}`) || url.endsWith('/api/games/slug/crimson-desert'))
                ? { body: game(blocks) }
                : { body: { id: 'x', editorial: {} } });
        return new Response(JSON.stringify(r.body ?? {}), {
            status: r.status ?? 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }) as typeof fetch;
}

function adapter(extra: Record<string, unknown> = {}) {
    return new KitsudenAdapter({ endpoint: 'https://cms.test', token: TOKEN, ...extra });
}

const writes = () => calls.filter((l) => l.method !== 'GET');
const reads = () => calls.filter((l) => l.method === 'GET');

beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('reading game pages', () => {
    test('getGame by slug reads /api/games/slug/:slug, without credentials', async () => {
        mockGame();
        const page = await adapter().getGame('crimson-desert');

        expect(calls[0].url).toBe('https://cms.test/api/games/slug/crimson-desert');
        expect(calls[0].auth).toBeNull();
        expect(page.id).toBe(DOC);
        expect(page.slug).toBe('crimson-desert');
        expect(page.title).toBe('Crimson Desert');
        expect(page.meta).toEqual({
            contentType: 'game',
            documentId: DOC,
            updatedAt: '2026-10-14T05:15:52.882Z'
        });
        expect(page.seo?.description).toContain('Crimson Desert wiki');
    });

    test('getGame by uuid reads /api/games/:id', async () => {
        mockGame();
        await adapter().getGame(GAME_ID);
        expect(calls[0].url).toBe(`https://cms.test/api/games/${GAME_ID}`);
    });

    test('getPage with the game: prefix delegates to getGame; without it, it still goes to the page builder', async () => {
        mockGame(undefined, (url) =>
            url.includes('/api/page-builder/pages/') ? { body: { id: 'p1', title: 'P', slug: 'p', blocks: [] } } : undefined
        );
        const a = adapter();

        const gamePage = await a.getPage(DOC);
        expect(gamePage.id).toBe(DOC);
        expect(calls[0].url).toBe(`https://cms.test/api/games/${GAME_ID}`);

        const page = await a.getPage('p1');
        expect(page.id).toBe('p1');
        expect(calls[1].url).toBe('https://cms.test/api/page-builder/pages/p1');
    });

    test('sorts by editorial.order ?? order and skips the hidden ones', async () => {
        mockGame();
        const page = await adapter().getGame('crimson-desert');

        expect(page.blocks.map((b) => b.id)).toEqual([
            'crimson-desert-smart-grid-3',
            'crimson-desert-smart-grid-1',
            'crimson-desert-progress-checklist-4'
        ]);
        expect(page.blocks.map((b) => b.meta?.index)).toEqual([0, 1, 2]);
        expect(page.blocks.every((b) => b.meta?.total === 3)).toBe(true);
        expect(page.blocks.every((b) => b.meta?.documentId === DOC)).toBe(true);
        expect(page.blocks.every((b) => b.meta?.contentType === 'game')).toBe(true);
    });

    test('without an editorial layer the order is that of `order`', async () => {
        mockGame([
            { id: 'b-c', type: 'dex', order: 2, data: {} },
            { id: 'b-a', type: 'smart-grid', order: 0, data: {} },
            { id: 'b-b', type: 'tier-list', order: 1, data: {} }
        ]);
        const page = await adapter().getGame('crimson-desert');
        expect(page.blocks.map((b) => b.id)).toEqual(['b-a', 'b-b', 'b-c']);
        expect((page.blocks[0] as KitsudenGameBlock).editorial).toBeUndefined();
    });

    test('same rule as the site: a block without id counts in the index and without order it is 0', async () => {
        // There is a block like that in monster-hunter-wilds (2026-10-14). If the adapter skipped
        // it, every index after it would point to the next block.
        mockGame([
            { id: 'b-1', type: 'smart-grid', order: 1, data: {} },
            { type: 'image-gallery', order: 2, data: {} },
            { id: 'b-3', type: 'dex', order: 3, data: {} },
            { id: 'b-0', type: 'tier-list', data: {} }
        ]);
        const page = await adapter().getGame('crimson-desert');
        expect(page.blocks.map((b) => b.id)).toEqual(['b-0', 'b-1', '', 'b-3']);
        expect(page.blocks.map((b) => b.meta?.index)).toEqual([0, 1, 2, 3]);
    });

    test("data carries the layer's title/description; original and editorial stay for the editor", async () => {
        mockGame();
        const page = await adapter().getGame('crimson-desert');
        const bosses = page.blocks[0] as KitsudenGameBlock;

        expect(bosses.type).toBe('smart-grid');
        expect(bosses.meta?.label).toBe('smart-grid');
        expect(bosses.data.title).toBe('Bosses of Pywel');
        expect(bosses.data.description).toBe('The bosses of the game.');
        expect(bosses.data.datasetId).toBe('aaaaaaaa-0000-0000-0000-000000000003');
        expect(bosses.original?.title).toBe('Bosses');
        expect(bosses.editorial).toEqual({ order: 0, title: 'Bosses of Pywel' });

        // The original object is not mutated
        const weapons = page.blocks[1] as KitsudenGameBlock;
        expect(weapons.data.title).toBe('Weapons with unique effects');
    });

    test('a layer with the 0.8 names (Kitsuden 0.8, read-only) still hides and sorts like its site', async () => {
        mockGame([
            { id: 'a', type: 'dex', order: 0, data: {}, editorial: { orden: 2 } },
            { id: 'b', type: 'dex', order: 1, data: {}, editorial: { oculto: true } },
            { id: 'c', type: 'dex', order: 2, data: {}, editorial: { orden: 0, titulo: 'Old' } },
            // The English key wins when both are there
            { id: 'd', type: 'dex', order: 3, data: {}, editorial: { orden: 9, order: 1 } }
        ]);
        const page = await adapter().getGame('crimson-desert');
        expect(page.blocks.map((b) => b.id)).toEqual(['c', 'd', 'a']);
        expect((page.blocks[0] as KitsudenGameBlock).editorial).toEqual({ title: 'Old', order: 0 });
        expect(page.blocks[0].data.title).toBe('Old');
    });

    test('a game without blocks returns an empty page, it does not blow up', async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ ...game(), blocks: null }), { status: 200 })) as typeof fetch;
        const page = await adapter().getGame('crimson-desert');
        expect(page.blocks).toEqual([]);
    });
});

describe('writing on game pages', () => {
    test('updateBlockField re-reads by uuid and PATCHes the layer of the VISIBLE block at that index', async () => {
        mockGame();
        const r = await adapter().updateBlockField(DOC, 1, 'title', 'Unique weapons');

        expect(r.success).toBe(true);
        expect(reads()).toHaveLength(1);
        expect(reads()[0].url).toBe(`https://cms.test/api/games/${GAME_ID}`);
        expect(reads()[0].auth).toBe(`Bearer ${TOKEN}`);

        expect(writes()).toEqual([
            {
                url: `https://cms.test/api/games/${GAME_ID}/blocks/crimson-desert-smart-grid-1/editorial`,
                method: 'PATCH',
                body: { title: 'Unique weapons' },
                auth: `Bearer ${TOKEN}`
            }
        ]);
    });

    test('the re-read goes BEFORE the write (and by uuid even if it was rendered by slug)', async () => {
        mockGame();
        await adapter().updateBlockField(DOC, 0, 'description', 'New');
        expect(calls.map((l) => l.method)).toEqual(['GET', 'PATCH']);
        expect(calls[0].url).not.toContain('/slug/');
    });

    test('updateBlockField with null removes the field from the layer', async () => {
        mockGame();
        await adapter().updateBlockField(DOC, 0, 'title', null);
        expect(writes()[0].body).toEqual({ title: null });
    });

    test('updateBlockField rejects fields other than title/description without calling the API', async () => {
        mockGame();
        for (const field of ['datasetId', 'titulo', 'descripcion']) {
            const r = await adapter().updateBlockField(DOC, 0, field, 'other');
            expect(r.success).toBe(false);
            expect(r.error).toContain('«title»');
        }
        expect(calls).toHaveLength(0);
    });

    test('updateBlock sends only the title/description that change', async () => {
        mockGame();
        // The editor usually sends the whole block: datasetId is not touched and a title equal
        // to the visible one is not pinned in the layer
        const r = await adapter().updateBlock(DOC, 0, {
            title: 'Bosses of Pywel',
            description: 'The bosses, one by one.',
            datasetId: 'tampered',
            columns: []
        });

        expect(r.success).toBe(true);
        expect(writes()).toHaveLength(1);
        expect(writes()[0].url).toBe(
            `https://cms.test/api/games/${GAME_ID}/blocks/crimson-desert-smart-grid-3/editorial`
        );
        expect(writes()[0].body).toEqual({ description: 'The bosses, one by one.' });
    });

    test('updateBlock without changes does not write', async () => {
        mockGame();
        const r = await adapter().updateBlock(DOC, 1, { title: 'Weapons with unique effects' });
        expect(r.success).toBe(true);
        expect(writes()).toHaveLength(0);
    });

    test('updateBlock without title or description is a clear error (0.8 names are not written)', async () => {
        mockGame();
        for (const data of [{ columns: ['x'] }, { titulo: 'Old name', descripcion: 'x' }]) {
            const r = await adapter().updateBlock(DOC, 1, data);
            expect(r.success).toBe(false);
            expect(r.error).toContain('«title»');
        }
        expect(calls).toHaveLength(0);
    });

    test('moveBlock PUTs the order with ALL the ids; the hidden one keeps its slot', async () => {
        mockGame();
        // Visible: [g3, g1, p4]; full list: [g3, g1, g2(hidden), p4]
        const r = await adapter().moveBlock(DOC, 2, 0);

        expect(r.success).toBe(true);
        expect(writes()).toEqual([
            {
                url: `https://cms.test/api/games/${GAME_ID}/blocks/order`,
                method: 'PUT',
                body: {
                    ids: [
                        'crimson-desert-progress-checklist-4',
                        'crimson-desert-smart-grid-3',
                        'crimson-desert-smart-grid-2',
                        'crimson-desert-smart-grid-1'
                    ]
                },
                auth: `Bearer ${TOKEN}`
            }
        ]);
    });

    test('moveBlock out of range does not write', async () => {
        mockGame();
        const r = await adapter().moveBlock(DOC, 0, 3);
        expect(r.success).toBe(false);
        expect(r.error).toContain('out of range');
        expect(writes()).toHaveLength(0);
    });

    test('removeBlock HIDES (PATCH hidden: true), never deletes', async () => {
        mockGame();
        const r = await adapter().removeBlock(DOC, 2);

        expect(r.success).toBe(true);
        expect(writes()).toEqual([
            {
                url: `https://cms.test/api/games/${GAME_ID}/blocks/crimson-desert-progress-checklist-4/editorial`,
                method: 'PATCH',
                body: { hidden: true },
                auth: `Bearer ${TOKEN}`
            }
        ]);
        expect(calls.some((l) => l.method === 'DELETE')).toBe(false);
    });

    test('the index is resolved against the FRESH read, not the rendered one', async () => {
        // Rendered with g3 first; in between another editor hid g3
        let read = 0;
        mockGame(undefined, (url, init) => {
            if ((init?.method ?? 'GET') !== 'GET') return undefined;
            read++;
            const blocks = baseBlocks();
            if (read > 1) blocks[2].editorial = { ...blocks[2].editorial, hidden: true } as any;
            return { body: game(blocks) };
        });
        const a = adapter();
        const rendered = await a.getGame('crimson-desert');
        expect(rendered.blocks[0].id).toBe('crimson-desert-smart-grid-3');

        await a.updateBlockField(DOC, 0, 'title', 'X');
        expect(writes()[0].url).toContain('/blocks/crimson-desert-smart-grid-1/editorial');
    });

    test('insertBlock, insertBlocks and duplicateBlock fail with a clear error and without touching the API', async () => {
        mockGame();
        const a = adapter();

        const results = [
            await a.insertBlock(DOC, 0, 'smart-grid', {}),
            await a.insertBlocks(DOC, 0, [{ nativeType: 'smart-grid' }]),
            await a.insertBlocks(DOC, 0, []),
            await a.duplicateBlock(DOC, 0)
        ];

        for (const r of results) {
            expect(r.success).toBe(false);
            expect(r.error).toBe(GAME_BLOCK_INSERT_ERROR);
        }
        expect(calls).toHaveLength(0);
    });

    test('writing still requires an agent key', async () => {
        mockGame();
        const noToken = await new KitsudenAdapter({ endpoint: 'https://cms.test' }).updateBlockField(
            DOC,
            0,
            'title',
            'X'
        );
        const legacy = await adapter({ token: 'kitsuden_sk_old' }).removeBlock(DOC, 0);

        expect(noToken.success).toBe(false);
        expect(noToken.error).toContain('kitsuden_agent_');
        expect(legacy.success).toBe(false);
        expect(legacy.error).toContain('kitsuden_agent_');
        expect(calls).toHaveLength(0);
    });

    test('a game:<slug> documentId is not used to write', async () => {
        mockGame();
        const r = await adapter().updateBlockField('game:crimson-desert', 0, 'title', 'X');
        expect(r.success).toBe(false);
        expect(r.error).toContain('game:<uuid>');
        expect(calls).toHaveLength(0);
    });

    test("the server's error (400/404/422) reaches the editor with its reason", async () => {
        mockGame(undefined, (url, init) =>
            init?.method === 'PATCH' ? { status: 400, body: { error: 'title > 500 characters' } } : undefined
        );
        const r = await adapter().updateBlockField(DOC, 0, 'title', 'x'.repeat(600));
        expect(r.success).toBe(false);
        expect(r.error).toContain('400');
        expect(r.error).toContain('title > 500 characters');
    });

    test('configurable gamesPath', async () => {
        mockGame(undefined, (url, init) =>
            (init?.method ?? 'GET') === 'GET' && url.endsWith(`/v2/games/${GAME_ID}`) ? { body: game() } : undefined
        );
        await adapter({ gamesPath: '/v2/games/' }).removeBlock(DOC, 0);
        expect(writes()[0].url).toBe(
            `https://cms.test/v2/games/${GAME_ID}/blocks/crimson-desert-smart-grid-3/editorial`
        );
    });
});

describe('page builder pages do not change', () => {
    test('a page uuid without the prefix still writes to /api/page-builder', async () => {
        const PAGE = '11111111-2222-3333-4444-555555555555';
        mockGame(undefined, (url, init) =>
            (init?.method ?? 'GET') === 'GET' && url.includes('/api/page-builder/pages/')
                ? {
                      body: {
                          id: PAGE,
                          title: 'Home',
                          slug: 'home',
                          blocks: [{ id: 'b1', type: 'hero', sortOrder: 0, content: { headline: 'One' } }]
                      }
                  }
                : undefined
        );
        const r = await adapter().updateBlockField(PAGE, 0, 'headline', 'Two');
        expect(r.success).toBe(true);
        expect(writes()[0].url).toBe('https://cms.test/api/page-builder/blocks/b1');
        expect(writes()[0].body).toEqual({ content: { headline: 'Two' } });
        expect(calls.some((l) => l.url.includes('/api/games'))).toBe(false);
    });
});
