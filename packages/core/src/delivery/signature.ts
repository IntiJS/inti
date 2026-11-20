/**
 * HMAC-SHA256 of a request body, as `sha256=<hex>`.
 *
 * Every purge notice (a CMS webhook, the WordPress plugin, an ERP) signs its
 * body with a secret it shares with the site. Without a valid signature a
 * purge route would let anyone empty the cache, which is the cheapest way to
 * send every visitor to the CMS at once.
 */

const encoder = new TextEncoder();

async function key(secret: string, usage: 'sign' | 'verify') {
    return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** `sha256=<hex>` of the body */
export async function signBody(body: string, secret: string): Promise<string> {
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret, 'sign'), encoder.encode(body)));
    return `sha256=${[...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Accepts `sha256=<hex>` or the bare hex. Compares in constant time */
export async function verifySignature(body: string, header: string | null | undefined, secret: string): Promise<boolean> {
    const hex = header?.trim().match(/^(?:sha256=)?([0-9a-f]{64})$/i)?.[1];
    if (!hex || !secret) return false;
    const signature = new Uint8Array(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
    return crypto.subtle.verify('HMAC', await key(secret, 'verify'), signature, encoder.encode(body));
}
