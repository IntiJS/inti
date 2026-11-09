import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { KitsudenAdapter } from '../src/index.js';
import { isVersionRequest, compatibleVersionResponse } from './helpers/version.js';

/**
 * The invariant that matters: `parsePage` exposes an index per block and the write path resolves
 * that same index to a row to PATCH it by id. If one sorts and the other does not, editing block
 * N writes to another block — with no error, no warning, and the editor sees "saved".
 *
 * The fixture's rows arrive out of order on purpose, which is what the API is allowed to return
 * (it promises no order) and what made this depend on luck.
 */

const PAGE_ID = 'p1';

const UNSORTED_ROWS = [
    { id: 'row-c', type: 'footer', sortOrder: 30, content: { t: 'footer' } },
    { id: 'row-a', type: 'hero', sortOrder: 10, content: { t: 'cover' } },
    { id: 'row-b', type: 'richtext', sortOrder: 20, content: { t: 'middle' } }
];

const PAGE = {
    id: PAGE_ID,
    title: 'Home',
    slug: 'home',
    status: 'published' as const,
    requireAuth: false,
    updatedAt: '2026-09-01T10:00:00.000Z',
    blocks: UNSORTED_ROWS
};

let calls: Array<{ url: string; method: string; body?: any }> = [];
let originalFetch: typeof fetch;

function mockFetch() {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (isVersionRequest(url)) return compatibleVersionResponse();
        calls.push({
            url,
            method: init?.method ?? 'GET',
            body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        return new Response(JSON.stringify(PAGE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }) as typeof fetch;
}

function newAdapter() {
    return new KitsudenAdapter({
        endpoint: 'https://cms.test',
        token: 'kitsuden_agent_test'
    });
}

beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    mockFetch();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('addressing by index', () => {
    test("parsePage's index and the write's point to the same block", async () => {
        const adapter = newAdapter();

        const page = adapter.parsePage(PAGE as any);
        // After sorting: 0=hero(row-a), 1=richtext(row-b), 2=footer(row-c)
        expect(page.blocks.map((b) => b.id)).toEqual(['row-a', 'row-b', 'row-c']);

        for (const [index, expectedId] of [
            [0, 'row-a'],
            [1, 'row-b'],
            [2, 'row-c']
        ] as const) {
            calls = [];
            await adapter.updateBlockField(PAGE_ID, index, 't', 'new');

            const patch = calls.find((l) => l.method === 'PATCH');
            expect(patch).toBeDefined();
            expect(patch!.url).toContain(`/blocks/${expectedId}`);
        }
    });

    test("the PATCH goes to the row's id, not to its position", async () => {
        const adapter = newAdapter();
        await adapter.updateBlockField(PAGE_ID, 0, 't', 'x');

        const patch = calls.find((l) => l.method === 'PATCH')!;
        // row-a is first by sortOrder (10) but arrives second in the array
        expect(patch.url).toContain('/blocks/row-a');
        expect(patch.body?.content?.t).toBe('x');
    });

    test('an index out of range fails instead of writing to another block', async () => {
        const adapter = newAdapter();
        const result = await adapter.updateBlockField(PAGE_ID, 99, 't', 'x');

        expect(result.success).toBe(false);
        expect(calls.some((l) => l.method === 'PATCH')).toBe(false);
    });
});
