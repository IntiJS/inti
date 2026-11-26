/**
 * What another editor sends through the room is untrusted: a peer controls every field of
 * its presence and cursor frames, and the room relays them as they are. These helpers
 * bound each field before anything renders it.
 */

const COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\(\s*[\d.%\s,/]+\)|hsla?\(\s*[\d.%\sdeg,/]+\))$/i;
const STATUSES = new Set(['online', 'away', 'offline']);

/** A CSS colour, or the fallback: a peer's colour never reaches a style as free text */
export function safeColor(value: unknown, fallback = '#6b7280'): string {
    return typeof value === 'string' && value.length <= 64 && COLOR.test(value.trim()) ? value.trim() : fallback;
}

/** An https (or same-origin relative) image URL, or null: no `javascript:`, no `data:` */
export function safeAvatarUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
        const url = new URL(value, 'https://inti.invalid/');
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        return url.origin === 'https://inti.invalid' ? `${url.pathname}${url.search}` : url.href;
    } catch {
        return null;
    }
}

/** Plain text of bounded length */
export function safeText(value: unknown, max = 80): string {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

/** A known presence status, or `online` */
export function safeStatus(value: unknown): string {
    return typeof value === 'string' && STATUSES.has(value) ? value : 'online';
}

/** A finite coordinate within a page, or 0 */
export function safeCoordinate(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(-1e6, Math.min(1e6, value)) : 0;
}

/** A presence frame with every field bounded; null when it has no user id */
export function sanitizePresence(payload: unknown): Record<string, unknown> | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    const userId = safeText(p.userId, 128);
    if (!userId) return null;
    const avatar = safeAvatarUrl(p.avatar);
    return {
        ...p,
        userId,
        name: safeText(p.name) || userId.slice(0, 8),
        color: safeColor(p.color),
        status: safeStatus(p.status),
        ...(avatar ? { avatar } : { avatar: undefined })
    };
}

/** A cursor frame with every field bounded; null when it has no user id */
export function sanitizeCursor(payload: unknown): Record<string, unknown> | null {
    const base = sanitizePresence(payload);
    if (!base) return null;
    const cursor = (payload as { cursor?: { x?: unknown; y?: unknown } }).cursor;
    return { ...base, cursor: { x: safeCoordinate(cursor?.x), y: safeCoordinate(cursor?.y) } };
}
