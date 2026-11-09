import { IntiAdapter } from '@intijs/core/adapters';
import type {
    EntrySummary,
    FieldType,
    ListableAdapter,
    PageSummary,
    SchemaCollection,
    SchemaDefinition,
    SchemaField,
    SearchableAdapter,
    WritableAdapter,
    DraftableAdapter,
    DraftResult,
    WriteResult
} from '@intijs/core/adapters';
import type { IntiBlock, IntiNavigation, IntiPage } from '@intijs/core/types';
import type { GeneratorBlockType } from '@intijs/core/plugins';

import { extractKitsudenSeo } from './seo.js';
import type {
    KitsudenBlockRow,
    KitsudenBlockType,
    KitsudenConfig,
    KitsudenGameBlockRow,
    KitsudenGameEditorial,
    KitsudenGameEditorialResponse,
    KitsudenGameResponse,
    KitsudenPageListResponse,
    KitsudenPageResponse,
    KitsudenSchemaField,
    KitsudenVersionResponse,
    MediaPreset
} from './types.js';

export type {
    KitsudenBlockRow,
    KitsudenBlockType,
    KitsudenConfig,
    KitsudenGameBlockRow,
    KitsudenGameEditorial,
    KitsudenGameEditorialResponse,
    KitsudenGameResponse,
    KitsudenPageListResponse,
    KitsudenPageResponse,
    KitsudenPageStatus,
    KitsudenPageSummary,
    KitsudenSchemaField,
    KitsudenVersionResponse,
    MediaPreset
} from './types.js';
export { extractKitsudenSeo } from './seo.js';

const SOURCE = 'kitsuden';
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PALETTE_TTL_MS = 5 * 60 * 1000;

/** Prefix of a game page's `documentId`: `game:<uuid>` */
export const GAME_PREFIX = 'game:';
/** The only `data` fields that are edited on a game block: they go to its editorial layer */
const EDITORIAL_FIELDS = new Set(['title', 'description']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GAME_BLOCK_INSERT_ERROR =
    'game blocks cannot be created from the editor: the loader generates them';

// ============================================
// Compatibility with the API (contracts)
// ============================================

/** Version of this package (the one in its package.json; a test watches it) */
export const ADAPTER_VERSION = '0.1.0';

/** Slug of a page's working copy: `inti-draft-of-<uuid>` */
const DRAFT_PREFIX = 'inti-draft-of-';

/**
 * MAJOR versions of each Kitsuden contract this version of the adapter understands, as
 * `[min, max]`. Kitsuden publishes them in `GET /api/version` (`contracts`). Policy and
 * compatibility matrix: docs → Adapters → Kitsuden, and `docs/install/versions.md` in Kitsuden.
 *
 * `games` and `games-editorial` are v2 since Kitsuden 0.9: the block and editorial keys are
 * English (`title`, `description`, `hidden`, `order`) and the editorial routes live under
 * `/blocks/`. This adapter does not write to a v1 (0.8) Kitsuden.
 */
export const SUPPORTED_CONTRACTS = {
    'page-builder': [1, 1],
    games: [2, 2],
    'games-editorial': [2, 2]
} as const satisfies Record<string, readonly [number, number]>;

export type KitsudenContract = keyof typeof SUPPORTED_CONTRACTS;

/**
 * The Kitsuden kon that serves each contract. Since `/api/version` only announces the
 * contracts whose kon is mounted, a missing one almost always means that kon is turned off,
 * not that Kitsuden is old. It must match Kitsuden's `CONTRACT_KON`
 * (apps/api/src/routes/version.ts).
 */
export const CONTRACT_KON: Record<KitsudenContract, string> = {
    'page-builder': 'kon-blocks',
    games: 'kon-games',
    'games-editorial': 'kon-games'
};

/** Which contracts each kind of write uses */
const PAGE_CONTRACTS: KitsudenContract[] = ['page-builder'];
const GAME_CONTRACTS: KitsudenContract[] = ['games', 'games-editorial'];

/**
 * The API declares a contract this version of the adapter does not speak (or does not declare
 * one it needs). Thrown BEFORE anything is written.
 */
export class KitsudenIncompatibleError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KitsudenIncompatibleError';
    }
}

/**
 * A game page block, ready to render.
 *
 * `data` is what is rendered (with the editorial layer's `title`/`description` on top);
 * `original` is the loader's `data` untouched and `editorial` the layer as it is, so the editor
 * can show "loader text" versus "edited text" and offer to go back to the original.
 */
export interface KitsudenGameBlock extends IntiBlock {
    editorial?: KitsudenGameEditorial;
    original?: Record<string, any>;
}

/** Is this `documentId` a game page (`game:<uuid>`)? */
export function isGameDocument(documentId: unknown): documentId is string {
    return typeof documentId === 'string' && documentId.startsWith(GAME_PREFIX);
}

/**
 * Kitsuden CMS Adapter
 * Integrates Kitsuden (kon-blocks, the "Page Builder") with Inti.js
 *
 * What sets it apart from the other adapters:
 *
 * 1. Blocks are NOT an array inside the document. They are `block_contents` rows with their
 *    own uuid, and they are edited one by one (`PATCH /blocks/:id`). Inti addresses by
 *    position, so every write resolves position → uuid against a fresh read.
 *
 * 2. `GET /pages/:id` HIDES invisible blocks and those scheduled outside their window. The
 *    array Inti indexes is the same one that was rendered, which is exactly what makes the
 *    position mean something — but it forces a re-read before writing instead of remembering
 *    the order of the previous request.
 *
 * 3. Reordering does not renumber from 0 to n-1: it permutes the `sortOrder` the visible blocks
 *    already had. Renumbering would move the hidden ones, which share the same scale and are
 *    not visible from here.
 */
