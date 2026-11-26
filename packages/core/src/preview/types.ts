/**
 * Live Preview System Types
 * Real-time content updates from CMS
 */

export interface PreviewConfig {
    enabled: boolean;
    wsPort?: number;
    wsPath?: string;
    /** Interface the websocket server listens on. Default `127.0.0.1`: this machine only */
    wsHost?: string;
    /**
     * Browser origins allowed to connect (`https://preview.acme.com`). Default: only
     * loopback origins (localhost, 127.0.0.1, [::1]). Clients that send no Origin (not a browser) are accepted
     */
    allowedOrigins?: string[];
    cmsEndpoint?: string;
    /**
     * Shared secret. When set, a client receives nothing and relays nothing until it sends
     * `{ type: 'auth', payload: { token } }` with it; usePreviewMode and previewMiddleware
     * require it as `?token=` outside development
     */
    cmsToken?: string;
    refreshDebounce?: number;
    draftMode?: boolean;
}

export interface PreviewMessage {
    type: 'content.update' | 'content.delete' | 'content.publish' | 'ping' | 'pong' | 'auth' | 'error';
    timestamp: number;
    payload: {
        contentType?: string;
        documentId?: string;
        locale?: string;
        data?: any;
        error?: string;
        token?: string;
    };
}

export interface PreviewState {
    isConnected: boolean;
    isDraftMode: boolean;
    lastUpdate: number;
    documentId?: string;
    contentType?: string;
}

export interface PreviewCallbacks {
    onConnect?: () => void;
    onDisconnect?: () => void;
    onUpdate?: (message: PreviewMessage) => void;
    onError?: (error: Error) => void;
}
