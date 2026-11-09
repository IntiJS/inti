import { IntiAdapter } from '@intijs/core/adapters';
import { extractWordPressSeo } from './seo.js';
import { normalizeAcfForWrite } from './acf-write.js';
import type { RestSchema } from './acf-write.js';
import type {
    IntiPage,
    IntiBlock,
    IntiNavigation,
    SchemaField,
    SchemaDefinition,
    SchemaCollection,
    IntrospectionConfig,
    IntrospectionResult,
    WritableAdapter,
    WriteResult,
    DraftableAdapter,
    DraftResult,
    FieldType,
    ListableAdapter,
    PageSummary
} from '@intijs/core/adapters';
import { IntrospectionAdapter } from '@intijs/core/adapters';
import {
    parseGutenberg,
    patchBlockText,
    serializeGutenberg,
    extractText,
    isTextEditable,
    gutenbergNameToType
} from './gutenberg.js';

export {
    parseGutenberg,
    patchBlockText,
    serializeGutenberg,
    extractText,
    isTextEditable,
    gutenbergNameToType
} from './gutenberg.js';
export type { GutenbergBlock } from './gutenberg.js';

// ============================================
// WordPress REST Payload Types
// ============================================

/**
 * Raw Post/Page as returned by the WP REST API (wp/v2)
 * with ACF exposed via "Show in REST" (ACF >= 5.11)
 */
export interface WordPressPost {
    id: number;
    slug: string;
    type?: string;
    status?: string;
    modified?: string;
    title?: { rendered?: string; raw?: string };
    content?: { rendered?: string };
    /** The post's ACF fields. The Flexible Content lives here as an array of layouts */
    acf?: Record<string, any>;
    [key: string]: any;
}

export interface WordPressConfig extends IntrospectionConfig {
    /** Base URL of the WordPress site (e.g. https://cms.mysite.com) */
    endpoint: string;
    /** WordPress user who owns the Application Password (server only) */
    username?: string;
    /** Application Password (WP >= 5.6). NEVER expose to the client */
    appPassword?: string;
    /** REST post type to use as pages (default: 'pages') */
    postType?: string;
    /** Name of the ACF Flexible Content field holding the blocks (default: 'content_blocks') */
    blocksField?: string;
    /** Explicit mapping acf_fc_layout → Inti block type (e.g. { hero_banner: 'Hero' }) */
    blockTypeMap?: Record<string, string>;
    /** Additional post types to introspect (default: ['pages', 'posts']) */
    collections?: string[];
    /**
     * Block model of the content:
     * - 'acf': ACF Flexible Content (recommended)
     * - 'gutenberg': Gutenberg blocks from post_content
     * - 'auto' (default): ACF if the field exists, otherwise Gutenberg
     */
    mode?: 'acf' | 'gutenberg' | 'auto';
    /**
     * URL of the patch endpoint of the inti-bridge companion plugin
     * ('auto' detects it; false disables it). The plugin does the patch
     * atomically in PHP and avoids the round-trip of the whole ACF array.
     */
    useBridgePlugin?: boolean | 'auto';
}

// ============================================
// Helpers
// ============================================

/** snake_case / kebab-case → PascalCase (hero_banner → HeroBanner) */
function toPascalCase(name: string): string {
    return name
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

/** Portable Base64 (Node and browser) for the Basic header */
function toBase64(input: string): string {
    const BufferRef = (globalThis as any).Buffer;
    if (BufferRef) {
        return BufferRef.from(input, 'utf-8').toString('base64');
    }
    return btoa(unescape(encodeURIComponent(input)));
}

/** Sets a value on an object following a dot-path ('cta.label') */
function setByPath(target: Record<string, any>, path: string, value: any): void {
    const parts = path.split('.');
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (cursor[key] === null || typeof cursor[key] !== 'object') {
            cursor[key] = {};
        }
        cursor = cursor[key];
    }
    cursor[parts[parts.length - 1]] = value;
}

/** Slug of a post's working copy: `inti-draft-of-<id>` */
const DRAFT_SLUG_PREFIX = 'inti-draft-of-';

/**
 * `fetch` that retries once if the connection drops before there is a response.
 *
 * Apache closes idle connections after 5 s and Node may reuse one right
 * then: the first save after a pause failed with "fetch failed".
 * Retrying is safe because every write from this adapter sends the final
 * state, not an increment. A rejection from the CMS is not retried: that is a response.
 */
function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init).catch(() => fetch(url, init));
}

// ============================================
// WordPress Adapter (read + write-back)
// ============================================

/**
 * Official adapter for Headless WordPress.
 *
 * Reading:
 * - WP REST API (wp/v2) with ACF exposed via "Show in REST"
 * - ACF Flexible Content → IntiBlock[] (1:1 mapping of layouts to blocks)
 *
 * Writing (write-back / inline editing):
 * - Read-modify-write of the whole Flexible Content array
 *   (an ACF REST requirement: the field value is sent whole)
 * - Authentication with Application Passwords (WP >= 5.6, Basic auth)
 *
 * Requirements on the source WordPress:
 * 1. ACF >= 5.11 with "Show in REST API" enabled on the field groups
 * 2. An Application Password for the editor user
 * 3. (Recommended) Flexible Content as the page block model
 */
export class WordPressAdapter extends IntiAdapter<WordPressPost> implements WritableAdapter, ListableAdapter, DraftableAdapter {
    readonly writable = true as const;

    private introspection: WordPressIntrospection;