export class KitsudenAdapter
    extends IntiAdapter<KitsudenPageResponse, KitsudenPageListResponse>
    implements WritableAdapter, ListableAdapter, SearchableAdapter, DraftableAdapter
{
    readonly writable = true as const;

    protected kitsudenConfig: Required<Omit<KitsudenConfig, 'token'>> & { token?: string };

    private palette: { types: KitsudenBlockType[]; expiresAt: number } | null = null;

    /**
     * `GET /api/version`, requested ONCE and only when writing. `null` = the API does not
     * publish it (a Kitsuden older than the route): warned once and writing goes on. A network
     * failure or a 5xx is NOT remembered: it is retried on the next write, so a one-off stumble
     * does not turn the check off.
     */
    private apiVersion: Promise<KitsudenVersionResponse | null> | null = null;

    constructor(config: KitsudenConfig) {
        super('Kitsuden', config);

        if (!config?.endpoint || !/^https?:\/\//i.test(config.endpoint)) {
            throw new Error(
                '[KitsudenAdapter] `endpoint` has to be the absolute origin of the CMS, e.g. https://cms.example.com'
            );
        }

        this.kitsudenConfig = {
            mountPath: '/api/page-builder',
            gamesPath: '/api/games',
            status: 'published',
            mediaPreset: 'large',
            timeoutMs: 10_000,
            versionPath: '/api/version',
            checkCompatibility: true,
            // A key present but `undefined` (e.g. `INTI_KITSUDEN_MOUNT_PATH` not set) overrode
            // the default and the first write of a page blew up with "reading 'replace'".
            ...(Object.fromEntries(
                Object.entries(config).filter(([, value]) => value !== undefined)
            ) as typeof config)
        };
    }

    // ============================================
    // Reading
    // ============================================

    parsePage(raw: KitsudenPageResponse): IntiPage {
        if (!raw || typeof raw.id !== 'string') {
            throw new Error(
                '[KitsudenAdapter] Invalid page payload: expected the object returned by GET /pages/:idOrSlug'
            );
        }

        const rows = sortRows(Array.isArray(raw.blocks) ? raw.blocks : []);
        const documentId = String(raw.id);

        const blocks: IntiBlock[] = rows.map((row, index) => ({
            id: String(row.id),
            type: row.type,
            data: (row.content ?? {}) as Record<string, any>,
            meta: {
                documentId,
                contentType: 'page',
                // `label` is the block's NATIVE identifier, as in WordPress (acf_fc_layout): the
                // composer uses it as the type when it offers in the palette the blocks it sees
                // on the page. With the display name ("Cover") it inserted a type Kitsuden's
                // palette rejects.
                label: row.type,
                index,
                total: rows.length,
                // The row already carries these three fields and they did not leave the
                // adapter: a hidden block, or one scheduled for next week, rendered anyway and
                // ended up in the HTML, the structured data and the search engine.
                visible: row.isVisible !== false,
                visibleFrom: row.visibleFrom ?? undefined,
                visibleUntil: row.visibleUntil ?? undefined
            }
        }));

        return {
            id: documentId,
            slug: raw.slug,
            title: raw.title || 'Untitled',
            blocks,
            seo: extractKitsudenSeo(raw, {
                endpoint: this.kitsudenConfig.endpoint,
                mediaPreset: this.kitsudenConfig.mediaPreset as MediaPreset
            }),
            meta: {
                contentType: 'page',
                documentId,
                updatedAt: raw.updatedAt
            }
        };
    }

    /**
     * Kitsuden has no menus endpoint: navigation is derived from the list of pages. The home
     * page (`isHomepage`) hangs from `/`.
     */
    parseNavigation(raw: KitsudenPageListResponse): IntiNavigation {
        const docs = Array.isArray(raw?.docs) ? raw.docs : [];
        return {
            items: docs.map((page) => ({
                label: page.title,
                url: page.isHomepage ? '/' : `/${page.slug}`
            }))
        };
    }

    /**
     * Raw page by uuid or by slug (the API accepts both). With `auth`, drafts and hidden
     * blocks are seen too.
     */
    async fetchPage(idOrSlug: string, options: { auth?: boolean } = {}): Promise<KitsudenPageResponse> {
        return this.request<KitsudenPageResponse>(`/pages/${encodeURIComponent(idOrSlug)}`, { auth: options.auth });
    }

    /**
     * Normalized page, ready to render.
     *
     * With the `game:` prefix (`game:<uuid>` or `game:<slug>`) it returns the game page: see
     * `getGame`.
     */
    async getPage(idOrSlug: string): Promise<IntiPage> {
        if (isGameDocument(idOrSlug)) return this.getGame(idOrSlug.slice(GAME_PREFIX.length));
        return this.parsePage(await this.fetchPage(idOrSlug));
    }

    // ============================================
    // Game pages (`games.blocks`)
    // ============================================

    /**
     * Raw game by uuid (`GET /api/games/:id`) or by slug (`GET /api/games/slug/:slug`). Also
     * accepts `game:<…>`.
     *
     * By uuid there is no cache on the server, so it is the read used before writing.
     */
    async fetchGame(slugOrId: string, options: { auth?: boolean } = {}): Promise<KitsudenGameResponse> {
        const key = isGameDocument(slugOrId) ? slugOrId.slice(GAME_PREFIX.length) : slugOrId;
        if (!key) throw new Error('[KitsudenAdapter] getGame needs a slug or a uuid');

        const path = UUID.test(key) ? `/${encodeURIComponent(key)}` : `/slug/${encodeURIComponent(key)}`;

        return this.request<KitsudenGameResponse>(path, { base: 'games', auth: options.auth });
    }

    /** Normalized game page, with the blocks in their visible order */
    async getGame(slugOrId: string): Promise<IntiPage> {
        return this.parseGame(await this.fetchGame(slugOrId));
    }

    /**
     * The `IntiPage` of a game.
     *
     * Applies the editorial layer the same way the site does: skips the `hidden` ones, sorts by
     * `editorial.order ?? order`, and renders `editorial.title/description` on top of `data`.
     * Each block's index is its position in THAT list, the same one writes compute again.
     */
    parseGame(raw: KitsudenGameResponse): IntiPage {
        if (!raw || typeof raw.id !== 'string') {
            throw new Error(
                '[KitsudenAdapter] Invalid game payload: expected the object returned by GET /api/games/slug/:slug'
            );
        }

        const documentId = `${GAME_PREFIX}${raw.id}`;
        const visible = visibleGameBlocks(raw.blocks);

        const blocks: KitsudenGameBlock[] = visible.map((block, index) => {
            const original = (block.data ?? {}) as Record<string, any>;
            const editorial = editorialLayer(block.editorial);
            const data: Record<string, any> = { ...original };
            if (editorial.title !== undefined) data.title = editorial.title;
            if (editorial.description !== undefined) data.description = editorial.description;

            const result: KitsudenGameBlock = {
                id: typeof block.id === 'string' ? block.id : '',
                type: block.type,
                data,
                original,
                meta: {
                    documentId,
                    contentType: 'game',
                    label: block.type,
                    index,
                    total: visible.length
                }
            };
            if (Object.keys(editorial).length > 0) result.editorial = editorial;
            return result;
        });

        const description = raw.excerpt ?? raw.description ?? undefined;

        return {
            id: documentId,
            slug: raw.slug,
            title: raw.title || 'Untitled',
            blocks,
            seo: {
                title: raw.title || undefined,
                description: typeof description === 'string' && description ? description : undefined
            },
            meta: {
                contentType: 'game',
                documentId,
                updatedAt: raw.updatedAt
            }
        };
    }

    /**
     * Lists the published pages for the sitemap.
     * `updatedAt` comes from the CMS, so `<lastmod>` is real and not invented.
     */
    async listPages(): Promise<PageSummary[]> {
        const limit = 100;
        const summaries: PageSummary[] = [];

        for (let offset = 0; ; offset += limit) {
            const batch = await this.request<KitsudenPageListResponse>('/pages', {
                query: { status: this.kitsudenConfig.status, limit, offset }
            });

            const docs = Array.isArray(batch?.docs) ? batch.docs : [];
            for (const page of docs) {
                summaries.push({
                    slug: page.slug,
                    title: page.title,
                    updatedAt: page.updatedAt
                });
            }

            // `totalDocs` rules; stopping on a short batch is the safety net
            if (docs.length < limit || summaries.length >= (batch?.totalDocs ?? 0)) break;
        }

        return summaries;
    }

    /**
     * Candidates for the relation picker. Only pages today: it is the only collection the blocks
     * kon exposes with text search.
     */
    async searchEntries(collection: string, query: string): Promise<EntrySummary[]> {
        if (collection !== 'pages' && collection !== 'page') {
            console.warn(
                `[${this.name}Adapter] searchEntries: unknown collection "${collection}" (only "pages" is exposed by the Page Builder API)`
            );
            return [];
        }

        const batch = await this.request<KitsudenPageListResponse>('/pages', {
            query: { status: this.kitsudenConfig.status, search: query, limit: 20 }
        });

        return (batch?.docs ?? []).map((page) => ({
            id: page.id,
            title: page.title,
            subtitle: page.isHomepage ? '/' : `/${page.slug}`
        }));
    }

    // ============================================
    // Introspection
    // ============================================

    /**
     * The schema comes from `GET /block-types`, the same palette the admin panel sees. That way
     * the generated SDK and the editor cannot disagree.
     */
    async introspect(): Promise<SchemaDefinition> {
        const types = await this.blockTypes();

        const collections: SchemaCollection[] = [
            {
                name: 'Page',
                description: 'Page of the page builder (block_pages)',
                timestamps: true,
                fields: [
                    { name: 'title', type: 'string', required: true },
                    { name: 'slug', type: 'string', required: true },
                    { name: 'description', type: 'text' },
                    { name: 'status', type: 'string', description: 'draft | published | archived' },
                    { name: 'metaTitle', type: 'string' },
                    { name: 'metaDescription', type: 'text' },
                    { name: 'ogImageId', type: 'media' },
                    { name: 'layout', type: 'string' },
                    { name: 'isHomepage', type: 'boolean' },
                    { name: 'requireAuth', type: 'boolean' },
                    { name: 'publishedAt', type: 'datetime' },
                    { name: 'blocks', type: 'blocks' }
                ]
            },
            ...types.map((type) => ({
                name: `${toPascal(type.type)}Block`,
                // The type as it is: it is the one parsePage assigns to each block
                blockType: type.type,
                description: type.description ?? type.name,
                fields: schemaFields(type.schema)
            }))
        ];

        return { source: SOURCE, version: 'page-builder/v1', collections };
    }

    /** Block palette, cached for a few minutes (inserts use it too) */
    async blockTypes(): Promise<KitsudenBlockType[]> {
        if (this.palette && this.palette.expiresAt > Date.now()) return this.palette.types;

        // Kitsuden returns it wrapped: `{ blockTypes: [...] }`. A bare array is accepted too, in
        // case a version of the kon changes it.
        const response = await this.request<KitsudenBlockType[] | { blockTypes?: KitsudenBlockType[] }>('/block-types');
        const list = Array.isArray(response)
            ? response
            : Array.isArray(response?.blockTypes)
              ? response.blockTypes
              : [];
        this.palette = { types: list, expiresAt: Date.now() + PALETTE_TTL_MS };
        return list;
    }

    /**
     * The palette in the vocabulary of `@intijs/genui` generation.
     *
     * Kitsuden declares its types with a schema, so the vocabulary comes from the CMS instead of
     * being written by hand in every project. It is the practical difference with WordPress,
     * where it has to be deduced from ACF.
     *
     * Reuses the `blockTypes()` cache: the generator is invoked once per editor request and does
     * not deserve an extra call to the CMS.
     */
    async generatorBlockTypes(options: KitsudenVocabulary = {}): Promise<GeneratorBlockType[]> {
        return toGeneratorBlockTypes(await this.blockTypes(), options);
    }

    /**
     * Media as a data source for `@intijs/genui`: a model chooses among these, and an invented
     * id does not pass validation.
     *
     * It receives the list instead of requesting it because Kitsuden keeps the catalog to its
     * team: an agent key gets 403 on `GET /api/media`. The images themselves are public, so
     * knowing their ids is enough.
     */
    mediaAsData(items: Array<{ id: string; summary: string; alt?: string }>): Array<{
        id: string;
        summary: string;
        value: { id: string; url: string; alt?: string };
    }> {
        const base = this.kitsudenConfig.endpoint.replace(/\/+$/, '');
        return items.map((item) => ({
            id: item.id,
            summary: item.summary,
            value: {
                id: item.id,
                url: `${base}/api/media/preset/${encodeURIComponent(item.id)}/${this.kitsudenConfig.mediaPreset}`,
                alt: item.alt
            }
        }));
    }

    // ============================================
    // Drafts
    // ============================================
    //
    // A copy of the page made with `POST /pages/:id/clone`, which the CMS leaves in `draft`
    // status. It is recognized by its slug, so it is also seen and edited from Kitsuden's panel.

    async fetchDraftBySlug(slug: string): Promise<IntiPage | null> {
        this.requireCredentials();

        const page = await this.readIfExists(slug);
        if (!page) return null;
        // Never published: it is its own draft
        if (page.status === 'draft') return this.parsePage(page);

        const copy = await this.readIfExists(`${DRAFT_PREFIX}${page.id}`);
        return copy ? { ...this.parsePage(copy), slug } : null;
    }

    async createDraft(documentId: string): Promise<DraftResult> {
        try {
            this.requireCredentials();
            await this.requireCompatibility(PAGE_CONTRACTS);

            const original = await this.fetchPage(documentId, { auth: true });
            const slug = `${DRAFT_PREFIX}${original.id}`;

            // There was one already: carry on with it instead of overwriting what it has
            const existing = await this.readIfExists(slug);
            if (existing) {
                return { success: true, documentId: String(existing.id), slug: original.slug, source: SOURCE };
            }

            const copy = await this.request<KitsudenPageResponse>(
                `/pages/${encodeURIComponent(original.id)}/clone`,
                { method: 'POST', body: { slug, title: original.title }, auth: true }
            );
            return { success: true, documentId: String(copy.id), slug: original.slug, source: SOURCE };
        } catch (error) {
            return this.failure(documentId, 'createDraft', error);
        }
    }

    /**
     * Takes the copy to the original page, keeping its id, its slug and whether it is the home
     * page, which an agent cannot change.
     *
     * The API has no atomic replace: the new blocks are created hidden, and only with all of
     * them created are the old ones removed. If creation fails it is undone and what is
     * published has not changed; the copy is not deleted until the end, so any later failure can
     * be retried.
     *
     * The API returns hidden or scheduled blocks to nobody, not even with a token. That is why
     * they cannot be copied or edited from here, and publishing leaves them as they were on the
     * original page. The new ones reuse the `sortOrder` of the visible ones they replace, so a
     * hidden one does not move when it is turned back on.
     */
    async publishDraft(draftId: string): Promise<DraftResult> {
        const created: KitsudenBlockRow[] = [];

        try {
            this.requireCredentials();
            await this.requireCompatibility(PAGE_CONTRACTS);

            const copy = await this.fetchPage(draftId, { auth: true });
            const originalId = copy.slug?.startsWith(DRAFT_PREFIX) ? copy.slug.slice(DRAFT_PREFIX.length) : null;

            if (!originalId) {
                if (copy.status !== 'draft') throw new Error(`Page ${draftId} is not a draft (status: ${copy.status})`);
                await this.request(`/pages/${encodeURIComponent(draftId)}`, {
                    method: 'PATCH',
                    body: { status: 'published' },
                    auth: true
                });
                return { success: true, documentId: draftId, slug: copy.slug, source: SOURCE };
            }

            const original = await this.fetchPage(originalId, { auth: true });
            const newRows = sortRows(copy.blocks ?? []);

            for (const row of newRows) {
                created.push(
                    await this.request<KitsudenBlockRow>(`/pages/${encodeURIComponent(originalId)}/blocks`, {
                        method: 'POST',
                        body: {
                            type: row.type,
                            content: row.content ?? {},
                            isVisible: false,
                            visibleFrom: row.visibleFrom ?? undefined,
                            visibleUntil: row.visibleUntil ?? undefined
                        },
                        auth: true
                    })
                );
            }

            // From here on it is not undone: the copy stays and the publish can be repeated
            const inserted = [...created];
            created.length = 0;

            const previous = sortRows(original.blocks ?? []);
            const orders = previous.map((row) => row.sortOrder);
            const highest = Math.max(0, ...orders, ...inserted.map((row) => row.sortOrder));

            for (const row of previous) {
                await this.request(`/blocks/${encodeURIComponent(row.id)}`, { method: 'DELETE', auth: true });
            }
            for (const [i, row] of inserted.entries()) {
                await this.request(`/blocks/${encodeURIComponent(row.id)}`, {
                    method: 'PATCH',
                    body: { isVisible: true, sortOrder: orders[i] ?? highest + i + 1 },
                    auth: true
                });
            }

            await this.request(`/pages/${encodeURIComponent(originalId)}`, {
                method: 'PATCH',
                body: {
                    title: copy.title,
                    description: copy.description ?? null,
                    metaTitle: copy.metaTitle ?? null,
                    metaDescription: copy.metaDescription ?? null,
                    ogImageId: copy.ogImageId ?? null
                },
                auth: true
            });

            await this.request(`/pages/${encodeURIComponent(draftId)}`, { method: 'DELETE', auth: true });

            return { success: true, documentId: originalId, slug: original.slug, source: SOURCE };
        } catch (error) {
            await this.rollbackInserts(created);
            return this.failure(draftId, 'publishDraft', error);
        }
    }

    async discardDraft(draftId: string): Promise<DraftResult> {
        try {
            this.requireCredentials();
            await this.requireCompatibility(PAGE_CONTRACTS);

            const copy = await this.fetchPage(draftId, { auth: true });
            // Never take down a published page because of a wrong id
            if (copy.status !== 'draft') {
                throw new Error(`Page ${draftId} is not a draft (status: ${copy.status})`);
            }

            await this.request(`/pages/${encodeURIComponent(draftId)}`, { method: 'DELETE', auth: true });
            return { success: true, documentId: draftId, source: SOURCE };
        } catch (error) {
            return this.failure(draftId, 'discardDraft', error);
        }
    }

    /** Reads with credentials; null if it does not exist */
    private async readIfExists(idOrSlug: string): Promise<KitsudenPageResponse | null> {
        try {
            return await this.fetchPage(idOrSlug, { auth: true });
        } catch (error) {
            if (error instanceof Error && / → 404/.test(error.message)) return null;
            throw error;
        }
    }

    // ============================================
    // Writing (inline editing)
    // ============================================

    async updateBlockField(
        documentId: string,
        blockIndex: number,
        field: string,
        value: any
    ): Promise<WriteResult> {
        if (isGameDocument(documentId)) {
            return this.updateGameBlockField(documentId, blockIndex, field, value);
        }
        try {
            this.requireCredentials();

            const rows = await this.rowsOf(documentId);
            const row = this.rowAt(rows, blockIndex, documentId);

            const content = deepClone(row.content ?? {});
            setByPath(content, field, value);

            await this.request(`/blocks/${encodeURIComponent(row.id)}`, {
                method: 'PATCH',
                body: { content },
                auth: true
            });

            return { success: true, documentId, value, source: SOURCE };
        } catch (error) {
            return this.failure(documentId, 'updateBlockField', error);
        }
    }

    async updateBlock(
        documentId: string,
        blockIndex: number,
        data: Record<string, any>
    ): Promise<WriteResult> {
        if (isGameDocument(documentId)) return this.updateGameBlock(documentId, blockIndex, data);
        try {
            this.requireCredentials();

            const rows = await this.rowsOf(documentId);
            const row = this.rowAt(rows, blockIndex, documentId);

            await this.request(`/blocks/${encodeURIComponent(row.id)}`, {
                method: 'PATCH',
                body: { content: data },
                auth: true
            });

            return { success: true, documentId, value: data, source: SOURCE };
        } catch (error) {
            return this.failure(documentId, 'updateBlock', error);
        }
    }

    async moveBlock(documentId: string, fromIndex: number, toIndex: number): Promise<WriteResult> {
        if (isGameDocument(documentId)) return this.moveGameBlock(documentId, fromIndex, toIndex);
        try {
            this.requireCredentials();

            const rows = await this.rowsOf(documentId);
            this.rowAt(rows, fromIndex, documentId);
            this.rowAt(rows, toIndex, documentId);

            const ids = rows.map((row) => row.id);
            const [moved] = ids.splice(fromIndex, 1);
            ids.splice(toIndex, 0, moved);

            await this.writeOrder(
                documentId,
                ids,
                rows.map((row) => row.sortOrder)
            );

            return { success: true, documentId, value: { fromIndex, toIndex }, source: SOURCE };
        } catch (error) {
            return this.failure(documentId, 'moveBlock', error);
        }
    }

    async insertBlock(
        documentId: string,
        index: number,
        nativeType: string,
        data: Record<string, any> = {}
    ): Promise<WriteResult> {
        if (isGameDocument(documentId)) return this.rejectGameInsert(documentId, 'insertBlock');
        try {
            this.requireCredentials();
            await this.requireKnownType(nativeType);

            const rows = await this.rowsOf(documentId);
            const created = await this.createBlock(documentId, nativeType, data);

            await this.place(documentId, rows, [created], index);

            return {
                success: true,
                documentId,
                value: { id: created.id, type: nativeType },
                source: SOURCE
            };
        } catch (error) {
            return this.failure(documentId, 'insertBlock', error);
        }
    }

    /**
     * A pattern goes in whole or not at all.
     *
     * Kitsuden has no batch insert: it is N inserts and ONE reorder. If one fails, the ones
     * already created are deleted — which is as close to atomic as it gets without support from
     * the CMS, and better than leaving half a pattern published.
     */
    async insertBlocks(
        documentId: string,
        index: number,
        newBlocks: Array<{ nativeType: string; data?: Record<string, any> }>
    ): Promise<WriteResult> {
        if (isGameDocument(documentId)) return this.rejectGameInsert(documentId, 'insertBlocks');
        if (newBlocks.length === 0) return { success: true, documentId, source: SOURCE };

        const created: KitsudenBlockRow[] = [];

        try {
            this.requireCredentials();
            for (const block of newBlocks) await this.requireKnownType(block.nativeType);

            const rows = await this.rowsOf(documentId);

            for (const block of newBlocks) {
                created.push(await this.createBlock(documentId, block.nativeType, block.data ?? {}));
            }

            await this.place(documentId, rows, created, index);

            return {
                success: true,
                documentId,
                value: { ids: created.map((row) => row.id) },
                source: SOURCE
            };
        } catch (error) {
            await this.rollbackInserts(created);
            return this.failure(documentId, 'insertBlocks', error);
        }
    }

    async removeBlock(documentId: string, index: number): Promise<WriteResult> {
        if (isGameDocument(documentId)) return this.hideGameBlock(documentId, index);
        try {
            this.requireCredentials();

            const rows = await this.rowsOf(documentId);
            const row = this.rowAt(rows, index, documentId);

            await this.request(`/blocks/${encodeURIComponent(row.id)}`, {
                method: 'DELETE',
                auth: true
            });

            return { success: true, documentId, value: { id: row.id }, source: SOURCE };
        } catch (error) {
            return this.failure(documentId, 'removeBlock', error);
        }
    }

    /**
     * The copy is made by the CMS (`POST /blocks/:id/duplicate`), which leaves it at the end of
     * the page. Inti expects it right behind the original, so it is reordered afterwards.
     */
    async duplicateBlock(documentId: string, index: number): Promise<WriteResult> {
        if (isGameDocument(documentId)) return this.rejectGameInsert(documentId, 'duplicateBlock');
        try {
            this.requireCredentials();

            const rows = await this.rowsOf(documentId);
            const row = this.rowAt(rows, index, documentId);

            const copy = await this.request<KitsudenBlockRow>(
                `/blocks/${encodeURIComponent(row.id)}/duplicate`,
                { method: 'POST', auth: true }
            );

            await this.place(documentId, rows, [copy], index + 1);

            return { success: true, documentId, value: { id: copy.id }, source: SOURCE };
        } catch (error) {
            return this.failure(documentId, 'duplicateBlock', error);
        }
    }

    // ============================================
    // Writing on game pages
    // ============================================
    //
    // `data` is never touched (it belongs to the loaders): everything goes to the per-block
    // `editorial` layer, through two atomic routes of the games kon. And the index Inti sends is
    // that of the VISIBLE, sorted list that was rendered, so the game is re-read by uuid before
    // translating it to an id.

    private async updateGameBlockField(
        documentId: string,
        index: number,
        field: string,
        value: unknown
    ): Promise<WriteResult> {
        try {
            this.requireCredentials();
            if (!EDITORIAL_FIELDS.has(field)) {
                throw new Error(
                    `On a game block only «title» and «description» are edited (got «${field}»): the rest of data is generated by the loader`
                );
            }
            if (value !== null && typeof value !== 'string') {
                throw new Error(`«${field}» has to be text (or null to go back to the loader's)`);
            }

            const { uuid, visible } = await this.gameBlocksFor(documentId);
            const block = this.gameBlockAt(visible, index, documentId);

            const response = await this.writeEditorial(uuid, block.id, { [field]: value });
            return { success: true, documentId, value: response ?? { [field]: value }, source: SOURCE };
        } catch (error) {
            return this.failure(documentId, 'updateBlockField', error);
        }
    }

    /**
     * Of `data` only `title` and `description` are used, and only those that change relative to
     * what is shown: the editor usually sends the whole block, and pinning in the layer a text
     * identical to the loader's would stop the next reload from updating it.
     */
    private async updateGameBlock(
        documentId: string,
        index: number,
        data: Record<string, any>
    ): Promise<WriteResult> {
        try {
            this.requireCredentials();
            const present = Object.keys(data ?? {}).filter((key) => EDITORIAL_FIELDS.has(key));
            if (present.length === 0) {
                throw new Error('On a game block only «title» and «description» are edited, and neither came');
            }
            for (const key of present) {
                if (data[key] !== null && typeof data[key] !== 'string') {
                    throw new Error(`«${key}» has to be text (or null to go back to the loader's)`);
                }
            }

            const { uuid, visible } = await this.gameBlocksFor(documentId);
            const block = this.gameBlockAt(visible, index, documentId);

            const editorial = editorialLayer(block.editorial) as Record<string, unknown>;
            const original = (block.data ?? {}) as Record<string, unknown>;
            const changes: Record<string, string | null> = {};
            for (const key of present) {
                const shown = editorial[key] ?? original[key];
                if (data[key] !== shown) changes[key] = data[key];
            }

            if (Object.keys(changes).length === 0) {
                return { success: true, documentId, value: {}, source: SOURCE };
            }

            const response = await this.writeEditorial(uuid, block.id, changes);
            return { success: true, documentId, value: response ?? changes, source: SOURCE };
        } catch (error) {
            return this.failure(documentId, 'updateBlock', error);
        }
    }

    /**
     * The order route requires ALL the game's ids, hidden ones included. The hidden ones keep
     * their slot in the full list and the visible ones are permuted among the slots they already
     * occupied: when a hidden one is shown again, it reappears where it was.
     */
    private async moveGameBlock(
        documentId: string,
        fromIndex: number,
        toIndex: number
    ): Promise<WriteResult> {
        try {
            this.requireCredentials();

            const { uuid, all, visible } = await this.gameBlocksFor(documentId);
            if (all.some((block) => typeof block.id !== 'string' || block.id === '')) {
                throw new Error(
                    `Game ${documentId} has a block without id: its sections cannot be reordered from the editor`
                );
            }
            this.gameBlockAt(visible, fromIndex, documentId);
            this.gameBlockAt(visible, toIndex, documentId);

            const newVisible = visible.map((block) => block.id);
            const [moved] = newVisible.splice(fromIndex, 1);
            newVisible.splice(toIndex, 0, moved);

            let next = 0;
            const ids = all.map((block) => (isHidden(block) ? block.id : newVisible[next++]));

            await this.request(`/${encodeURIComponent(uuid)}/blocks/order`, {
                base: 'games',
                method: 'PUT',
                body: { ids },
                auth: true
            });

            return { success: true, documentId, value: { fromIndex, toIndex }, source: SOURCE };
        } catch (error) {
            return this.failure(documentId, 'moveBlock', error);
        }
    }

    /** Removing a game block is HIDING it: the block belongs to the loader */
    private async hideGameBlock(documentId: string, index: number): Promise<WriteResult> {
        try {
            this.requireCredentials();

            const { uuid, visible } = await this.gameBlocksFor(documentId);
            const block = this.gameBlockAt(visible, index, documentId);

            await this.writeEditorial(uuid, block.id, { hidden: true });
            return { success: true, documentId, value: { id: block.id, hidden: true }, source: SOURCE };
        } catch (error) {
            return this.failure(documentId, 'removeBlock', error);
        }
    }

    private rejectGameInsert(documentId: string, operation: string): WriteResult {
        return this.failure(documentId, operation, new Error(GAME_BLOCK_INSERT_ERROR));
    }

    private async writeEditorial(
        uuid: string,
        blockId: string,
        body: Record<string, unknown>
    ): Promise<KitsudenGameEditorialResponse> {
        return this.request<KitsudenGameEditorialResponse>(
            `/${encodeURIComponent(uuid)}/blocks/${encodeURIComponent(blockId)}/editorial`,
            { base: 'games', method: 'PATCH', body, auth: true }
        );
    }

    /** Re-read by uuid (no cache on the server) before every write */
    private async gameBlocksFor(documentId: string): Promise<{
        uuid: string;
        all: KitsudenGameBlockRow[];
        visible: KitsudenGameBlockRow[];
    }> {
        const uuid = documentId.slice(GAME_PREFIX.length);
        if (!UUID.test(uuid)) {
            throw new Error(
                `Game document ids are "game:<uuid>" (got "${documentId}"): writes never resolve by slug`
            );
        }

        // Every game write goes through here: the contract check
        await this.requireCompatibility(GAME_CONTRACTS);
        const game = await this.fetchGame(uuid, { auth: true });
        if (!Array.isArray(game?.blocks)) {
            throw new Error(`Game ${uuid} came back without blocks`);
        }

        const all = sortedGameBlocks(game.blocks);
        return { uuid, all, visible: all.filter((block) => !isHidden(block)) };
    }

    private gameBlockAt(
        visible: KitsudenGameBlockRow[],
        index: number,
        documentId: string
    ): KitsudenGameBlockRow {
        if (!Number.isInteger(index) || index < 0 || index >= visible.length) {
            throw new Error(
                `Block index ${index} out of range (0-${visible.length - 1}) on game ${documentId}`
            );
        }
        const block = visible[index];
        if (typeof block.id !== 'string' || block.id === '') {
            throw new Error(
                `Block ${index} on game ${documentId} has no id: it cannot be edited from the editor`
            );
        }
        return block;
    }

    // ============================================
    // Internals
    // ============================================

    /**
     * ALWAYS re-read by uuid, never by slug.
     *
     * The server caches `GET /pages/:id` for 120 s under the key that was requested, and
     * invalidates `page:<uuid>:*` on writes. A read by slug can keep serving the previous order,
     * and writing against that order moves the wrong block.
     */
    private async rowsOf(documentId: string): Promise<KitsudenBlockRow[]> {
        // Every page write starts here: it is the place of the contract check (after validating
        // what is local, before touching the API)
        await this.requireCompatibility(PAGE_CONTRACTS);
        // With credentials: without them, a draft does not exist for the API
        const page = await this.fetchPage(documentId, { auth: true });
        if (!Array.isArray(page?.blocks)) {
            throw new Error(`Page ${documentId} came back without blocks (include_blocks=false?)`);
        }
        return sortRows(page.blocks);
    }

    private rowAt(rows: KitsudenBlockRow[], index: number, documentId: string): KitsudenBlockRow {
        if (!Number.isInteger(index) || index < 0 || index >= rows.length) {
            throw new Error(
                `Block index ${index} out of range (0-${rows.length - 1}) on page ${documentId}`
            );
        }
        return rows[index];
    }

    private async createBlock(
        documentId: string,
        nativeType: string,
        data: Record<string, any>
    ): Promise<KitsudenBlockRow> {
        return this.request<KitsudenBlockRow>(`/pages/${encodeURIComponent(documentId)}/blocks`, {
            method: 'POST',
            body: { type: nativeType, content: data ?? {} },
            auth: true
        });
    }

    /**
     * An insert always leaves the block at the end. If its place was another, it is reordered;
     * if it was the end, the request is saved.
     */
    private async place(
        documentId: string,
        previous: KitsudenBlockRow[],
        added: KitsudenBlockRow[],
        index: number
    ): Promise<void> {
        const target = Math.max(0, Math.min(index, previous.length));
        if (target >= previous.length) return;

        const ids = previous.map((row) => row.id);
        ids.splice(target, 0, ...added.map((row) => row.id));

        const orders = [...previous.map((row) => row.sortOrder), ...added.map((row) => row.sortOrder)];

        await this.writeOrder(documentId, ids, orders);
    }

    /**
     * Permutes the existing `sortOrder` values instead of renumbering.
     *
     * Hidden blocks do not get here but share the scale: if the visible ones became 0…n-1, a
     * hidden one with `sortOrder` 3 would appear somewhere else when made visible. Reusing the
     * values that were there leaves those positions intact. Only when there are ties —several
     * blocks with the same value, which the API allows— is there no choice but to renumber.
     */
    private async writeOrder(documentId: string, idsInOrder: string[], currentOrders: number[]): Promise<void> {
        const sorted = [...currentOrders].sort((a, b) => a - b);
        const noTies = new Set(sorted).size === sorted.length;

        const blockOrders = idsInOrder.map((id, i) => ({
            id,
            sortOrder: noTies ? sorted[i] : i
        }));

        await this.request(`/pages/${encodeURIComponent(documentId)}/blocks/reorder`, {
            method: 'POST',
            body: { blockOrders },
            auth: true
        });
    }

    private async rollbackInserts(created: KitsudenBlockRow[]): Promise<void> {
        for (const row of created) {
            try {
                await this.request(`/blocks/${encodeURIComponent(row.id)}`, {
                    method: 'DELETE',
                    auth: true
                });
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                console.error(
                    `[${this.name}Adapter] rollback: block ${row.id} could not be deleted and is left orphaned:`,
                    detail
                );
            }
        }
    }

    /**
     * A type outside the palette is saved as an invalid enum value: the API answers 500 and the
     * editor only sees "something failed". It is checked beforehand.
     */
    private async requireKnownType(nativeType: string): Promise<void> {
        const types = await this.blockTypes();
        if (types.length === 0) return; // without a palette nothing can be asserted
        if (types.some((type) => type.type === nativeType)) return;

        throw new Error(
            `Block type "${nativeType}" is not in this CMS palette (${types.map((t) => t.type).join(', ')})`
        );
    }

    // ============================================
    // Compatibility (lazy, on the first write)
    // ============================================

    /**
     * Checks against `GET /api/version` that Kitsuden speaks the contracts this write uses. The
     * writes call it before touching anything; it can also be called by hand at startup to fail
     * early.
     *
     * - A declared contract outside `SUPPORTED_CONTRACTS` → `KitsudenIncompatibleError` (the write
     *   returns `success: false` with that message and writes nothing).
     * - The API does not declare a contract that is needed → the same error: almost always its
     *   kon is turned off (Kitsuden only announces the contracts of mounted kons); if not, that
     *   Kitsuden predates the feature.
     * - `/api/version` does not exist (404/405: a Kitsuden older than the route) → warned ONCE and
     *   writing goes on.
     * - Network failure / 5xx / a response that is not Kitsuden's → warned and writing goes on,
     *   and it is tried again on the next write.
     */
    async checkCompatibility(
        contracts: readonly KitsudenContract[] = Object.keys(SUPPORTED_CONTRACTS) as KitsudenContract[]
    ): Promise<KitsudenVersionResponse | null> {
        if (!this.kitsudenConfig.checkCompatibility) return null;

        if (!this.apiVersion) {
            const pending = this.fetchVersion();
            this.apiVersion = pending;
            // Only what is final is remembered (a version read, or "does not exist")
            pending.catch(() => {
                if (this.apiVersion === pending) this.apiVersion = null;
            });
        }

        let api: KitsudenVersionResponse | null;
        try {
            api = await this.apiVersion;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            console.warn(
                `[${this.name}Adapter] could not check the Kitsuden version (${detail}); writing without checking, it will be retried on the next write`
            );
            return null;
        }
        if (!api) return null;

        for (const contract of contracts) {
            const [min, max] = SUPPORTED_CONTRACTS[contract];
            const declared = api.contracts[contract];
            if (declared === undefined) {
                throw new KitsudenIncompatibleError(
                    `Kitsuden ${api.version} does not declare the contract «${contract}» that @intijs/adapter-kitsuden ${ADAPTER_VERSION} uses for this write. Most likely the kon that serves it (${CONTRACT_KON[contract]}) is turned off in that Kitsuden: turn it on from the panel. If it is on, that Kitsuden predates the contract: update it (or use a version of the adapter older than that feature). Nothing was written.`
                );
            }
            if (declared > max) {
                throw new KitsudenIncompatibleError(
                    `Kitsuden ${api.version} speaks «${contract}» v${declared} and @intijs/adapter-kitsuden ${ADAPTER_VERSION} only understands v${min}${min === max ? '' : `–v${max}`}: update @intijs/adapter-kitsuden. Nothing was written.`
                );
            }
            if (declared < min) {
                throw new KitsudenIncompatibleError(
                    `Kitsuden ${api.version} speaks «${contract}» v${declared}, older than the v${min} that @intijs/adapter-kitsuden ${ADAPTER_VERSION} requires: update Kitsuden or use an older version of the adapter. Nothing was written.`
                );
            }
        }
        return api;
    }

    private async requireCompatibility(contracts: readonly KitsudenContract[]): Promise<void> {
        await this.checkCompatibility(contracts);
    }

    /** `null` = the route does not exist; throws if it could not be known */
    private async fetchVersion(): Promise<KitsudenVersionResponse | null> {
        const base = this.kitsudenConfig.endpoint.replace(/\/+$/, '');
        const path = '/' + this.kitsudenConfig.versionPath.replace(/^\/+/, '');
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.kitsudenConfig.timeoutMs);

        try {
            const response = await fetch(`${base}${path}`, {
                headers: { Accept: 'application/json' },
                signal: abort.signal
            });

            if (response.status === 404 || response.status === 405) {
                console.warn(
                    `[${this.name}Adapter] ${path} does not exist on ${base} (a Kitsuden older than the contract check): contract compatibility cannot be checked; writing goes on. Update Kitsuden to get the check.`
                );
                return null;
            }
            if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);

            const body = (await response.json().catch(() => null)) as
                | (Partial<KitsudenVersionResponse> & { contratos?: unknown })
                | null;
            // Kitsuden 0.8 called it `contratos`: read for one version, then only `contracts`.
            const contracts = body?.contracts ?? body?.contratos;
            if (!body || typeof contracts !== 'object' || contracts === null) {
                throw new Error(`GET ${path} did not return Kitsuden's shape ({ version, contracts })`);
            }
            return {
                product: 'kitsuden',
                version: typeof body.version === 'string' ? body.version : 'unknown',
                contracts: contracts as Record<string, number>
            };
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * The kon's routes require an agent identity: the global middleware only puts `agent` in
     * the context for `kitsuden_agent_*`. A legacy `kitsuden_sk_*` key falls to the cookie path
     * and gets a 401 with no further explanation, so it is said here.
     */
    private requireCredentials(): void {
        const token = this.kitsudenConfig.token;

        if (!token) {
            throw new Error(
                '[KitsudenAdapter] writing needs `token`: a Kitsuden agent key (kitsuden_agent_…). Reading published pages does not.'
            );
        }

        if (!token.startsWith('kitsuden_agent_')) {
            throw new Error(
                '[KitsudenAdapter] `token` has to be an agent key (kitsuden_agent_…). Legacy kitsuden_sk_* keys never set an agent identity, so the Page Builder routes answer 401 to them.'
            );
        }
    }

    private failure(documentId: string, operation: string, error: unknown): WriteResult {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${this.name}Adapter] ${operation} failed:`, message);
        return { success: false, documentId, error: message, source: SOURCE };
    }

    private async request<T>(
        path: string,
        options: {
            method?: string;
            body?: unknown;
            auth?: boolean;
            query?: Record<string, string | number | undefined>;
            /** `blocks` (default): the pages kon; `games`: the games kon */
            base?: 'blocks' | 'games';
        } = {}
    ): Promise<T> {
        const base = this.kitsudenConfig.endpoint.replace(/\/+$/, '');
        const mount = (
            options.base === 'games' ? this.kitsudenConfig.gamesPath : this.kitsudenConfig.mountPath
        ).replace(/\/+$/, '');
        const url = new URL(`${base}${mount}${path}`);

        for (const [key, value] of Object.entries(options.query ?? {})) {
            if (value !== undefined) url.searchParams.set(key, String(value));
        }

        const headers: Record<string, string> = { Accept: 'application/json' };
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        if (options.auth && this.kitsudenConfig.token) {
            headers['Authorization'] = `Bearer ${this.kitsudenConfig.token}`;
        }

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.kitsudenConfig.timeoutMs);

        try {
            const response = await fetch(url.toString(), {
                method: options.method ?? 'GET',
                headers,
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: abort.signal
            });

            if (!response.ok) {
                // The error body carries the real reason ("Page not found", "Block not found",
                // the hint of a 422); without it only a number is left.
                const detail = await response.text().catch(() => '');
                throw new Error(
                    `${options.method ?? 'GET'} ${url.pathname} → ${response.status}` +
                        (detail ? `: ${detail.slice(0, 300)}` : '')
                );
            }

            if (response.status === 204) return undefined as T;
            return (await response.json()) as T;
        } finally {
            clearTimeout(timer);
        }
    }
}

export default KitsudenAdapter;

// ============================================
// Utilities
// ============================================

function deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * `field` comes from the browser (a double click on the page): a `__proto__.x` path would write
 * to the object's prototype, not to the block.
 */
function setByPath(target: Record<string, any>, path: string, value: unknown): void {
    const parts = path.split('.').filter(Boolean);
    if (parts.length === 0) throw new Error('Empty field path');

    let node = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (UNSAFE_KEYS.has(key)) throw new Error(`Unsafe field path segment: ${key}`);
        if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
        node = node[key];
    }

    const last = parts[parts.length - 1];
    if (UNSAFE_KEYS.has(last)) throw new Error(`Unsafe field path segment: ${last}`);
    node[last] = value;
}

/**
 * Sorts the rows by `sortOrder`.
 *
 * The order is a fact of the row, not the position in the array: `moveBlock` writes `sortOrder`
 * and the API does not promise to return them sorted. It is applied both when parsing the page
 * and when resolving an index to write — in only one of the two it would create a silent
 * offset, and an edit would end up writing to the block next door.
 *
 * `sort` is stable since ES2019, so two rows with the same `sortOrder` keep the order they came
 * in.
 */
function sortRows(rows: KitsudenBlockRow[]): KitsudenBlockRow[] {
    return [...rows].sort((a, b) => (a?.sortOrder ?? 0) - (b?.sortOrder ?? 0));
}

function isHidden(block: KitsudenGameBlockRow): boolean {
    return editorialLayer(block?.editorial).hidden === true;
}

/** The 0.8 names of the editorial keys (Kitsuden ≤ 0.8, `games` contract v1). */
const EDITORIAL_KEYS_0_8 = { title: 'titulo', description: 'descripcion', hidden: 'oculto', order: 'orden' } as const;

/**
 * Only the layer's keys with the expected type; the rest is ignored.
 *
 * Reads also accept the 0.8 name of a key when the English one is absent, so a page of a
 * Kitsuden 0.8 (read-only for this adapter: its writes need contract v2) still hides and sorts
 * like its site. Remove with the next minor of the adapter.
 */
function editorialLayer(layer: KitsudenGameBlockRow['editorial']): KitsudenGameEditorial {
    const clean: KitsudenGameEditorial = {};
    if (!layer || typeof layer !== 'object') return clean;
    const raw = layer as Record<string, unknown>;
    const read = (key: keyof typeof EDITORIAL_KEYS_0_8) => (key in raw ? raw[key] : raw[EDITORIAL_KEYS_0_8[key]]);
    const title = read('title');
    const description = read('description');
    const hidden = read('hidden');
    const order = read('order');
    if (typeof title === 'string') clean.title = title;
    if (typeof description === 'string') clean.description = description;
    if (typeof hidden === 'boolean') clean.hidden = hidden;
    if (typeof order === 'number' && Number.isFinite(order)) clean.order = order;
    return clean;
}

/**
 * Order of a game page: `editorial.order ?? order`, like the site.
 * Stable: on equal order, the array's (which is the loader's).
 */
function sortedGameBlocks(blocks: KitsudenGameBlockRow[] | null | undefined): KitsudenGameBlockRow[] {
    // The SAME rule as the site: a block without `id` also counts in the visible index (the site
    // renders it), and without `order` in the layer or in the block it is 0. If they differed,
    // the edit would go to another block.
    const list = Array.isArray(blocks) ? blocks.filter((block) => block && typeof block === 'object') : [];
    const key = (block: KitsudenGameBlockRow) => {
        const order = editorialLayer(block.editorial).order;
        if (order !== undefined) return order;
        return typeof block.order === 'number' && Number.isFinite(block.order) ? block.order : 0;
    };
    return list
        .map((block) => ({ block, order: key(block) }))
        .sort((a, b) => a.order - b.order)
        .map(({ block }) => block);
}

/** The blocks that are rendered, in the order they are rendered */
export function visibleGameBlocks(blocks: KitsudenGameBlockRow[] | null | undefined): KitsudenGameBlockRow[] {
    return sortedGameBlocks(blocks).filter((block) => !isHidden(block));
}

/**
 * Translates Kitsuden's palette into the vocabulary AI block generation expects.
 *
 * It is the advantage of having a native catalog with a schema: in WordPress the fields have to
 * be deduced from ACF and it is half right, while here the CMS declares them. The more faithful
 * this vocabulary, the less room the model has to invent.
 *
 * A reference (`media`, `relation`, and the `string`s that by their name hold a media id, like
 * `mediaId`) is dropped unless a source to choose from is given: an invented id points to
 * nothing. With `mediaSource`, the model can only choose among what exists. `date` and
 * `datetime` are dropped: the format matters and the date is an editorial decision.
 */
export function toGeneratorBlockTypes(
    types: KitsudenBlockType[],
    options: KitsudenVocabulary = {}
): GeneratorBlockType[] {
    return types.map((type) => {
        const fields: NonNullable<GeneratorBlockType['fields']> = {};
        const variants: Record<string, string[]> = {};

        for (const [name, definition] of Object.entries(type.schema ?? {})) {
            const field = generatorField(name, definition, options);
            if (!field) continue;

            fields[name] = field;

            // An enum with options is declared as a closed variant: that way the JSON schema
            // compiles it to an enum and a value outside the list stops being representable.
            if (definition?.type === 'enum' && Array.isArray(definition.options)) {
                const values = definition.options
                    .filter((option) => option !== null && option !== undefined)
                    .map((option) => String(option));
                if (values.length > 0) variants[name] = values;
            }
        }

        const generatable: GeneratorBlockType = { nativeType: type.type };
        if (type.name) generatable.label = type.name;
        if (type.description) generatable.description = type.description;
        if (Object.keys(fields).length > 0) generatable.fields = fields;
        if (Object.keys(variants).length > 0) generatable.variants = variants;

        return generatable;
    });
}

export interface KitsudenVocabulary {
    /** Data source for media fields. Without it, those fields are left out */
    mediaSource?: string;
    /** Sources for `relation` fields, by field name */
    relationSources?: Record<string, string>;
}

type GeneratorField = NonNullable<GeneratorBlockType['fields']>[string];

/** `mediaId`, `imageId`, `ogImageId`: a `string` that is really a reference */
const MEDIA_NAME = /(^|[a-z_])(media|image|img|photo|video|thumbnail|avatar|cover|poster)_?id$/i;
/** `ctaUrl`, `href`: a `string` that will end up in a link, and its scheme has to be validated */
const LINK_NAME = /(url|href|link)$/i;

/** The field as `@intijs/genui` understands it, or null if a model must not fill it */
function generatorField(
    name: string,
    definition: KitsudenSchemaField | undefined,
    options: KitsudenVocabulary
): GeneratorField | null {
    const description = definition?.description ? { description: definition.description } : {};
    const media = (): GeneratorField | null =>
        options.mediaSource ? { type: 'media', source: options.mediaSource, ...description } : null;

    switch (definition?.type) {
        case 'string':
            if (MEDIA_NAME.test(name)) return media();
            if (LINK_NAME.test(name)) return { type: 'url', ...description };
            return { type: 'string', ...description };
        case 'enum':
            return { type: 'string', ...description };
        case 'text':
            return { type: 'text', ...description };
        case 'richtext':
            return { type: 'richtext', ...description };
        case 'number':
            return {
                type: 'number',
                ...(definition.min !== undefined ? { min: definition.min } : {}),
                ...(definition.max !== undefined ? { max: definition.max } : {}),
                ...description
            };
        case 'boolean':
            return { type: 'boolean', ...description };
        case 'media':
            return media();
        case 'relation': {
            const source = options.relationSources?.[name];
            return source ? { type: 'relation', source, ...description } : null;
        }
        case 'object': {
            const fields: Record<string, GeneratorField> = {};
            for (const [key, child] of Object.entries(definition.properties ?? {})) {
                const field = generatorField(key, child, options);
                if (field) fields[key] = field;
            }
            return Object.keys(fields).length > 0 ? { type: 'object', fields, ...description } : null;
        }
        case 'array': {
            const of = definition.items ? generatorField(name, definition.items, options) : null;
            return of ? { type: 'list', of, ...description } : null;
        }
        default:
            return null;
    }
}

function toPascal(text: string): string {
    return text
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

function schemaFields(schema?: Record<string, KitsudenSchemaField>): SchemaField[] {
    if (!schema) return [];

    return Object.entries(schema).map(([name, definition]) => {
        const field: SchemaField = { name, type: fieldType(definition) };
        if (definition?.required === true) field.required = true;
        if (definition?.description) field.description = definition.description;
        return field;
    });
}

function fieldType(definition?: KitsudenSchemaField): FieldType {
    switch (definition?.type) {
        case 'string':
        case 'enum':
            return 'string';
        case 'text':
            return 'text';
        case 'richtext':
            return 'richtext';
        case 'number':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'date':
            return 'date';
        case 'datetime':
            return 'datetime';
        case 'media':
            return 'media';
        case 'relation':
            return 'relation';
        default:
            // `object`, `array` and whatever comes: the editor treats it as JSON
            return 'json';
    }
}
