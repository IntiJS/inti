/**
 * Real-time Collaboration System
 *
 * Real-time synchronization system for:
 * - Collaborative content editing
 * - Live cursors
 * - Conflict resolution
 * - Presence awareness
 */

// ============================================
// Configuration
// ============================================

export interface RealtimeConfig {
    /** WebSocket endpoint */
    endpoint: string;
    /** Room/Channel to join */
    room: string;
    /** Authentication token */
    token?: string;
    /** Reconnect automatically */
    autoReconnect?: boolean;
    /** Ping interval (ms) */
    pingInterval?: number;
    /** Connection timeout (ms) */
    connectionTimeout?: number;
    /** Enable presence */
    presence?: boolean;
    /** Enable conflict resolution */
    conflictResolution?: boolean;
}

// ============================================
// Messages
// ============================================

export type MessageType =
    // Connection
    | 'connect'
    | 'disconnect'
    | 'auth'
    | 'ping'
    | 'pong'
    // Room
    | 'join'
    | 'leave'
    | 'presence'
    // Data
    | 'update'
    | 'insert'
    | 'delete'
    | 'cursor'
    // Conflicts
    | 'conflict'
    | 'resolve'
    // Synchronization
    | 'sync_request'
    | 'sync_response';

export interface RealtimeMessage<T = any> {
    /** Message type */
    type: MessageType;
    /** Message ID */
    id: string;
    /** Timestamp */
    timestamp: number;
    /** Sending user */
    userId: string;
    /** Target room */
    room: string;
    /** Payload */
    payload: T;
}

// ============================================
// Presence
// ============================================

export interface UserPresence {
    /** User ID */
    userId: string;
    /** Display name */
    name: string;
    /** Assigned color */
    color: string;
    /** Avatar URL */
    avatar?: string;
    /** Status */
    status: 'online' | 'away' | 'offline';
    /** Last activity */
    lastSeen: number;
    /** Cursor position (if any) */
    cursor?: CursorPosition;
    /** Additional metadata */
    metadata?: Record<string, any>;
}

export interface CursorPosition {
    /** X position */
    x: number;
    /** Y position */
    y: number;
    /** Element it is over */
    element?: string;
    /** Specific field/input */
    field?: string;
}

// ============================================
// Updates and Operations
// ============================================

export interface ContentUpdate {
    /** Document/block ID */
    documentId: string;
    /** Content type */
    contentType: string;
    /** Modified field */
    field: string;
    /** Previous value */
    oldValue: any;
    /** New value */
    newValue: any;
    /** Document version */
    version: number;
    /** Timestamp */
    timestamp: number;
}

export interface Operation {
    /** Operation type */
    type: 'set' | 'delete' | 'insert' | 'move';
    /** Path to the field */
    path: string;
    /** Value (for set/insert) */
    value?: any;
    /** Position (for insert/move) */
    index?: number;
    /** Inverse operation (for undo) */
    inverse?: Operation;
}

// ============================================
// Conflict Resolution
// ============================================

export interface Conflict {
    /** Conflict ID */
    id: string;
    /** Affected document */
    documentId: string;
    /** Conflicting field */
    field: string;
    /** Local value */
    localValue: any;
    /** Remote value */
    remoteValue: any;
    /** Base value (common ancestor) */
    baseValue?: any;
    /** Local timestamp */
    localTimestamp: number;
    /** Remote timestamp */
    remoteTimestamp: number;
    /** Users in conflict */
    users: string[];
}

export type ConflictResolutionStrategy =
    | 'last-write-wins'
    | 'first-write-wins'
    | 'merge'
    | 'manual'
    | 'custom';

export interface ConflictResolution {
    /** Strategy used */
    strategy: ConflictResolutionStrategy;
    /** Resulting value */
    value: any;
    /** Whether it was resolved automatically */
    autoResolved: boolean;
    /** Message for the user */
    message?: string;
}

// ============================================
// Client State
// ============================================

export interface RealtimeClientState {
    /** Whether it is connected */
    connected: boolean;
    /** Connection ID */
    connectionId?: string;
    /** Users in the room */
    users: Map<string, UserPresence>;
    /** Updates pending synchronization */
    pendingUpdates: ContentUpdate[];
    /** Pending conflicts */
    pendingConflicts: Conflict[];
    /** Document version */
    documentVersion: number;
    /** Synchronization state */
    syncState: 'synced' | 'syncing' | 'conflict';
}

// ============================================
// Events
// ============================================

export type RealtimeEventType =
    | 'connect'
    | 'disconnect'
    | 'error'
    | 'user_join'
    | 'user_leave'
    | 'update'
    | 'cursor_move'
    | 'conflict'
    | 'sync';

export interface RealtimeEvent<T = any> {
    type: RealtimeEventType;
    timestamp: number;
    data: T;
}

export type RealtimeEventHandler<T = any> = (event: RealtimeEvent<T>) => void;

// ============================================
// Broadcast and Multicast
// ============================================

export interface BroadcastOptions {
    /** Include the sender */
    includeSelf?: boolean;
    /** Delivery timeout */
    timeout?: number;
    /** Receipt acknowledgement */
    ack?: boolean;
}

export interface MulticastOptions extends BroadcastOptions {
    /** Target users */
    to: string[];
}