    constructor(config: WordPressConfig) {
        super('WordPress', config);
        this.introspection = new WordPressIntrospection(config);
    }

    private get wpConfig(): WordPressConfig {
        return this.config as WordPressConfig;
    }

    /** Base URL of the REST collection (e.g. https://cms.x.com/wp-json/wp/v2/pages) */
    private get restBase(): string {
        const endpoint = this.wpConfig.endpoint.replace(/\/$/, '');
        const postType = this.wpConfig.postType || 'pages';
        return `${endpoint}/wp-json/wp/v2/${postType}`;
    }

    private get blocksField(): string {
        return this.wpConfig.blocksField || 'content_blocks';
    }

    /** Headers for write operations (Basic auth with an Application Password) */
    private authHeaders(): Record<string, string> {
        const { username, appPassword } = this.wpConfig;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        if (username && appPassword) {
            // Application Passwords are shown with spaces; WP accepts them with or without
            headers['Authorization'] = `Basic ${toBase64(`${username}:${appPassword.replace(/\s+/g, '')}`)}`;
        }

        return headers;
    }

    // ============================================
    // Page Parsing (Agnostic Contract)
    // ============================================

    parsePage(raw: WordPressPost): IntiPage {
        try {
            if (!raw || typeof raw.id === 'undefined') {
                throw new Error('Invalid WordPress payload: missing post id');
            }

            const acf = raw.acf || {};
            const rawBlocks = acf[this.blocksField];
            const mode = this.wpConfig.mode || 'auto';

            let blocks: IntiBlock[];
            if (mode !== 'gutenberg' && Array.isArray(rawBlocks)) {
                // ACF Flexible Content
                blocks = rawBlocks.map((layout, index) => this.parseFlexibleLayout(layout, raw, index, rawBlocks.length));
            } else if (mode !== 'acf') {
                // Gutenberg (auto-fallback or explicit mode)
                blocks = this.parseGutenbergContent(raw);
            } else {
                blocks = [];
            }

            return {
                id: String(raw.id),
                slug: raw.slug || `page-${raw.id}`,
                title: raw.title?.rendered || 'Untitled',
                blocks,
                // Yoast, RankMath, AIOSEO or SEOPress if present; ACF otherwise
                seo: extractWordPressSeo(raw, acf),
                meta: {
                    contentType: raw.type || this.wpConfig.postType || 'pages',
                    documentId: String(raw.id),
                    updatedAt: raw.modified
                }
            };
        } catch (error) {
            console.error(`[${this.name}Adapter] Resilient Fallback used due to error:`, error instanceof Error ? error.message : error);

            return {
                id: 'error-id',
                slug: 'error-slug',
                title: 'Inti System Fallback',
                blocks: []
            };
        }
    }

    /**
     * Converts an ACF Flexible Content layout into an IntiBlock.
     * `acf_fc_layout` determines the type; the rest of the keys are the data.
     */
    private parseFlexibleLayout(layout: Record<string, any>, post: WordPressPost, index: number, total: number): IntiBlock {
        const { acf_fc_layout, ...data } = layout;
        const layoutName = acf_fc_layout || 'unknown';

        const type = this.wpConfig.blockTypeMap?.[layoutName] || toPascalCase(layoutName);

        return {
            type,
            // Flexible Content layouts have no ID of their own: the index is the identity
            id: `${post.id}-${this.blocksField}-${index}`,
            data,
            meta: {
                documentId: String(post.id),
                contentType: post.type || this.wpConfig.postType || 'pages',
                label: layoutName,
                index,
                total
            }
        };
    }

    /**
     * Parses the post's Gutenberg blocks.
     *
     * Block comments only exist in content.raw (auth +
     * context=edit). Without raw, the whole rendered content is exposed
     * as a single 'RichText' block (renderable but not editable
     * per block).
     */
    private parseGutenbergContent(post: WordPressPost): IntiBlock[] {
        const rawContent = (post.content as any)?.raw;

        if (typeof rawContent === 'string' && rawContent.includes('<!-- wp:')) {
            const gutenbergBlocks = parseGutenberg(rawContent);

            return gutenbergBlocks.map((block, index) => {
                const text = extractText(block);
                return {
                    type: gutenbergNameToType(block.name),
                    id: `${post.id}-gutenberg-${index}`,
                    data: {
                        attrs: block.attrs,
                        html: block.innerHTML,
                        // `text` enables the inline editor's auto-bind
                        // (and is the only writable field in Gutenberg mode)
                        ...(text !== null ? { text } : {})
                    },
                    meta: {
                        documentId: String(post.id),
                        contentType: post.type || this.wpConfig.postType || 'pages',
                        label: `gutenberg:${block.name}`,
                        index,
                        total: gutenbergBlocks.length
                    }
                };
            });
        }

        // No raw: a single block with the rendered HTML
        const rendered = post.content?.rendered;
        if (!rendered) return [];

        return [{
            type: 'RichText',
            id: `${post.id}-content`,
            data: { html: rendered },
            meta: {
                documentId: String(post.id),
                contentType: post.type || this.wpConfig.postType || 'pages',
                label: 'gutenberg:rendered',
                index: 0,
                total: 1
            }
        }];
    }

    parseNavigation(_raw: any): IntiNavigation {
        // WP menus are not in wp/v2 core (they require a plugin).
        // To be solved in a later phase of the adapter.
        return { items: [] };
    }

    // ============================================
    // Data Fetching
    // ============================================

