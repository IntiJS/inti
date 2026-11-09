import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { KitsudenAdapter } from '../src/index.js';
import { isVersionRequest, compatibleVersionResponse } from './helpers/version.js';

/**
 * Writes in this adapter have two places where they can fail silently:
 *
 * 1. Inti says "block 1"; Kitsuden only understands uuids. If the translation
 *    is wrong, ANOTHER block is edited and the page still looks plausible while
 *    changed in the wrong place.
 * 2. Reordering by renumbering from 0 to n-1 would shift hidden blocks, which
 *    share the `sortOrder` scale and do not appear in the read.
 *
 * The tests below exist primarily for those two cases.
 */

const PAGE_ID = '11111111-2222-3333-4444-555555555555';

/** Three visible blocks with gaps between their sortOrder: the gaps belong to hidden blocks */
function pageWithBlocks() {
    return {
        id: PAGE_ID,
        title: 'Home',
        slug: 'home',
        status: 'published' as const,
        blocks: [
            { id: 'b1', pageId: PAGE_ID, type: 'hero', sortOrder: 0, content: { headline: 'One' } },
            {
                id: 'b2',
                pageId: PAGE_ID,
                type: 'richtext',
                sortOrder: 5,
                content: { text: 'Two', cta: { label: 'Go', url: '/go' } }
            },
            { id: 'b3', pageId: PAGE_ID, type: 'divider', sortOrder: 9, content: {} }
        ]
    };
}

const TYPES = [{ type: 'hero', name: 'Hero' }, { type: 'richtext', name: 'Text' }];

const TOKEN = 'kitsuden_agent_tests';

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

/** Default responses: page with blocks, palette, and OK for everything else */
function mockNormal(extra?: (url: string, init?: RequestInit) => { status?: number; body?: any } | undefined) {
    mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.includes('/block-types')) return { body: TYPES };
        if (url.includes(`/pages/${PAGE_ID}`) && (init?.method ?? 'GET') === 'GET') {
            return { body: pageWithBlocks() };
        }
        return { body: { success: true } };
    });
}

function createAdapter(extra: Record<string, unknown> = {}) {
    return new KitsudenAdapter({ endpoint: 'https://cms.test', token: TOKEN, ...extra });
}

const writes = () => calls.filter((c) => c.method !== 'GET');
const reordered = () => calls.find((c) => c.url.includes('/blocks/reorder'));

beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

// ============================================
// Position → uuid
// ============================================

describe('KitsudenAdapter.updateBlockField', () => {
    test('translates the position to the block uuid and sends only content', async () => {
        mockNormal();

        const result = await createAdapter().updateBlockField(PAGE_ID, 1, 'text', 'Two edited');

        expect(result).toMatchObject({ success: true, source: 'kitsuden' });

        const patch = writes()[0];
        // Block 1 is b2: if this said b1 or b3, another block would be edited
        expect(patch.url).toBe('https://cms.test/api/page-builder/blocks/b2');
        expect(patch.method).toBe('PATCH');
        expect(patch.body).toEqual({ content: { text: 'Two edited', cta: { label: 'Go', url: '/go' } } });
    });

    test('accepts dot-paths without losing the rest of the block', async () => {
        mockNormal();

        await createAdapter().updateBlockField(PAGE_ID, 1, 'cta.label', 'Let us go');

        expect(writes()[0].body.content).toEqual({
            text: 'Two',
            cta: { label: 'Let us go', url: '/go' }
        });
    });

    test('re-reads the page on every write', async () => {
        // The order may have changed since the page was rendered: reading
        // beforehand is the only thing that makes the translation reliable.
        mockNormal();

        const adapter = createAdapter();
        await adapter.updateBlockField(PAGE_ID, 0, 'headline', 'A');
        await adapter.updateBlockField(PAGE_ID, 0, 'headline', 'B');

        expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith(PAGE_ID))).toHaveLength(2);
    });

    test('a non-existent position fails without touching anything', async () => {
        mockNormal();

        const result = await createAdapter().updateBlockField(PAGE_ID, 7, 'text', 'x');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/out of range/);
        expect(writes()).toHaveLength(0);
    });

    test('a path containing __proto__ is rejected', async () => {
        // `field` comes from the browser: without this it would write to the prototype.
        mockNormal();

        const result = await createAdapter().updateBlockField(PAGE_ID, 0, '__proto__.polluted', 1);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Unsafe field path/);
        expect(writes()).toHaveLength(0);
        expect(({} as any).polluted).toBeUndefined();
    });

    test('the CMS error reaches the result in full', async () => {
        mockNormal((url, init) =>
            init?.method === 'PATCH' ? { status: 404, body: { error: 'Block not found' } } : undefined
        );

        const result = await createAdapter().updateBlockField(PAGE_ID, 0, 'headline', 'x');

        expect(result.success).toBe(false);
        expect(result.error).toContain('404');
        expect(result.error).toContain('Block not found');
    });
});

