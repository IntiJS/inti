import type { PreviewConfig } from './types.js';
import { sameSecret } from './server.js';

/**
 * Astro integration for Preview Mode
 * Provides SSR support for draft content
 */

export interface PreviewContext {
    isPreview: boolean;
    draftToken?: string;
    documentId?: string;
}

function isDevelopment(): boolean {
    try {
        return Boolean(import.meta.env?.DEV);
    } catch {
        return false;
    }
}

/**
 * Check if current request is in preview mode
 * Use in Astro SSR pages.
 *
 * Outside development, preview mode needs `secret` (the preview config's `cmsToken`) and
 * a request carrying it as `?token=`. `?preview=1` alone is not a credential: a page that
 * fetches drafts when `isPreview` is true would show them to anyone.
 */
export function usePreviewMode(request: Request, secret?: string): PreviewContext {
    const url = new URL(request.url);
    
    // Check for preview token in query params
    const previewToken = url.searchParams.get('preview');
    const draftToken = url.searchParams.get('token');
    const documentId = url.searchParams.get('document');
    
    // In development, preview is on unless ?preview=false. Elsewhere ?preview=1 is a
    // request, not a credential: it also needs ?token= matching the configured secret
    const asked = previewToken === '1' || previewToken === 'true';
    const isPreview = isDevelopment()
        ? previewToken !== 'false'
        : asked && typeof secret === 'string' && secret !== '' && sameSecret(draftToken, secret);
    
    return {
        isPreview,
        draftToken: draftToken || undefined,
        documentId: documentId || undefined
    };
}

/**
 * Middleware for Astro to handle preview mode
 */
export function previewMiddleware(config: PreviewConfig) {
    return async (context: any, next: () => Promise<Response>) => {
        const previewContext = usePreviewMode(context.request, config.cmsToken);

        // Attach preview context to Astro locals
        context.locals.preview = previewContext;

        // A wrong token is refused rather than quietly served the published page
        if (previewContext.draftToken && config.cmsToken && !sameSecret(previewContext.draftToken, config.cmsToken)) {
            return new Response('Invalid preview token', { status: 403 });
        }
        
        return next();
    };
}

/**
 * Script to inject into pages for live preview
 */
export function getPreviewScript(config: PreviewConfig): string {
    if (!config.enabled) return '';
    
    return `
<script>
(function() {
    // Inti Live Preview Client
    const PREVIEW_CONFIG = ${JSON.stringify({
        wsPort: config.wsPort,
        wsPath: config.wsPath,
        draftMode: config.draftMode
    })};
    
    let ws = null;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    
    function connect() {
        const wsUrl = 'ws://localhost:' + PREVIEW_CONFIG.wsPort + PREVIEW_CONFIG.wsPath;
        ws = new WebSocket(wsUrl);
        
        ws.onopen = function() {
            console.log('🔌 Inti Preview: Connected');
            reconnectAttempts = 0;
        };
        
        ws.onmessage = function(event) {
            try {
                const msg = JSON.parse(event.data);
                
                if (msg.type === 'content.update') {
                    console.log('📝 Inti Preview: Content updated, reloading...');
                    // Add visual indicator
                    showUpdateIndicator();
                    // Debounced reload
                    clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(function() {
                        window.location.reload();
                    }, 300);
                }
            } catch (e) {
                console.error('Preview message error:', e);
            }
        };
        
        ws.onclose = function() {
            console.log('🔌 Inti Preview: Disconnected');
            scheduleReconnect();
        };
        
        ws.onerror = function(err) {
            console.error('Preview error:', err);
        };
    }
    
    function scheduleReconnect() {
        reconnectAttempts++;
        if (reconnectAttempts > 5) return;
        
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        setTimeout(connect, delay);
    }
    
    function showUpdateIndicator() {
        let indicator = document.getElementById('__inti_preview_indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = '__inti_preview_indicator';
            indicator.innerHTML = '🔄 Content updated, reloading...';
            indicator.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#3b82f6;color:white;padding:8px;text-align:center;z-index:99999;font-family:sans-serif;font-size:14px;';
            document.body.appendChild(indicator);
        }
    }
    
    // Auto-connect in preview mode
    if (window.location.search.includes('preview=')) {
        connect();
    }
})();
</script>
`;
}
