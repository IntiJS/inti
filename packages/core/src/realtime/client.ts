/**
 * RealtimeClient - WebSocket client for real-time collaboration
 */

import type {
    RealtimeConfig,
    RealtimeMessage,
    MessageType,
    UserPresence,
    CursorPosition,
    ContentUpdate,
    Conflict,
    ConflictResolution,
    RealtimeEvent,
    RealtimeEventType,
    RealtimeEventHandler,
    BroadcastOptions
} from './types.js';

export class RealtimeClient {
    private config: RealtimeConfig;
    private ws: WebSocket | null = null;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectTimer: any = null;
    private pingTimer: any = null;
    private eventHandlers: Map<RealtimeEventType, Set<RealtimeEventHandler>> = new Map();
    private messageQueue: RealtimeMessage[] = [];
    private connected = false;
    private userId: string;
    private userColor: string;
    
    constructor(config: RealtimeConfig) {
        this.config = {
            autoReconnect: true,
            pingInterval: 30000,
            connectionTimeout: 10000,
            presence: true,
            conflictResolution: true,
            ...config
        };
        
        // Generate a unique ID for this client
        this.userId = this.generateUserId();
        this.userColor = this.generateUserColor();
    }
    
    // ============================================
    // Connection
    // ============================================
    
    async connect(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            try {
                const url = new URL(this.config.endpoint);
                url.searchParams.set('room', this.config.room);
                url.searchParams.set('userId', this.userId);
                
                if (this.config.token) {
                    url.searchParams.set('token', this.config.token);
                }
                
                this.ws = new WebSocket(url.toString());
                
                const timeout = setTimeout(() => {
                    reject(new Error('Connection timeout'));
                }, this.config.connectionTimeout);
                
                this.ws.onopen = () => {
                    clearTimeout(timeout);
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    this.startPing();
                    this.flushMessageQueue();
                    this.emit('connect', { userId: this.userId });
                    resolve(true);
                };
                
                this.ws.onclose = () => {
                    this.connected = false;
                    this.stopPing();
                    this.emit('disconnect', {});
                    
                    if (this.config.autoReconnect) {
                        this.scheduleReconnect();
                    }
                };
                
                this.ws.onerror = (error) => {
                    clearTimeout(timeout);
                    this.emit('error', { error });
                    reject(error);
                };
                
                this.ws.onmessage = (event) => {
                    this.handleMessage(JSON.parse(event.data));
                };
                
            } catch (error) {
                reject(error);
            }
        });
    }
    
    disconnect(): void {
        this.connected = false;
        this.stopPing();
        clearTimeout(this.reconnectTimer);
        this.ws?.close();
        this.ws = null;
    }
    
    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[Realtime] Max reconnection attempts reached');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        
        console.log(`[Realtime] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        
        this.reconnectTimer = setTimeout(() => {
            this.connect().catch(() => {
                // Error handled in onclose
            });
        }, delay);
    }
    
    // ============================================
    // Ping/Pong
    // ============================================
    
    private startPing(): void {
        this.pingTimer = setInterval(() => {
            this.send({
                type: 'ping',
                id: this.generateMessageId(),
                timestamp: Date.now(),
                userId: this.userId,
                room: this.config.room,
                payload: {}
            });
        }, this.config.pingInterval);
    }
    
    private stopPing(): void {
        clearInterval(this.pingTimer);
    }
    
    // ============================================
    // Messages
    // ============================================
    
    private send(message: RealtimeMessage): void {
        if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            this.messageQueue.push(message);
        }
    }
    
    private flushMessageQueue(): void {
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            if (message) this.send(message);
        }
    }
    
    private handleMessage(message: RealtimeMessage): void {
        switch (message.type) {
            case 'pong':
                // Connection is alive
                break;
                
            case 'presence':
                this.emit('user_join', message.payload);
                break;
                
            case 'update':
                this.emit('update', message.payload);
                break;
                
            case 'cursor':
                this.emit('cursor_move', message.payload);
                break;
                
            case 'conflict':
                this.handleConflict(message.payload);
                break;
                
            case 'sync_response':
                this.emit('sync', message.payload);
                break;
        }
    }
    
    // ============================================
    // Public API
    // ============================================
    
    /**
     * Send a content update
     */
    update(content: ContentUpdate): void {
        this.send({
            type: 'update',
            id: this.generateMessageId(),
            timestamp: Date.now(),
            userId: this.userId,
            room: this.config.room,
            payload: content
        });
    }
    
    /**
     * Send the cursor position
     */
    moveCursor(position: CursorPosition): void {
        this.send({
            type: 'cursor',
            id: this.generateMessageId(),
            timestamp: Date.now(),
            userId: this.userId,
            room: this.config.room,
            payload: {
                userId: this.userId,
                cursor: position,
                color: this.userColor
            }
        });
    }
    
    /**
     * Broadcast to all users
     */
    broadcast(type: string, payload: any, options: BroadcastOptions = {}): void {
        this.send({
            type: 'update',
            id: this.generateMessageId(),
            timestamp: Date.now(),
            userId: this.userId,
            room: this.config.room,
            payload: {
                broadcast: true,
                includeSelf: options.includeSelf,
                type,
                data: payload
            }
        });
    }
    
    /**
     * Request a full sync
     */
    requestSync(): void {
        this.send({
            type: 'sync_request',
            id: this.generateMessageId(),
            timestamp: Date.now(),
            userId: this.userId,
            room: this.config.room,
            payload: {}
        });
    }
    
    // ============================================
    // Conflict Resolution
    // ============================================
    
    private handleConflict(conflict: Conflict): void {
        if (!this.config.conflictResolution) {
            this.emit('conflict', conflict);
            return;
        }
        
        const resolution = this.resolveConflict(conflict);
        
        this.send({
            type: 'resolve',
            id: this.generateMessageId(),
            timestamp: Date.now(),
            userId: this.userId,
            room: this.config.room,
            payload: {
                conflictId: conflict.id,
                resolution
            }
        });
    }
    
    private resolveConflict(conflict: Conflict): ConflictResolution {
        // Last-write-wins by default
        const localWins = conflict.localTimestamp > conflict.remoteTimestamp;
        
        return {
            strategy: 'last-write-wins',
            value: localWins ? conflict.localValue : conflict.remoteValue,
            autoResolved: true,
            message: localWins ? 'Local changes kept' : 'Remote changes accepted'
        };
    }
    
    // ============================================
    // Event System
    // ============================================
    
    on<T>(event: RealtimeEventType, handler: RealtimeEventHandler<T>): () => void {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }
        this.eventHandlers.get(event)!.add(handler);
        
        // Return unsubscribe
        return () => {
            this.eventHandlers.get(event)?.delete(handler);
        };
    }
    
    private emit<T>(type: RealtimeEventType, data: T): void {
        const handlers = this.eventHandlers.get(type);
        if (handlers) {
            const event: RealtimeEvent<T> = {
                type,
                timestamp: Date.now(),
                data
            };
            handlers.forEach(handler => {
                try {
                    handler(event);
                } catch (error) {
                    console.error('[Realtime] Event handler error:', error);
                }
            });
        }
    }
    
    // ============================================
    // Getters
    // ============================================
    
    getUserId(): string {
        return this.userId;
    }
    
    getUserColor(): string {
        return this.userColor;
    }
    
    isConnected(): boolean {
        return this.connected;
    }
    
    // ============================================
    // Helpers
    // ============================================
    
    private generateUserId(): string {
        return `user-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    private generateMessageId(): string {
        return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    }
    
    private generateUserColor(): string {
        const colors = [
            '#3b82f6', // blue
            '#ef4444', // red
            '#10b981', // green
            '#f59e0b', // yellow
            '#8b5cf6', // purple
            '#ec4899', // pink
            '#06b6d4', // cyan
            '#f97316'  // orange
        ];
        return colors[Math.floor(Math.random() * colors.length)];
    }
}

// ============================================
// Global Instance
// ============================================

let globalRealtimeClient: RealtimeClient | null = null;

export function initRealtime(config: RealtimeConfig): RealtimeClient {
    if (globalRealtimeClient) {
        globalRealtimeClient.disconnect();
    }
    globalRealtimeClient = new RealtimeClient(config);
    return globalRealtimeClient;
}

export function getRealtimeClient(): RealtimeClient | null {
    return globalRealtimeClient;
}

export function disconnectRealtime(): void {
    globalRealtimeClient?.disconnect();
    globalRealtimeClient = null;
}
