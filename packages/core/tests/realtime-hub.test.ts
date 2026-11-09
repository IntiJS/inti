import { describe, test, expect } from 'bun:test';
import { RealtimeHub, createLocalBackplane } from '../src/realtime/hub.js';
import type { RealtimeBackplane, RealtimeMessage } from '../src/plugins/index.js';

// ============================================
// Helpers
// ============================================

/** Test client that collects the received SSE frames */
function client() {
    const frames: string[] = [];
    return {
        frames,
        deliver: (frame: string) => frames.push(frame),
        /** Payloads already parsed from the `data: {...}` frame */
        payloads: () => frames.map((f) => JSON.parse(f.replace(/^data: /, '').trim()))
    };
}

const message = (overrides: Partial<RealtimeMessage> = {}): RealtimeMessage => ({
    documentId: 'doc-a',
    senderId: 'client-1',
    type: 'update',
    ...overrides
});

// ============================================
// Per-document isolation (the bug that was fixed)
// ============================================

describe('RealtimeHub — per-document isolation', () => {
    test('a client does NOT receive events from another document', async () => {
        const hub = new RealtimeHub();
        const onDocA = client();
        const onDocB = client();

        await hub.join('doc-a', 'a1', onDocA.deliver);
        await hub.join('doc-b', 'b1', onDocB.deliver);

        await hub.publish(message({ documentId: 'doc-a', senderId: 'other' }));

        expect(onDocA.frames).toHaveLength(1);
        // The broadcast used to go to everyone connected, unfiltered
        expect(onDocB.frames).toHaveLength(0);
    });

    test('all clients of the same document receive the change', async () => {
        const hub = new RealtimeHub();
        const first = client();
        const second = client();

        await hub.join('doc-a', 'a1', first.deliver);
        await hub.join('doc-a', 'a2', second.deliver);

        await hub.publish(message({ senderId: 'other' }));

        expect(first.frames).toHaveLength(1);
        expect(second.frames).toHaveLength(1);
    });

    test('the sender does not receive its own message', async () => {
        const hub = new RealtimeHub();
        const sender = client();
        const other = client();

        await hub.join('doc-a', 'a1', sender.deliver);
        await hub.join('doc-a', 'a2', other.deliver);

        await hub.publish(message({ senderId: 'a1' }));

        expect(sender.frames).toHaveLength(0);
        expect(other.frames).toHaveLength(1);
    });

    test('publishing to a document with no clients does not fail', async () => {
        const hub = new RealtimeHub();

        await hub.publish(message({ documentId: 'nobody-here' }));

        expect(hub.roomCount()).toBe(0);
    });
});

// ============================================
// Frame format
// ============================================

describe('RealtimeHub — frames', () => {
    test('emits valid SSE with the expected payload', async () => {
        const hub = new RealtimeHub();
        const receiver = client();

        await hub.join('doc-a', 'a1', receiver.deliver);
        await hub.publish(message({ senderId: 'editor-2', type: 'blockUpdated', data: { blockIndex: 3 } }));

        expect(receiver.frames[0].startsWith('data: ')).toBe(true);
        expect(receiver.frames[0].endsWith('\n\n')).toBe(true);
        expect(receiver.payloads()[0]).toEqual({
            type: 'blockUpdated',
            clientId: 'editor-2',
            data: { blockIndex: 3 }
        });
    });
});

// ============================================
// Connection lifecycle
// ============================================

