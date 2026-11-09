/**
 * @intijs/core/team — what a team needs once more than one person edits.
 *
 * - Shared block patterns: by default each editor keeps theirs in the
 *   browser; a store makes the one an editor saves visible to everyone.
 * - A realtime backplane: the core fans out changes within its own process;
 *   with several instances behind a load balancer, Valkey (or anything
 *   speaking the Redis protocol) reconnects them.
 *
 * Register them with a plugin:
 *
 *   registerIntiPlugin({
 *     name: 'team',
 *     getPatternStore: () => createFilePatternStore('./data/patterns.json'),
 *     getRealtimeBackplane: () => createValkeyBackplane({ publisher, subscriber })
 *   });
 */

export {
    createMemoryPatternStore,
    createFilePatternStore,
    createCustomPatternStore,
    restrictPatternWrites
} from './patterns.js';

export { createValkeyBackplane } from './valkey.js';
export type { ValkeyBackplaneConfig, ValkeyPublisher, ValkeySubscriber } from './valkey.js';
