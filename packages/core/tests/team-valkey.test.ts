import { describe, test, expect } from 'bun:test';
import { createValkeyBackplane } from '../src/team/valkey.js';
import type { RealtimeMessage } from '../src/plugins/index.js';

// ============================================
// Fake Valkey: in-memory pub/sub with the same semantics
// ============================================

/**
 * A Valkey server delivers what is published to ALL of the channel's
 * subscribers, including the process that published it. This double
 * replicates that, which is exactly what local fan-out depends on.
 */
function fakeValkey() {
    const subscribers: Array<{ channels: Set<string>; handlers: Set<(c: string, p: string) => void> }> = [];

    const server = {
        publish(channel: string, payload: string) {
            for (const sub of subscribers) {
                if (!sub.channels.has(channel)) continue;
                for (const handler of sub.handlers) handler(channel, payload);
            }
        }
    };

    function connection() {
        const state = { channels: new Set<string>(), handlers: new Set<(c: string, p: string) => void>() };
        subscribers.push(state);

        return {
            published: [] as Array<{ channel: string; payload: string }>,
            quitCalls: 0,
            publish(channel: string, payload: string) {
                this.published.push({ channel, payload });
                server.publish(channel, payload);
            },
            subscribe(channel: string) {
                state.channels.add(channel);
            },
            unsubscribe(channel: string) {
                state.channels.delete(channel);
            },
            on(_event: 'message', handler: (c: string, p: string) => void) {
                state.handlers.add(handler);
            },
            off(_event: 'message', handler: (c: string, p: string) => void) {
                state.handlers.delete(handler);
            },
            quit() {
                this.quitCalls++;
            }
        };
    }

    return { connection };
}

const message = (overrides: Partial<RealtimeMessage> = {}): RealtimeMessage => ({
    documentId: 'doc-a',
    senderId: 'client-1',
    type: 'update',
    ...overrides
});

// ============================================
// Tests
// ============================================

describe('createValkeyBackplane', () => {
    test('publishes on the channel as JSON', async () => {
        const valkey = fakeValkey();
        const publisher = valkey.connection();
        const backplane = createValkeyBackplane({ publisher, subscriber: valkey.connection() });

        await backplane.publish(message({ type: 'blockUpdated' }));

        expect(publisher.published).toHaveLength(1);
        expect(publisher.published[0].channel).toBe('inti:realtime');
        expect(JSON.parse(publisher.published[0].payload).type).toBe('blockUpdated');
    });

    test('the message comes back to the same process — local fan-out depends on it', async () => {
        const valkey = fakeValkey();
        const backplane = createValkeyBackplane({
            publisher: valkey.connection(),
            subscriber: valkey.connection()
        });

        const received: RealtimeMessage[] = [];
        await backplane.subscribe((m) => received.push(m));
        await backplane.publish(message());

        // If it were filtered per instance, local clients
        // would never see their own change
        expect(received).toHaveLength(1);
        expect(received[0].documentId).toBe('doc-a');
    });

    test('what another instance publishes arrives just the same', async () => {
        const valkey = fakeValkey();

        // Instance A: only publishes
        const instanceA = createValkeyBackplane({
            publisher: valkey.connection(),
            subscriber: valkey.connection()
        });
        // Instance B: listens
        const instanceB = createValkeyBackplane({
            publisher: valkey.connection(),
            subscriber: valkey.connection()
        });

        const received: RealtimeMessage[] = [];
        await instanceB.subscribe((m) => received.push(m));
        await instanceA.publish(message({ senderId: 'editor-on-A' }));

        expect(received).toHaveLength(1);
        expect(received[0].senderId).toBe('editor-on-A');
    });

    test('respects a custom channel', async () => {
        const valkey = fakeValkey();
        const publisher = valkey.connection();
        const backplane = createValkeyBackplane({
            publisher,
            subscriber: valkey.connection(),
            channel: 'inti:staging'
        });

        await backplane.publish(message());

        expect(publisher.published[0].channel).toBe('inti:staging');
    });

    test('does not mix different channels on the same server', async () => {
        const valkey = fakeValkey();
        const prod = createValkeyBackplane({
            publisher: valkey.connection(),
            subscriber: valkey.connection(),
            channel: 'inti:prod'
        });
        const staging = createValkeyBackplane({
            publisher: valkey.connection(),
            subscriber: valkey.connection(),
            channel: 'inti:staging'
        });

        const onStaging: RealtimeMessage[] = [];
        await staging.subscribe((m) => onStaging.push(m));
        await prod.publish(message());

        expect(onStaging).toHaveLength(0);
    });

    test('requires separate connections to publish and listen', () => {
        const shared = fakeValkey().connection();

        // A connection in subscribe mode accepts no other commands
        expect(() => createValkeyBackplane({ publisher: shared, subscriber: shared })).toThrow(/separate connections/);
    });

    test('a corrupt payload does not bring down the subscription', async () => {
        const valkey = fakeValkey();
        const publisher = valkey.connection();
        const backplane = createValkeyBackplane({ publisher, subscriber: valkey.connection() });

        const received: RealtimeMessage[] = [];
        await backplane.subscribe((m) => received.push(m));

        publisher.publish('inti:realtime', 'this is not json');
        await backplane.publish(message());

        expect(received).toHaveLength(1);
    });

    test('drops messages without a document or a sender', async () => {
        const valkey = fakeValkey();
        const publisher = valkey.connection();
        const backplane = createValkeyBackplane({ publisher, subscriber: valkey.connection() });

        const received: RealtimeMessage[] = [];
        await backplane.subscribe((m) => received.push(m));

        publisher.publish('inti:realtime', JSON.stringify({ senderId: 'x', type: 'update' }));
        publisher.publish('inti:realtime', JSON.stringify({ documentId: 'doc-a', type: 'update' }));

        expect(received).toHaveLength(0);
    });

    test('unsubscribing stops delivery', async () => {
        const valkey = fakeValkey();
        const backplane = createValkeyBackplane({
            publisher: valkey.connection(),
            subscriber: valkey.connection()
        });

        const received: RealtimeMessage[] = [];
        const unsubscribe = await backplane.subscribe((m) => received.push(m));
        unsubscribe();
        await backplane.publish(message());

        expect(received).toHaveLength(0);
    });

    test('close closes both connections', async () => {
        const valkey = fakeValkey();
        const publisher = valkey.connection();
        const subscriber = valkey.connection();
        const backplane = createValkeyBackplane({ publisher, subscriber });

        await backplane.close!();

        expect(publisher.quitCalls).toBe(1);
        expect(subscriber.quitCalls).toBe(1);
    });
});