    /** Are there credentials to request context=edit (needed for content.raw)? */
    private get hasCredentials(): boolean {
        return !!(this.wpConfig.username && this.wpConfig.appPassword);
    }

    async fetchPageBySlug(slug: string): Promise<IntiPage> {
        // With credentials we request context=edit to get content.raw
        // (essential for per-block editing in Gutenberg mode)
        const editContext = this.hasCredentials ? '&context=edit' : '';
        const url = `${this.restBase}?slug=${encodeURIComponent(slug)}&acf_format=standard${editContext}`;
        const response = await fetchWithRetry(url, { headers: this.authHeaders() });

        if (!response.ok) {
            throw new Error(`Failed to fetch page: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const post = Array.isArray(data) ? data[0] : data;

        if (!post) {
            throw new Error(`Page not found for slug: ${slug}`);
        }

        return this.parsePage(post);
    }

    async fetchAllPages(): Promise<IntiPage[]> {
        const editContext = this.hasCredentials ? '&context=edit' : '';
        const url = `${this.restBase}?per_page=100&acf_format=standard${editContext}`;
        const response = await fetchWithRetry(url, { headers: this.authHeaders() });

        if (!response.ok) {
            throw new Error(`Failed to fetch pages: ${response.status} ${response.statusText}`);
        }

        const posts: WordPressPost[] = await response.json();
        return posts.map(post => this.parsePage(post));
    }

    /**
     * Lists the published pages for the sitemap.
     *
     * It only requests the needed fields (`_fields`), so it is much
     * cheaper than fetching every page's full blocks.
     */
    async listPages(): Promise<PageSummary[]> {
        const summaries: PageSummary[] = [];
        let page = 1;

        // WP paginates at 100; walk until exhausted
        while (page <= 50) {
            const url = `${this.restBase}?per_page=100&page=${page}&status=publish&_fields=slug,modified_gmt,title`;
            const response = await fetchWithRetry(url, { headers: this.authHeaders() });

            if (!response.ok) {
                // Requesting a page that does not exist returns 400: end of the walk
                if (response.status === 400 && page > 1) break;
                throw new Error(`Failed to list pages: ${response.status} ${response.statusText}`);
            }

            const batch: Array<{ slug: string; modified_gmt?: string; title?: { rendered?: string } }> =
                await response.json();

            if (!Array.isArray(batch) || batch.length === 0) break;

            for (const post of batch) {
                summaries.push({
                    slug: post.slug,
                    // modified_gmt comes without a zone; mark it as UTC
                    updatedAt: post.modified_gmt ? `${post.modified_gmt}Z` : undefined,
                    title: post.title?.rendered
                });
            }

            if (batch.length < 100) break;
            page++;
        }

        return summaries;
    }

    /** Gets the raw post (with ACF) — basis of the read-modify-write */
    private async fetchRawPost(documentId: string): Promise<WordPressPost> {
        // `light` avoids formatting what it can, but inside a Flexible
        // Content it still arrives expanded: `pushAcf` takes care of that
        const url = `${this.restBase}/${documentId}?acf_format=light&context=edit`;
        let response = await fetchWithRetry(url, { headers: this.authHeaders() });

        // context=edit requires auth; if it fails (e.g. read permissions), retry with context=view
        if (!response.ok && response.status === 401) {
            response = await fetchWithRetry(`${this.restBase}/${documentId}?acf_format=light`, {
                headers: this.authHeaders()
            });
        }

        if (!response.ok) {
            throw new Error(`Failed to fetch post ${documentId}: ${response.status} ${response.statusText}`);
        }

        return response.json();
    }

    // ============================================
    // Write-Back (Inline Editing)
    // ============================================

    /**
     * Updates a field of a block (a Flexible Content layout).
     *
     * ACF REST requires the FULL value of the Flexible Content field,
     * so the flow is read-modify-write:
     * 1. GET the post with its current ACF array
     * 2. Patch the field inside the `blockIndex` layout (supports dot-paths)
     * 3. POST the whole array back (layouts keep acf_fc_layout)
     *
     * With blockIndex === -1 a page-level ACF field is updated.
     */
    async updateBlockField(documentId: string, blockIndex: number, field: string, value: any): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            // Atomic patch via the companion plugin (if installed)
            const bridged = await this.tryBridgePatch(documentId, blockIndex, field, value);
            if (bridged) return bridged;

            const post = await this.fetchRawPost(documentId);

            // Gutenberg mode: the content lives in post_content, not in ACF
            const mode = this.wpConfig.mode || 'auto';
            const usesAcf = Array.isArray(post.acf?.[this.blocksField]);
            if (blockIndex >= 0 && (mode === 'gutenberg' || (mode === 'auto' && !usesAcf))) {
                return await this.updateGutenbergText(post, documentId, blockIndex, field, value);
            }

            const acf = { ...(post.acf || {}) };

            if (blockIndex === -1) {
                // Top-level ACF field of the page
                setByPath(acf, field, value);
            } else {
                const blocks = acf[this.blocksField];

                if (!Array.isArray(blocks)) {
                    throw new Error(`Field "${this.blocksField}" is not a Flexible Content array on post ${documentId}`);
                }
                if (blockIndex < 0 || blockIndex >= blocks.length) {
                    throw new Error(`Block index ${blockIndex} out of range (0-${blocks.length - 1})`);
                }

                // Clone the array and the target layout so the original is not mutated
                const patched = blocks.map((layout: Record<string, any>, i: number) =>
                    i === blockIndex ? JSON.parse(JSON.stringify(layout)) : layout
                );
                setByPath(patched[blockIndex], field, value);
                acf[this.blocksField] = patched;
            }

            return await this.pushAcf(documentId, acf, value);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] updateBlockField failed:`, message);
            return { success: false, documentId, error: message, source: 'wordpress' };
        }
    }

