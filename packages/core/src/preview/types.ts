/**
 * Live Preview System Types
 * Real-time content updates from CMS
 */

export interface PreviewConfig {
    enabled: boolean;
    wsPort?: number;
    wsPath?: string;
    cmsEndpoint?: string;
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
