/**
 * Odoo API keys expire.
 *
 * Since Odoo 19 an API key has an expiration date, and each user group caps how far away it may
 * be (90 days by default for the groups a site's user belongs to). A site that keeps one key in
 * an environment variable stops reading its catalog the day it expires.
 *
 * A key store hands out the current key and can hold the next one. `rotateOdooKey` asks Odoo
 * for a new key with the old one (`res.users.apikeys.generate`), stores it, and only then
 * revokes the old one, so there is no moment without a valid key. Odoo allows that when the
 * user is an administrator or `base.enable_programmatic_api_keys` is set.
 */

import type { OdooClient } from './client.js';

export interface OdooKeyStore {
    /** The key to use now */
    current(): string | Promise<string>;
    /**
     * Called after a 401: switch to the next key if there is one. True when it switched, so the
     * request is tried again with it.
     */
    next?(): boolean | Promise<boolean>;
    /** Stores a new key (after a rotation), with its expiration */
    save?(key: string, expiresAt: Date): void | Promise<void>;
    /** When the current key expires, if known */
    expiresAt?(): Date | undefined | Promise<Date | undefined>;
}

export function staticKey(key: string): OdooKeyStore {
    return { current: () => key };
}

/**
 * The current key and, during a rotation done by hand, the next one: `INTI_ODOO_API_KEY` and
 * `INTI_ODOO_API_KEY_NEXT`. When the current one is refused, the next one takes over.
 * `INTI_ODOO_API_KEY_EXPIRES` (an ISO date) lets `rotateIfExpiring` act in time.
 */
export function envKeyStore(read: (name: string) => string | undefined = (name) => process.env[name]): OdooKeyStore {
    let useNext = false;
    let saved: { key: string; expiresAt: Date } | null = null;
    return {
        current() {
            if (saved) return saved.key;
            const key = (useNext ? read('INTI_ODOO_API_KEY_NEXT') : read('INTI_ODOO_API_KEY')) ?? '';
            if (!key) throw new Error('[odoo] INTI_ODOO_API_KEY is not set');
            return key;
        },
        next() {
            if (useNext || saved || !read('INTI_ODOO_API_KEY_NEXT')) return false;
            useNext = true;
            console.warn('[odoo] INTI_ODOO_API_KEY was refused; using INTI_ODOO_API_KEY_NEXT. Make it the current key.');
            return true;
        },
        save(key, expiresAt) {
            // Only for this process: write it wherever the site keeps its secrets too
            saved = { key, expiresAt };
        },
        expiresAt() {
            if (saved) return saved.expiresAt;
            const raw = read('INTI_ODOO_API_KEY_EXPIRES');
            const date = raw ? new Date(raw) : undefined;
            return date && !Number.isNaN(date.getTime()) ? date : undefined;
        }
    };
}

export interface RotateOptions {
    /** Name of the new key in Odoo. Default `inti <date>` */
    name?: string;
    /** Days until the new key expires. Odoo refuses more than the user's groups allow. Default 90 */
    days?: number;
    /** `rpc` (default) or null for any scope */
    scope?: string | null;
    now?: Date;
}

/** A new key from the current one, stored before the old one is revoked */
export async function rotateOdooKey(client: OdooClient, store: OdooKeyStore, options: RotateOptions = {}): Promise<{ expiresAt: Date }> {
    if (!store.save) throw new Error('[odoo] this key store cannot save a new key');
    const old = await store.current();
    const now = options.now ?? new Date();
    const expiresAt = new Date(now.getTime() + (options.days ?? 90) * 86_400_000);
    const stamp = expiresAt.toISOString().slice(0, 19).replace('T', ' ');

    const fresh = await client.call<string>('res.users.apikeys', 'generate', {
        key: old,
        scope: options.scope === undefined ? 'rpc' : options.scope,
        name: options.name ?? `inti ${now.toISOString().slice(0, 10)}`,
        expiration_date: stamp
    });
    if (typeof fresh !== 'string' || !fresh) throw new Error('[odoo] generate did not return a key');

    await store.save(fresh, expiresAt);
    await client.call('res.users.apikeys', 'revoke', { key: old });
    return { expiresAt };
}

/** Rotates when the current key expires within `withinDays` (default 14). Run it daily */
export async function rotateIfExpiring(
    client: OdooClient,
    store: OdooKeyStore,
    options: RotateOptions & { withinDays?: number } = {}
): Promise<{ rotated: boolean; expiresAt?: Date }> {
    const expiresAt = await store.expiresAt?.();
    const now = options.now ?? new Date();
    if (!expiresAt) return { rotated: false };
    if (expiresAt.getTime() - now.getTime() > (options.withinDays ?? 14) * 86_400_000) return { rotated: false, expiresAt };
    const result = await rotateOdooKey(client, store, options);
    return { rotated: true, expiresAt: result.expiresAt };
}
