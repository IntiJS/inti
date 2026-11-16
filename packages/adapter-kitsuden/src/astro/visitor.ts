/**
 * The visitor of the request being rendered, for `KitsudenConfig.clientIp`.
 *
 * The adapter is created once per server, but the visitor changes on every request. The
 * middleware runs each request inside `runWithVisitor`, and `currentVisitorIp` reads it back
 * from wherever the adapter is called during that request.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<{ ip?: string }>();

export function runWithVisitor<T>(ip: string | undefined, run: () => T): T {
    return store.run({ ip }, run);
}

/** The IP of the visitor being served, or undefined outside a request */
export function currentVisitorIp(): string | undefined {
    return store.getStore()?.ip;
}

/**
 * The visitor's IP as this server sees it.
 *
 * Behind a reverse proxy the socket address is the proxy's, and every visitor would share one
 * counter. With `trustProxy`, the address is taken from `X-Forwarded-For` instead: its LAST
 * entry, the one the proxy added (the entries before it are written by the client and can be
 * anything). Only enable it when a proxy you control is the only way to reach this server.
 */
export function visitorIp(socketAddress: string | undefined, forwardedFor: string | null | undefined, trustProxy: boolean): string | undefined {
    if (trustProxy && forwardedFor) {
        const last = forwardedFor
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .pop();
        if (last) return last;
    }
    return socketAddress;
}
