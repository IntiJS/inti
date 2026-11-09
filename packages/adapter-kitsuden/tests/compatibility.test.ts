import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SUPPORTED_CONTRACTS, KitsudenAdapter, ADAPTER_VERSION } from '../src/index.js';

/**
 * Compatibility check with the API (the contracts of `GET /api/version`).
 *
 * Lazy: nothing is requested when the adapter is built or when it READS (reading published pages
 * has to keep working against any Kitsuden); it is requested once, before the first write. A
 * contract the adapter does not understand stops the write BEFORE anything is touched; an old
 * Kitsuden without the route only produces a warning.
 */

const PAGE_ID = '11111111-2222-3333-4444-555555555555';
const GAME_ID = '0a6e1c2e-0000-4000-8000-000000000001';
const TOKEN = 'kitsuden_agent_tests';

const PAGE = {
    id: PAGE_ID,
    title: 'Home',
    slug: 'home',
    blocks: [{ id: 'b1', pageId: PAGE_ID, type: 'hero', sortOrder: 0, content: { headline: 'Hello' } }]
};
const GAME = {
    id: GAME_ID,
    title: 'Crimson Desert',
    slug: 'crimson-desert',
    blocks: [{ id: 'cd-1', type: 'tier-list', order: 0, data: { title: 'Tier' } }]
};

type Version = { status?: number; body?: unknown; throws?: boolean };

let calls: Array<{ url: string; method: string }> = [];
let warnings: string[] = [];
let version: Version;
let originalFetch: typeof fetch;
let originalWarn: typeof console.warn;
let originalError: typeof console.error;

function contracts(changes: Record<string, number | undefined> = {}) {
    const base: Record<string, number | undefined> = Object.fromEntries(
        Object.entries(SUPPORTED_CONTRACTS).map(([name, [, max]]) => [name, max])
    );
    Object.assign(base, changes);
    return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined));
}

function respond(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
    calls = [];
    warnings = [];
    version = { body: { product: 'kitsuden', version: '0.9.0-beta', contracts: contracts() } };
    originalFetch = globalThis.fetch;
    originalWarn = console.warn;
    originalError = console.error;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
    console.error = () => {};

    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method });
        const { pathname } = new URL(url);

        if (pathname === '/api/version' || pathname === '/cms/version') {
            if (version.throws) throw new TypeError('fetch failed');
            return respond(version.status ?? 200, version.body ?? {});
        }
        if (pathname.startsWith('/api/page-builder/pages/') && method === 'GET') return respond(200, PAGE);
        if (pathname === '/api/page-builder/pages') return respond(200, { docs: [], totalDocs: 0, limit: 100, offset: 0 });
        if (pathname === '/api/page-builder/block-types') return respond(200, { blockTypes: [{ type: 'hero', name: 'Hero' }] });
        if (pathname.startsWith('/api/page-builder/blocks/')) return respond(200, { id: 'b1' });
        if (pathname.startsWith('/api/games/') && method === 'GET') return respond(200, GAME);
        if (pathname.includes('/blocks/')) return respond(200, { id: 'cd-1', editorial: { title: 'x' } });
        return respond(404, { error: 'not mocked' });
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
});

const adapter = (extra: Record<string, unknown> = {}) =>
    new KitsudenAdapter({ endpoint: 'https://cms.test', token: TOKEN, ...extra });

const versionRequests = () => calls.filter((l) => new URL(l.url).pathname.endsWith('/version'));
const writes = () => calls.filter((l) => l.method !== 'GET');

describe('lazy check', () => {
    test('building and READING do not query /api/version', async () => {
        const a = adapter();
        await a.getPage(PAGE_ID);
        await a.getGame('crimson-desert');
        await a.listPages();
        await a.blockTypes();
        expect(versionRequests()).toHaveLength(0);
    });

    test('the first write requests it; the next ones reuse the answer', async () => {
        const a = adapter();
        expect((await a.updateBlockField(PAGE_ID, 0, 'headline', 'One')).success).toBe(true);
        expect((await a.updateBlockField(PAGE_ID, 0, 'headline', 'Two')).success).toBe(true);
        expect((await a.updateBlockField(`game:${GAME_ID}`, 0, 'title', 'Three')).success).toBe(true);
        expect(versionRequests()).toHaveLength(1);
        // And it was requested BEFORE the first write
        expect(calls.findIndex((l) => l.url.endsWith('/api/version'))).toBeLessThan(
            calls.findIndex((l) => l.method !== 'GET')
        );
        expect(warnings).toHaveLength(0);
    });

    test('checkCompatibility() can be called at startup and returns what the API declares', async () => {
        const api = await adapter().checkCompatibility();
        expect(api?.version).toBe('0.9.0-beta');
        expect(api?.contracts['page-builder']).toBe(SUPPORTED_CONTRACTS['page-builder'][1]);
    });

    test('a Kitsuden 0.8 answer (`producto`, `contratos`) is read for one version', async () => {
        version.body = { producto: 'kitsuden', version: '0.8.0', contratos: contracts() };
        const api = await adapter().checkCompatibility();
        expect(api).toEqual({ product: 'kitsuden', version: '0.8.0', contracts: contracts() });
    });

    test('checkCompatibility: false never asks', async () => {
        const a = adapter({ checkCompatibility: false });
        expect((await a.updateBlockField(PAGE_ID, 0, 'headline', 'One')).success).toBe(true);
        expect(versionRequests()).toHaveLength(0);
    });

    test('versionPath is honored (Kitsuden behind another prefix)', async () => {
        await adapter({ versionPath: 'cms/version' }).updateBlockField(PAGE_ID, 0, 'headline', 'One');
        expect(versionRequests().map((l) => l.url)).toEqual(['https://cms.test/cms/version']);
    });
});

