import { isNotFound } from '@intijs/core/errors';
import { describe, test, expect } from 'bun:test';
import { KitsudenAdapter, KitsudenUnavailableError, SUPPORTED_CONTRACTS } from '../src/index.js';

/**
 * What a real Kitsuden showed (scripts/kitsuden-check.mjs and the probes behind it):
 *
 * - publishing a 25-block draft took 62 calls; the agent quota (60/min) cut it and the public
 *   page was left with 3 of its 25 blocks;
 * - two fields of one block saved at the same moment kept only one;
 * - an edit made after someone reordered the page landed on another block.
 *
 * These tests pin the answers: the atomic and field-level routes when Kitsuden declares them,
 * a fallback that never empties a page, retries on 429, and writes addressed by block id.
 */

const PAGE = '11111111-2222-3333-4444-555555555555';
const DRAFT = '99999999-2222-3333-4444-555555555555';
const TOKEN = 'kitsuden_agent_tests';

type Call = { url: string; method: string; body?: any; headers: Record<string, string> };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

function page(order: string[] = ['b1', 'b2', 'b3']) {
    return {
        id: PAGE,
        title: 'Home',
        slug: 'home',
        status: 'published',
        updatedAt: '2026-01-01T00:00:00.000Z',
        blocks: order.map((id, i) => ({
            id,
            type: 'hero',
            sortOrder: i * 10,
            content: { headline: id.toUpperCase(), sub: 'keep' },
            updatedAt: id === 'b2' ? '2026-03-01T00:00:00.000Z' : '2026-02-01T00:00:00.000Z'
        }))
    };
}

/** A fetch that records calls and answers /api/version with the given contracts */
function fake(handler: (call: Call) => Reply, contracts: Record<string, number> = {}) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
        if (new URL(url).pathname === '/api/version') {
            const declared = { ...Object.fromEntries(Object.entries(SUPPORTED_CONTRACTS).map(([name, [, max]]) => [name, max])), ...contracts };
            return Response.json({ product: 'kitsuden', version: '0.10.0', contracts: declared });
        }
        const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, headers };
        calls.push(call);
        const reply = handler(call) ?? {};
        const status = reply.status ?? 200;
        return new Response(status === 204 || status === 304 ? null : JSON.stringify(reply.body ?? {}), {
            status,
            headers: { 'Content-Type': 'application/json', ...(reply.headers ?? {}) }
        });
    }) as typeof fetch;
    return { calls, fetchImpl };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

function adapter(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
    return new KitsudenAdapter({ endpoint: 'https://cms.test', token: TOKEN, fetch: fetchImpl, ...extra });
}

