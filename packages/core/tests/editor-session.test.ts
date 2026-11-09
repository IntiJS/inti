import { describe, test, expect, afterEach } from 'bun:test';
import { evaluateEditorSession, resolveEditorSession, resetEditorSessionWarnings } from '../src/server/editor-session.js';
import { ANONYMOUS_WRITES_ENV } from '../src/server/access.js';
import { registerIntiPlugin, clearIntiPlugins } from '../src/plugins/index.js';
import { GET as syncGet, POST as syncPost } from '../src/api/sync.js';
import { GET as searchGet } from '../src/api/search.js';

const editor = { id: 'u1', role: 'editor' };
const base = { isDevelopment: false, actor: null, allowAnonymous: false };

/** Simulates production and restores the environment no matter what */
async function inProduction<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const all = { NODE_ENV: 'production', [ANONYMOUS_WRITES_ENV]: undefined, ...vars };
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(all)) {
        previous[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

/** Plugin that recognizes the editor by a header */
function registerHeaderSession(): void {
    registerIntiPlugin({
        name: 'test-session',
        resolveActor: (ctx) => (ctx.request?.headers.get('x-editor') === 'yes' ? editor : null)
    });
}

const call = (handler: any, request: Request) => handler({ request, cookies: undefined, url: new URL(request.url) });

afterEach(() => {
    clearIntiPlugins();
    resetEditorSessionWarnings();
});

describe('evaluateEditorSession', () => {
    test('rejects in production with no actor and no deliberate opening', () => {
        const decision = evaluateEditorSession(base);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('resolveActor');
        expect(decision.reason).toContain(ANONYMOUS_WRITES_ENV);
    });

    test('allows in development', () => {
        expect(evaluateEditorSession({ ...base, isDevelopment: true }).allowed).toBe(true);
    });

    test('allows with an actor', () => {
        const decision = evaluateEditorSession({ ...base, actor: editor });
        expect(decision).toEqual({ allowed: true, actor: editor });
    });

    test('allows with a deliberate opening', () => {
        expect(evaluateEditorSession({ ...base, allowAnonymous: true }).allowed).toBe(true);
    });
});

describe('resolveEditorSession', () => {
    test('a beforeWrite without resolveActor does not open the editor', async () => {
        registerIntiPlugin({ name: 'guard', beforeWrite: () => ({ allowed: true }) });
        const decision = await inProduction({}, () => resolveEditorSession({}));
        expect(decision.allowed).toBe(false);
    });

    test('resolveActor receives the "session" operation and the request', async () => {
        let seen: string | undefined;
        registerIntiPlugin({
            name: 'spy',
            resolveActor: (ctx) => {
                seen = ctx.operation;
                return editor;
            }
        });
        const decision = await inProduction({}, () =>
            resolveEditorSession({ request: new Request('http://x/'), documentId: 'doc' })
        );
        expect(seen).toBe('session');
        expect(decision.actor).toEqual(editor);
    });

    test('a prerendered page never carries the editor outside dev', async () => {
        registerIntiPlugin({ name: 'always', resolveActor: () => editor });
        const decision = await inProduction({}, () => resolveEditorSession({ prerendered: true }));
        expect(decision.allowed).toBe(false);
    });
});

describe('/api/inti/sync', () => {
    const post = (headers: Record<string, string> = {}) =>
        new Request('http://site/api/inti/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ docId: 'doc', clientId: 'c1', type: 'update', data: { x: 1 } })
        });

    test('POST without a session → 401', async () => {
        registerHeaderSession();
        const res = await inProduction({}, () => call(syncPost, post()));
        expect(res.status).toBe(401);
    });

    test('POST with a session → 200', async () => {
        registerHeaderSession();
        const res = await inProduction({}, () => call(syncPost, post({ 'x-editor': 'yes' })));
        expect(res.status).toBe(200);
    });

    test('POST that is not JSON → 415, even with a session', async () => {
        registerHeaderSession();
        const request = new Request('http://site/api/inti/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', 'x-editor': 'yes' },
            body: JSON.stringify({ docId: 'doc', clientId: 'c1' })
        });
        const res = await inProduction({}, () => call(syncPost, request));
        expect(res.status).toBe(415);
    });

    test('GET (listen) without a session → 401', async () => {
        const res = await inProduction({}, () =>
            call(syncGet, new Request('http://site/api/inti/sync?docId=doc'))
        );
        expect(res.status).toBe(401);
    });
});

describe('/api/inti/search', () => {
    test('without a session → 401', async () => {
        const res = await inProduction({}, () =>
            call(searchGet, new Request('http://site/api/inti/search?collection=posts&q=a'))
        );
        expect(res.status).toBe(401);
    });
});

// ============================================
// The user's plugin and the one the editor reads are the same
// ============================================

describe('plugin registry shared between copies of the module', () => {
    test('a plugin registered in one copy is seen by the other', async () => {
        // In a real project the user registers with `@intijs/core/plugins`
        // (dist/) and the editor session reads it from src/: two instances
        // of the module. With one array per instance, the session never saw the
        // plugin and in production no editor could open the editor.
        const copy = await import('../src/plugins/index.ts?other-instance');
        copy.registerIntiPlugin({
            name: 'from-other-copy',
            resolveActor: (ctx: any) => (ctx.request?.headers.get('x-editor') === 'yes' ? editor : null)
        });

        const decision = await inProduction({}, () =>
            resolveEditorSession({ request: new Request('http://x/', { headers: { 'x-editor': 'yes' } }) })
        );
        expect(decision.allowed).toBe(true);
        expect(decision.actor).toEqual(editor);
    });
});

// ============================================
// Diagnostics: plugin registered where it is not loaded in time
// ============================================

describe('warning when no one can identify the editor', () => {
    async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
        const original = console.warn;
        const warnings: string[] = [];
        console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
        try {
            await fn();
        } finally {
            console.warn = original;
        }
        return warnings;
    }

    test('in production without resolveActor it warns, only once, where to register it', async () => {
        const warnings = await captureWarnings(() =>
            inProduction({}, async () => {
                await resolveEditorSession({});
                await resolveEditorSession({});
            })
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('src/middleware.ts');
    });

    test('with a plugin that identifies it does not warn', async () => {
        registerHeaderSession();
        const warnings = await captureWarnings(() => inProduction({}, () => resolveEditorSession({})));
        expect(warnings).toHaveLength(0);
    });

    test('with the deliberate opening it does not warn', async () => {
        const warnings = await captureWarnings(() =>
            inProduction({ [ANONYMOUS_WRITES_ENV]: '1' }, () => resolveEditorSession({}))
        );
        expect(warnings).toHaveLength(0);
    });
});