describe('incompatible contract: clear error and NOTHING written', () => {
    test('the API speaks page-builder v2 → asks to update the adapter', async () => {
        version.body = { product: 'kitsuden', version: '2.0.0', contracts: contracts({ 'page-builder': 2 }) };
        const r = await adapter().updateBlockField(PAGE_ID, 0, 'headline', 'One');

        expect(r.success).toBe(false);
        expect(r.error).toContain('Kitsuden 2.0.0 speaks «page-builder» v2');
        expect(r.error).toContain(`@intijs/adapter-kitsuden ${ADAPTER_VERSION} only understands v1`);
        expect(r.error).toContain('update @intijs/adapter-kitsuden');
        expect(writes()).toHaveLength(0);
        // It does not even re-read the page: it fails before touching content
        expect(calls.filter((l) => l.url.includes('/pages/'))).toHaveLength(0);
    });

    test('the API speaks a version OLDER than the minimum → asks to update Kitsuden', async () => {
        version.body = { product: 'kitsuden', version: '0.1.0', contracts: contracts({ 'page-builder': 0 }) };
        const r = await adapter().moveBlock(PAGE_ID, 0, 0);
        expect(r.success).toBe(false);
        expect(r.error).toContain('older than');
        expect(r.error).toContain('update Kitsuden');
        expect(writes()).toHaveLength(0);
    });

    test('a Kitsuden 0.8 (games v1, Spanish keys and /bloques/ routes) is not written on game pages', async () => {
        version.body = {
            producto: 'kitsuden',
            version: '0.8.0',
            contratos: contracts({ games: 1, 'games-editorial': 1 })
        };
        const a = adapter();
        const r = await a.updateBlockField(`game:${GAME_ID}`, 0, 'title', 'New');
        expect(r.success).toBe(false);
        expect(r.error).toContain('«games» v1, older than the v2');
        expect(writes()).toHaveLength(0);
        // Its pages (page-builder v1) still are
        expect((await a.updateBlockField(PAGE_ID, 0, 'headline', 'One')).success).toBe(true);
    });

    test('a Kitsuden without the editorial layer (no games-editorial) blocks game writes, not page ones', async () => {
        version.body = { product: 'kitsuden', version: '0.9.0', contracts: contracts({ 'games-editorial': undefined }) };
        const a = adapter();

        const game = await a.updateBlockField(`game:${GAME_ID}`, 0, 'title', 'New');
        expect(game.success).toBe(false);
        expect(game.error).toContain('does not declare the contract «games-editorial»');
        // Kitsuden only announces the contracts of mounted kons: usually a kon turned off
        expect(game.error).toContain('kon-games');
        expect(game.error).toContain('turned off');
        expect(game.error).not.toContain('update Kitsuden');
        expect(writes()).toHaveLength(0);

        const page = await a.updateBlockField(PAGE_ID, 0, 'headline', 'One');
        expect(page.success).toBe(true);
    });

    test('games v3 also blocks hiding and moving game blocks', async () => {
        version.body = { product: 'kitsuden', version: '2.0.0', contracts: contracts({ games: 3 }) };
        const a = adapter();
        expect((await a.removeBlock(`game:${GAME_ID}`, 0)).error).toContain('«games» v3');
        expect((await a.moveBlock(`game:${GAME_ID}`, 0, 0)).error).toContain('«games» v3');
        expect(writes()).toHaveLength(0);
    });

    test('a contract the adapter does not use (e.g. admin-registry v9) does not get in the way', async () => {
        version.body = { product: 'kitsuden', version: '3.0.0', contracts: contracts({ 'admin-registry': 9 } as any) };
        expect((await adapter().updateBlockField(PAGE_ID, 0, 'headline', 'One')).success).toBe(true);
    });
});

describe('a Kitsuden that does not publish /api/version, or does not answer', () => {
    test('404 (Kitsuden < 0.9.0) → one warning and it writes; it does not ask again', async () => {
        version = { status: 404, body: { error: 'Not Found' } };
        const a = adapter();
        expect((await a.updateBlockField(PAGE_ID, 0, 'headline', 'One')).success).toBe(true);
        expect((await a.updateBlockField(PAGE_ID, 0, 'headline', 'Two')).success).toBe(true);

        expect(versionRequests()).toHaveLength(1);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('/api/version does not exist');
        expect(writes()).toHaveLength(2);
    });

    test('500 → warning, it writes, and it retries on the next write', async () => {
        version = { status: 500, body: { error: 'boom' } };
        const a = adapter();
        expect((await a.updateBlockField(PAGE_ID, 0, 'headline', 'One')).success).toBe(true);
        expect(warnings[0]).toContain('could not check the Kitsuden version');

        // It recovers: the second write asks again and now checks
        version = { body: { product: 'kitsuden', version: '2.0.0', contracts: contracts({ 'page-builder': 2 }) } };
        const r = await a.updateBlockField(PAGE_ID, 0, 'headline', 'Two');
        expect(versionRequests()).toHaveLength(2);
        expect(r.success).toBe(false);
        expect(writes()).toHaveLength(1);
    });

    test('network error → warning and it writes', async () => {
        version = { throws: true };
        expect((await adapter().updateBlockField(PAGE_ID, 0, 'headline', 'One')).success).toBe(true);
        expect(warnings[0]).toContain('fetch failed');
    });

    test("a 200 that is not Kitsuden's (no `contracts`) → warning and it writes", async () => {
        version = { body: { status: 'ok' } };
        expect((await adapter().updateBlockField(PAGE_ID, 0, 'headline', 'One')).success).toBe(true);
        expect(warnings[0]).toContain("did not return Kitsuden's shape");
    });
});

test('ADAPTER_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
    expect(ADAPTER_VERSION).toBe(pkg.version);
});
