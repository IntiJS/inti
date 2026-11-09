import type { IntiPage, IntiBlock, IntiNavigation, IntiSchema, IntiConfig } from '../types/index.js';

// ============================================
// Introspection Types (Schema Definition)
// ============================================

export type FieldType = 'string' | 'text' | 'richtext' | 'blocks' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'relation' | 'media' | 'component';

export interface SchemaField {
    name: string;
    type: FieldType;
    required?: boolean;
    description?: string;
    // For relations: reference to another collection
    relation?: {
        collection: string;
        multiple?: boolean;
    };
}

export interface SchemaCollection {
    name: string;
    fields: SchemaField[];
    description?: string;
    /**
     * If the collection describes a block type, the `IntiBlock.type` the
     * adapter assigns to it when reading (`'hero'` in Kitsuden, `'HeroBanner'` in
     * WordPress). With it, `inti sync` generates a type that discriminates a
     * page's blocks by `type` and types their `data`.
     *
     * The collection name does not work for that: it is a TypeScript
     * identifier (`HeroBlock`) and the transformation is not reversible.
     */
    blockType?: string;
    // Metadata
    timestamps?: boolean;
}

export interface SchemaDefinition {
    source: string;
    version: string;
    collections: SchemaCollection[];
}

// ============================================
// Write-Back Types (Inline Editing)
// ============================================

/**
 * Result of a write operation to the source CMS
 */
export interface WriteResult {
    success: boolean;
    /** ID of the affected document */
    documentId: string;
    /** Final persisted value (may differ from the one sent if the CMS normalizes it) */
    value?: any;
    /** Readable error message if success === false */
    error?: string;
    /** Source that processed the write (e.g. 'wordpress', 'local') */
    source?: string;
}

/**
 * Write contract for adapters that support write-back.
 *
 * An adapter that implements it enables inline editing from
 * VisualBridge: the change made on the page travels back to the
 * source CMS without going through its admin.
 */
export interface WritableAdapter {
    /** Capability marker for runtime detection */
    readonly writable: true;

    /**
     * Updates a field inside a block of a document.
     * @param documentId - Document ID in the source CMS
     * @param blockIndex - Index of the block within the blocks array
     * @param field - Field name (supports dot-path: 'cta.label')
     * @param value - New value
     */
    updateBlockField(documentId: string, blockIndex: number, field: string, value: any): Promise<WriteResult>;

    /**
     * Replaces the whole data of a block (optional)
     */
    updateBlock?(documentId: string, blockIndex: number, data: Record<string, any>): Promise<WriteResult>;

    /**
     * Moves a block from one position to another (optional).
     * Enables block drag & drop with write-back.
     */
    moveBlock?(documentId: string, fromIndex: number, toIndex: number): Promise<WriteResult>;

    /**
     * Inserts a new block at the given position (optional).
     * @param nativeType - Native CMS identifier (acf_fc_layout in
     *   WordPress, __component uid in Strapi, type in the local store)
     * @param data - Initial block data (the type's defaults)
     */
    insertBlock?(documentId: string, index: number, nativeType: string, data?: Record<string, any>): Promise<WriteResult>;

    /**
     * Inserts several consecutive blocks in a single write (optional).
     *
     * It exists for atomicity, not performance: inserting a pattern with
     * N calls to `insertBlock` leaves the customer's page half-done if
     * call number 3 fails. An adapter that does read-modify-write —which
     * is all of them— solves this by grouping the splice into one request.
     *
     * When not implemented, the core falls back to `insertBlock` in sequence
     * and rolls back what was already written if something fails, which is
     * the best that can be done without CMS support.
     */
    insertBlocks?(
        documentId: string,
        index: number,
        blocks: Array<{ nativeType: string; data?: Record<string, any> }>
    ): Promise<WriteResult>;

    /** Removes the block at the given position (optional) */
    removeBlock?(documentId: string, index: number): Promise<WriteResult>;

    /** Duplicates the block at the given position, inserting it right after (optional) */
    duplicateBlock?(documentId: string, index: number): Promise<WriteResult>;
}

/**
 * Summary of an entry for the relation picker
 */
export interface EntrySummary {
    id: string;
    title: string;
    subtitle?: string;
}

/**
 * Search contract for the relation-editing mini-panel:
 * lists candidates from a collection to assign to a relation field.
 */
export interface SearchableAdapter {
    searchEntries(collection: string, query: string): Promise<EntrySummary[]>;
}

/** Type guard: detects whether an adapter supports entry search */
export function isSearchableAdapter(adapter: unknown): adapter is IntiAdapter & SearchableAdapter {
    return !!adapter
        && typeof adapter === 'object'
        && typeof (adapter as SearchableAdapter).searchEntries === 'function';
}

/** A published page, as a sitemap needs it */
export interface PageSummary {
    slug: string;
    /** ISO-8601. Feeds <lastmod>, which crawlers use to reprioritize */
    updatedAt?: string;
    title?: string;
}

