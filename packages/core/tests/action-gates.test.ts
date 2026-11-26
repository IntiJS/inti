import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test, expect, mock, afterEach, beforeAll, afterAll } from 'bun:test';

/**
 * The actions that are not adapter writes still sit behind the editor.
 *
 * A security audit (2026-11) found four ways around the write policy, each reproduced
 * against the built handlers:
 *
 * - `searchEntries` and `listPatterns` had no check at all: an anonymous POST queried
 *   the CMS with the server credential and read the shared patterns.
 * - `generateBlocks`, `savePattern` and `deletePattern` only checked that a guard was
 *   registered, never what it decided, so a site whose `beforeWrite` denies anonymous
 *   callers still let them spend the AI key and rewrite the pattern library.
 * - A `beforeWrite` that threw (a null actor, a failed lookup) let the write through.
 * - `publishDraft` was authorised only as the draft id, while it overwrites the
 *   published page: a policy protecting `home` was bypassed by publishing `home--draft`.
 *
 * Astro's virtual modules do not exist outside Vite; as in actions-forbidden.test.ts
 * they are replaced by Astro's real `ActionError` and zod.
 */

// Astro 7 keeps ActionError outside its package exports: load it by path, as actions-forbidden does
const astroDir = dirname(createRequire(import.meta.url).resolve('astro/package.json'));
const { ActionError } = await import(pathToFileURL(join(astroDir, 'dist/actions/runtime/client.js')).href);
const { z } = await import('zod');

mock.module('astro:actions', () => ({
    ActionError,
    defineAction: <T>(definition: T) => definition
}));
mock.module('astro:schema', () => ({ z }));

const { intiActions } = await import('../src/actions/index.js');
const { registerIntiPlugin, clearIntiPlugins } = await import('../src/plugins/index.js');
const { resetAccessWarnings } = await import('../src/server/access.js');
const { resetEditorSessionWarnings } = await import('../src/server/editor-session.js');
const { createMemoryPatternStore } = await import('../src/team/patterns.js');

type Handler = (input: unknown, context?: { request?: Request }) => Promise<unknown>;
const handler = (name: keyof typeof intiActions): Handler =>
    (intiActions[name] as unknown as { handler: Handler }).handler;

const anonymous = { request: new Request('http://localhost/_actions/inti.searchEntries', { method: 'POST' }) };
const editor = { id: 'editor-1', role: 'editor' };

/** A writable, searchable, draftable adapter that records what reaches it */
function fakeAdapter() {
    const calls: unknown[][] = [];
    const adapter = {
        name: 'fake',
        writable: true as const,
        async updateBlockField(...args: unknown[]) {
            calls.push(['updateBlockField', ...args]);
            return { success: true, documentId: String(args[0]) };
        },
        async searchEntries(collection: string, query: string) {
            calls.push(['searchEntries', collection, query]);
            return [{ id: '1', title: 'Unpublished pricing' }];
        },
        async fetchDraftBySlug() {
            return null;
        },
        async createDraft(documentId: string) {
            return { success: true, documentId: `${documentId}--draft` };
        },
        async publishDraft(draftId: string) {
            calls.push(['publishDraft', draftId]);
            return { success: true, documentId: draftId.replace(/--draft$/, '') };
        },
        async discardDraft(draftId: string) {
            return { success: true, documentId: draftId };
        },
        async draftOriginId(draftId: string) {
            return draftId.endsWith('--draft') ? draftId.slice(0, -'--draft'.length) : null;
        }
    };
    return { adapter, calls };
}

/** A site's session plugin: resolves an actor (or null) and denies writes without one */
function registerSession(actor: typeof editor | null, extra: Record<string, unknown> = {}) {
    registerIntiPlugin({
        name: 'session',
        resolveActor: () => actor,
        beforeWrite: (ctx) => (ctx.actor ? { allowed: true } : { allowed: false, reason: 'A session is required.' }),
        ...extra
    } as never);
}

async function rejectionOf(promise: Promise<unknown>): Promise<any> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('the action was not rejected');
}

let previousNodeEnv: string | undefined;

beforeAll(() => {
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.INTI_ALLOW_ANONYMOUS_WRITES;
});

afterAll(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
});

afterEach(() => {
    clearIntiPlugins();
    resetAccessWarnings();
    resetEditorSessionWarnings();
});

describe('searchEntries and listPatterns need an editor session', () => {
    test('an anonymous search is refused before the CMS is queried, even with no plugin', async () => {
        const { adapter, calls } = fakeAdapter();
        registerIntiPlugin({ name: 'cms', getWriteAdapter: () => adapter } as never);

        const error = await rejectionOf(handler('searchEntries')({ collection: 'pages', query: '' }, anonymous));
        expect(error).toBeInstanceOf(ActionError);
        expect(error.code).toBe('UNAUTHORIZED');
        expect(calls).toEqual([]);
    });

    test('an editor can search', async () => {
        const { adapter } = fakeAdapter();
        registerSession(editor, { getWriteAdapter: () => adapter });
        expect(await handler('searchEntries')({ collection: 'pages', query: '' }, anonymous)).toEqual([
            { id: '1', title: 'Unpublished pricing' }
        ]);
    });

    test('a collection that is not a plain name never reaches the adapter', async () => {
        const { adapter, calls } = fakeAdapter();
        registerSession(editor, { getWriteAdapter: () => adapter });

        for (const collection of ['../users', 'posts?status=any', 'a/b', '%2e%2e']) {
            const error = await rejectionOf(handler('searchEntries')({ collection, query: '' }, anonymous));
            expect(error.code).toBe('BAD_REQUEST');
        }
        expect(calls).toEqual([]);
    });

    test('anonymous callers cannot read the shared patterns', async () => {
        const store = createMemoryPatternStore([{ name: 'launch', blocks: [{ nativeType: 'Hero', data: { heading: 'Secret' } }] }]);
        registerSession(null, { getPatternStore: () => store });

        const error = await rejectionOf(handler('listPatterns')({}, anonymous));
        expect(error.code).toBe('UNAUTHORIZED');
    });
});

