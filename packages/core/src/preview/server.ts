import type { PreviewConfig, PreviewMessage } from './types.js';

// Type-only import for WebSocket
interface WebSocket {
    readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: string, listener: (event: any) => void): void;
}

interface WebSocketServer {
    on(event: string, callback: (ws: WebSocket, request?: { headers: Record<string, string | string[] | undefined> }) => void): void;
    close(): void;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Constant-time comparison of two strings */
export function sameSecret(given: unknown, expected: string): boolean {
    if (typeof given !== 'string') return false;
    const a = new TextEncoder().encode(given);
    const b = new TextEncoder().encode(expected);
    let diff = a.length ^ b.length;
    for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
    return diff === 0;
}

/** Is a browser at this Origin allowed to connect? No Origin: not a browser, allowed */
export function isAllowedOrigin(origin: string | undefined, allowed?: string[]): boolean {
    if (!origin) return true;
    if (allowed?.length) return allowed.includes(origin);
    try {
        return LOOPBACK.has(new URL(origin).hostname);
    } catch {
        return false;
    }
}

/**
 * WebSocket Preview Server
 * Handles real-time content updates from CMS
 */
export class PreviewServer {
    private config: PreviewConfig;
    /** Clients that receive broadcasts: authenticated ones, or every allowed one when no token is set */
    private clients: Set<WebSocket> = new Set();
    /** Clients that proved the token: only they may relay content.update to the others */
    private trusted: Set<WebSocket> = new Set();
    private server: WebSocketServer | null = null;
    private isRunning = false;

    constructor(config: PreviewConfig) {
        this.config = {
            wsPort: 3001,
            wsPath: '/__inti_preview',
            wsHost: '127.0.0.1',
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
            host: this.config.wsHost,
            port: this.config.wsPort,
            path: this.config.wsPath
        });

        this.server!.on('connection', (ws, request) => {
            const origin = request?.headers?.origin;
            this.handleConnection(ws, Array.isArray(origin) ? origin[0] : origin);
        });

        this.isRunning = true;
        console.log(`🔄 Inti Preview Server running on ws://${this.config.wsHost}:${this.config.wsPort}${this.config.wsPath}`);
    }

    /**
     * Stop the preview server
     */
    stop(): void {
        if (!this.isRunning) return;
        
        this.server?.close();
        this.clients.clear();
        this.trusted.clear();
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

    /** @internal exposed for tests: what the server does with one connection */
    handleConnection(ws: WebSocket, origin?: string): void {
        // A page on another site cannot open a socket to this server and read drafts
        if (!isAllowedOrigin(origin, this.config.allowedOrigins)) {
            ws.close();
            return;
        }
        // With a token, a client is only added once it proves it (see 'auth')
        if (!this.config.cmsToken) this.clients.add(ws);
        console.log('👤 Preview client connected');

        ws.addEventListener('message', (event: MessageEvent) => {
            this.handleMessage(ws, event.data);
        });

        ws.addEventListener('close', () => {
            this.clients.delete(ws);
            this.trusted.delete(ws);
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

    /** @internal exposed for tests */
    handleMessage(ws: WebSocket, data: string): void {
        try {
            const message: PreviewMessage = JSON.parse(data);

            switch (message.type) {
                case 'pong':
                    // Client is alive
                    break;
                
                case 'auth':
                    if (!this.config.cmsToken) break;
                    if (!sameSecret(message.payload?.token, this.config.cmsToken)) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            timestamp: Date.now(),
                            payload: { error: 'Authentication failed' }
                        }));
                        ws.close();
                        break;
                    }
                    this.clients.add(ws);
                    this.trusted.add(ws);
                    break;

                case 'content.update':
                    // Only a client that proved the token may speak for the CMS
                    if (!this.trusted.has(ws)) break;
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
