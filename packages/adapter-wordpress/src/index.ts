import { NotFoundError, isConflict, isNotFound } from '@intijs/core/errors';
import { createHttpClient, type HttpClient, type HttpRequestOptions } from '@intijs/core/http';
import { assertSafeFieldPath } from '@intijs/core/adapters';
import { IntiAdapter } from '@intijs/core/adapters';
import { augmentMedia } from './media.js';
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
    PageSummary,
    PageTranslation
} from '@intijs/core/adapters';
import { IntrospectionAdapter } from '@intijs/core/adapters';
import {
    parseGutenberg,
    patchBlockText,
    serializeGutenberg,
    extractText,
    isTextEditable,
    isBound,
    removeGutenbergBlock,
    gutenbergNameToType
} from './gutenberg.js';
import type { GutenbergDocument } from './gutenberg.js';

export {
    parseGutenberg,
    patchBlockText,
    serializeGutenberg,
    extractText,
    isTextEditable,
    isBound,
    removeGutenbergBlock,
    gutenbergNameToType
} from './gutenberg.js';
export type { GutenbergBlock, GutenbergDocument } from './gutenberg.js';
export { augmentMedia, wordpressImage } from './media.js';

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
    /**
     * Ask WordPress only for the fields a page needs (`_fields`). Default
     * true. Add a plugin's REST field with `extraFields`.
     */
    trimFields?: boolean;
    /** More top-level REST fields to keep when trimming */
    extraFields?: string[];
    /** Milliseconds before a request to WordPress is abandoned. Default 10000 */
    timeoutMs?: number;
    /** Requests in flight while walking every page of a listing. Default 4 */
    concurrency?: number;
    fetch?: typeof fetch;
}

/** One entry of a taxonomy */
export interface WordPressTerm {
    id: number;
    slug: string;
    name: string;
    taxonomy: string;
    description?: string;
    count?: number;
    parent?: number;
    link?: string;
}

/** A page of an archive (a post type, or a term of a taxonomy) */
export interface WordPressArchive {
    items: Array<PageSummary & { id: string; excerpt?: string; date?: string }>;
    total: number;
    totalPages: number;
    page: number;
    term?: WordPressTerm;
}

export interface ArchiveQuery {
    /** REST base of the post type. Default `posts` */
    postType?: string;
    /** REST base of the taxonomy (`categories`, `tags`, a custom one) */
    taxonomy?: string;
    /** Slug of the term */
    term?: string;
    page?: number;
    perPage?: number;
    search?: string;
    locale?: string;
}

/** The fields a page needs from `wp/v2`, for `_fields` */
const PAGE_FIELDS = [
    'id', 'slug', 'type', 'status', 'link', 'modified', 'modified_gmt', 'date_gmt', 'title', 'content', 'excerpt',
    'featured_media', 'acf', 'parent', 'lang', 'translations',
    'yoast_head_json', 'rank_math_head_json', 'rank_math', 'aioseo_head_json', 'aioseo', 'seopress',
    'seopress_titles_title', 'seopress_titles_desc', 'seopress_robots_canonical', 'seopress_social_fb_img',
    'seopress_robots_index', 'seopress_social_fb_title', 'seopress_social_fb_desc', 'seopress_social_twitter_title',
    'seopress_social_twitter_desc', 'seopress_social_twitter_img',
    'inti_blocks', 'inti_locale', 'inti_translations'
];

