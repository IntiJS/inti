/**
 * A field path an adapter may write: dot-separated, no empty segment, and no
 * segment that reaches an object's prototype.
 *
 * The actions check this before calling an adapter, but the MCP server and
 * any script call adapters directly. `updateBlockField(id, 0, '__proto__.x', …)`
 * on a naive dot-path setter writes `Object.prototype.x` for the whole process.
 */
export const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeFieldPath(path: string): boolean {
    if (typeof path !== 'string' || path === '') return false;
    return path.split('.').every((part) => part !== '' && !FORBIDDEN_PATH_SEGMENTS.has(part));
}

/** Throws with the message the editor shows */
export function assertSafeFieldPath(path: string): void {
    if (!isSafeFieldPath(path)) throw new Error(`Invalid field path: "${path}"`);
}
