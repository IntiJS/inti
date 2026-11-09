/**
 * Default access control for the write actions.
 *
 * Astro actions are HTTP endpoints: they exist in production whether or
 * not the editor is shown. Hiding the UI (which is what
 * `shouldEnableVisualBridge` does) does not close the endpoint, so with
 * nothing else a `POST /_actions/inti.updateBlockField` rewrites the
 * client's CMS using the server's credentials.
 *
 * The core ships no authentication —that lives in the plugin the
 * integrator writes—, but it can refuse to write when
 * NOBODY is checking anything. That is the rule here:
 *
 *   production + no plugin declaring `beforeWrite` or
 *   `resolveActor` + no explicit opt-in → the write is rejected.
 *
 * Note that the condition is "a guard is registered", not "there is an
 * actor". A `beforeWrite` may legitimately allow anonymous writes; if
 * the integrator wired it, the decision is theirs and we do not
 * override it. What is rejected is the case where nobody decides.
 */

/** Variable that deliberately opens anonymous writes */
export const ANONYMOUS_WRITES_ENV = 'INTI_ALLOW_ANONYMOUS_WRITES';

/** Reads a variable both under Node and under the Vite/Astro bundle */
function readEnv(name: string): string | undefined {
    if (typeof process !== 'undefined' && process.env?.[name] != null) {
        return process.env[name];
    }
    if (typeof import.meta !== 'undefined' && (import.meta as any).env?.[name] != null) {
        return (import.meta as any).env[name];
    }
    return undefined;
}

function isTruthy(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * An environment that does not identify itself as development is treated
 * as production. This is deliberate: if we do not know where we are, the
 * safe option is the restrictive one.
 */
export function isDevelopmentRuntime(): boolean {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') return true;
    if (typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV === true) return true;
    return false;
}

export interface WriteAccessInput {
    /** Operation name, only for the error message */
    operation: string;
    /** Does any plugin declare `beforeWrite` or `resolveActor`? */
    hasWriteGuard: boolean;
    /** Are we in development? */
    isDevelopment: boolean;
    /** Have anonymous writes been explicitly opened? */
    allowAnonymous: boolean;
}

export interface WriteAccessDecision {
    allowed: boolean;
    reason?: string;
}

const DENIAL_REASON = [
    'Inti rejected an unauthenticated write in production.',
    '',
    'Inti actions are public HTTP endpoints. Without a plugin that',
    'checks who is writing, anyone with the URL can modify your',
    'CMS content.',
    '',
    'Choose one of these options:',
    '',
    '  1. Register a plugin with `resolveActor` and/or `beforeWrite`:',
    '       import { registerIntiPlugin } from \'@intijs/core/plugins\';',
    '',
    '  2. Do not expose the actions in production: publish the site as',
    '     static and edit only in development or in a private environment.',
    '',
    `  3. If you really want anonymous writes, declare it: ${ANONYMOUS_WRITES_ENV}=1`,
    '',
    'Docs: https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/securing-writes.md'
].join('\n');

/**
 * Decides whether a write may proceed. Pure function: all environment
 * reading happens in `assertWriteAccess`, so the rule can be tested
 * without touching `process.env`.
 */
export function evaluateWriteAccess(input: WriteAccessInput): WriteAccessDecision {
    // In development the editor is active and the documented flow does not
    // require authentication: blocking here would break the quickstart for nothing.
    if (input.isDevelopment) return { allowed: true };

    // Someone is checking. Their `beforeWrite` decides, not us.
    if (input.hasWriteGuard) return { allowed: true };

    // Deliberate opt-in.
    if (input.allowAnonymous) return { allowed: true };

    return {
        allowed: false,
        reason: `${DENIAL_REASON}\n\n(rejected operation: ${input.operation})`
    };
}

let warnedAboutAnonymous = false;

/**
 * Warns once that anonymous writes are open. It is a valid decision,
 * but it should not go unnoticed in the logs of a production server.
 */
function warnAnonymousOnce(): void {
    if (warnedAboutAnonymous) return;
    warnedAboutAnonymous = true;
    console.warn(
        `[inti] ${ANONYMOUS_WRITES_ENV} is set: the write actions ` +
        'accept unauthenticated requests. Anyone who can reach this server ' +
        'can modify the CMS content.'
    );
}

/** Meant for tests: resets the one-time warning */
export function resetAccessWarnings(): void {
    warnedAboutAnonymous = false;
}

/**
 * Reads the environment and decides, without throwing. The actions use it
 * to turn the rejection into a 403 (`ActionError` FORBIDDEN): a plain
 * `Error` thrown from an action comes out as a 500, and the client could
 * not tell "you are not allowed" from "the server is down".
 */
export function checkWriteAccess(operation: string, hasWriteGuard: boolean): WriteAccessDecision {
    const isDevelopment = isDevelopmentRuntime();
    const allowAnonymous = isTruthy(readEnv(ANONYMOUS_WRITES_ENV));

    if (!isDevelopment && !hasWriteGuard && allowAnonymous) {
        warnAnonymousOnce();
    }

    return evaluateWriteAccess({
        operation,
        hasWriteGuard,
        isDevelopment,
        allowAnonymous
    });
}

/**
 * Throws if the write is not allowed. The message explains how to
 * fix it.
 *
 * For consumers outside Astro (CLI, MCP). The actions use
 * `checkWriteAccess`, which lets them answer 403 instead of 500.
 */
export function assertWriteAccess(operation: string, hasWriteGuard: boolean): void {
    const decision = checkWriteAccess(operation, hasWriteGuard);
    if (!decision.allowed) {
        throw new Error(decision.reason);
    }
}