describe('RealtimeHub — connections', () => {
    test('after leaving it stops receiving', async () => {
        const hub = new RealtimeHub();
        const receiver = client();

        const leave = await hub.join('doc-a', 'a1', receiver.deliver);
        leave();

        await hub.publish(message({ senderId: 'other' }));

        expect(receiver.frames).toHaveLength(0);
    });

    test('the room is discarded when it becomes empty', async () => {
        const hub = new RealtimeHub();

        const leave = await hub.join('doc-a', 'a1', () => {});
        expect(hub.roomCount()).toBe(1);

        leave();
        expect(hub.roomCount()).toBe(0);
    });

    test('counts the clients per document', async () => {
        const hub = new RealtimeHub();

        await hub.join('doc-a', 'a1', () => {});
        await hub.join('doc-a', 'a2', () => {});
        await hub.join('doc-b', 'b1', () => {});

        expect(hub.clientCount('doc-a')).toBe(2);
        expect(hub.clientCount('doc-b')).toBe(1);
        expect(hub.clientCount('doc-c')).toBe(0);
    });

    test('a dead client cleans itself up and does not break delivery', async () => {
        const hub = new RealtimeHub();
        const healthy = client();

        await hub.join('doc-a', 'broken', () => {
            throw new Error('stream closed');
        });
        await hub.join('doc-a', 'healthy', healthy.deliver);

        await hub.publish(message({ senderId: 'other' }));

        expect(healthy.frames).toHaveLength(1);
        expect(hub.clientCount('doc-a')).toBe(1);
    });

    test('reconnecting with the same clientId replaces the previous connection', async () => {
        const hub = new RealtimeHub();
        const stale = client();
        const fresh = client();

        await hub.join('doc-a', 'a1', stale.deliver);
        await hub.join('doc-a', 'a1', fresh.deliver);

        await hub.publish(message({ senderId: 'other' }));

        expect(hub.clientCount('doc-a')).toBe(1);
        expect(stale.frames).toHaveLength(0);
        expect(fresh.frames).toHaveLength(1);
    });
});

// ============================================
// Backplane
// ============================================

describe('RealtimeHub — backplane', () => {
    test('subscribes only once even with concurrent joins', async () => {
        let subscriptions = 0;
        const backplane: RealtimeBackplane = {
            publish: async () => {},
            subscribe: async () => {
                subscriptions++;
                return () => {};
            }
        };
        const hub = new RealtimeHub(backplane);

        await Promise.all([
            hub.join('doc-a', 'a1', () => {}),
            hub.join('doc-a', 'a2', () => {}),
            hub.join('doc-b', 'b1', () => {})
        ]);

        expect(subscriptions).toBe(1);
    });

    test('publish delegates to the backplane', async () => {
        const published: RealtimeMessage[] = [];
        const hub = new RealtimeHub({
            publish: async (m) => {
                published.push(m);
            },
            subscribe: async () => () => {}
        });

        await hub.publish(message({ type: 'blockUpdated' }));

        expect(published).toHaveLength(1);
        expect(published[0].type).toBe('blockUpdated');
    });

    test('a message arriving from the backplane is delivered locally', async () => {
        // Simulates what happens with two instances: the other one publishes and
        // this one receives it through the shared backplane
        let handler: ((m: RealtimeMessage) => void) | null = null;
        const hub = new RealtimeHub({
            publish: async () => {},
            subscribe: async (h) => {
                handler = h;
                return () => {};
            }
        });
        const receiver = client();

        await hub.join('doc-a', 'a1', receiver.deliver);
        handler!(message({ senderId: 'editor-from-another-instance' }));

        expect(receiver.frames).toHaveLength(1);
    });

    test('if the subscription fails it is retried on the next join', async () => {
        let attempts = 0;
        const hub = new RealtimeHub({
            publish: async () => {},
            subscribe: async () => {
                attempts++;
                if (attempts === 1) throw new Error('backplane down');
                return () => {};
            }
        });

        await expect(hub.join('doc-a', 'a1', () => {})).rejects.toThrow('backplane down');
        await hub.join('doc-a', 'a1', () => {});

        expect(attempts).toBe(2);
    });

    test('close releases the subscription and the rooms', async () => {
        let unsubscribed = false;
        const hub = new RealtimeHub({
            publish: async () => {},
            subscribe: async () => () => {
                unsubscribed = true;
            }
        });

        await hub.join('doc-a', 'a1', () => {});
        await hub.close();

        expect(unsubscribed).toBe(true);
        expect(hub.roomCount()).toBe(0);
    });
});

describe('createLocalBackplane', () => {
    test('delivers to the subscribers in the process', async () => {
        const backplane = createLocalBackplane();
        const received: RealtimeMessage[] = [];

        await backplane.subscribe((m) => received.push(m));
        await backplane.publish(message());

        expect(received).toHaveLength(1);
    });

    test('cancelling the subscription stops delivery', async () => {
        const backplane = createLocalBackplane();
        const received: RealtimeMessage[] = [];

        const unsubscribe = await backplane.subscribe((m) => received.push(m));
        unsubscribe();
        await backplane.publish(message());

        expect(received).toHaveLength(0);
    });
});
