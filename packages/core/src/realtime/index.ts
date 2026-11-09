/**
 * Real-time Collaboration System
 * 
 * Real-time synchronization system for collaborative editing
 * with live cursors, presence awareness and conflict resolution.
 */

// Types
export type {
    RealtimeConfig,
    RealtimeMessage,
    MessageType,
    UserPresence,
    CursorPosition,
    ContentUpdate,
    Operation,
    Conflict,
    ConflictResolution,
    ConflictResolutionStrategy,
    RealtimeEvent,
    RealtimeEventType,
    RealtimeEventHandler,
    BroadcastOptions
} from './types.js';

// Client
export {
    RealtimeClient,
    initRealtime,
    getRealtimeClient,
    disconnectRealtime
} from './client.js';

// Helpers
export function createContentUpdate(
    documentId: string,
    contentType: string,
    field: string,
    oldValue: any,
    newValue: any,
    version: number
) {
    return {
        documentId,
        contentType,
        field,
        oldValue,
        newValue,
        version,
        timestamp: Date.now()
    };
}

export function generateRoomId(contentType: string, documentId: string): string {
    return `${contentType}:${documentId}`;
}
