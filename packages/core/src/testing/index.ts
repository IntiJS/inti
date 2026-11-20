/**
 * The conformance suite every adapter runs.
 *
 *   import { describe, test, expect } from 'bun:test';   // or vitest
 *   import { adapterConformance } from '@intijs/core/testing';
 *
 *   adapterConformance({ describe, test, expect }, {
 *       name: 'MyAdapter',
 *       create: () => new MyAdapter({ endpoint, fetch: fakeCms }),
 *       existingSlug: 'home',
 *       writableField: 'heading',
 *       unavailable: () => new MyAdapter({ endpoint, fetch: () => Promise.reject(new TypeError('fetch failed')) })
 *   });
 *
 * It checks the promises the rest of Inti relies on and that are easy to
 * break without noticing: a missing page is a `NotFoundError` and not a
 * generic error (or the site answers 503 instead of 404), a CMS that is down
 * is an `UnavailableError` (or the site answers 404 and is deindexed), a write
 * that cannot happen returns `{ success: false }` instead of throwing, a
 * dot-path never reaches the prototype, and block indexes are never renumbered.
 *
 * The test functions are injected, so the suite runs under any runner.
 */

import { isDraftableAdapter, isListableAdapter, isWritableAdapter, type IntiAdapter } from '../adapters/index.js';
import { isNotFound, isUnavailable } from '../errors/index.js';
import type { IntiPage } from '../types/index.js';

type Fn = () => unknown | Promise<unknown>;

/** The subset of `bun:test` / `vitest` the suite uses */
export interface TestApi {
    describe(name: string, body: () => void): unknown;
    test(name: string, body: Fn, timeout?: number): unknown;
    expect(value: unknown): {
        toBe(expected: unknown): unknown;
        toEqual(expected: unknown): unknown;
        toBeTruthy(): unknown;
        toContain(expected: unknown): unknown;
    };
}

export interface ConformanceTarget {
    name: string;
    /** A fresh adapter per check, pointed at a CMS (or a double) where `existingSlug` exists */
    create(): IntiAdapter | Promise<IntiAdapter>;
    /** A published page with at least one block */
    existingSlug: string;
    /** A slug that does not exist. Default `inti-conformance-missing` */
    missingSlug?: string;
    /** A text field of the first block, for the write checks. Without it they are skipped */
    writableField?: string;
    /** An adapter whose CMS cannot answer (refused connection, 503). Without it the check is skipped */
    unavailable?(): IntiAdapter | Promise<IntiAdapter>;
    /** Milliseconds per check. Default 10000 */
    timeout?: number;
    /** Checks a double of the CMS cannot support (`drafts`, `listing`) */
    skip?: Array<'drafts' | 'listing'>;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    return undefined;
}

function assertPage(expect: TestApi['expect'], page: IntiPage) {
    expect(typeof page.id).toBe('string');
    expect(typeof page.slug).toBe('string');
    expect(typeof page.title).toBe('string');
    expect(Array.isArray(page.blocks)).toBe(true);
    for (const block of page.blocks) {
        expect(typeof block.type).toBe('string');
        expect(block.data !== null && typeof block.data === 'object').toBe(true);
    }
    const indexes = page.blocks.map((block) => block.meta?.index).filter((index) => index !== undefined);
    // An index is how the editor addresses a block: two blocks must never share one
    expect(new Set(indexes).size).toBe(indexes.length);
}

