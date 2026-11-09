/**
 * Server-side resolution of the write adapter.
 *
 * Shared by the actions (write-back) and the API routes (relation
 * search). Credentials live ONLY here, on the server.
 */

import { resolveAdapter, isWritableAdapter } from '../adapters/index.js';
import type { IntiAdapter, WritableAdapter } from '../adapters/index.js';
import { resolvePluginWriteAdapter } from '../plugins/index.js';

/**
 * Reads an environment variable both in the Astro runtime (import.meta.env)
 * and in plain Node (process.env)
 */
export function env(name: string): string | undefined {
    // First what the server received at startup: that is what should win
    // in a deployment, and whatever `.env` held at build time is the fallback
    const fromProcess = typeof process !== 'undefined' ? process.env?.[name] : undefined;
    if (fromProcess !== undefined) return fromProcess;

    try {
        // It must be written `import.meta.env`, with no `?.` in between: that is
        // what Vite recognizes and replaces. With `import.meta?.env`, Astro 5 and
        // 6's module runner in development throws "Dynamic access of import.meta.env"
        // and the editor does not load.
        return (import.meta as any).env?.[name];
    } catch {
        return undefined;
    }
}

/** Write adapter cache (one instance per process) */
let writeAdapterCache: (IntiAdapter & WritableAdapter) | null | undefined;

/**
 * Resolves the write-capable adapter from environment variables.
 *
 * - INTI_ADAPTER            → adapter name ('wordpress', 'kitsuden', 'strapi', 'local')
 * - INTI_WP_*               → WordPress config
 * - INTI_KITSUDEN_*         → Kitsuden config
 * - INTI_STRAPI_*           → Strapi config
 * - INTI_KEYSTATIC_*        → Keystatic config
 *
 * Without INTI_ADAPTER the local store is used. Returns null only if the
 * requested adapter does not exist or cannot write.
 */
export async function resolveWriteAdapter(): Promise<(IntiAdapter & WritableAdapter) | null> {
    // Not stored in the cache: a binding may differ on each request
    const fromPlugin = resolvePluginWriteAdapter();
    if (fromPlugin) return fromPlugin;

    if (writeAdapterCache !== undefined) return writeAdapterCache;

    const adapterName = env('INTI_ADAPTER');

    // With no CMS configured the local store is used: it is just another
    // adapter, not a special path. It lets you try editing without connecting anything.
    if (!adapterName || adapterName === 'local') {
        const { LocalAdapter } = await import('../adapters/local.js');
        writeAdapterCache = new LocalAdapter({ file: env('INTI_LOCAL_STORE') });
        return writeAdapterCache;
    }

    try {
        const pkg = await resolveAdapter(adapterName);

        // Adapter-specific config, by the INTI_<CMS>_* env var convention
        let config: Record<string, any>;
        switch (adapterName) {
            case 'wordpress':
                config = {
                    endpoint: env('INTI_WP_ENDPOINT') || '',
                    username: env('INTI_WP_USER'),
                    appPassword: env('INTI_WP_APP_PASSWORD'),
                    postType: env('INTI_WP_POST_TYPE') || 'pages',
                    blocksField: env('INTI_WP_BLOCKS_FIELD') || 'content_blocks'
                };
                break;
            case 'kitsuden':
                // INTI_ENDPOINT / INTI_TOKEN still work: they were the only way
                // to configure it before it had its own variables.
                config = {
                    endpoint: env('INTI_KITSUDEN_ENDPOINT') || env('INTI_ENDPOINT') || '',
                    token: env('INTI_KITSUDEN_TOKEN') || env('INTI_TOKEN'),
                    mountPath: env('INTI_KITSUDEN_MOUNT_PATH'),
                    status: env('INTI_KITSUDEN_STATUS'),
                    mediaPreset: env('INTI_KITSUDEN_MEDIA_PRESET')
                };
                break;
            case 'keystatic':
                config = {
                    root: env('INTI_KEYSTATIC_ROOT'),
                    repo: env('INTI_KEYSTATIC_REPO'),
                    token: env('INTI_KEYSTATIC_TOKEN'),
                    branch: env('INTI_KEYSTATIC_BRANCH'),
                    collection: env('INTI_KEYSTATIC_COLLECTION'),
                    blocksField: env('INTI_KEYSTATIC_BLOCKS_FIELD')
                };
                break;
            case 'strapi':
                config = {
                    endpoint: env('INTI_STRAPI_ENDPOINT') || '',
                    apiToken: env('INTI_STRAPI_TOKEN'),
                    contentType: env('INTI_STRAPI_CONTENT_TYPE') || 'pages',
                    blocksField: env('INTI_STRAPI_BLOCKS_FIELD') || 'blocks'
                };
                break;
            default:
                // Community adapters: generic endpoint + token config
                config = { endpoint: env('INTI_ENDPOINT') || '', token: env('INTI_TOKEN') };
        }

        // Variables that are not set are not passed: an explicit `undefined`
        // would override the adapter's default value.
        const instance = new pkg.adapter(
            Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))
        );

        if (!isWritableAdapter(instance)) {
            console.warn(`[Inti] Adapter "${adapterName}" does not support write-back: inline editing stays off.`);
            writeAdapterCache = null;
            return null;
        }

        writeAdapterCache = instance;
        return instance;
    } catch (error) {
        console.error(`[Inti] Could not resolve write adapter "${adapterName}":`, error instanceof Error ? error.message : error);
        writeAdapterCache = null;
        return null;
    }
}