/**
 * Listing contract: enumerates the published pages.
 *
 * It is all that is needed to generate a sitemap with a real `lastmod`
 * instead of an invented one, because the date already lives in the CMS.
 */
export interface ListableAdapter {
    listPages(): Promise<PageSummary[]>;
}

/** Type guard: detects whether an adapter can enumerate its pages */
export function isListableAdapter(adapter: unknown): adapter is IntiAdapter & ListableAdapter {
    return !!adapter
        && typeof adapter === 'object'
        && typeof (adapter as ListableAdapter).listPages === 'function';
}

/** A working copy: its `documentId` is where the edits go */
export interface DraftResult extends WriteResult {
    /** Page slug: the draft opens with `?inti-draft=1` on it */
    slug?: string;
}

/**
 * Drafts contract: change a page without the visitor seeing it.
 *
 * A draft is a complete working copy, not a page state: switching a
 * published page to `draft` would pull it from the site while it is edited.
 * Since the copy is just another document, the editor and the actions do not
 * change: they only receive a different `documentId`.
 */
export interface DraftableAdapter {
    /** The working copy for that slug, or null if there is none */
    fetchDraftBySlug(slug: string): Promise<IntiPage | null>;
    /** Creates the copy, or returns the existing one: never overwrites work in progress */
    createDraft(documentId: string): Promise<DraftResult>;
    /** Moves the copy into the published page and removes the copy */
    publishDraft(draftId: string): Promise<DraftResult>;
    /** Removes the copy without touching the published page */
    discardDraft(draftId: string): Promise<DraftResult>;
}

/** Type guard: detects whether an adapter supports drafts */
export function isDraftableAdapter(adapter: unknown): adapter is IntiAdapter & WritableAdapter & DraftableAdapter {
    return !!adapter
        && typeof adapter === 'object'
        && typeof (adapter as DraftableAdapter).createDraft === 'function'
        && typeof (adapter as DraftableAdapter).publishDraft === 'function'
        && typeof (adapter as DraftableAdapter).fetchDraftBySlug === 'function';
}

/**
 * Type guard: detects whether an adapter supports write-back
 */
export function isWritableAdapter(adapter: unknown): adapter is IntiAdapter & WritableAdapter {
    return !!adapter
        && typeof adapter === 'object'
        && (adapter as WritableAdapter).writable === true
        && typeof (adapter as WritableAdapter).updateBlockField === 'function';
}

// ============================================
// Base Adapter Classes
// ============================================

/**
 * Base abstract class for all Data Adapters in Inti.js.
 * Enforces the "Agnostic Contract" for unified fast rendering.
 */
export abstract class IntiAdapter<TRawPage = any, TRawNav = any> {
    public name: string;
    public config: Record<string, any>;

    constructor(name: string, config: Record<string, any> = {}) {
        this.name = name;
        this.config = config;
    }

    abstract parsePage(raw: TRawPage): IntiPage;
    abstract parseNavigation?(raw: TRawNav): IntiNavigation;

    /**
     * Introspect the CMS schema
     * Returns a standardized schema definition for code generation
     */
    abstract introspect?(): Promise<SchemaDefinition>;
}

/**
 * Content Layer Adapter - For collection-based content (articles, posts, etc.)
 */
export abstract class ContentAdapter<T = any> {
    abstract sourceName: string;

    abstract fetchRawCollection(collection: string): Promise<any[]>;
    abstract normalize(rawItem: any): IntiSchema<T>;

    async getCollection(collection: string): Promise<IntiSchema<T>[]> {
        const rawData = await this.fetchRawCollection(collection);
        return rawData.map((item) => {
            const normalized = this.normalize(item);
            normalized.meta = { ...normalized.meta, source: this.sourceName };
            return normalized;
        });
    }
}

// ============================================
// Adapter Resolution
// ============================================

export interface AdapterPackage {
    name: string;
    adapter: new (config: any) => IntiAdapter<any, any>;
}

export async function resolveAdapter(adapterName: string): Promise<AdapterPackage> {
    // Try official adapter
    try {
        const pkg = await import(`@intijs/adapter-${adapterName}`);
        return { name: adapterName, adapter: pkg.default || pkg[Object.keys(pkg)[0]] };
    } catch {}
    
    // Try community adapter
    try {
        const pkg = await import(`inti-adapter-${adapterName}`);
        return { name: adapterName, adapter: pkg.default || pkg[Object.keys(pkg)[0]] };
    } catch {}
    
    throw new Error(
        `Adapter "${adapterName}" not found.\n` +
        `Install with: npm install @intijs/adapter-${adapterName}\n` +
        `Or for community adapters: npm install inti-adapter-${adapterName}`
    );
}

// Introspection
export {
    IntrospectionAdapter,
    globalSchemaCache,
    createSchemaField,
    createSchemaCollection,
    createSchemaDefinition
} from './introspection.js';

export type {
    IntrospectionConfig,
    IntrospectionResult
} from './introspection.js';

export type { IntiPage, IntiBlock, IntiNavigation, IntiSchema, IntiConfig };
