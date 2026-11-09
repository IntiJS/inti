import { SUPPORTED_CONTRACTS } from '../../src/index.js';

/**
 * `GET /api/version` of a compatible Kitsuden: the highest version of each contract the adapter
 * supports. The fetch mocks of the other tests answer it without recording it as a call: the
 * contract check has its own tests (compatibility.test.ts), and that way each test's request
 * counts keep talking only about what it tests.
 */
export function compatibleVersionResponse(): Response {
    const contracts = Object.fromEntries(Object.entries(SUPPORTED_CONTRACTS).map(([name, [, max]]) => [name, max]));
    return new Response(JSON.stringify({ product: 'kitsuden', version: '0.9.0-beta', contracts }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

export const isVersionRequest = (url: string) => new URL(url).pathname === '/api/version';
