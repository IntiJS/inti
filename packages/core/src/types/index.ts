/**
 * Inti.js Core Types - The Agnostic Contract
 * Defines the unified data structures every adapter produces
 */

// ============================================
// Block System Types
// ============================================

export interface IntiBlock {
    /** Block type registered in the registry */
    type: string;
    /** Unique block ID in the CMS */
    id?: string;
    /** Block data */
    data: Record<string, any>;
    /** Optional metadata for Visual Bridge */
    meta?: {
        documentId?: string;
        contentType?: string;
        locale?: string;
        label?: string;
        index?: number;
        total?: number;
        /**
         * Visibility declared in the CMS. `false` hides the block in
         * production; the editor still sees it so it can be switched back on.
         */
        visible?: boolean;
        /** ISO date before which the block must not be shown */
        visibleFrom?: string;
        /** ISO date after which the block stops being shown */
        visibleUntil?: string;
        /** Page zone: blocks with the same slot are versions of it */
        slot?: string;
        /** Who it is aimed at: `device:mobile;pref.diet:vegan` */
        audience?: string;
    };
}

/**
 * SEO metadata normalized, wherever it comes from.
 *
 * Each CMS stores it its own way —Yoast in WordPress, the `seo`
 * component in Strapi, custom fields in Contentful or Sanity— and the
 * adapter's job is to translate it into this shape. That way the site does
 * not depend on which SEO plugin the customer uses, and switching CMS does
 * not force rewriting the templates.
 */
export interface PageSeo {
    title?: string;
    description?: string;
    /** Social image. May be relative: it is made absolute when rendering */
    image?: string;
    /** Canonical declared in the CMS. Takes precedence over the request URL */
    canonical?: string;
    /** Indexing directives already resolved by the plugin */
    robots?: {
        index?: boolean;
        follow?: boolean;
        /** Maximum snippet length; -1 = no limit */
        maxSnippet?: number;
        maxImagePreview?: 'none' | 'standard' | 'large';
    };
    /** Open Graph-specific overrides */
    openGraph?: {
        title?: string;
        description?: string;
        image?: string;
        type?: string;
    };
    /** Twitter/X-specific overrides */
    twitter?: {
        card?: string;
        title?: string;
        description?: string;
        image?: string;
        site?: string;
    };
    keywords?: string[];
    /** ISO-8601 */
    publishedAt?: string;
    modifiedAt?: string;
    /** og format, e.g. 'es_ES' */
    locale?: string;
    /**
     * JSON-LD the CMS itself already computed (Yoast's @graph, for
     * example). It is emitted as is: it is usually more complete than
     * what can be derived from outside.
     */
    jsonLd?: unknown;
    /** Where it came from: 'yoast', 'rank-math', 'strapi-seo'… Useful when debugging */
    source?: string;
}

export interface IntiPage {
    /** Unique page ID in the CMS */
    id: string;
    /** Page slug/URL */
    slug: string;
    /** Page title */
    title: string;
    /** Blocks that make up the page */
    blocks: IntiBlock[];
    /** SEO metadata normalized from the CMS */
    seo?: PageSeo;
    /** Optional metadata for Visual Bridge */
    meta?: {
        contentType?: string;
        locale?: string;
        documentId?: string;
        updatedAt?: string;
    };
}

export interface IntiNavigationItem {
    label: string;
    url: string;
    children?: IntiNavigationItem[];
}

export interface IntiNavigation {
    items: IntiNavigationItem[];
}

// ============================================
// Content Layer Types
// ============================================

export interface IntiSchema<T = any> {
    id: string;
    type: string;
    slug: string;
    data: T;
    meta?: {
        createdAt?: Date;
        updatedAt?: Date;
        source?: string;
    };
}

// ============================================
// Configuration Types
// ============================================

export interface IntiConfig {
    adapter: string;
    adapterConfig: Record<string, any>;
    collections?: string[];
    outputDir?: string;
    realtime?: {
        enabled: boolean;
        endpoint?: string;
    };
}
