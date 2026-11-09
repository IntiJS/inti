import type { PreviewConfig, PreviewMessage } from './types.js';

// Type-only import for WebSocket
interface WebSocket {
    readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: string, listener: (event: any) => void): void;
}

interface WebSocketServer {
    on(event: string, callback: (ws: WebSocket) => void): void;
    close(): void;
}

/**
 * WebSocket Preview Server
 * Handles real-time content updates from CMS
 */
export class PreviewServer {
    private config: PreviewConfig;
    private clients: Set<WebSocket> = new Set();
    private server: WebSocketServer | null = null;
    private isRunning = false;

    constructor(config: PreviewConfig) {
        this.config = {
            wsPort: 3001,
            wsPath: '/__inti_preview',
            refreshDebounce: 300,
            draftMode: true,
            ...config
        };
    }

    /**
     * Start the preview WebSocket server
     */
    async start(): Promise<void> {
        if (this.isRunning || !this.config.enabled) return;

        // Dynamic import to avoid issues in non-Node environments
        let WebSocketServerImpl: any;
        try {
            // Use require-style import to avoid static analysis
            const wsModule = 'ws';
            const ws = await eval(`import('${wsModule}')`) as any;
            WebSocketServerImpl = ws.WebSocketServer;
        } catch {
            throw new Error('WebSocket server requires "ws" package. Install with: npm install ws');
        }
        
        this.server = new WebSocketServerImpl({
            port: this.config.wsPort,
            path: this.config.wsPath
        });

        this.server!.on('connection', (ws: WebSocket) => {
            this.handleConnection(ws);
        });

        this.isRunning = true;
        console.log(`🔄 Inti Preview Server running on ws://localhost:${this.config.wsPort}${this.config.wsPath}`);
    }

    /**
     * Stop the preview server
     */
    stop(): void {
        if (!this.isRunning) return;
        
        this.server?.close();
        this.clients.clear();
        this.isRunning = false;
        console.log('🔄 Inti Preview Server stopped');
    }

    /**
     * Broadcast a message to all connected clients
     */
    broadcast(message: PreviewMessage): void {
        const data = JSON.stringify(message);
        this.clients.forEach(client => {
            if (client.readyState === 1) { // WebSocket.OPEN
                client.send(data);
            }
        });
    }

    /**
     * Notify clients of content update
     */
    notifyUpdate(contentType: string, documentId: string, data: any, locale?: string): void {
        this.broadcast({
            type: 'content.update',
            timestamp: Date.now(),
            payload: {
                contentType,
                documentId,
                locale,
                data
            }
        });
    }

    /**
     * Notify clients of content deletion
     */
    notifyDelete(contentType: string, documentId: string): void {
        this.broadcast({
            type: 'content.delete',
            timestamp: Date.now(),
            payload: {
                contentType,
                documentId
            }
        });
    }

    /**
     * Notify clients of content publish
     */
    notifyPublish(contentType: string, documentId: string): void {
        this.broadcast({
            type: 'content.publish',
            timestamp: Date.now(),
            payload: {
                contentType,
                documentId
            }
        });
    }

    private handleConnection(ws: WebSocket): void {
        this.clients.add(ws);
        console.log('👤 Preview client connected');

        ws.addEventListener('message', (event: MessageEvent) => {
            this.handleMessage(ws, event.data);
        });

        ws.addEventListener('close', () => {
            this.clients.delete(ws);
            console.log('👤 Preview client disconnected');
        });

        // Send auth challenge if token is configured
        if (this.config.cmsToken) {
            ws.send(JSON.stringify({
                type: 'auth',
                timestamp: Date.now(),
                payload: {}
            }));
        }

        // Send initial ping
        ws.send(JSON.stringify({
            type: 'ping',
            timestamp: Date.now(),
            payload: {}
        }));
    }

    private handleMessage(ws: WebSocket, data: string): void {
        try {
            const message: PreviewMessage = JSON.parse(data);

            switch (message.type) {
                case 'pong':
                    // Client is alive
                    break;
                
                case 'auth':
                    // Verify authentication if needed
                    if (this.config.cmsToken && message.payload.token !== this.config.cmsToken) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            timestamp: Date.now(),
                            payload: { error: 'Authentication failed' }
                        }));
                        ws.close();
                    }
                    break;

                case 'content.update':
                    // Forward to all other clients
                    this.clients.forEach(client => {
                        if (client !== ws && client.readyState === 1) {
                            client.send(data);
                        }
                    });
                    break;
            }
        } catch (error) {
            console.error('Preview server error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                timestamp: Date.now(),
                payload: { error: 'Invalid message format' }
            }));
        }
    }
}

// Global server instance
let globalServer: PreviewServer | null = null;

export function createPreviewServer(config: PreviewConfig): PreviewServer {
    globalServer = new PreviewServer(config);
    return globalServer;
}

export function getPreviewServer(): PreviewServer | null {
    return globalServer;
}