/** How long the adapter believes the companion plugin is missing after a 404 for its route */
const BRIDGE_RETRY_MS = 10 * 60 * 1000;

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
    assertSafeFieldPath(path);
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
    /** Timeouts, retries on reads, Retry-After, ETags and typed errors for every request */
    private http: HttpClient;

    constructor(config: WordPressConfig) {
        super('WordPress', config);
        this.introspection = new WordPressIntrospection(config);
        this.http = createHttpClient({
            name: 'wordpress',
            baseUrl: config.endpoint.replace(/\/$/, ''),
            headers: () => this.authHeaders(),
            timeoutMs: config.timeoutMs,
            fetch: config.fetch
        });
    }

    private get wpConfig(): WordPressConfig {
        return this.config as WordPressConfig;
    }

    private get blocksField(): string {
        return this.wpConfig.blocksField || 'content_blocks';
    }

    /**
     * Basic auth with an Application Password, when there is one. The body's
     * `Content-Type` is set by the HTTP client, exactly `application/json`:
     * WordPress reads a JSON body only with that type.
     */
    private authHeaders(): Record<string, string> {
        const { username, appPassword } = this.wpConfig;
        const headers: Record<string, string> = {};

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
                ...this.languageOf(raw),
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
            // Images gain `srcset`, `sources` (AVIF, WebP) and `video` from what WordPress made
            data: augmentMedia(data),
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
            // The plugin's `inti_blocks` has the same positions, with what bound and dynamic blocks render
            const fromPlugin: Array<{ name: string; rendered?: string | null }> | undefined = Array.isArray(post.inti_blocks)
                ? post.inti_blocks
                : undefined;
            const aligned = fromPlugin?.length === gutenbergBlocks.length && fromPlugin.every((b, i) => b.name === gutenbergBlocks[i].name);

            return gutenbergBlocks.map((block, index) => {
                const text = extractText(block);
                const rendered = aligned ? fromPlugin![index].rendered : undefined;
                return {
                    type: gutenbergNameToType(block.name),
                    id: `${post.id}-gutenberg-${index}`,
                    data: {
                        attrs: block.attrs,
                        // A bound or dynamic block shows what WordPress renders, not what is stored
                        html: rendered ?? block.innerHTML,
                        ...(isBound(block) ? { bound: true } : {}),
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

        // No raw, but the plugin parsed the blocks: per-block rendering, read only
        if (Array.isArray(post.inti_blocks) && post.inti_blocks.length > 0) {
            const parsed = post.inti_blocks as Array<{ name: string; attrs?: Record<string, any>; innerHTML?: string; rendered?: string | null }>;
            return parsed.map((block, index) => ({
                type: gutenbergNameToType(block.name),
                id: `${post.id}-gutenberg-${index}`,
                data: { attrs: block.attrs ?? {}, html: block.rendered ?? block.innerHTML ?? '' },
                meta: {
                    documentId: String(post.id),
                    contentType: post.type || this.wpConfig.postType || 'pages',
                    label: `gutenberg:${block.name}`,
                    index,
                    total: parsed.length
                }
            }));
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

    /** The tree `GET /inti/v1/menus/<location>` returns, as IntiNavigation */
    parseNavigation(raw: any): IntiNavigation {
        const convert = (items: any[]): IntiNavigation['items'] =>
            (Array.isArray(items) ? items : []).map((item) => ({
                label: String(item?.label ?? item?.title?.rendered ?? item?.title ?? ''),
                // The site's own route when the link points inside it
                url: String(item?.path ?? item?.url ?? '#'),
                ...(Array.isArray(item?.children) && item.children.length ? { children: convert(item.children) } : {})
            }));
        return { items: convert(raw?.items ?? raw) };
    }

    /**
     * The menu assigned to a theme location (`primary`, `footer`…), in a
     * language when the site has several. Needs the companion plugin: core
     * WordPress only exposes menus to logged-in users.
     */
    async fetchNavigation(location: string, options: { locale?: string } = {}): Promise<IntiNavigation> {
        const raw = await this.http.get(`/wp-json/inti/v1/menus/${encodeURIComponent(location)}`, {
            query: { lang: options.locale },
            resource: 'menu'
        });
        return this.parseNavigation(raw);
    }

    /** `locale` and `translations` from the plugin's fields, or from Polylang's own */
    private languageOf(raw: WordPressPost): { locale?: string; translations?: PageTranslation[] } {
        const locale = raw.inti_locale ?? (typeof raw.lang === 'string' ? raw.lang : undefined);
        if (!locale) return {};
        const translations: PageTranslation[] = Array.isArray(raw.inti_translations)
            ? raw.inti_translations
                  .filter((t: any) => t && typeof t.locale === 'string' && typeof t.slug === 'string')
                  .map((t: any) => ({ locale: t.locale, slug: t.slug, ...(typeof t.url === 'string' ? { url: t.url } : {}) }))
            : [];
        return { locale, ...(translations.length ? { translations } : {}) };
    }

    // ============================================
    // Data Fetching
    // ============================================

    /** Are there credentials to request context=edit (needed for content.raw)? */
    private get hasCredentials(): boolean {
        return !!(this.wpConfig.username && this.wpConfig.appPassword);
    }

    /** `_fields` for a page, or nothing when trimming is off */
    private pageFields(): string | undefined {
        if (this.wpConfig.trimFields === false) return undefined;
        return [...PAGE_FIELDS, ...(this.wpConfig.extraFields ?? [])].join(',');
    }

    /**
     * The published page with that slug. A nested page can be asked for by
     * its path (`services/design`): WordPress matches the last segment, and
     * the path picks between pages that share it.
     */
    async fetchPageBySlug(slug: string, options: { locale?: string } = {}): Promise<IntiPage> {
        const path = slug.replace(/^\/+|\/+$/g, '');
        const last = path.split('/').pop() || 'home';
        const posts = await this.http.get<WordPressPost[]>(this.restPath, {
            query: {
                slug: last,
                acf_format: 'standard',
                // With credentials, context=edit gives content.raw (per-block editing in Gutenberg mode)
                context: this.hasCredentials ? 'edit' : undefined,
                _fields: this.pageFields(),
                lang: options.locale
            },
            resource: 'page'
        });

        const list = Array.isArray(posts) ? posts : [];
        const post =
            list.length > 1 && path.includes('/')
                ? (list.find((candidate) => {
                      try {
                          return new URL(String(candidate.link)).pathname.replace(/\/+$/, '').endsWith(`/${path}`);
                      } catch {
                          return false;
                      }
                  }) ?? list[0])
                : list[0];

        if (!post) throw new NotFoundError('page', slug, `Page not found for slug: ${slug}`);
        return this.parsePage(post);
    }

    async fetchAllPages(): Promise<IntiPage[]> {
        const posts = await this.walk<WordPressPost>(this.restPath, {
            acf_format: 'standard',
            context: this.hasCredentials ? 'edit' : undefined,
            _fields: this.pageFields()
        });
        return posts.map((post) => this.parsePage(post));
    }

    /** Path of the post type's REST collection: `/wp-json/wp/v2/pages` */
    private get restPath(): string {
        return `/wp-json/wp/v2/${this.wpConfig.postType || 'pages'}`;
    }

    /**
     * Every page of a REST listing. The first answer says how many pages
     * there are (`X-WP-TotalPages`); the rest are asked for in parallel, a
     * few at a time. There is no cap: a sitemap that stops at 5,000 URLs
     * hides the rest of the site.
     */
    private async walk<T>(path: string, query: HttpRequestOptions['query'] = {}): Promise<T[]> {
        const perPage = 100;
        const first = await this.http.request<T[]>('GET', path, { query: { ...query, per_page: perPage, page: 1 } });
        const totalPages = Number(first.headers.get('x-wp-totalpages')) || 1;
        const pages: T[][] = [Array.isArray(first.data) ? first.data : []];

        const remaining = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
        const concurrency = Math.max(1, this.wpConfig.concurrency ?? 4);
        const results = new Map<number, T[]>();
        await Promise.all(
            Array.from({ length: Math.min(concurrency, remaining.length) }, async () => {
                for (let next = remaining.shift(); next !== undefined; next = remaining.shift()) {
                    const batch = await this.http.get<T[]>(path, { query: { ...query, per_page: perPage, page: next } });
                    results.set(next, Array.isArray(batch) ? batch : []);
                }
            })
        );
        for (let page = 2; page <= totalPages; page++) pages.push(results.get(page) ?? []);
        return pages.flat();
    }

    async listPages(): Promise<PageSummary[]> {
        const posts = await this.walk<WordPressPost>(this.restPath, {
            status: 'publish',
            _fields: 'slug,link,modified_gmt,title,inti_locale,inti_translations,lang'
        });

        return posts.map((post) => ({
            slug: this.pathOf(post),
            // modified_gmt comes without a zone; mark it as UTC
            updatedAt: post.modified_gmt ? `${post.modified_gmt}Z` : undefined,
            title: post.title?.rendered,
            ...this.languageOf(post)
        }));
    }

    /** The path a post has on the site, from its link (nested pages keep their parents) */
    private pathOf(post: WordPressPost): string {
        try {
            const link = new URL(String(post.link));
            const root = new URL(this.wpConfig.endpoint);
            const path = link.pathname.replace(root.pathname.replace(/\/$/, ''), '').replace(/^\/+|\/+$/g, '');
            if (path) return path;
        } catch {
            // no link: the slug
        }
        return post.slug;
    }

    // ============================================
    // Taxonomies and archives
    // ============================================

    /** Terms of a taxonomy (`categories`, `tags`, a custom REST base), every page of them */
    async listTerms(taxonomy: string, options: { locale?: string; hideEmpty?: boolean } = {}): Promise<WordPressTerm[]> {
        const terms = await this.walk<Record<string, any>>(`/wp-json/wp/v2/${taxonomy}`, {
            hide_empty: options.hideEmpty === false ? undefined : 'true',
            lang: options.locale,
            _fields: 'id,slug,name,taxonomy,description,count,parent,link'
        });
        return terms.map((term) => this.toTerm(term));
    }

    /** One term by slug; `NotFoundError` when there is none */
    async fetchTerm(taxonomy: string, slug: string, options: { locale?: string } = {}): Promise<WordPressTerm> {
        const terms = await this.http.get<Record<string, any>[]>(`/wp-json/wp/v2/${taxonomy}`, {
            query: { slug, lang: options.locale, _fields: 'id,slug,name,taxonomy,description,count,parent,link' },
            resource: 'term'
        });
        const term = Array.isArray(terms) ? terms[0] : undefined;
        if (!term) throw new NotFoundError('term', slug);
        return this.toTerm(term);
    }

    private toTerm(term: Record<string, any>): WordPressTerm {
        return {
            id: Number(term.id),
            slug: String(term.slug),
            name: String(term.name ?? term.slug),
            taxonomy: String(term.taxonomy ?? ''),
            description: term.description || undefined,
            count: typeof term.count === 'number' ? term.count : undefined,
            parent: term.parent || undefined,
            link: term.link
        };
    }

    /**
     * A page of an archive: the posts of a type, optionally of one term.
     * `total` and `totalPages` come from WordPress's headers, for pagination.
     */
    async fetchArchive(query: ArchiveQuery = {}): Promise<WordPressArchive> {
        const postType = query.postType ?? 'posts';
        const page = Math.max(1, query.page ?? 1);
        const perPage = Math.max(1, Math.min(100, query.perPage ?? 10));
        const term = query.taxonomy && query.term ? await this.fetchTerm(query.taxonomy, query.term, { locale: query.locale }) : undefined;

        const result = await this.http.request<WordPressPost[]>('GET', `/wp-json/wp/v2/${postType}`, {
            query: {
                page,
                per_page: perPage,
                search: query.search,
                lang: query.locale,
                ...(term && query.taxonomy ? { [query.taxonomy]: term.id } : {}),
                _fields: 'id,slug,link,title,excerpt,date_gmt,modified_gmt,inti_locale,inti_translations,lang'
            },
            resource: 'archive'
        }).catch((error) => {
            // WordPress answers 400 for a page past the last one: an empty page, not an error
            if ((error as { status?: number }).status === 400 && page > 1) {
                return { data: [] as WordPressPost[], status: 200, headers: new Headers() };
            }
            throw error;
        });

        const posts = Array.isArray(result.data) ? result.data : [];
        return {
            items: posts.map((post) => ({
                id: String(post.id),
                slug: this.pathOf(post),
                title: post.title?.rendered,
                excerpt: post.excerpt?.rendered,
                date: post.date_gmt ? `${post.date_gmt}Z` : undefined,
                updatedAt: post.modified_gmt ? `${post.modified_gmt}Z` : undefined,
                ...this.languageOf(post)
            })),
            total: Number(result.headers.get('x-wp-total')) || posts.length,
            totalPages: Number(result.headers.get('x-wp-totalpages')) || 1,
            page,
            term
        };
    }

    /** Gets the raw post (with ACF) — basis of the read-modify-write */
    private async fetchRawPost(documentId: string): Promise<WordPressPost> {
        // `light` avoids formatting what it can, but inside a Flexible
        // Content it still arrives expanded: `pushAcf` takes care of that
        try {
            return await this.http.get<WordPressPost>(`${this.restPath}/${documentId}`, {
                query: { acf_format: 'light', context: 'edit' },
                resource: 'post'
            });
        } catch (error) {
            // context=edit requires edit permission; reading still works without it
            if ((error as { status?: number }).status !== 401) throw error;
            return this.http.get<WordPressPost>(`${this.restPath}/${documentId}`, { query: { acf_format: 'light' }, resource: 'post' });
        }
    }

    // ============================================
    // Write-Back (Inline Editing)
    // ============================================
    //
    // With the companion plugin (inti-bridge) every write is one PHP call:
    // a field with `acf_update_value`, a structural change on the raw rows,
    // a Gutenberg document as a whole. Each carries the `modified_gmt` the
    // adapter read when it read anything, and the plugin answers 409 when the
    // page changed since: two editors never silently lose each other's work.
    //
    // Without the plugin the adapter falls back to the REST API: read the
    // whole Flexible Content array, change it, post it back.

    /** Until when the plugin is believed to be missing (a 404 for its route) */
    private bridgeMissingUntil = 0;

    private get bridgeSetting(): boolean | 'auto' {
        return this.wpConfig.useBridgePlugin ?? 'auto';
    }

    /**
     * Calls the plugin. `null` means "not installed" (or turned off): the
     * caller uses the REST fallback. Any other failure is thrown, typed: a
     * conflict, a refused write or a timeout is not a reason to try the
     * racier path behind the user's back.
     */
    private async bridge<T = Record<string, any>>(route: string, body: Record<string, unknown>): Promise<T | null> {
        if (this.bridgeSetting === false) return null;
        if (this.bridgeSetting === 'auto' && Date.now() < this.bridgeMissingUntil) return null;

        try {
            // A version check (or a final value) makes a resend harmless: one retry after a dropped connection
            return await this.http.post<T>(`/wp-json/inti/v1/${route}`, { json: body, idempotent: true, resource: 'inti-bridge route' });
        } catch (error) {
            // Only a missing route means "no plugin"; a 404 for a post is a real answer
            if (isNotFound(error) && /rest_no_route/.test(String((error as Error).message)) && this.bridgeSetting === 'auto') {
                this.bridgeMissingUntil = Date.now() + BRIDGE_RETRY_MS;
                return null;
            }
            throw error;
        }
    }

    /** `{ success: false }` with a message the editor can act on */
    private failure(operation: string, documentId: string, error: unknown): WriteResult {
        const message = isConflict(error)
            ? 'The page changed in WordPress since it was read. Reload it and edit again.'
            : error instanceof Error
              ? error.message
              : String(error);
        console.error(`[${this.name}Adapter] ${operation} failed:`, message);
        return { success: false, documentId, error: message, source: 'wordpress' };
    }

    /** Does this post keep its blocks in the Flexible Content field? */
    private usesAcf(post: WordPressPost): boolean {
        const mode = this.wpConfig.mode || 'auto';
        return mode === 'acf' || (mode === 'auto' && Array.isArray(post.acf?.[this.blocksField]));
    }

    /** The plugin's error code (`inti_no_rows`), when the error carries one */
    private static bridgeCode(error: unknown): string | undefined {
        const text = String((error as { body?: string })?.body ?? (error as Error)?.message ?? '');
        return text.match(/"code"\s*:\s*"([a-z_]+)"/)?.[1];
    }

    /**
     * A structural change done by the plugin on the raw rows. `null` when the
     * plugin is missing or the post has no Flexible Content (Gutenberg).
     */
    private async bridgeRows(documentId: string, op: string, params: Record<string, unknown>): Promise<WriteResult | null> {
        if ((this.wpConfig.mode || 'auto') === 'gutenberg') return null;
        try {
            const result = await this.bridge('rows', { post_id: Number(documentId), blocks_field: this.blocksField, op, ...params });
            return result ? { success: true, documentId, value: params, source: 'wordpress-bridge' } : null;
        } catch (error) {
            if (WordPressAdapter.bridgeCode(error) === 'inti_no_rows' && (this.wpConfig.mode || 'auto') === 'auto') return null;
            throw error;
        }
    }

    /**
     * Updates a field of a block (a Flexible Content layout), or of the page
     * with blockIndex === -1.
     *
     * With the plugin: one atomic `acf_update_value`. Without it, ACF REST
     * requires the FULL Flexible Content value, so the flow is
     * read-modify-write of the whole array.
     */
    async updateBlockField(documentId: string, blockIndex: number, field: string, value: any): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();
            assertSafeFieldPath(field);

            if ((this.wpConfig.mode || 'auto') !== 'gutenberg' || blockIndex === -1) {
                try {
                    const bridged = await this.bridge('patch', {
                        post_id: Number(documentId),
                        blocks_field: this.blocksField,
                        block_index: blockIndex,
                        field,
                        value
                    });
                    if (bridged) return { success: true, documentId, value, source: 'wordpress-bridge' };
                } catch (error) {
                    // A Gutenberg page has no row to patch: its text is written below
                    if (WordPressAdapter.bridgeCode(error) !== 'inti_no_rows' || blockIndex === -1) throw error;
                }
            }

            const post = await this.fetchRawPost(documentId);

            // Gutenberg mode: the content lives in post_content, not in ACF
            if (blockIndex >= 0 && !this.usesAcf(post)) {
                return await this.updateGutenbergText(post, documentId, blockIndex, field, value);
            }

            const acf = { ...(post.acf || {}) };

            if (blockIndex === -1) {
                setByPath(acf, field, value);
            } else {
                const blocks = acf[this.blocksField];
                if (!Array.isArray(blocks)) {
                    throw new Error(`Field "${this.blocksField}" is not a Flexible Content array on post ${documentId}`);
                }
                if (blockIndex < 0 || blockIndex >= blocks.length) {
                    throw new Error(`Block index ${blockIndex} out of range (0-${blocks.length - 1})`);
                }
                // Clone the target layout so the original is not mutated
                const patched = blocks.map((layout: Record<string, any>, i: number) =>
                    i === blockIndex ? JSON.parse(JSON.stringify(layout)) : layout
                );
                setByPath(patched[blockIndex], field, value);
                acf[this.blocksField] = patched;
            }

            return await this.pushAcf(documentId, acf, value);
        } catch (error) {
            return this.failure('updateBlockField', documentId, error);
        }
    }

    /** Replaces a block's whole data, preserving its acf_fc_layout */
    async updateBlock(documentId: string, blockIndex: number, data: Record<string, any>): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const bridged = await this.bridgeRows(documentId, 'replace', { index: blockIndex, data });
            if (bridged) return { ...bridged, value: data };

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
            return this.failure('updateBlock', documentId, error);
        }
    }

    /**
     * Writes a Gutenberg document. Through the plugin it carries the
     * `modified_gmt` the adapter read, so a concurrent edit is a 409 instead
     * of being overwritten.
     */
    private async writeContent(post: WordPressPost, documentId: string, blocks: GutenbergDocument): Promise<void> {
        const content = serializeGutenberg(blocks);
        const expected = post.modified_gmt ? `${post.modified_gmt}Z` : undefined;
        const bridged = await this.bridge('content', { post_id: Number(documentId), content, expected_modified: expected });
        if (bridged) return;
        await this.http.post(`${this.restPath}/${documentId}`, { json: { content }, idempotent: true, resource: 'post' });
    }

    /**
     * Text write-back in Gutenberg mode.
     *
     * Only the 'text' field is editable, and only in simple blocks
     * (one tag, no nested markup, no binding) — the rest is rejected with a
     * clear error so the post_content is not corrupted.
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
        if (isBound(blocks[blockIndex])) {
            throw new Error(
                `Block "${blocks[blockIndex].name}" takes its content from a binding: change it where it comes from.`
            );
        }
        if (!isTextEditable(blocks[blockIndex])) {
            throw new Error(
                `Block "${blocks[blockIndex].name}" is too complex for inline editing. ` +
                `Edit it in the WordPress editor instead.`
            );
        }

        blocks[blockIndex] = patchBlockText(blocks[blockIndex], String(value));
        await this.writeContent(post, documentId, blocks);

        return { success: true, documentId, value, source: 'wordpress-gutenberg' };
    }

    /** Moves a block (layout) to another position */
    async moveBlock(documentId: string, fromIndex: number, toIndex: number): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const bridged = await this.bridgeRows(documentId, 'move', { from: fromIndex, to: toIndex });
            if (bridged) return bridged;

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
            return this.failure('moveBlock', documentId, error);
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
        const result = await this.insertBlocks(documentId, index, [{ nativeType, data }]);
        return result.success ? { ...result, value: { nativeType, index } } : result;
    }

    /**
     * Inserts several blocks in a single write. A pattern goes in whole or
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
            const rows = newBlocks.map((block) => ({ ...(block.data ?? {}), acf_fc_layout: block.nativeType }));

            const bridged = await this.bridgeRows(documentId, 'insert', { index, rows });
            if (bridged) return { ...bridged, value: { nativeType: newBlocks[0].nativeType, index } };

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
            patched.splice(clamped, 0, ...rows);
            acf[this.blocksField] = patched;

            return await this.pushAcf(documentId, acf, { nativeType: newBlocks[0].nativeType, index: clamped });
        } catch (error) {
            return this.failure('insertBlocks', documentId, error);
        }
    }

    /**
     * Removes the block at the given position.
     * Works in ACF and in Gutenberg mode (classic content around it stays).
     */
    async removeBlock(documentId: string, index: number): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const bridged = await this.bridgeRows(documentId, 'remove', { index });
            if (bridged) return { ...bridged, value: { removed: index } };

            const post = await this.fetchRawPost(documentId);
            const blocks = post.acf?.[this.blocksField];

            if (this.usesAcf(post) && Array.isArray(blocks)) {
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
                removeGutenbergBlock(parsed, index);
            });
        } catch (error) {
            return this.failure('removeBlock', documentId, error);
        }
    }

    /** Duplicates the block at the given position (it lands right after the original) */
    async duplicateBlock(documentId: string, index: number): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const bridged = await this.bridgeRows(documentId, 'duplicate', { index });
            if (bridged) return { ...bridged, value: { duplicated: index } };

            const post = await this.fetchRawPost(documentId);
            const blocks = post.acf?.[this.blocksField];

            if (this.usesAcf(post) && Array.isArray(blocks)) {
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
                // The copy gets a blank line before it, not the original's classic content
                parsed.splice(index + 1, 0, { ...parsed[index], leading: undefined });
            });
        } catch (error) {
            return this.failure('duplicateBlock', documentId, error);
        }
    }

    /** Mutates the Gutenberg block list and persists the serialized content */
    private async spliceGutenberg(
        post: WordPressPost,
        documentId: string,
        mutate: (blocks: GutenbergDocument) => void
    ): Promise<WriteResult> {
        const rawContent = (post.content as any)?.raw;
        if (typeof rawContent !== 'string' || !rawContent.includes('<!-- wp:')) {
            throw new Error(`Post ${documentId} has no raw Gutenberg content available (context=edit requires credentials)`);
        }

        const parsed = parseGutenberg(rawContent);
        mutate(parsed);
        await this.writeContent(post, documentId, parsed);

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
        const posts = await this.http.get<WordPressPost[]>(this.restPath, {
            query: { slug, status, acf_format: 'standard', context: 'edit' },
            resource: 'page'
        });
        return (Array.isArray(posts) ? posts[0] : undefined) ?? null;
    }

    private fetchPostById(id: string | number): Promise<WordPressPost> {
        return this.http.get<WordPressPost>(`${this.restPath}/${id}`, { query: { acf_format: 'standard', context: 'edit' }, resource: 'post' });
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
            // Not idempotent: creating twice makes two drafts, so no resend
            const created = await this.http.post<WordPressPost>(this.restPath, {
                json: {
                    status: 'draft',
                    slug,
                    title: original.title?.raw ?? original.title?.rendered,
                    content: (original.content as any)?.raw ?? '',
                    acf: normalizeAcfForWrite(original.acf ?? {}, schema)
                },
                resource: 'post'
            });
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

            // No original: a new page, which is published as is. Only a draft, as in
            // discardDraft: a private, pending or scheduled page must not go public
            // because its id reached this method.
            if (!originalId) {
                if (draft.status !== 'draft') {
                    throw new Error(`Post ${draftId} is not a draft (status: ${draft.status})`);
                }
                await this.http.post(`${this.restPath}/${draftId}`, { json: { status: 'publish' }, idempotent: true, resource: 'post' });
                return { success: true, documentId: draftId, slug: draft.slug, source: 'wordpress' };
            }

            const schema = await this.fetchAcfSchema(draftId);
            const published = await this.http.post<WordPressPost>(`${this.restPath}/${originalId}`, {
                json: {
                    title: draft.title?.raw ?? draft.title?.rendered,
                    content: (draft.content as any)?.raw ?? '',
                    acf: normalizeAcfForWrite(draft.acf ?? {}, schema)
                },
                idempotent: true,
                resource: 'post'
            });
            await this.trashPost(draftId);
            return { success: true, documentId: originalId, slug: published.slug, source: 'wordpress' };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, documentId: draftId, error: message, source: 'wordpress' };
        }
    }

    /** The page `publishDraft(draftId)` overwrites (see `DraftableAdapter`) */
    async draftOriginId(draftId: string): Promise<string | null> {
        try {
            const draft = await this.fetchRawPost(draftId);
            return draft.slug?.startsWith(DRAFT_SLUG_PREFIX) ? draft.slug.slice(DRAFT_SLUG_PREFIX.length) : null;
        } catch {
            return null;
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
        await this.http.delete(`${this.restPath}/${id}`, { idempotent: true, resource: 'post' });
    }

    /**
     * Searches a collection's entries (REST post type) for the relation
     * picker. `collection` is the rest_base ('posts', 'pages', CPTs).
     */
    async searchEntries(collection: string, query: string): Promise<Array<{ id: string; title: string; subtitle?: string }>> {
        const posts = await this.http.get<WordPressPost[]>(`/wp-json/wp/v2/${collection}`, {
            query: { per_page: 10, search: query, _fields: 'id,title,slug' },
            resource: collection
        });

        return posts.map(post => ({
            id: String(post.id),
            title: post.title?.rendered || `#${post.id}`,
            subtitle: post.slug
        }));
    }

    /** REST schema of the `acf` object. It is the same for every post of the type */
    private acfSchema?: Promise<RestSchema | undefined>;

    private fetchAcfSchema(documentId: string): Promise<RestSchema | undefined> {
        this.acfSchema ??= this.http
            .request<{ schema?: { properties?: { acf?: RestSchema } } }>('OPTIONS', `${this.restPath}/${documentId}`, { retry: false })
            .then((response) => response.data?.schema?.properties?.acf)
            .catch(() => undefined);
        return this.acfSchema;
    }

    /** POSTs the whole acf object to the post's endpoint */
    private async pushAcf(documentId: string, acf: Record<string, any>, value: any): Promise<WriteResult> {
        const schema = await this.fetchAcfSchema(documentId);

        // The whole final state: sending it twice changes nothing
        await this.http.post(`${this.restPath}/${documentId}`, {
            json: { acf: normalizeAcfForWrite(acf, schema) },
            idempotent: true,
            resource: 'post'
        });

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
