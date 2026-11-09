import type { PreviewConfig, PreviewMessage, PreviewState, PreviewCallbacks } from './types.js';

/**
 * Preview Client
 * Browser-side WebSocket client for live preview
 */
export class PreviewClient {
    private config: PreviewConfig;
    private ws: WebSocket | null = null;
    private reconnectTimer: any = null;
    private pingTimer: any = null;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private callbacks: PreviewCallbacks = {};
    private state: PreviewState = {
        isConnected: false,
        isDraftMode: false,
        lastUpdate: 0
    };

    constructor(config: PreviewConfig, callbacks: PreviewCallbacks = {}) {
        this.config = {
            wsPort: 3001,
            wsPath: '/__inti_preview',
            refreshDebounce: 300,
            draftMode: true,
            ...config
        };
        this.callbacks = callbacks;
    }

    /**
     * Connect to preview server
     */
    connect(): void {
        if (!this.config.enabled || this.ws?.readyState === WebSocket.OPEN) return;

        const wsUrl = `ws://localhost:${this.config.wsPort}${this.config.wsPath}`;
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.addEventListener('open', () => {
                this.handleOpen();
            });
            
            this.ws.addEventListener('message', (event) => {
                this.handleMessage(event.data);
            });
            
            this.ws.addEventListener('close', () => {
                this.handleClose();
            });
            
            this.ws.addEventListener('error', (error) => {
                this.handleError(error);
            });
        } catch (error) {
            console.error('Failed to connect to preview server:', error);
            this.scheduleReconnect();
        }
    }

    /**
     * Disconnect from preview server
     */
    disconnect(): void {
        this.clearTimers();
        this.ws?.close();
        this.ws = null;
        this.state.isConnected = false;
    }

    /**
     * Send authentication token
     */
    authenticate(token: string): void {
        this.send({
            type: 'auth',
            timestamp: Date.now(),
            payload: { token }
        });
    }

    /**
     * Get current preview state
     */
    getState(): PreviewState {
        return { ...this.state };
    }

    /**
     * Check if in preview/draft mode
     */
    isPreviewMode(): boolean {
        return this.state.isConnected && this.state.isDraftMode;
    }

    private handleOpen(): void {
        console.log('🔌 Connected to Inti Preview Server');
        this.state.isConnected = true;
        this.state.isDraftMode = this.config.draftMode ?? true;
        this.reconnectAttempts = 0;
        
        // Start ping interval
        this.pingTimer = setInterval(() => {
            this.send({
                type: 'ping',
                timestamp: Date.now(),
                payload: {}
            });
        }, 30000);

        this.callbacks.onConnect?.();
    }

    private handleMessage(data: string): void {
        try {
            const message: PreviewMessage = JSON.parse(data);

            switch (message.type) {
                case 'pong':
                    // Server is alive
                    break;

                case 'content.update':
                    this.state.lastUpdate = message.timestamp;
                    this.state.documentId = message.payload.documentId;
                    this.state.contentType = message.payload.contentType;
                    
                    // Trigger page refresh or hot reload
                    this.handleContentUpdate(message);
                    break;

                case 'content.delete':
                    console.log(`Content deleted: ${message.payload.contentType}/${message.payload.documentId}`);
                    this.callbacks.onUpdate?.(message);
                    break;

                case 'content.publish':
                    console.log(`Content published: ${message.payload.contentType}/${message.payload.documentId}`);
                    this.callbacks.onUpdate?.(message);
                    break;

                case 'error':
                    console.error('Preview error:', message.payload.error);
                    this.callbacks.onError?.(new Error(message.payload.error || 'Unknown error'));
                    break;
            }
        } catch (error) {
            console.error('Failed to parse preview message:', error);
        }
    }

    private handleClose(): void {
        console.log('🔌 Disconnected from Inti Preview Server');
        this.state.isConnected = false;
        this.clearTimers();
        this.callbacks.onDisconnect?.();
        this.scheduleReconnect();
    }

    private handleError(error: Event): void {
        console.error('Preview WebSocket error:', error);
        this.callbacks.onError?.(new Error('WebSocket error'));
    }

    private handleContentUpdate(message: PreviewMessage): void {
        // Debounce rapid updates
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(() => {
            this.callbacks.onUpdate?.(message);
            
            // Optional: Auto-reload page
            if (typeof window !== 'undefined' && (window as any).__INTI_PREVIEW_AUTO_RELOAD) {
                window.location.reload();
            }
        }, this.config.refreshDebounce);
    }

    private send(message: PreviewMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        
        console.log(`Reconnecting in ${delay}ms... (attempt ${this.reconnectAttempts})`);
        
        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }

    private clearTimers(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}

// Global client for browser
let globalClient: PreviewClient | null = null;

export function initPreview(config: PreviewConfig, callbacks?: PreviewCallbacks): PreviewClient {
    if (typeof window === 'undefined') {
        throw new Error('Preview client can only be initialized in browser environment');
    }
    
    globalClient = new PreviewClient(config, callbacks);
    globalClient.connect();
    return globalClient;
}

export function getPreviewClient(): PreviewClient | null {
    return globalClient;
}

export function isPreviewMode(): boolean {
    return globalClient?.isPreviewMode() ?? false;
}
