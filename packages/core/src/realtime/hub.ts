/**
 * Realtime hub: broadcasts editing messages among connected editors.
 *
 * It separates two responsibilities that used to be mixed:
 *
 * - **Rooms**: which clients of THIS process are viewing which document.
 *   Broadcasting never crosses documents: whoever edits page A does not
 *   receive page B's events.
 * - **Backplane**: how a message reaches the other processes. With a single
 *   instance the in-memory one is enough; with several a shared one is needed.
 */

import type { RealtimeBackplane, RealtimeMessage } from '../plugins/index.js';

/** Delivers an already serialized frame to a connected client */
export type Deliver = (frame: string) => void;

/**
 * In-memory backplane: it only reaches the current process.
 *
 * It is the core's default. With more than one instance behind a load
 * balancer, editors connected to different instances do not see each
 * other — that requires a shared backplane.
 */
export function createLocalBackplane(): RealtimeBackplane {
    const handlers = new Set<(message: RealtimeMessage) => void>();

    return {
        async publish(message) {
            for (const handler of handlers) handler(message);
        },
        async subscribe(handler) {
            handlers.add(handler);
            return () => handlers.delete(handler);
        }
    };
}

export class RealtimeHub {
    /** documentId → clientId → delivery */
    private rooms = new Map<string, Map<string, Deliver>>();
    private backplane: RealtimeBackplane;
    private unsubscribe: (() => void) | null = null;
    private binding: Promise<void> | null = null;

    constructor(backplane: RealtimeBackplane = createLocalBackplane()) {
        this.backplane = backplane;
    }

    /**
     * Subscribes to the backplane only once, even when called in parallel
     * from several simultaneous requests.
     */
    private ensureBound(): Promise<void> {
        if (!this.binding) {
            this.binding = this.backplane
                .subscribe((message) => this.deliver(message))
                .then((unsubscribe) => {
                    this.unsubscribe = unsubscribe;
                })
                .catch((error) => {
                    // Retry on the next request instead of staying broken
                    this.binding = null;
                    throw error;
                });
        }
        return this.binding;
    }

    /**
     * Connects a client to a document's room.
     * Returns the function that disconnects it.
     */
    async join(documentId: string, clientId: string, deliver: Deliver): Promise<() => void> {
        await this.ensureBound();

        let room = this.rooms.get(documentId);
        if (!room) {
            room = new Map();
            this.rooms.set(documentId, room);
        }
        room.set(clientId, deliver);

        return () => this.leave(documentId, clientId);
    }

    leave(documentId: string, clientId: string): void {
        const room = this.rooms.get(documentId);
        if (!room) return;

        room.delete(clientId);
        // Do not let empty rooms pile up
        if (room.size === 0) this.rooms.delete(documentId);
    }

    /** Publishes to the backplane; local broadcasting happens when it comes back */
    async publish(message: RealtimeMessage): Promise<void> {
        await this.ensureBound();
        await this.backplane.publish(message);
    }

    /**
     * Broadcasts to the local clients in the document's room, skipping the
     * sender. Returns how many it reached.
     */
    deliver(message: RealtimeMessage): number {
        const room = this.rooms.get(message.documentId);
        if (!room) return 0;

        const frame = `data: ${JSON.stringify({
            type: message.type,
            clientId: message.senderId,
            data: message.data
        })}\n\n`;

        let sent = 0;
        for (const [clientId, send] of room) {
            if (clientId === message.senderId) continue;
            try {
                send(frame);
                sent++;
            } catch {
                // Connection already closed: it is cleaned up instead of retried
                room.delete(clientId);
            }
        }

        if (room.size === 0) this.rooms.delete(message.documentId);
        return sent;
    }

    /** Clients connected to a document in this process */
    clientCount(documentId: string): number {
        return this.rooms.get(documentId)?.size ?? 0;
    }

    /** Documents with at least one client in this process */
    roomCount(): number {
        return this.rooms.size;
    }

    async close(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.binding = null;
        this.rooms.clear();
        await this.backplane.close?.();
    }
}
