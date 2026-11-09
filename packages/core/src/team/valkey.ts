/**
 * Multi-instance realtime over Valkey (or any server compatible with the
 * Redis protocol).
 *
 * The core fans out changes only within its own process. As soon as there
 * is more than one instance behind a load balancer, two editors connected
 * to different instances stop seeing each other. This backplane reconnects
 * them by publishing every change on a pub/sub channel that every instance
 * listens to.
 *
 * Every message round-trips through Valkey, including for the instance that
 * published it: local fan-out happens when it comes back, just as on any
 * other instance. That way there is a single delivery path and there can be
 * no duplicates. The editor that originated the change does not get it
 * because the hub already filters by `senderId`.
 *
 * The client is injected instead of depending on a specific library:
 * `iovalkey`, `ioredis` or `node-redis` all work, and the package pulls in none.
 */

import type { RealtimeBackplane, RealtimeMessage } from '../plugins/index.js';

/** The minimum the backplane needs from a pub/sub client */
export interface ValkeyPublisher {
    publish(channel: string, payload: string): Promise<unknown> | unknown;
    quit?(): Promise<unknown> | unknown;
}

export interface ValkeySubscriber {
    subscribe(channel: string): Promise<unknown> | unknown;
    unsubscribe(channel: string): Promise<unknown> | unknown;
    on(event: 'message', handler: (channel: string, payload: string) => void): unknown;
    off?(event: 'message', handler: (channel: string, payload: string) => void): unknown;
    quit?(): Promise<unknown> | unknown;
}

export interface ValkeyBackplaneConfig {
    /** Connection for publishing */
    publisher: ValkeyPublisher;
    /**
     * Connection dedicated to listening. It must be DIFFERENT from the
     * publisher: a connection in subscribe mode accepts no other commands.
     */
    subscriber: ValkeySubscriber;
    /** Pub/sub channel. Change it to isolate environments on the same server */
    channel?: string;
}

const DEFAULT_CHANNEL = 'inti:realtime';

export function createValkeyBackplane(config: ValkeyBackplaneConfig): RealtimeBackplane {
    const channel = config.channel ?? DEFAULT_CHANNEL;

    if ((config.publisher as unknown) === (config.subscriber as unknown)) {
        throw new Error(
            'createValkeyBackplane: publisher and subscriber must be separate connections — ' +
                'a connection in subscribe mode cannot publish.'
        );
    }

    return {
        async publish(message) {
            await config.publisher.publish(channel, JSON.stringify(message));
        },

        async subscribe(handler) {
            const onMessage = (incoming: string, payload: string) => {
                // One server can host several channels
                if (incoming !== channel) return;

                let message: RealtimeMessage;
                try {
                    message = JSON.parse(payload);
                } catch {
                    // A corrupt payload must not bring down the subscription
                    return;
                }

                // Without a document there is no room to fan out to
                if (!message?.documentId || !message?.senderId) return;

                handler(message);
            };

            config.subscriber.on('message', onMessage);
            await config.subscriber.subscribe(channel);

            return () => {
                config.subscriber.off?.('message', onMessage);
                void config.subscriber.unsubscribe(channel);
            };
        },

        async close() {
            await config.subscriber.quit?.();
            await config.publisher.quit?.();
        }
    };
}