// ============================================
// Credentials
// ============================================

describe('KitsudenAdapter credentials', () => {
    test('without a token nothing is written, and it says so', async () => {
        mockNormal();

        const result = await new KitsudenAdapter({ endpoint: 'https://cms.test' }).updateBlockField(
            PAGE_ID,
            0,
            'headline',
            'x'
        );

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/kitsuden_agent/);
        expect(calls).toHaveLength(0);
    });

    test('a legacy kitsuden_sk_* key is rejected before receiving an opaque 401', async () => {
        mockNormal();

        const result = await createAdapter({ token: 'kitsuden_sk_old' }).updateBlockField(
            PAGE_ID,
            0,
            'headline',
            'x'
        );

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/agent key/);
        expect(calls).toHaveLength(0);
    });

    test('writes travel with the agent Bearer token', async () => {
        let header: string | undefined;
        globalThis.fetch = (async (input: any, init?: RequestInit) => {
            const url = String(input);
            if (init?.method === 'PATCH') {
                header = (init.headers as Record<string, string>)['Authorization'];
            }
            const body = url.includes(`/pages/${PAGE_ID}`) ? pageWithBlocks() : { ok: true };
            return new Response(JSON.stringify(body), { status: 200 });
        }) as typeof fetch;

        await createAdapter().updateBlockField(PAGE_ID, 0, 'headline', 'x');

        expect(header).toBe(`Bearer ${TOKEN}`);
    });
});

// ============================================
// Order
// ============================================

describe('KitsudenAdapter.moveBlock', () => {
    test('permutes the existing sortOrder values instead of renumbering', async () => {
        mockNormal();

        const result = await createAdapter().moveBlock(PAGE_ID, 0, 2);

        expect(result.success).toBe(true);
        // The values 0/5/9 are preserved: the gaps belong to hidden blocks,
        // which stay where they were.
        expect(reordered()!.body).toEqual({
            blockOrders: [
                { id: 'b2', sortOrder: 0 },
                { id: 'b3', sortOrder: 5 },
                { id: 'b1', sortOrder: 9 }
            ]
        });
    });

    test('when sortOrder values are duplicated there is no choice but to renumber', async () => {
        mockNormal((url, init) =>
            (init?.method ?? 'GET') === 'GET' && url.endsWith(PAGE_ID)
                ? {
                      body: {
                          ...pageWithBlocks(),
                          blocks: pageWithBlocks().blocks.map((b) => ({ ...b, sortOrder: 0 }))
                      }
                  }
                : undefined
        );

        await createAdapter().moveBlock(PAGE_ID, 2, 0);

        expect(reordered()!.body).toEqual({
            blockOrders: [
                { id: 'b3', sortOrder: 0 },
                { id: 'b1', sortOrder: 1 },
                { id: 'b2', sortOrder: 2 }
            ]
        });
    });

    test('moving to a non-existent position reorders nothing', async () => {
        mockNormal();

        const result = await createAdapter().moveBlock(PAGE_ID, 0, 9);

        expect(result.success).toBe(false);
        expect(reordered()).toBeUndefined();
    });
});