describe('writes addressed by block id', () => {
    test('an edit reaches the block the editor rendered, even after the page was reordered', async () => {
        // The editor rendered b1 at position 0; someone moved it to the end since
        const { calls, fetchImpl } = fake((c) => (c.method === 'GET' ? { body: page(['b2', 'b3', 'b1']) } : undefined));
        const result = await adapter(fetchImpl).updateBlockField(PAGE, 0, 'headline', 'New', { blockId: 'b1' });

        expect(result.success).toBe(true);
        expect(writes(calls)).toHaveLength(1);
        expect(writes(calls)[0].url).toEndWith('/blocks/b1');
    });

    test('a block that is gone writes nothing and says to reload', async () => {
        const { calls, fetchImpl } = fake((c) => (c.method === 'GET' ? { body: page(['b2', 'b3']) } : undefined));
        const result = await adapter(fetchImpl).updateBlockField(PAGE, 0, 'headline', 'New', { blockId: 'b1' });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/no longer on page .* Reload the page; nothing was written/);
        expect(writes(calls)).toHaveLength(0);
    });

    test('move, remove, duplicate and settings follow the id too', async () => {
        const reordered = page(['b2', 'b3', 'b1']);
        const { calls, fetchImpl } = fake((c) => {
            if (c.method === 'GET') return { body: reordered };
            if (c.url.endsWith('/duplicate')) return { body: { id: 'copy', sortOrder: 30, type: 'hero' } };
            return undefined;
        });
        const a = adapter(fetchImpl);

        expect((await a.removeBlock(PAGE, 0, { blockId: 'b1' })).success).toBe(true);
        expect(writes(calls).at(-1)!.url).toEndWith('/blocks/b1');

        expect((await a.updateBlock(PAGE, 0, { headline: 'X' }, { blockId: 'b1' })).success).toBe(true);
        expect(writes(calls).at(-1)!.url).toEndWith('/blocks/b1');

        // b1 is at position 2: moving it to 0 puts it first
        expect((await a.moveBlock(PAGE, 0, 0, { blockId: 'b1' })).success).toBe(true);
        expect(writes(calls).at(-1)!.body.blockOrders.map((o: { id: string }) => o.id)).toEqual(['b1', 'b2', 'b3']);

        // The copy goes right after b1, wherever b1 is (here in the middle)
        const middle = fake((c) => {
            if (c.method === 'GET') return { body: page(['b2', 'b1', 'b3']) };
            if (c.url.endsWith('/duplicate')) return { body: { id: 'copy', sortOrder: 30, type: 'hero' } };
            return undefined;
        });
        expect((await adapter(middle.fetchImpl).duplicateBlock(PAGE, 0, { blockId: 'b1' })).success).toBe(true);
        expect(writes(middle.calls)[0].url).toEndWith('/blocks/b1/duplicate');
        expect(writes(middle.calls)[1].body.blockOrders.map((o: { id: string }) => o.id)).toEqual(['b2', 'b1', 'copy', 'b3']);
    });

    test('without an id, writes work by position as before', async () => {
        const { calls, fetchImpl } = fake((c) => (c.method === 'GET' ? { body: page() } : undefined));
        expect((await adapter(fetchImpl).updateBlockField(PAGE, 1, 'headline', 'New')).success).toBe(true);
        expect(writes(calls)[0].url).toEndWith('/blocks/b2');
    });
});

describe('field edits', () => {
    test('with page-builder-patch only the field travels, so a concurrent edit of another field survives', async () => {
        const { calls, fetchImpl } = fake((c) => (c.method === 'GET' ? { body: page() } : undefined), { 'page-builder-patch': 1 });
        await adapter(fetchImpl).updateBlockField(PAGE, 0, 'headline', 'New');
        expect(writes(calls)[0].body).toEqual({ contentPatch: [{ path: 'headline', value: 'New' }] });
    });

    test('without it the whole content is sent, with the other fields as read', async () => {
        const { calls, fetchImpl } = fake((c) => (c.method === 'GET' ? { body: page() } : undefined));
        await adapter(fetchImpl).updateBlockField(PAGE, 0, 'headline', 'New');
        expect(writes(calls)[0].body).toEqual({ content: { headline: 'New', sub: 'keep' } });
    });

    test('a prototype path is refused before any request, on both routes', async () => {
        for (const contracts of [{}, { 'page-builder-patch': 1 }]) {
            const { calls, fetchImpl } = fake((c) => (c.method === 'GET' ? { body: page() } : undefined), contracts);
            const result = await adapter(fetchImpl).updateBlockField(PAGE, 0, 'a.__proto__.b', 1);
            expect(result.success).toBe(false);
            expect(calls).toHaveLength(0);
        }
    });
});