    /**
     * Replaces a block's whole data, preserving its acf_fc_layout
     */
    async updateBlock(documentId: string, blockIndex: number, data: Record<string, any>): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const post = await this.fetchRawPost(documentId);
            const acf = { ...(post.acf || {}) };
            const blocks = acf[this.blocksField];

            if (!Array.isArray(blocks) || blockIndex < 0 || blockIndex >= blocks.length) {
                throw new Error(`Block index ${blockIndex} out of range on post ${documentId}`);
            }

            const layoutName = blocks[blockIndex]?.acf_fc_layout;
            const patched = [...blocks];
            patched[blockIndex] = { acf_fc_layout: layoutName, ...data };
            acf[this.blocksField] = patched;

            return await this.pushAcf(documentId, acf, data);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] updateBlock failed:`, message);
            return { success: false, documentId, error: message, source: 'wordpress' };
        }
    }

    /**
     * Text write-back in Gutenberg mode.
     *
     * Only the 'text' field is editable, and only in simple blocks
     * (one tag, no nested markup) — the rest is rejected with a clear
     * error so the post_content is not corrupted.
     */
    private async updateGutenbergText(post: WordPressPost, documentId: string, blockIndex: number, field: string, value: any): Promise<WriteResult> {
        if (field !== 'text') {
            throw new Error(
                `Gutenberg mode only supports inline editing of the "text" field ` +
                `(got "${field}"). Complex edits belong in the WordPress editor.`
            );
        }

        const rawContent = (post.content as any)?.raw;
        if (typeof rawContent !== 'string' || !rawContent.includes('<!-- wp:')) {
            throw new Error(
                `Post ${documentId} has no raw Gutenberg content available. ` +
                `Write credentials are required (context=edit).`
            );
        }

        const blocks = parseGutenberg(rawContent);

        if (blockIndex < 0 || blockIndex >= blocks.length) {
            throw new Error(`Block index ${blockIndex} out of range (0-${blocks.length - 1})`);
        }
        if (!isTextEditable(blocks[blockIndex])) {
            throw new Error(
                `Block "${blocks[blockIndex].name}" is too complex for inline editing. ` +
                `Edit it in the WordPress editor instead.`
            );
        }

        blocks[blockIndex] = patchBlockText(blocks[blockIndex], String(value));
        const serialized = serializeGutenberg(blocks);

        const response = await fetchWithRetry(`${this.restBase}/${documentId}`, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify({ content: serialized })
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`WordPress rejected the update: ${response.status} ${response.statusText} ${body.slice(0, 200)}`);
        }

        return { success: true, documentId, value, source: 'wordpress-gutenberg' };
    }

    // ============================================
    // Plugin Companion (inti-bridge)
    // ============================================

    /** Cache of the plugin feature-detect ('unknown' until the first attempt) */
    private bridgeAvailable: boolean | 'unknown' = 'unknown';

    /**
     * Tries the atomic patch via the inti-bridge companion plugin.
     *
     * The plugin runs ACF's `update_sub_field()` in PHP: a single call,
     * no round-trip of the whole array (removes the race condition of
     * concurrent edits). Returns null if the plugin is not installed
     * or is disabled by config → the caller uses the REST fallback.
     */
    private async tryBridgePatch(documentId: string, blockIndex: number, field: string, value: any): Promise<WriteResult | null> {
        const setting = this.wpConfig.useBridgePlugin ?? 'auto';
        if (setting === false) return null;
        if (setting === 'auto' && this.bridgeAvailable === false) return null;

        const endpoint = this.wpConfig.endpoint.replace(/\/$/, '');

        try {
            const response = await fetchWithRetry(`${endpoint}/wp-json/inti/v1/patch`, {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({
                    post_id: Number(documentId),
                    blocks_field: this.blocksField,
                    block_index: blockIndex,
                    field,
                    value
                })
            });

            if (response.status === 404) {
                // Plugin not installed: remember it and use the fallback
                this.bridgeAvailable = false;
                return null;
            }

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`inti-bridge rejected the patch: ${response.status} ${body.slice(0, 200)}`);
            }

            this.bridgeAvailable = true;
            return { success: true, documentId, value, source: 'wordpress-bridge' };
        } catch (error) {
            // Network or plugin error with useBridgePlugin=true: propagate as a failure
            if (setting === true) {
                const message = error instanceof Error ? error.message : String(error);
                return { success: false, documentId, error: message, source: 'wordpress-bridge' };
            }
            // In 'auto', any failure → silent fallback to the REST path
            this.bridgeAvailable = false;
            return null;
        }
    }

    /**
     * Moves a block (layout) to another position in the Flexible Content array.
     * Same read-modify-write as updateBlockField.
     */
    async moveBlock(documentId: string, fromIndex: number, toIndex: number): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const post = await this.fetchRawPost(documentId);
            const acf = { ...(post.acf || {}) };
            const blocks = acf[this.blocksField];

            if (!Array.isArray(blocks)) {
                throw new Error(`Field "${this.blocksField}" is not a Flexible Content array on post ${documentId}`);
            }
            if (fromIndex < 0 || fromIndex >= blocks.length || toIndex < 0 || toIndex >= blocks.length) {
                throw new Error(`Move indexes out of range (0-${blocks.length - 1})`);
            }

            const patched = [...blocks];
            const [moved] = patched.splice(fromIndex, 1);
            patched.splice(toIndex, 0, moved);
            acf[this.blocksField] = patched;

            return await this.pushAcf(documentId, acf, { fromIndex, toIndex });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] moveBlock failed:`, message);
            return { success: false, documentId, error: message, source: 'wordpress' };
        }
    }

    // ============================================
    // Block Composition (builder)
    // ============================================

    /**
     * Inserts a new Flexible Content layout at the given position.
     * `nativeType` is the layout name (acf_fc_layout).
     * Not supported in Gutenberg mode (there is no block template).
     */
    async insertBlock(documentId: string, index: number, nativeType: string, data: Record<string, any> = {}): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const post = await this.fetchRawPost(documentId);
            const acf = { ...(post.acf || {}) };
            const blocks = acf[this.blocksField];

            if (!Array.isArray(blocks)) {
                throw new Error(
                    `Field "${this.blocksField}" is not a Flexible Content array on post ${documentId}. ` +
                    `Inserting blocks is only supported in ACF mode.`
                );
            }

            const clamped = Math.max(0, Math.min(index, blocks.length));
            const patched = [...blocks];
            patched.splice(clamped, 0, { acf_fc_layout: nativeType, ...data });
            acf[this.blocksField] = patched;

            return await this.pushAcf(documentId, acf, { nativeType, index: clamped });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] insertBlock failed:`, message);
            return { success: false, documentId, error: message, source: 'wordpress' };
        }
    }

    /**
     * Inserts several blocks in a single POST. A pattern goes in whole or
     * not at all: without this, a failure halfway leaves the published page
     * with half a pattern.
     */
    async insertBlocks(
        documentId: string,
        index: number,
        newBlocks: Array<{ nativeType: string; data?: Record<string, any> }>
    ): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            if (newBlocks.length === 0) {
                return { success: true, documentId, source: 'wordpress' };
            }

            const post = await this.fetchRawPost(documentId);
            const acf = { ...(post.acf || {}) };
            const blocks = acf[this.blocksField];

            if (!Array.isArray(blocks)) {
                throw new Error(
                    `Field "${this.blocksField}" is not a Flexible Content array on post ${documentId}. ` +
                    `Inserting blocks is only supported in ACF mode.`
                );
            }

            const clamped = Math.max(0, Math.min(index, blocks.length));
            const patched = [...blocks];
            patched.splice(
                clamped,
                0,
                ...newBlocks.map((block) => ({ acf_fc_layout: block.nativeType, ...(block.data ?? {}) }))
            );
            acf[this.blocksField] = patched;

            return await this.pushAcf(documentId, acf, {
                nativeType: newBlocks[0].nativeType,
                index: clamped
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] insertBlocks failed:`, message);
            return { success: false, documentId, error: message, source: 'wordpress' };
        }
    }

    /**
     * Removes the block at the given position.
     * Works in ACF and in Gutenberg mode (splice of parsed blocks).
     */
    async removeBlock(documentId: string, index: number): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const post = await this.fetchRawPost(documentId);
            const blocks = post.acf?.[this.blocksField];

            if (Array.isArray(blocks)) {
                if (index < 0 || index >= blocks.length) {
                    throw new Error(`Block index ${index} out of range (0-${blocks.length - 1})`);
                }
                const acf = { ...(post.acf || {}) };
                const patched = [...blocks];
                patched.splice(index, 1);
                acf[this.blocksField] = patched;
                return await this.pushAcf(documentId, acf, { removed: index });
            }

            return await this.spliceGutenberg(post, documentId, (parsed) => {
                if (index < 0 || index >= parsed.length) {
                    throw new Error(`Block index ${index} out of range (0-${parsed.length - 1})`);
                }
                parsed.splice(index, 1);
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] removeBlock failed:`, message);
            return { success: false, documentId, error: message, source: 'wordpress' };
        }
    }

    /**
     * Duplicates the block at the given position (it lands right after the original).
     */
    async duplicateBlock(documentId: string, index: number): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const post = await this.fetchRawPost(documentId);
            const blocks = post.acf?.[this.blocksField];

            if (Array.isArray(blocks)) {
                if (index < 0 || index >= blocks.length) {
                    throw new Error(`Block index ${index} out of range (0-${blocks.length - 1})`);
                }
                const acf = { ...(post.acf || {}) };
                const patched = [...blocks];
                patched.splice(index + 1, 0, JSON.parse(JSON.stringify(blocks[index])));
                acf[this.blocksField] = patched;
                return await this.pushAcf(documentId, acf, { duplicated: index });
            }

            return await this.spliceGutenberg(post, documentId, (parsed) => {
                if (index < 0 || index >= parsed.length) {
                    throw new Error(`Block index ${index} out of range (0-${parsed.length - 1})`);
                }
                parsed.splice(index + 1, 0, { ...parsed[index] });
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] duplicateBlock failed:`, message);
            return { success: false, documentId, error: message, source: 'wordpress' };
        }
    }

    /** Mutates the Gutenberg block list and persists the serialized content */
    private async spliceGutenberg(
        post: WordPressPost,
        documentId: string,
        mutate: (blocks: ReturnType<typeof parseGutenberg>) => void
    ): Promise<WriteResult> {
        const rawContent = (post.content as any)?.raw;
        if (typeof rawContent !== 'string' || !rawContent.includes('<!-- wp:')) {
            throw new Error(`Post ${documentId} has no raw Gutenberg content available (context=edit requires credentials)`);
        }

        const parsed = parseGutenberg(rawContent);
        mutate(parsed);

        const response = await fetchWithRetry(`${this.restBase}/${documentId}`, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify({ content: serializeGutenberg(parsed) })
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`WordPress rejected the update: ${response.status} ${response.statusText} ${body.slice(0, 200)}`);
        }

        return { success: true, documentId, source: 'wordpress-gutenberg' };
    }

    // ============================================
    // Drafts
    // ============================================
    //
    // The working copy is a WordPress page with status `draft`, so the client
    // sees it in wp-admin and publishing leaves a trail in its revisions. It is
    // recognized by its slug: it needs no plugin or registered meta on the site.

    /** Returns the post with that slug and status, or null */
    private async findBySlug(slug: string, status: string): Promise<WordPressPost | null> {
        const params = `slug=${encodeURIComponent(slug)}&status=${status}&acf_format=standard&context=edit`;
        const response = await fetchWithRetry(`${this.restBase}?${params}`, { headers: this.authHeaders() });
        if (!response.ok) {
            throw new Error(`Failed to fetch "${slug}": ${response.status} ${response.statusText}`);
        }
        const posts: WordPressPost[] = await response.json();
        return posts[0] ?? null;
    }

    private async fetchPostById(id: string | number, query = 'acf_format=standard&context=edit'): Promise<WordPressPost> {
        const response = await fetchWithRetry(`${this.restBase}/${id}?${query}`, { headers: this.authHeaders() });
        if (!response.ok) {
            throw new Error(`Failed to fetch post ${id}: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }

    async fetchDraftBySlug(slug: string): Promise<IntiPage | null> {
        this.assertWriteCredentials();

        const published = await this.findBySlug(slug, 'publish');
        const draft = published
            ? await this.findBySlug(`${DRAFT_SLUG_PREFIX}${published.id}`, 'draft')
            // A page that has never been published yet is its own draft
            : await this.findBySlug(slug, 'draft');

        return draft ? { ...this.parsePage(draft), slug } : null;
    }

    async createDraft(documentId: string): Promise<DraftResult> {
        try {
            this.assertWriteCredentials();

            const original = await this.fetchRawPost(documentId);
            const slug = `${DRAFT_SLUG_PREFIX}${original.id}`;

            // One already existed: keep working on it instead of overwriting what it holds
            const existing = await this.findBySlug(slug, 'draft');
            if (existing) {
                return { success: true, documentId: String(existing.id), slug: original.slug, source: 'wordpress' };
            }

            const schema = await this.fetchAcfSchema(documentId);
            const response = await fetchWithRetry(this.restBase, {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({
                    status: 'draft',
                    slug,
                    title: original.title?.raw ?? original.title?.rendered,
                    content: (original.content as any)?.raw ?? '',
                    acf: normalizeAcfForWrite(original.acf ?? {}, schema)
                })
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`WordPress rejected the draft: ${response.status} ${body.slice(0, 200)}`);
            }

            const created: WordPressPost = await response.json();
            return { success: true, documentId: String(created.id), slug: original.slug, source: 'wordpress' };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, documentId, error: message, source: 'wordpress' };
        }
    }

    async publishDraft(draftId: string): Promise<DraftResult> {
        try {
            this.assertWriteCredentials();

            const draft = await this.fetchRawPost(draftId);
            const originalId = draft.slug?.startsWith(DRAFT_SLUG_PREFIX)
                ? draft.slug.slice(DRAFT_SLUG_PREFIX.length)
                : null;

            // No original: a new page, which is published as is
            if (!originalId) {
                const response = await fetchWithRetry(`${this.restBase}/${draftId}`, {
                    method: 'POST',
                    headers: this.authHeaders(),
                    body: JSON.stringify({ status: 'publish' })
                });
                if (!response.ok) {
                    const body = await response.text().catch(() => '');
                    throw new Error(`WordPress rejected the publish: ${response.status} ${body.slice(0, 200)}`);
                }
                return { success: true, documentId: draftId, slug: draft.slug, source: 'wordpress' };
            }

            const schema = await this.fetchAcfSchema(draftId);
            const response = await fetchWithRetry(`${this.restBase}/${originalId}`, {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({
                    title: draft.title?.raw ?? draft.title?.rendered,
                    content: (draft.content as any)?.raw ?? '',
                    acf: normalizeAcfForWrite(draft.acf ?? {}, schema)
                })
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`WordPress rejected the publish: ${response.status} ${body.slice(0, 200)}`);
            }

            const published: WordPressPost = await response.json();
            await this.trashPost(draftId);
            return { success: true, documentId: originalId, slug: published.slug, source: 'wordpress' };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, documentId: draftId, error: message, source: 'wordpress' };
        }
    }

    async discardDraft(draftId: string): Promise<DraftResult> {
        try {
            this.assertWriteCredentials();

            const draft = await this.fetchPostById(draftId);
            // Never take down a published page because of a wrong id
            if (draft.status !== 'draft') {
                throw new Error(`Post ${draftId} is not a draft (status: ${draft.status})`);
            }
            await this.trashPost(draftId);
            return { success: true, documentId: draftId, source: 'wordpress' };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, documentId: draftId, error: message, source: 'wordpress' };
        }
    }

    /** To the trash, not a permanent delete: it can be recovered from wp-admin */
    private async trashPost(id: string): Promise<void> {
        const response = await fetchWithRetry(`${this.restBase}/${id}`, { method: 'DELETE', headers: this.authHeaders() });
        if (!response.ok) {
            throw new Error(`Failed to trash post ${id}: ${response.status} ${response.statusText}`);
        }
    }

    /**
     * Searches a collection's entries (REST post type) for the relation
     * picker. `collection` is the rest_base ('posts', 'pages', CPTs).
     */
    async searchEntries(collection: string, query: string): Promise<Array<{ id: string; title: string; subtitle?: string }>> {
        const endpoint = this.wpConfig.endpoint.replace(/\/$/, '');
        const params = new URLSearchParams({ per_page: '10', search: query });
        const url = `${endpoint}/wp-json/wp/v2/${collection}?${params}`;

        const response = await fetchWithRetry(url, { headers: this.authHeaders() });

        if (!response.ok) {
            throw new Error(`Failed to search "${collection}": ${response.status} ${response.statusText}`);
        }

        const posts: WordPressPost[] = await response.json();

        return posts.map(post => ({
            id: String(post.id),
            title: post.title?.rendered || `#${post.id}`,
            subtitle: post.slug
        }));
    }

    /** REST schema of the `acf` object. It is the same for every post of the type */
    private acfSchema?: Promise<RestSchema | undefined>;

    private fetchAcfSchema(documentId: string): Promise<RestSchema | undefined> {
        this.acfSchema ??= fetch(`${this.restBase}/${documentId}`, { method: 'OPTIONS', headers: this.authHeaders() })
            .then(async (response) => {
                if (!response.ok) return undefined;
                const body = await response.json();
                return body?.schema?.properties?.acf as RestSchema | undefined;
            })
            .catch(() => undefined);
        return this.acfSchema;
    }

    /** POSTs the whole acf object to the post's endpoint */
    private async pushAcf(documentId: string, acf: Record<string, any>, value: any): Promise<WriteResult> {
        const schema = await this.fetchAcfSchema(documentId);

        const response = await fetchWithRetry(`${this.restBase}/${documentId}`, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify({ acf: normalizeAcfForWrite(acf, schema) })
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`WordPress rejected the update: ${response.status} ${response.statusText} ${body.slice(0, 200)}`);
        }

        return { success: true, documentId, value, source: 'wordpress' };
    }

    private assertWriteCredentials(): void {
        const { username, appPassword } = this.wpConfig;
        if (!username || !appPassword) {
            throw new Error(
                'Write-back requires WordPress credentials. ' +
                'Set username + appPassword (Application Password, WP >= 5.6) in the adapter config. ' +
                'These must only live on the server (env vars), never in client code.'
            );
        }
    }

    // ============================================
    // Introspection
    // ============================================

    async introspect(): Promise<SchemaDefinition> {
        const result = await this.introspection.introspect();

        if (!result.success) {
            console.error(`[${this.name}Adapter] Introspection failed:`, result.error);
        } else {
            console.log(`[${this.name}Adapter] Introspection successful from: ${result.source}`);
        }

        return result.schema;
    }

    async introspectDetailed(): Promise<IntrospectionResult> {
        return this.introspection.introspect();
    }

    async introspectFresh(): Promise<SchemaDefinition> {
        const result = await this.introspection.introspectFresh();
        return result.schema;
    }
}

