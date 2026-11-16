import { describe, test, expect, mock, afterEach, beforeAll, afterAll } from 'bun:test';

/**
 * The editor sends the id of the block it rendered (`data-inti-block-id`) with every block
 * write, and the actions pass it on: to the adapter, which can address the block by id
 * instead of by a position that may have changed, and to `beforeWrite`, which can log it.
 *
 * Optional end to end: an editor that sends no id, or an adapter that ignores it, keeps
 * working by position.
 */

const { ActionError } = await import('astro/actions/runtime/shared.js');
const { z } = await import('zod');

mock.module('astro:actions', () => ({ ActionError, defineAction: <T>(definition: T) => definition }));
mock.module('astro:schema', () => ({ z }));

const { intiActions } = await import('../src/actions/index.js');
const { registerIntiPlugin, clearIntiPlugins } = await import('../src/plugins/index.js');

type Handler = (input: unknown, context?: { request?: Request }) => Promise<unknown>;
const run = (name: keyof typeof intiActions, input: unknown) =>
    (intiActions[name] as unknown as { handler: Handler }).handler(input, { request: new Request('http://localhost/_actions/x', { method: 'POST' }) });

const received: Array<{ method: string; args: unknown[] }> = [];
const seen: Array<string | undefined> = [];

const ok = (documentId: string) => Promise.resolve({ success: true, documentId });
const adapter = {
    name: 'Probe',
    writable: true as const,
    updateBlockField: (...args: unknown[]) => (received.push({ method: 'updateBlockField', args }), ok(String(args[0]))),
    updateBlock: (...args: unknown[]) => (received.push({ method: 'updateBlock', args }), ok(String(args[0]))),
    moveBlock: (...args: unknown[]) => (received.push({ method: 'moveBlock', args }), ok(String(args[0]))),
    removeBlock: (...args: unknown[]) => (received.push({ method: 'removeBlock', args }), ok(String(args[0]))),
    duplicateBlock: (...args: unknown[]) => (received.push({ method: 'duplicateBlock', args }), ok(String(args[0])))
};

let previousNodeEnv: string | undefined;
beforeAll(() => {
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
});
afterAll(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
});
afterEach(() => {
    clearIntiPlugins();
    received.length = 0;
    seen.length = 0;
});

function register() {
    registerIntiPlugin({
        name: 'probe',
        resolveActor: () => ({ id: 'editor' }),
        beforeWrite: (ctx) => {
            seen.push(ctx.blockId);
            return { allowed: true };
        },
        getWriteAdapter: () => adapter as never
    });
}

describe('block writes carry the rendered block id', () => {
    test('each block action passes blockId to the adapter and to beforeWrite', async () => {
        register();
        await run('updateBlockField', { documentId: 'p', blockIndex: 0, blockId: 'b1', field: 'title', value: 'x' });
        await run('updateBlock', { documentId: 'p', blockIndex: 0, blockId: 'b2', data: { a: 1 } });
        await run('moveBlock', { documentId: 'p', fromIndex: 0, toIndex: 1, blockId: 'b3' });
        await run('removeBlock', { documentId: 'p', index: 0, blockId: 'b4' });
        await run('duplicateBlock', { documentId: 'p', index: 0, blockId: 'b5' });

        expect(received.map((r) => [r.method, r.args.at(-1)])).toEqual([
            ['updateBlockField', { blockId: 'b1' }],
            ['updateBlock', { blockId: 'b2' }],
            ['moveBlock', { blockId: 'b3' }],
            ['removeBlock', { blockId: 'b4' }],
            ['duplicateBlock', { blockId: 'b5' }]
        ]);
        expect(seen).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
    });

    test('without an id the write still goes through, by position', async () => {
        register();
        await run('updateBlockField', { documentId: 'p', blockIndex: 2, field: 'title', value: 'x' });
        expect(received[0].args.slice(0, 4)).toEqual(['p', 2, 'title', 'x']);
        expect(received[0].args[4]).toEqual({ blockId: undefined });
    });

    test('the input schema only takes a short string as the id (Astro validates it before the handler)', () => {
        const schema = (name: keyof typeof intiActions) => (intiActions[name] as unknown as { input: { safeParse(v: unknown): { success: boolean } } }).input;
        expect(schema('updateBlockField').safeParse({ documentId: 'p', blockIndex: 0, blockId: 'b1', field: 't', value: 1 }).success).toBe(true);
        expect(schema('updateBlockField').safeParse({ documentId: 'p', blockIndex: 0, blockId: 'x'.repeat(201), field: 't', value: 1 }).success).toBe(false);
        expect(schema('removeBlock').safeParse({ documentId: 'p', index: 0, blockId: 42 }).success).toBe(false);
        expect(schema('moveBlock').safeParse({ documentId: 'p', fromIndex: 0, toIndex: 1, blockId: '' }).success).toBe(false);
    });
});