describe('publishing a draft', () => {
    const draft = () => ({ ...page(['n1', 'n2']), id: DRAFT, slug: `inti-draft-of-${PAGE}`, status: 'draft', title: 'Edited' });

    test('with page-builder-publish it is one transaction on the CMS', async () => {
        const { calls, fetchImpl } = fake(
            (c) => {
                if (c.method === 'GET' && c.url.includes(DRAFT)) return { body: draft() };
                if (c.url.endsWith('/publish-draft')) return { body: { ...page(['n1', 'n2']), slug: 'home' } };
                return undefined;
            },
            { 'page-builder-publish': 1 }
        );
        const result = await adapter(fetchImpl).publishDraft(DRAFT);

        expect(result).toMatchObject({ success: true, documentId: PAGE, slug: 'home' });
        expect(writes(calls)).toHaveLength(1);
        expect(writes(calls)[0]).toMatchObject({ method: 'POST', body: { draftId: DRAFT } });
        expect(writes(calls)[0].url).toEndWith(`/pages/${PAGE}/publish-draft`);
    });

    test('without it, the new blocks are shown before any old one is removed', async () => {
        let created = 0;
        const { calls, fetchImpl } = fake((c) => {
            if (c.method === 'GET') return { body: c.url.includes(DRAFT) ? draft() : page() };
            if (c.method === 'POST' && c.url.endsWith('/blocks')) return { body: { id: `new${++created}`, sortOrder: 100 + created, type: 'hero' } };
            return undefined;
        });
        const result = await adapter(fetchImpl).publishDraft(DRAFT);
        expect(result.success).toBe(true);

        const sequence = writes(calls).map((c) => `${c.method} ${new URL(c.url).pathname.replace('/api/page-builder', '')}`);
        const lastShow = sequence.findLastIndex((s) => s.startsWith('PATCH /blocks/new'));
        const firstDelete = sequence.findIndex((s) => s.startsWith('DELETE /blocks/b'));
        expect(lastShow).toBeGreaterThan(-1);
        expect(firstDelete).toBeGreaterThan(lastShow);
    });
});

describe('quotas and outages', () => {
    test('a write answered 429 waits what the CMS says and retries with the same Idempotency-Key', async () => {
        let attempts = 0;
        const { calls, fetchImpl } = fake((c) => {
            if (c.method === 'GET') return { body: page() };
            attempts++;
            return attempts === 1 ? { status: 429, body: { quota: 'requests_per_minute', retry_after: 0 } } : undefined;
        });
        const result = await adapter(fetchImpl).updateBlockField(PAGE, 0, 'headline', 'New');

        expect(result.success).toBe(true);
        const patches = writes(calls);
        expect(patches).toHaveLength(2);
        expect(patches[0].headers['idempotency-key']).toBeTruthy();
        expect(patches[1].headers['idempotency-key']).toBe(patches[0].headers['idempotency-key']);
    });

    test('a wait longer than allowed is not made: the write fails with the CMS reason', async () => {
        const { calls, fetchImpl } = fake((c) => (c.method === 'GET' ? { body: page() } : { status: 429, body: { retry_after: 3600 } }));
        const result = await adapter(fetchImpl).updateBlockField(PAGE, 0, 'headline', 'New');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/429/);
        expect(writes(calls)).toHaveLength(1);
    });

    test('every write carries its own Idempotency-Key; reads carry none', async () => {
        const { calls, fetchImpl } = fake((c) => (c.method === 'GET' ? { body: page() } : undefined));
        const a = adapter(fetchImpl);
        await a.updateBlockField(PAGE, 0, 'headline', 'One');
        await a.updateBlockField(PAGE, 0, 'headline', 'Two');
        const keys = writes(calls).map((c) => c.headers['idempotency-key']);
        expect(new Set(keys).size).toBe(2);
        expect(calls.filter((c) => c.method === 'GET').every((c) => !c.headers['idempotency-key'])).toBe(true);
    });

    test('a read the CMS cannot answer is a KitsudenUnavailableError a site can turn into a 503', async () => {
        const busy = fake(() => ({ status: 429, body: { retry_after: 30 } }));
        const error = await adapter(busy.fetchImpl).getPage('home').catch((e) => e);
        expect(error).toBeInstanceOf(KitsudenUnavailableError);
        expect(error).toMatchObject({ status: 429, retryAfter: 30 });
        // A page being rendered does not wait on a quota
        expect(busy.calls).toHaveLength(1);

        const down = fake(() => ({ status: 503 }));
        expect(await adapter(down.fetchImpl).getPage('home').catch((e) => e)).toBeInstanceOf(KitsudenUnavailableError);

        const offline = (async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof fetch;
        const unreachable = await adapter(offline).getPage('home').catch((e) => e);
        expect(unreachable).toBeInstanceOf(KitsudenUnavailableError);
        expect(unreachable.status).toBeUndefined();

        // A missing page is not an outage
        const missing = fake(() => ({ status: 404, body: { error: 'Page not found' } }));
        const notFound = await adapter(missing.fetchImpl).getPage('nope').catch((e) => e);
        expect(notFound).not.toBeInstanceOf(KitsudenUnavailableError);
        expect(isNotFound(notFound)).toBe(true);
    });
});