// ============================================
// WordPress-Specific Introspection
// ============================================

/**
 * WordPress does not expose the ACF schema over REST natively,
 * so introspection combines two sources:
 * 1. `/wp-json/wp/v2/types` — registered post types
 * 2. One sample post per type — ACF fields inferred from the values
 */
class WordPressIntrospection extends IntrospectionAdapter {
    private wpConfig: WordPressConfig;

    constructor(config: WordPressConfig) {
        super('WordPress', config);
        this.wpConfig = config;
    }

    private get endpoint(): string {
        return this.wpConfig.endpoint.replace(/\/$/, '');
    }

    protected async fetchRawSchema(): Promise<any> {
        const typesUrl = `${this.endpoint}/wp-json/wp/v2/types`;
        const response = await this.fetchWithTimeout(typesUrl, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`Types endpoint returned ${response.status}: ${response.statusText}`);
        }

        const types = await response.json();
        const wanted = this.wpConfig.collections || ['page', 'post'];
        const samples: Record<string, any> = {};

        // One sample post per type to infer the ACF fields
        for (const [typeName, typeInfo] of Object.entries<any>(types)) {
            if (!wanted.includes(typeName)) continue;

            const restBase = typeInfo.rest_base || typeName;
            try {
                const sampleResponse = await this.fetchWithTimeout(
                    `${this.endpoint}/wp-json/wp/v2/${restBase}?per_page=1&acf_format=standard`,
                    { headers: { 'Content-Type': 'application/json' } }
                );
                if (sampleResponse.ok) {
                    const items = await sampleResponse.json();
                    samples[typeName] = { restBase, sample: Array.isArray(items) ? items[0] : items };
                }
            } catch {
                // No sample: the collection is emitted with base fields only
                samples[typeName] = { restBase, sample: null };
            }
        }