export function adapterConformance(api: TestApi, target: ConformanceTarget): void {
    const { describe, test, expect } = api;
    const timeout = target.timeout ?? 10_000;
    const missing = target.missingSlug ?? 'inti-conformance-missing';

    describe(`${target.name} — adapter conformance`, () => {
        test('reads a page with the shape of IntiPage', async () => {
            const adapter = await target.create();
            const page = await adapter.fetchPageBySlug(target.existingSlug);
            assertPage(expect, page);
            expect(page.blocks.length > 0).toBe(true);
        }, timeout);

        test('a missing page is a NotFoundError (the site answers 404)', async () => {
            const adapter = await target.create();
            const error = await rejection(adapter.fetchPageBySlug(missing));
            expect(isNotFound(error)).toBe(true);
        }, timeout);

        if (target.unavailable) {
            const down = target.unavailable;
            test('a CMS that cannot answer is an UnavailableError (the site answers 503)', async () => {
                const adapter = await down();
                const error = await rejection(adapter.fetchPageBySlug(target.existingSlug));
                expect(error !== undefined).toBe(true);
                expect(isUnavailable(error)).toBe(true);
                expect(isNotFound(error)).toBe(false);
            }, timeout);
        }

        test('lists pages with ISO dates, when it can list', async () => {
            const adapter = await target.create();
            if (!isListableAdapter(adapter) || target.skip?.includes('listing')) return;
            const pages = await adapter.listPages();
            expect(pages.map((page) => page.slug)).toContain(target.existingSlug);
            for (const page of pages) {
                if (page.updatedAt !== undefined) expect(Number.isNaN(Date.parse(page.updatedAt))).toBe(false);
            }
        }, timeout);

        if (target.writableField) {
            const field = target.writableField;

            test('writes a field and reads it back', async () => {
                const adapter = await target.create();
                if (!isWritableAdapter(adapter)) return;
                const page = await adapter.fetchPageBySlug(target.existingSlug);
                const documentId = page.blocks[0]?.meta?.documentId ?? page.meta?.documentId ?? page.id;
                const index = page.blocks[0]?.meta?.index ?? 0;
                const value = `conformance ${Date.now()}`;
                const result = await adapter.updateBlockField(documentId, index, field, value, { blockId: page.blocks[0]?.id });
                expect(result.success).toBe(true);
                const again = await adapter.fetchPageBySlug(target.existingSlug);
                const block = again.blocks.find((candidate) => (candidate.meta?.index ?? again.blocks.indexOf(candidate)) === index);
                expect(block?.data?.[field]).toBe(value);
            }, timeout);

            test('a write that cannot happen returns success: false instead of throwing', async () => {
                const adapter = await target.create();
                if (!isWritableAdapter(adapter)) return;
                const page = await adapter.fetchPageBySlug(target.existingSlug);
                const documentId = page.blocks[0]?.meta?.documentId ?? page.meta?.documentId ?? page.id;
                let thrown: unknown;
                let result;
                try {
                    result = await adapter.updateBlockField(documentId, 9_999, field, 'x');
                } catch (error) {
                    thrown = error;
                }
                expect(thrown).toBe(undefined);
                expect(result?.success).toBe(false);
                expect(typeof result?.error).toBe('string');
            }, timeout);

            test('a dot-path never reaches the prototype', async () => {
                const adapter = await target.create();
                if (!isWritableAdapter(adapter)) return;
                const page = await adapter.fetchPageBySlug(target.existingSlug);
                const documentId = page.blocks[0]?.meta?.documentId ?? page.meta?.documentId ?? page.id;
                const index = page.blocks[0]?.meta?.index ?? 0;
                for (const path of ['__proto__.polluted', 'constructor.prototype.polluted', `${field}.__proto__`]) {
                    const result = await adapter.updateBlockField(documentId, index, path, 'yes').catch((error) => ({ success: false, error: String(error) }));
                    expect(result.success).toBe(false);
                }
                expect(({} as Record<string, unknown>).polluted).toBe(undefined);
            }, timeout);
        }

        test('drafts round-trip, when it has drafts', async () => {
            const adapter = await target.create();
            if (!isDraftableAdapter(adapter) || target.skip?.includes('drafts')) return;
            const page = await adapter.fetchPageBySlug(target.existingSlug);
            const draft = await adapter.createDraft(page.meta?.documentId ?? page.id);
            expect(draft.success).toBe(true);
            const read = await adapter.fetchDraftBySlug(target.existingSlug);
            expect(read !== null).toBe(true);
            const discarded = await adapter.discardDraft(draft.documentId);
            expect(discarded.success).toBe(true);
        }, timeout);
    });
}
