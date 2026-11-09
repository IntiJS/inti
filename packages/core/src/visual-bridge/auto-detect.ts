/**
 * CMS auto-detection for VisualBridge
 * 
 * Automatically detects the configured adapter and configures
 * VisualBridge with no manual intervention.
 */

import type { VisualBridgeConfig } from './types.js';

export interface IntiConfig {
    adapter: string;
    adapterConfig?: {
        endpoint?: string;
        adminUrl?: string;
        [key: string]: any;
    };
}

/**
 * Detects the CMS from the configured adapter
 */
export function detectCmsFromAdapter(adapterName: string): {
    cms: string;
    adminUrl?: string;
} {
    // Mapping of adapter names to CMS
    const adapterMap: Record<string, { cms: string; defaultAdminPath: string }> = {
        'strapi': { cms: 'strapi', defaultAdminPath: '/admin' },
        'contentful': { cms: 'contentful', defaultAdminPath: '' },
        'sanity': { cms: 'sanity', defaultAdminPath: '/desk' },
        'kitsuden': { cms: 'kitsuden', defaultAdminPath: '/admin' },
        'directus': { cms: 'directus', defaultAdminPath: '/admin' },
        'wordpress': { cms: 'wordpress', defaultAdminPath: '/wp-admin' },
        'drupal': { cms: 'drupal', defaultAdminPath: '/admin' },
        'ghost': { cms: 'ghost', defaultAdminPath: '/ghost' }
    };
    
    // Look for an exact match
    const normalizedName = adapterName.toLowerCase().replace('adapter-', '');
    
    if (adapterMap[normalizedName]) {
        return {
            cms: adapterMap[normalizedName].cms,
            adminUrl: adapterMap[normalizedName].defaultAdminPath
        };
    }
    
    // With no exact match, try to extract it from the name
    for (const [key, value] of Object.entries(adapterMap)) {
        if (normalizedName.includes(key)) {
            return {
                cms: value.cms,
                adminUrl: value.defaultAdminPath
            };
        }
    }
    
    // Fallback: use the name as is
    return {
        cms: normalizedName,
        adminUrl: undefined
    };
}

/**
 * Builds the full admin URL from the endpoint
 */
export function resolveAdminUrl(
    endpoint: string,
    cms: string,
    customPath?: string
): string {
    if (customPath) {
        // If it is a full URL, use it
        if (customPath.startsWith('http')) {
            return customPath;
        }
        // If it is a relative path, join it with the endpoint
        const baseUrl = endpoint.replace(/\/$/, '');
        const path = customPath.startsWith('/') ? customPath : `/${customPath}`;
        return `${baseUrl}${path}`;
    }
    
    // Default path per CMS
    const defaultPaths: Record<string, string> = {
        strapi: '/admin',
        contentful: '', // Contentful uses app.contentful.com
        sanity: '/desk',
        gremius: '/admin',
        directus: '/admin',
        wordpress: '/wp-admin',
        drupal: '/admin',
        ghost: '/ghost'
    };
    
    const path = defaultPaths[cms] || '/admin';
    const baseUrl = endpoint.replace(/\/$/, '');
    return `${baseUrl}${path}`;
}

/**
 * Creates an auto-detected VisualBridge configuration
 */
export function createVisualBridgeConfig(
    intiConfig: IntiConfig,
    options?: Partial<Omit<VisualBridgeConfig, 'enabled' | 'cms'>>
): VisualBridgeConfig {
    const detected = detectCmsFromAdapter(intiConfig.adapter);
    const cms = detected.cms;
    const { display: _display, features: _features, cmsConfig: _cmsConfig, ...rest } = options ?? {};
    
    // Resolve the admin URL
    let adminUrl: string | undefined;
    
    if (intiConfig.adapterConfig?.adminUrl) {
        // Explicit URL in the config
        adminUrl = intiConfig.adapterConfig.adminUrl;
    } else if (intiConfig.adapterConfig?.endpoint) {
        // Derive it from the endpoint
        adminUrl = resolveAdminUrl(
            intiConfig.adapterConfig.endpoint,
            cms,
            detected.adminUrl
        );
    }
    
    // CMS-specific config
    const cmsConfig: VisualBridgeConfig['cmsConfig'] = {
        adminUrl,
        ...options?.cmsConfig
    };
    
    // Add the token if there is one
    if (intiConfig.adapterConfig?.previewToken) {
        cmsConfig.previewToken = intiConfig.adapterConfig.previewToken;
    }
    if (intiConfig.adapterConfig?.token) {
        cmsConfig.previewToken = intiConfig.adapterConfig.token;
    }
    
    return {
        enabled: true,
        cms,
        cmsConfig,
        display: {
            highlightOnHover: true,
            toolbarPosition: 'top',
            theme: 'dark',
            ...options?.display
        },
        features: {
            editInCms: true,
            livePreview: false,
            dragDrop: false,
            addBlocks: false,
            deleteBlocks: true,
            duplicateBlocks: true,
            // Default for callers that do not know whether there is a write
            // adapter. VisualBridgeAuto replaces it with the adapter's real
            // capability, which is what matters: a list of names leaves out
            // any new CMS, as happened with Kitsuden.
            inlineEdit:
                cms === 'wordpress' || cms === 'strapi' || cms === 'kitsuden' || cms === 'local',
            ...options?.features
        },
        // Without the objects already merged above: spreading them again
        // would replace them whole and the defaults would be lost.
        ...rest
    };
}

/**
 * Detects whether we are in development mode
 */
export function isDevelopment(): boolean {
    return typeof process !== 'undefined' && process.env?.NODE_ENV === 'development' ||
           typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;
}

/**
 * Detects whether VisualBridge should be enabled automatically
 */
export function shouldEnableVisualBridge(
    intiConfig: IntiConfig,
    force?: boolean,
    /** Is there an adapter able to write? The caller resolves it, on the server */
    canWrite = false
): boolean {
    if (force === false) return false;
    if (force === true) return true;
    
    // Only in development by default
    if (!isDevelopment()) return false;
    
    // Either one is enough: being able to write (inline editing) or knowing
    // where the admin is ("edit in the CMS" button). The admin URL used to be
    // required, and the local store —which has none— never showed the
    // editor: the documentation's "try it without connecting anything" did
    // not work.
    return canWrite || !!(intiConfig.adapterConfig?.adminUrl || intiConfig.adapterConfig?.endpoint);
}