        return { types: wanted, samples };
    }

    protected transformSchema(rawSchema: any): SchemaDefinition {
        const collections: SchemaCollection[] = [];

        for (const typeName of rawSchema.types || []) {
            const entry = rawSchema.samples?.[typeName];
            const fields: SchemaField[] = [
                { name: 'id', type: 'string', required: true },
                { name: 'slug', type: 'string', required: true },
                { name: 'title', type: 'string', required: true },
                { name: 'content', type: 'richtext', required: false }
            ];

            // Infer ACF fields from the sample post
            const acf = entry?.sample?.acf;
            if (acf && typeof acf === 'object') {
                for (const [fieldName, value] of Object.entries(acf)) {
                    fields.push({
                        name: fieldName,
                        type: this.inferFieldType(fieldName, value),
                        required: false,
                        description: `ACF field (inferred from sample)`
                    });
                }
            }

            collections.push({
                name: toPascalCase(typeName),
                fields,
                description: `WordPress "${typeName}" post type`,
                timestamps: true
            });
        }

        collections.push(...this.layoutCollections(rawSchema));

        return {
            source: 'WordPress',
            version: '1.0.0',
            collections
        };
    }

    /**
     * One collection per Flexible Content layout seen in the samples.
     *
     * This is what lets a page's blocks be typed: `blockType` is the
     * same `type` that `parsePage` assigns (honoring `blockTypeMap`). The
     * fields are inferred from the values, like the page's, so a layout
     * that does not appear in any sample is not described.
     * If two samples bring the same layout, their fields are merged.
     */
    private layoutCollections(rawSchema: any): SchemaCollection[] {
        const layouts = new Map<string, Map<string, SchemaField>>();

        for (const entry of Object.values<any>(rawSchema.samples ?? {})) {
            const acf = entry?.sample?.acf;
            if (!acf || typeof acf !== 'object') continue;

            for (const value of Object.values(acf)) {
                if (!Array.isArray(value)) continue;

                for (const layout of value) {
                    const layoutName = layout?.acf_fc_layout;
                    if (typeof layoutName !== 'string' || !layoutName) continue;

                    const fields = layouts.get(layoutName) ?? new Map<string, SchemaField>();
                    for (const [fieldName, fieldValue] of Object.entries(layout)) {
                        if (fieldName === 'acf_fc_layout' || fields.has(fieldName)) continue;
                        fields.set(fieldName, {
                            name: fieldName,
                            type: this.inferFieldType(fieldName, fieldValue),
                            required: false
                        });
                    }
                    layouts.set(layoutName, fields);
                }
            }
        }

        return [...layouts.entries()].map(([layoutName, fields]) => {
            const blockType = this.wpConfig.blockTypeMap?.[layoutName] || toPascalCase(layoutName);
            return {
                // Suffix so it does not clash with a post type of the same name
                name: `${toPascalCase(layoutName)}Block`,
                blockType,
                description: `Flexible Content layout "${layoutName}" (inferred from sample)`,
                fields: [...fields.values()]
            };
        });
    }

    /** Infers the Inti type from the sample ACF value */
    private inferFieldType(name: string, value: any): FieldType {
        if (Array.isArray(value)) {
            // Array of layouts with acf_fc_layout = Flexible Content = blocks
            if (value.length > 0 && value[0]?.acf_fc_layout) return 'blocks';
            return 'json';
        }
        if (value === null || value === undefined) return 'string';

        switch (typeof value) {
            case 'number': return 'number';
            case 'boolean': return 'boolean';
            case 'object':
                // ACF image fields return an object with url/sizes
                if (value.url || value.sizes) return 'media';
                return 'json';
            default: {
                const str = String(value);
                if (/^\d{4}-\d{2}-\d{2}/.test(str)) return 'date';
                if (/<[a-z][\s\S]*>/i.test(str)) return 'richtext';
                if (name.includes('image') || name.includes('media')) return 'media';
                return str.length > 200 ? 'text' : 'string';
            }
        }
    }

    protected getMockSchema(): SchemaDefinition {
        return {
            source: 'WordPress',
            version: '1.0.0-mock',
            collections: [
                {
                    name: 'Page',
                    description: 'WordPress pages with ACF Flexible Content blocks',
                    timestamps: true,
                    fields: [
                        { name: 'id', type: 'string', required: true },
                        { name: 'slug', type: 'string', required: true },
                        { name: 'title', type: 'string', required: true },
                        { name: 'content_blocks', type: 'blocks', required: false, description: 'ACF Flexible Content' },
                        { name: 'seo_description', type: 'text', required: false },
                        { name: 'seo_image', type: 'media', required: false }
                    ]
                },
                {
                    name: 'Post',
                    description: 'WordPress blog posts',
                    timestamps: true,
                    fields: [
                        { name: 'id', type: 'string', required: true },
                        { name: 'slug', type: 'string', required: true },
                        { name: 'title', type: 'string', required: true },
                        { name: 'content', type: 'richtext', required: true },
                        { name: 'excerpt', type: 'text', required: false },
                        { name: 'featured_image', type: 'media', required: false }
                    ]
                }
            ]
        };
    }
}

export default WordPressAdapter;

// WooCommerce: only translation to JSON-LD. Products are edited in
// wp-admin; this exists so they render with rich results.
export {
    productFromWooCommerce,
    mapStockStatus,
    isIndexableProduct,
    wooProductsAsData
} from './woocommerce.js';
export type { WooDataItem, WooProduct, WooVariation, WooMappingOptions } from './woocommerce.js';
