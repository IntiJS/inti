import { describe, test, expect, mock, afterEach, beforeAll, afterAll } from 'bun:test';

/**
 * A rejected write responds 403, not 500.
 *
 * Astro turns any `Error` thrown by an action's handler into a 500: only an
 * `ActionError` from `astro:actions` carries its own status
 * (`instanceof ActionError` in Astro's runtime). Until 2026-10-18 an
 * anonymous write rejected by the site's `beforeWrite` (the Kitsuden
 * starter's plugin, e.g.) reached the editor as a 500: "the server is
 * down" instead of "you do not have permission".
 *
 * Astro's virtual modules do not exist outside Vite, so here they are
 * replaced by Astro's REAL pieces: `ActionError` comes from its
 * runtime (the same code → status map the server uses) and `z` from the
 * zod that Astro ships. `defineAction` is reduced to returning the definition,
 * so the handler can be called directly.
 */

const { ActionError } = await import('astro/actions/runtime/shared.js');
const { z } = await import('zod');

mock.module('astro:actions', () => ({
    ActionError,
    defineAction: <T>(definition: T) => definition
}));
mock.module('astro:schema', () => ({ z }));

const { intiActions } = await import('../src/actions/index.js');
const { registerIntiPlugin, clearIntiPlugins } = await import('../src/plugins/index.js');
const { resetAccessWarnings } = await import('../src/server/access.js');

type Handler = (input: unknown, context?: { request?: Request }) => Promise<unknown>;
const handler = (name: keyof typeof intiActions): Handler =>
    (intiActions[name] as unknown as { handler: Handler }).handler;

/** Anonymous request: no session cookie or header */
const anonymous = { request: new Request('http://localhost/_actions/inti.updateBlockField', { method: 'POST' }) };

/** What a site's session plugin does: no actor, no write */
function registerSessionGuard(): void {
    registerIntiPlugin({
        name: 'session-guard',
        resolveActor: () => null,
        beforeWrite: (ctx) =>
            ctx.actor ? { allowed: true } : { allowed: false, reason: 'A session with role admin or editor is required.' }
    });
}

/** The error the action throws, or fails if it does not throw */
async function rejectionOf(promise: Promise<unknown>): Promise<any> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('the action did not reject the write');
}

let previousNodeEnv: string | undefined;

beforeAll(() => {
    // Production: the default access control is only relaxed in development
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
});

describe('anonymous write rejected by beforeWrite', () => {
    test('updateBlockField responds 403 FORBIDDEN with the plugin reason', async () => {
        registerSessionGuard();

        const error = await rejectionOf(
            handler('updateBlockField')({ documentId: 'page-1', blockIndex: 0, field: 'title', value: 'x' }, anonymous)
        );

        expect(error).toBeInstanceOf(ActionError);
        expect(error.code).toBe('FORBIDDEN');
        expect(error.status).toBe(403);
        expect(error.message).toBe('A session with role admin or editor is required.');
    });

    test('all per-block writes respond 403', async () => {
        registerSessionGuard();

        const calls: Array<[keyof typeof intiActions, unknown]> = [
            ['moveBlock', { documentId: 'page-1', fromIndex: 0, toIndex: 1 }],
            ['insertBlock', { documentId: 'page-1', index: 0, nativeType: 'hero' }],
            ['removeBlock', { documentId: 'page-1', index: 0 }],
            ['duplicateBlock', { documentId: 'page-1', index: 0 }],
            ['updateBlock', { documentId: 'page-1', blockIndex: 0, data: { title: 'x' } }],
            ['insertBlocks', { documentId: 'page-1', index: 0, blocks: [{ nativeType: 'hero' }] }]
        ];

        for (const [name, input] of calls) {
            const error = await rejectionOf(handler(name)(input, anonymous));
            expect({ name, status: error.status, code: error.code }).toEqual({ name, status: 403, code: 'FORBIDDEN' });
        }
    });

    test('the rejection happens before touching the CMS', async () => {
        registerSessionGuard();
        let afterWriteCalls = 0;
        registerIntiPlugin({ name: 'audit', afterWrite: () => { afterWriteCalls++; } });

        await rejectionOf(
            handler('updateBlockField')({ documentId: 'page-1', blockIndex: 0, field: 'title', value: 'x' }, anonymous)
        );

        expect(afterWriteCalls).toBe(0);
    });

    test('a plugin without a reason leaves a default message, also 403', async () => {
        registerIntiPlugin({ name: 'mute', beforeWrite: () => ({ allowed: false }) });

        const error = await rejectionOf(handler('removeBlock')({ documentId: 'page-1', index: 0 }, anonymous));

        expect(error.status).toBe(403);
        expect(error.message).toContain('mute');
    });
});

describe('production without a guard', () => {
    test('the default rule also responds 403, with the reason explaining how to fix it', async () => {
        const error = await rejectionOf(
            handler('updateBlockField')({ documentId: 'page-1', blockIndex: 0, field: 'title', value: 'x' }, anonymous)
        );

        expect(error).toBeInstanceOf(ActionError);
        expect(error.status).toBe(403);
        expect(error.message).toContain('INTI_ALLOW_ANONYMOUS_WRITES');
    });
});
