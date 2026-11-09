/**
 * Shapes returned by the Kitsuden API (kon-blocks, the "Page Builder").
 *
 * They are the rows as they are: `GET /pages/:idOrSlug` answers the page with its blocks
 * nested, and each block is a `block_contents` row with its own uuid. There is no
 * `data.attributes` envelope as in Strapi.
 */

/** kon-media presets available for derived images */
export type MediaPreset = 'thumbnail' | 'small' | 'medium' | 'large' | 'hero';

export type KitsudenPageStatus = 'draft' | 'published' | 'archived';

export interface KitsudenBlockRow {
    id: string;
    pageId?: string;
    type: string;
    name?: string | null;
    sortOrder: number;
    columnSpan?: number;
    content?: Record<string, unknown> | null;
    cssClass?: string | null;
    backgroundColor?: string | null;
    textColor?: string | null;
    padding?: string | null;
    isVisible?: boolean;
    visibleFrom?: string | null;
    visibleUntil?: string | null;
    createdAt?: string;
    updatedAt?: string;
}

export interface KitsudenPageResponse {
    id: string;
    title: string;
    slug: string;
    description?: string | null;
    status?: KitsudenPageStatus;
    metaTitle?: string | null;
    metaDescription?: string | null;
    ogImageId?: string | null;
    layout?: string;
    cssClass?: string | null;
    isHomepage?: boolean;
    requireAuth?: boolean;
    publishedAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
    /** Absent when requested with `include_blocks=false` */
    blocks?: KitsudenBlockRow[];
}

/** Page summary as returned by `GET /pages` */
export interface KitsudenPageSummary {
    id: string;
    title: string;
    slug: string;
    description?: string | null;
    status?: KitsudenPageStatus;
    layout?: string;
    isHomepage?: boolean;
    publishedAt?: string | null;
    updatedAt?: string;
}

export interface KitsudenPageListResponse {
    docs: KitsudenPageSummary[];
    totalDocs: number;
    limit: number;
    offset: number;
}

/** A palette entry: `GET /block-types` */
export interface KitsudenBlockType {
    type: string;
    name: string;
    category?: string;
    icon?: string;
    description?: string;
    schema?: Record<string, KitsudenSchemaField>;
}

export interface KitsudenSchemaField {
    type?: string;
    required?: boolean;
    description?: string;
    options?: unknown[];
    default?: unknown;
    min?: number;
    max?: number;
    properties?: Record<string, KitsudenSchemaField>;
    items?: KitsudenSchemaField;
}

/**
 * Editorial layer of a game block (`games` contract v2, Kitsuden 0.9).
 *
 * `data` belongs to the loaders (which regenerate the whole array on every reload); what a
 * person edits lives here and survives the reload. Up to Kitsuden 0.8 the keys were
 * `titulo`, `descripcion`, `oculto` and `orden`.
 */
export interface KitsudenGameEditorial {
    title?: string;
    description?: string;
    hidden?: boolean;
    order?: number;
}

/** A block of `games.blocks` as the API returns it */
export interface KitsudenGameBlockRow {
    /** Deterministic, e.g. `crimson-desert-smart-grid-1` */
    id: string;
    type: string;
    order?: number;
    data?: Record<string, unknown> | null;
    editorial?: KitsudenGameEditorial | null;
}

/**
 * A game as returned by `GET /api/games/slug/:slug` and `GET /api/games/:id` (no envelope).
 * Only the fields the adapter uses are typed; the rest (specs, media, platforms…) passes
 * through untouched.
 */
export interface KitsudenGameResponse {
    id: string;
    title: string;
    slug: string;
    subtitle?: string | null;
    description?: string | null;
    excerpt?: string | null;
    status?: string;
    blocks?: KitsudenGameBlockRow[] | null;
    createdAt?: string;
    updatedAt?: string;
    [key: string]: unknown;
}

/** Response of `PATCH /api/games/:id/blocks/:blockId/editorial` */
export interface KitsudenGameEditorialResponse {
    id: string;
    editorial: KitsudenGameEditorial | null;
}

export interface KitsudenConfig {
    /** Origin of the CMS, e.g. `https://cms.example.com` */
    endpoint: string;
    /**
     * Agent key (`kitsuden_agent_…`). Only needed to write: reading published pages is
     * public.
     */
    token?: string;
    /** Mount point of the blocks kon (default: `/api/page-builder`) */
    mountPath?: string;
    /** Path of the games kon (default: `/api/games`) */
    gamesPath?: string;
    /** Status pages are listed and searched with (default: `published`) */
    status?: KitsudenPageStatus;
    /** Preset the social image is served with (default: `large`) */
    mediaPreset?: MediaPreset;
    /** Request timeout in milliseconds (default: 10000) */
    timeoutMs?: number;
    /**
     * Path of the API version (default: `/api/version`). Before the FIRST write the adapter
     * checks there that Kitsuden speaks a contract version it understands.
     */
    versionPath?: string;
    /**
     * `false` turns that check off (default: `true`). Only for setups where `/api/version` is
     * not reachable from the Astro server and compatibility was verified by hand.
     */
    checkCompatibility?: boolean;
}

/**
 * Response of `GET /api/version` (Kitsuden with versioned contracts). Kitsuden 0.8 named the
 * first and last fields `producto` and `contratos`; the adapter reads both and normalizes them to
 * these.
 */
export interface KitsudenVersionResponse {
    product: 'kitsuden';
    /** semver of the API */
    version: string;
    /** MAJOR version of each public contract, e.g. `{ "page-builder": 1 }` */
    contracts: Record<string, number>;
}
