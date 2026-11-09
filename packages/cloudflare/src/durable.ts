/**
 * Durable Objects: what needs a single source of truth across instances.
 *
 * It has its own entry point because it imports `cloudflare:workers`, which only exists in a
 * Worker. Export these classes from your `src/worker.ts`.
 */

import { DurableObject } from 'cloudflare:workers';

// ============================================
// Editing room
// ============================================

/** What is remembered about each connection. Survives hibernation */
interface Attachment {
    clientId: string;
    actorId?: string;
    joinedAt: number;
}

const HISTORY_SIZE = 50;
const MAX_MESSAGE_BYTES = 64 * 1024;
/** What a client cannot fake: the room sets these */
const SERVER_TYPES = new Set(['joined', 'left', 'presence', 'history', 'error']);

/**
 * One room per document. It uses hibernating WebSockets: an idle room costs
 * nothing, and its connections stay open. It keeps the latest messages, so whoever
 * joins or reconnects catches up.
 *
 * It does not authenticate: whoever opens it does, with `connectToRoom`, before forwarding the
 * request. The `clientId` and actor the others see are set by the room, not the client.
 */
export class IntiRoom extends DurableObject {
    async fetch(request: Request): Promise<Response> {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected Upgrade: websocket', { status: 426 });
        }

        const url = new URL(request.url);
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        const attachment: Attachment = {
            clientId: url.searchParams.get('clientId') || crypto.randomUUID(),
            actorId: request.headers.get('x-inti-actor') ?? undefined,
            joinedAt: Date.now()
        };

        this.ctx.acceptWebSocket(server);
        server.serializeAttachment(attachment);

        server.send(JSON.stringify({ type: 'history', messages: await this.history() }));
        this.broadcast({ type: 'joined', clientId: attachment.clientId, actorId: attachment.actorId }, server);
        server.send(JSON.stringify({ type: 'presence', clients: this.presence() }));

        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
        const size = typeof message === 'string' ? new TextEncoder().encode(message).length : message.byteLength;
        if (typeof message !== 'string' || size > MAX_MESSAGE_BYTES) {
            socket.send(JSON.stringify({ type: 'error', error: 'Message rejected: text under 64 KB only' }));
            return;
        }

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(message);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        } catch {
            socket.send(JSON.stringify({ type: 'error', error: 'Message rejected: invalid JSON' }));
            return;
        }

        const type = typeof parsed.type === 'string' ? parsed.type : 'update';
        if (type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong' }));
            return;
        }
        if (SERVER_TYPES.has(type)) {
            socket.send(JSON.stringify({ type: 'error', error: `Message rejected: "${type}" is reserved` }));
            return;
        }

        const sender = socket.deserializeAttachment() as Attachment;
        const outgoing = { ...parsed, type, clientId: sender.clientId, actorId: sender.actorId, at: Date.now() };

        // Cursors are not stored: they expire instantly and would write nonstop
        if (type !== 'cursor') await this.remember(outgoing);
        this.broadcast(outgoing, socket);
    }

    async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
        const sender = socket.deserializeAttachment() as Attachment | null;
        this.broadcast({ type: 'left', clientId: sender?.clientId }, socket);
        try {
            socket.close(code, reason);
        } catch {
            // it was already closed
        }
    }

    private presence() {
        return this.ctx.getWebSockets().map((socket) => {
            const { clientId, actorId } = socket.deserializeAttachment() as Attachment;
            return { clientId, actorId };
        });
    }

    private broadcast(message: unknown, except?: WebSocket): void {
        const frame = JSON.stringify(message);
        for (const socket of this.ctx.getWebSockets()) {
            if (socket === except) continue;
            try {
                socket.send(frame);
            } catch {
                // A dropped connection does not stop notifying the others
            }
        }
    }

    private async history(): Promise<unknown[]> {
        return (await this.ctx.storage.get<unknown[]>('history')) ?? [];
    }

    private async remember(message: unknown): Promise<void> {
        const history = await this.history();
        history.push(message);
        await this.ctx.storage.put('history', history.slice(-HISTORY_SIZE));
    }
}

export interface RoomConnection {
    documentId: string;
    /** Who it is, already authenticated. The other editors see it */
    actorId?: string;
}

/**
 * Opens a document's room. Check the session first: this does not authenticate.
 *
 *   export const GET = async ({ request, cookies, url }) => {
 *       const session = await resolveEditorSession({ request, cookies });
 *       if (!session.allowed) return new Response(null, { status: 401 });
 *       return connectToRoom(env.INTI_ROOM, request, { documentId: url.searchParams.get('docId'), actorId: session.actor?.id });
 *   };
 */
export function connectToRoom(namespace: DurableObjectNamespace, request: Request, connection: RoomConnection): Promise<Response> {
    const stub = namespace.get(namespace.idFromName(connection.documentId));
    const headers = new Headers(request.headers);
    // Never whatever comes from the client
    headers.delete('x-inti-actor');
    if (connection.actorId) headers.set('x-inti-actor', connection.actorId);
    return stub.fetch(new Request(request.url, { method: request.method, headers }));
}

// ============================================
// Shared limits
// ============================================

/**
 * Counts requests in a single place. In memory, each Worker instance would keep its
 * own count and the real cap would be the per-instance cap. One object per key.
 */
export class IntiLimiter extends DurableObject {
    async take(limit: number, windowSeconds: number): Promise<boolean> {
        const now = Date.now();
        const stored = await this.ctx.storage.get<{ start: number; count: number }>('window');

        if (!stored || now - stored.start >= windowSeconds * 1000) {
            await this.ctx.storage.put('window', { start: now, count: 1 });
            // So a visitor who never returns does not take up space forever
            await this.ctx.storage.setAlarm(now + windowSeconds * 2000);
            return true;
        }
        if (stored.count >= limit) return false;

        await this.ctx.storage.put('window', { start: stored.start, count: stored.count + 1 });
        return true;
    }

    async alarm(): Promise<void> {
        await this.ctx.storage.deleteAll();
    }
}

/** The `limiter` for `createVisitorComposer`, backed by `IntiLimiter` */
export function createDurableLimiter(namespace: DurableObjectNamespace<IntiLimiter>) {
    return {
        take(key: string, limit: number, windowSeconds: number): Promise<boolean> {
            return namespace.get(namespace.idFromName(key)).take(limit, windowSeconds) as Promise<boolean>;
        }
    };
}
