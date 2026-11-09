// @ts-nocheck
import { handler as ssrHandler } from './dist/server/entry.mjs';

/**
 * Inti.js Native Bun Server
 * Maximize throughput by bypassing Node.js abstractions.
 */

const clients = new Set<WebSocket>();

const server = Bun.serve({
    port: process.env.PORT || 3000,

    async fetch(req, server) {
        const url = new URL(req.url);

        // 1. WebSocket Upgrade Endpoint
        if (url.pathname === '/inti-preview-socket') {
            const upgraded = server.upgrade(req);
            if (upgraded) return undefined;
        }

        // 2. Serve Static Assets
        if (url.pathname.startsWith('/_astro/') || url.pathname.includes('.')) {
            try {
                const staticUrl = new URL(`.${url.pathname}`, import.meta.url);
                const file = Bun.file(staticUrl.pathname);
                if (await file.exists()) {
                    return new Response(file);
                }
            } catch (e) {
                // Fall through to SSR
            }
        }

        // 3. Astro Native SSR Handler
        try {
            const response = await ssrHandler(req);
            return response;
        } catch (e) {
            console.error('[Inti.js] SSR Error:', e);
            return new Response('Internal Server Error', { status: 500 });
        }
    },

    websocket: {
        message(ws, message) {
            console.log(`[Inti WS] Received: ${message}`);
        },
        open(ws: any) {
            clients.add(ws as any);
            console.log(`[Inti WS] Client connected for Real-time Preview. Total: ${clients.size}`);
        },
        close(ws: any, code: number, message: string) {
            clients.delete(ws as any);
            console.log(`[Inti WS] Client disconnected.`);
        },
    },
});

console.log(`🔥 Inti.js running at http://localhost:${server.port}`);

export function broadcastInvalidation(blockId: string) {
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'INVALIDATE_BLOCK',
                blockId,
                timestamp: Date.now()
            }));
        }
    }
}