// ============================================
// Create, copy and delete
// ============================================

describe('KitsudenAdapter.insertBlock', () => {
    test('creates the block and places it in position', async () => {
        mockNormal((url, init) =>
            init?.method === 'POST' && url.endsWith('/blocks')
                ? { status: 201, body: { id: 'new-block', pageId: PAGE_ID, type: 'hero', sortOrder: 10, content: {} } }
                : undefined
        );

        const result = await createAdapter().insertBlock(PAGE_ID, 1, 'hero', { headline: 'New' });

        expect(result.success).toBe(true);

        const created = writes().find((c) => c.url.endsWith('/blocks'))!;
        expect(created.body).toEqual({ type: 'hero', content: { headline: 'New' } });

        // The API always appends at the end; reordering puts it at position 1
        expect(reordered()!.body.blockOrders.map((b: any) => b.id)).toEqual([
            'b1',
            'new-block',
            'b2',
            'b3'
        ]);
    });

    test('inserting at the end skips reordering', async () => {
        mockNormal((url, init) =>
            init?.method === 'POST' && url.endsWith('/blocks')
                ? { status: 201, body: { id: 'new-block', type: 'hero', sortOrder: 10, content: {} } }
                : undefined
        );

        await createAdapter().insertBlock(PAGE_ID, 3, 'hero');

        expect(reordered()).toBeUndefined();
    });

    test('a type outside the palette is rejected before creating anything', async () => {
        // Saving it would return 500 for an invalid enum and the editor would only see
        // "something went wrong".
        mockNormal();

        const result = await createAdapter().insertBlock(PAGE_ID, 0, 'made-up');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not in this CMS palette/);
        expect(writes()).toHaveLength(0);
    });
});

describe('KitsudenAdapter.insertBlocks', () => {
    test('if one of the creates fails, it deletes the ones already created', async () => {
        let creates = 0;
        mockNormal((url, init) => {
            if (init?.method === 'POST' && url.endsWith('/blocks')) {
                creates += 1;
                if (creates === 2) return { status: 500, body: { error: 'boom' } };
                return { status: 201, body: { id: `n${creates}`, type: 'hero', sortOrder: 10, content: {} } };
            }
            return undefined;
        });

        const result = await createAdapter().insertBlocks(PAGE_ID, 0, [
            { nativeType: 'hero' },
            { nativeType: 'richtext' }
        ]);

        expect(result.success).toBe(false);

        const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
        expect(deleted).toEqual(['https://cms.test/api/page-builder/blocks/n1']);
    });

    test('an empty list does not call the CMS', async () => {
        mockNormal();

        expect(await createAdapter().insertBlocks(PAGE_ID, 0, [])).toMatchObject({ success: true });
        expect(calls).toHaveLength(0);
    });
});

describe('KitsudenAdapter.duplicateBlock', () => {
    test('the copy lands right after the original', async () => {
        mockNormal((url, init) =>
            init?.method === 'POST' && url.includes('/duplicate')
                ? { status: 201, body: { id: 'copy', type: 'hero', sortOrder: 10, content: {} } }
                : undefined
        );

        const result = await createAdapter().duplicateBlock(PAGE_ID, 0);

        expect(result.success).toBe(true);
        expect(calls.some((c) => c.url.endsWith('/blocks/b1/duplicate'))).toBe(true);
        expect(reordered()!.body.blockOrders.map((b: any) => b.id)).toEqual([
            'b1',
            'copy',
            'b2',
            'b3'
        ]);
    });
});

describe('KitsudenAdapter.removeBlock', () => {
    test('deletes the uuid corresponding to the position', async () => {
        mockNormal();

        const result = await createAdapter().removeBlock(PAGE_ID, 2);

        expect(result.success).toBe(true);
        expect(writes()[0]).toMatchObject({
            url: 'https://cms.test/api/page-builder/blocks/b3',
            method: 'DELETE'
        });
    });
});