describe('reads of a site', () => {
    test('with siteKey, anonymous reads are counted per visitor; writes keep the agent key only', async () => {
        const { calls, fetchImpl } = fake((c) => (c.method === 'GET' ? { body: page() } : undefined));
        const a = new KitsudenAdapter({ endpoint: 'https://cms.test', token: TOKEN, fetch: fetchImpl, siteKey: 'site-secret', clientIp: () => '203.0.113.7' });

        await a.getPage('home');
        expect(calls[0].headers['x-kitsuden-site']).toBe('site-secret');
        expect(calls[0].headers['x-kitsuden-client']).toBe('203.0.113.7');
        expect(calls[0].headers.authorization).toBeUndefined();

        await a.updateBlockField(PAGE, 0, 'headline', 'New');
        const write = writes(calls)[0];
        expect(write.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(write.headers['x-kitsuden-site']).toBeUndefined();
    });

    test('the header names follow the Kitsuden build', async () => {
        const { calls, fetchImpl } = fake(() => ({ body: page() }));
        await adapter(fetchImpl, { siteKey: 'k', clientIp: () => '1.2.3.4', siteHeaders: { site: 'x-kitsuden-sitio', client: 'x-kitsuden-cliente' } }).getPage('home');
        expect(calls[0].headers['x-kitsuden-sitio']).toBe('k');
        expect(calls[0].headers['x-kitsuden-cliente']).toBe('1.2.3.4');
    });

    test('an unchanged page is revalidated with its ETag and not downloaded again', async () => {
        const { calls, fetchImpl } = fake((c) => (c.headers['if-none-match'] === 'W/"v1"' ? { status: 304 } : { body: page(), headers: { ETag: 'W/"v1"' } }));
        const a = adapter(fetchImpl);
        const first = await a.getPage('home');
        const second = await a.getPage('home');

        expect(calls[1].headers['if-none-match']).toBe('W/"v1"');
        expect(second.blocks.map((b) => b.id)).toEqual(first.blocks.map((b) => b.id));
    });

    test("the page's updatedAt is the latest of the page and its blocks", async () => {
        const { fetchImpl } = fake(() => ({ body: page() }));
        expect((await adapter(fetchImpl).getPage('home')).meta?.updatedAt).toBe('2026-03-01T00:00:00.000Z');
    });

    test('mediaUrl turns a media id into the public URL, in SEO and in data sources', async () => {
        const { fetchImpl } = fake(() => ({ body: { ...page(), ogImageId: 'img-1' } }));
        const a = adapter(fetchImpl, { mediaUrl: (id: string, preset: string) => `https://www.example.com/img/${id}/${preset}` });
        expect((await a.getPage('home')).seo?.image).toBe('https://www.example.com/img/img-1/large');
        expect(a.mediaAsData([{ id: 'img-2', summary: 'x' }])[0].value.url).toBe('https://www.example.com/img/img-2/large');

        // Default: the CMS's own preset route
        const plain = adapter(fetchImpl);
        expect((await plain.getPage('home')).seo?.image).toBe('https://cms.test/api/media/preset/img-1/large');
    });
});