describe('generateBlocks and the pattern actions apply the site policy', () => {
    test('an anonymous caller cannot spend the generator', async () => {
        let calls = 0;
        registerSession(null, {
            getBlockGenerator: () => ({
                generate: async () => {
                    calls++;
                    return { blocks: [], warnings: [] };
                }
            })
        });

        const error = await rejectionOf(
            handler('generateBlocks')({ prompt: 'x', blockTypes: [{ nativeType: 'Hero' }] }, anonymous)
        );
        expect(error.code).toBe('UNAUTHORIZED');
        expect(calls).toBe(0);
    });

    test('an anonymous caller cannot save over or delete a shared pattern', async () => {
        const store = createMemoryPatternStore([{ name: 'launch', blocks: [{ nativeType: 'Hero', data: { heading: 'Original' } }] }]);
        registerSession(null, { getPatternStore: () => store });

        const save = await rejectionOf(
            handler('savePattern')({ name: 'launch', blocks: [{ nativeType: 'Hero', data: { heading: 'Overwritten' } }] }, anonymous)
        );
        const remove = await rejectionOf(handler('deletePattern')({ name: 'launch' }, anonymous));
        expect(save.code).toBe('UNAUTHORIZED');
        expect(remove.code).toBe('UNAUTHORIZED');

        const patterns = await store.list();
        expect(patterns).toHaveLength(1);
        expect(patterns[0].blocks[0].data.heading).toBe('Original');
    });

    test('the site beforeWrite decides pattern writes for an editor too', async () => {
        const store = createMemoryPatternStore();
        registerIntiPlugin({
            name: 'no-patterns',
            resolveActor: () => editor,
            beforeWrite: (ctx: { operation: string }) =>
                ctx.operation === 'savePattern' ? { allowed: false, reason: 'Patterns are managed by admins.' } : { allowed: true },
            getPatternStore: () => store
        } as never);

        const error = await rejectionOf(
            handler('savePattern')({ name: 'p', blocks: [{ nativeType: 'Hero', data: {} }] }, anonymous)
        );
        expect(error.code).toBe('FORBIDDEN');
        expect(await store.list()).toEqual([]);
    });

    test('an editor still generates and saves patterns', async () => {
        const store = createMemoryPatternStore();
        registerSession(editor, {
            getPatternStore: () => store,
            getBlockGenerator: () => ({ generate: async () => ({ blocks: [], warnings: [] }) })
        });

        expect(await handler('generateBlocks')({ prompt: 'x', blockTypes: [{ nativeType: 'Hero' }] }, anonymous)).toMatchObject({
            available: true
        });
        expect(await handler('savePattern')({ name: 'p', blocks: [{ nativeType: 'Hero', data: {} }] }, anonymous)).toEqual({
            shared: true
        });
        expect((await store.list())[0].createdBy).toBe('editor-1');
    });
});

describe('a beforeWrite that fails denies the write', () => {
    test('an exception in the policy is a denial, not an approval', async () => {
        const { adapter, calls } = fakeAdapter();
        registerIntiPlugin({
            name: 'buggy-policy',
            resolveActor: () => null,
            // Dereferences a null actor: throws for every anonymous request
            beforeWrite: (ctx: { actor: { role: string } }) => ({ allowed: ctx.actor.role === 'editor' }),
            getWriteAdapter: () => adapter
        } as never);

        const error = await rejectionOf(
            handler('updateBlockField')({ documentId: 'blog', blockIndex: 0, field: 'heading', value: 'x' }, anonymous)
        );
        expect(error.code).toBe('FORBIDDEN');
        expect(calls).toEqual([]);
    });
});

describe('publishDraft is authorised for the page it overwrites', () => {
    const protectHome = (adapter: unknown) =>
        registerIntiPlugin({
            name: 'protect-home',
            resolveActor: () => editor,
            beforeWrite: (ctx: { operation: string; documentId: string }) =>
                ctx.operation === 'publishDraft' && ctx.documentId === 'home'
                    ? { allowed: false, reason: 'Publishing home is restricted.' }
                    : { allowed: true },
            getWriteAdapter: () => adapter
        } as never);

    test('publishing the draft of a protected page is refused', async () => {
        const { adapter, calls } = fakeAdapter();
        protectHome(adapter);

        const error = await rejectionOf(handler('publishDraft')({ documentId: 'home--draft' }, anonymous));
        expect(error.code).toBe('FORBIDDEN');
        expect(calls).toEqual([]);
    });

    test('publishing the draft of another page goes through', async () => {
        const { adapter, calls } = fakeAdapter();
        protectHome(adapter);

        await handler('publishDraft')({ documentId: 'blog--draft' }, anonymous);
        expect(calls).toEqual([['publishDraft', 'blog--draft']]);
    });
});
