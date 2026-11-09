import { describe, test, expect, afterEach } from 'bun:test';
import {
    evaluateWriteAccess,
    assertWriteAccess,
    isDevelopmentRuntime,
    resetAccessWarnings,
    ANONYMOUS_WRITES_ENV
} from '../src/server/access.js';
import {
    registerIntiPlugin,
    clearIntiPlugins,
    hasWriteGuard
} from '../src/plugins/index.js';

// ============================================
// Helpers
// ============================================

const base = {
    operation: 'updateBlockField',
    hasWriteGuard: false,
    isDevelopment: false,
    allowAnonymous: false
};

/** Runs with a given environment and restores it no matter what */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(vars)) {
        previous[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        fn();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

afterEach(() => {
    clearIntiPlugins();
    resetAccessWarnings();
});

// ============================================
// The rule
// ============================================

describe('evaluateWriteAccess', () => {
    test('rejects in production when no one checks anything', () => {
        const decision = evaluateWriteAccess(base);
        expect(decision.allowed).toBe(false);
    });

    test('the reason explains how to fix it, not just that it failed', () => {
        const { reason } = evaluateWriteAccess(base);
        expect(reason).toContain('resolveActor');
        expect(reason).toContain(ANONYMOUS_WRITES_ENV);
        // The rejected operation appears, so it can be found in logs
        expect(reason).toContain('updateBlockField');
    });

    test('allows in development: the quickstart asks for no authentication', () => {
        expect(evaluateWriteAccess({ ...base, isDevelopment: true }).allowed).toBe(true);
    });

    test('allows if a guard is registered', () => {
        expect(evaluateWriteAccess({ ...base, hasWriteGuard: true }).allowed).toBe(true);
    });

    test('allows with the explicit opt-in', () => {
        expect(evaluateWriteAccess({ ...base, allowAnonymous: true }).allowed).toBe(true);
    });

    test('a registered guard overrides the missing opt-in', () => {
        // A beforeWrite may allow anonymous writes on purpose;
        // that decision belongs to the integrator and is not overridden here.
        const decision = evaluateWriteAccess({
            ...base,
            hasWriteGuard: true,
            allowAnonymous: false
        });
        expect(decision.allowed).toBe(true);
    });
});

// ============================================
// Environment detection: fail closed
// ============================================

describe('isDevelopmentRuntime', () => {
    test('an unidentified environment counts as production', () => {
        withEnv({ NODE_ENV: undefined }, () => {
            // import.meta.env.DEV may be on under the runner; what matters
            // is that a missing NODE_ENV does not mean "dev".
            const viteDev = (import.meta as any).env?.DEV === true;
            expect(isDevelopmentRuntime()).toBe(viteDev);
        });
    });

    test('NODE_ENV=production is not development', () => {
        withEnv({ NODE_ENV: 'production' }, () => {
            if ((import.meta as any).env?.DEV !== true) {
                expect(isDevelopmentRuntime()).toBe(false);
            }
        });
    });
});

// ============================================
// hasWriteGuard: it looks at the hook, not at its answer
// ============================================

describe('hasWriteGuard', () => {
    test('without plugins there is no guard', () => {
        expect(hasWriteGuard()).toBe(false);
    });

    test('a plugin with beforeWrite counts', () => {
        registerIntiPlugin({ name: 'guard', beforeWrite: () => ({ allowed: true }) });
        expect(hasWriteGuard()).toBe(true);
    });

    test('a plugin with resolveActor counts', () => {
        registerIntiPlugin({ name: 'auth', resolveActor: () => null });
        expect(hasWriteGuard()).toBe(true);
    });

    test('a plugin without write hooks does NOT count', () => {
        // A pattern store authenticates no one.
        registerIntiPlugin({ name: 'patterns', getPatternStore: () => null });
        expect(hasWriteGuard()).toBe(false);
    });

    test('a resolveActor that returns null is still a guard', () => {
        // The condition is "someone is deciding", not "there is an actor":
        // otherwise an anonymous visitor would disable the protection.
        registerIntiPlugin({ name: 'auth', resolveActor: () => null });
        expect(hasWriteGuard()).toBe(true);
    });
});

// ============================================
// assertWriteAccess: the real path
// ============================================

describe('assertWriteAccess', () => {
    test('throws in production without a guard', () => {
        withEnv({ NODE_ENV: 'production', [ANONYMOUS_WRITES_ENV]: undefined }, () => {
            expect(() => assertWriteAccess('updateBlockField', false)).toThrow(
                /unauthenticated write/i
            );
        });
    });

    test('does not throw with the opt-in on', () => {
        withEnv({ NODE_ENV: 'production', [ANONYMOUS_WRITES_ENV]: '1' }, () => {
            expect(() => assertWriteAccess('updateBlockField', false)).not.toThrow();
        });
    });

    test('the opt-in only accepts affirmative values', () => {
        withEnv({ NODE_ENV: 'production', [ANONYMOUS_WRITES_ENV]: 'false' }, () => {
            expect(() => assertWriteAccess('updateBlockField', false)).toThrow();
        });
        withEnv({ NODE_ENV: 'production', [ANONYMOUS_WRITES_ENV]: '0' }, () => {
            expect(() => assertWriteAccess('updateBlockField', false)).toThrow();
        });
        withEnv({ NODE_ENV: 'production', [ANONYMOUS_WRITES_ENV]: '' }, () => {
            expect(() => assertWriteAccess('updateBlockField', false)).toThrow();
        });
    });

    test('does not throw in production with a guard plugin', () => {
        withEnv({ NODE_ENV: 'production' }, () => {
            registerIntiPlugin({ name: 'guard', beforeWrite: () => ({ allowed: true }) });
            expect(() => assertWriteAccess('updateBlockField', hasWriteGuard())).not.toThrow();
        });
    });

    test('warns only once that anonymous writes are open', () => {
        withEnv({ NODE_ENV: 'production', [ANONYMOUS_WRITES_ENV]: '1' }, () => {
            const original = console.warn;
            const messages: string[] = [];
            console.warn = (...args: unknown[]) => { messages.push(args.join(' ')); };
            try {
                assertWriteAccess('updateBlockField', false);
                assertWriteAccess('updateBlockField', false);
                assertWriteAccess('moveBlock', false);
            } finally {
                console.warn = original;
            }
            expect(messages).toHaveLength(1);
            expect(messages[0]).toContain(ANONYMOUS_WRITES_ENV);
        });
    });
});
