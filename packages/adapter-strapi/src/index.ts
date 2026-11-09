import { IntiAdapter } from '@intijs/core/adapters';
import { extractStrapiSeo } from './seo.js';
import type { IntiPage, IntiBlock, IntiNavigation } from '@intijs/core/types';
import type {
    SchemaDefinition,
    SchemaCollection,
    SchemaField,
    FieldType,
    WritableAdapter,
    WriteResult
} from '@intijs/core/adapters';

/**
 * Strapi CMS Adapter
 * Integrates Strapi (v4/v5) with Inti.js
 *
 * Writing (write-back / inline editing):
 * - PUT /api/:pluralApiId/:id with a Bearer token
 * - The dynamic zone is sent whole; components keep their `id`
 *   so Strapi updates in place and preserves the fields not sent
 */
export interface StrapiConfig {
    endpoint: string;
    apiToken?: string;
    previewToken?: string;
    populate?: string | string[];
    draftMode?: boolean;
    /** pluralApiId of the pages content type (default: 'pages') */
    contentType?: string;
    /** Name of the dynamic zone field holding the blocks (default: 'blocks') */
    blocksField?: string;
}

export class StrapiAdapter extends IntiAdapter<StrapiPageResponse> implements WritableAdapter {
    readonly writable = true as const;

    protected strapiConfig: StrapiConfig;

    constructor(config: StrapiConfig) {
        super('Strapi', config);
        this.strapiConfig = {
            populate: '*',
            draftMode: false,
            ...config
        };
    }

    parsePage(raw: StrapiPageResponse): IntiPage {
        const data = raw.data;
        const attributes = data.attributes || data;
        const contentType = attributes.__contentType || this.config.contentType || 'page';

        return {
            id: data.id.toString(),
            slug: attributes.slug || data.id.toString(),
            title: attributes.title || 'Untitled',
            blocks: this.parseBlocks(attributes.blocks || attributes.content || [], {
                documentId: data.id.toString(),
                contentType,
                locale: attributes.locale
            }),
            seo: extractStrapiSeo(attributes),
            meta: {
                contentType,
                documentId: data.id.toString(),
                locale: attributes.locale,
                updatedAt: attributes.updatedAt
            }
        };
    }

    parseNavigation(raw: StrapiNavigationResponse): IntiNavigation {
        const items = raw.data.map(item => ({
            label: item.attributes.label || item.attributes.title || 'Untitled',
            url: item.attributes.url || `/${item.attributes.slug || ''}`,
            children: item.attributes.children?.data?.map((child: any) => ({
                label: child.attributes.label || child.attributes.title || 'Untitled',
                url: child.attributes.url || `/${child.attributes.slug || ''}`
            }))
        }));

        return { items };
    }

    /**
     * Introspect Strapi schema for type generation
     */
    async introspect(): Promise<SchemaDefinition> {
        const contentTypes = await this.fetchContentTypes();
        
        const collections: SchemaCollection[] = contentTypes.map(ct => ({
            name: this.toPascalCase(ct.info.singularName),
            fields: this.parseStrapiFields(ct.attributes)
        }));

        return {
            source: 'strapi',
            version: '5.0',
            collections
        };
    }

    private parseBlocks(blocks: any[], pageMeta?: any): IntiBlock[] {
        return blocks.map((block, index) => {
            const blockId = block.id?.toString() || `block-${index}`;
            const meta = {
                ...pageMeta,
                index,
                total: blocks.length,
                label: block.label || block.title
            };

            // Handle Strapi's dynamic zones
            if (block.__component) {
                const [category, componentName] = block.__component.split('.');
                return {
                    id: blockId,
                    type: componentName,
                    data: this.extractBlockData(block),
                    meta: {
                        ...meta,
                        // The full uid is the native identifier
                        // (needed for insertBlock from the palette)
                        label: block.__component
                    }
                };
            }

            // Handle content blocks
            if (block.type === 'paragraph' || block.type === 'heading') {
                return {
                    id: blockId,
                    type: 'rich-text',
                    data: { content: block },
                    meta
                };
            }

            // Default block
            return {
                id: blockId,
                type: block.__component || 'unknown',
                data: block,
                meta
            };
        });
    }

    private extractBlockData(block: any): Record<string, any> {
        const data: Record<string, any> = {};
        
        for (const [key, value] of Object.entries(block)) {
            if (key.startsWith('_')) continue;
            
            // Handle media relations
            if (typeof value === 'object' && value !== null && 'data' in value) {
                const mediaData = (value as any).data;
                if (Array.isArray(mediaData)) {
                    data[key] = mediaData.map(m => this.parseMedia(m));
                } else if (mediaData) {
                    data[key] = this.parseMedia(mediaData);
                }
            }
            // Handle relations
            else if (typeof value === 'object' && value !== null && 'data' in value) {
                data[key] = (value as any).data;
            }
            else {
                data[key] = value;
            }
        }
        
        return data;
    }

    private parseMedia(mediaData: any): any {
        const attrs = mediaData.attributes || mediaData;
        return {
            id: mediaData.id.toString(),
            url: attrs.url,
            alt: attrs.alternativeText,
            width: attrs.width,
            height: attrs.height,
            format: attrs.ext?.replace('.', ''),
            size: attrs.size,
            mimeType: attrs.mime,
            filename: attrs.name
        };
    }

    private async fetchContentTypes(): Promise<any[]> {
        const url = new URL('/api/content-type-builder/content-types', this.strapiConfig.endpoint);
        
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        
        if (this.strapiConfig.apiToken) {
            headers['Authorization'] = `Bearer ${this.strapiConfig.apiToken}`;
        }

        const response = await fetch(url.toString(), { headers });
        
        if (!response.ok) {
            throw new Error(`Failed to fetch Strapi content types: ${response.statusText}`);
        }

        const data = await response.json();
        return data.data.filter((ct: any) => !ct.uid.startsWith('admin::'));
    }

    private parseStrapiFields(attributes: Record<string, any>): SchemaField[] {
        const fieldTypeMap: Record<string, FieldType> = {
            'string': 'string',
            'text': 'text',
            'richtext': 'richtext',
            'blocks': 'blocks',
            'number': 'number',
            'integer': 'number',
            'decimal': 'number',
            'float': 'number',
            'boolean': 'boolean',
            'date': 'date',
            'datetime': 'datetime',
            'media': 'media',
            'relation': 'relation',
            'enumeration': 'string',
            'json': 'json',
            'uid': 'string',
            'component': 'component',
            'dynamiczone': 'blocks'
        };

        return Object.entries(attributes)
            .filter(([key]) => !key.startsWith('_'))
            .map(([key, attr]: [string, any]) => ({
                name: key,
                type: fieldTypeMap[attr.type] || 'json',
                required: attr.required || false,
                multiple: attr.repeatable || (attr.type === 'relation' && attr.relation?.includes('Many')),
                localized: attr.pluginOptions?.i18n?.localized || false
            }));
    }

    private toPascalCase(str: string): string {
        return str
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join('');
    }

    // ============================================
    // Write-Back (Inline Editing)
    // ============================================

    private get blocksFieldName(): string {
        return this.strapiConfig.blocksField || 'blocks';
    }

    private get entryBase(): string {
        const endpoint = this.strapiConfig.endpoint.replace(/\/$/, '');
        const contentType = this.strapiConfig.contentType || 'pages';
        return `${endpoint}/api/${contentType}`;
    }

    private writeHeaders(): Record<string, string> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.strapiConfig.apiToken) {
            headers['Authorization'] = `Bearer ${this.strapiConfig.apiToken}`;
        }
        return headers;
    }

    /** Gets the raw entry with the dynamic zone populated — basis of the read-modify-write */
    /**
     * Reads a page by its slug.
     *
     * It was missing: WordPress, Kitsuden and the local store had a way to read a
     * page and Strapi only a way to parse it, so the docs said
     * "the same flow works for Strapi" and there was no way to follow it without
     * writing the request by hand.
     */
    async fetchPageBySlug(slug: string): Promise<IntiPage> {
        const params = new URLSearchParams(this.buildQueryParams());
        params.set('filters[slug][$eq]', slug);

        const response = await fetch(`${this.entryBase}?${params}`, { headers: this.writeHeaders() });
        if (!response.ok) {
            throw new Error(`Failed to fetch page: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        const entry = Array.isArray(json?.data) ? json.data[0] : undefined;
        if (!entry) {
            throw new Error(`Page not found for slug: ${slug}`);
        }

        return this.parsePage({ data: entry } as StrapiPageResponse);
    }

    private async fetchRawEntry(documentId: string): Promise<any> {
        const url = `${this.entryBase}/${documentId}?populate=*`;
        const response = await fetch(url, { headers: this.writeHeaders() });

        if (!response.ok) {
            throw new Error(`Failed to fetch entry ${documentId}: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        // v4: data.attributes; v5: flat data
        return json.data?.attributes ? { id: json.data.id, ...json.data.attributes } : json.data;
    }

    /**
     * Prepares a dynamic zone component for the PUT.
     *
     * With the `id` present, Strapi updates the component in place and
     * preserves the fields not sent — that is why only id,
     * __component and the scalar values are sent (populated relations/media
     * with shape {data:...} are omitted so validation does not break).
     */
    private sanitizeComponent(component: Record<string, any>): Record<string, any> {
        const clean: Record<string, any> = {};

        for (const [key, value] of Object.entries(component)) {
            // Populated relations/media: omit → Strapi preserves them by id
            if (value && typeof value === 'object' && !Array.isArray(value) && 'data' in value) continue;
            clean[key] = value;
        }

        return clean;
    }

    /**
     * Updates a field of a block (a dynamic zone component).
     * With blockIndex === -1 a top-level field of the entry is updated.
     * Supports dot-paths ('cta.label') for nested fields of the component.
     */
    async updateBlockField(documentId: string, blockIndex: number, field: string, value: any): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            if (blockIndex === -1) {
                // Top-level field: direct partial PUT, no round-trip
                return await this.pushData(documentId, this.buildNestedPatch(field, value), value);
            }

            const entry = await this.fetchRawEntry(documentId);
            const zone = entry?.[this.blocksFieldName];

            if (!Array.isArray(zone)) {
                throw new Error(`Field "${this.blocksFieldName}" is not a dynamic zone array on entry ${documentId}`);
            }
            if (blockIndex < 0 || blockIndex >= zone.length) {
                throw new Error(`Block index ${blockIndex} out of range (0-${zone.length - 1})`);
            }

            // The zone is sent whole; each component keeps its id
            const patched = zone.map((component: Record<string, any>, i: number) => {
                const clean = this.sanitizeComponent(component);
                if (i !== blockIndex) return clean;

                const target = JSON.parse(JSON.stringify(clean));
                this.setByPath(target, field, value);
                return target;
            });

            return await this.pushData(documentId, { [this.blocksFieldName]: patched }, value);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] updateBlockField failed:`, message);
            return { success: false, documentId, error: message, source: 'strapi' };
        }
    }

    /** Replaces a block's data, preserving id and __component */
    async updateBlock(documentId: string, blockIndex: number, data: Record<string, any>): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const entry = await this.fetchRawEntry(documentId);
            const zone = entry?.[this.blocksFieldName];

            if (!Array.isArray(zone) || blockIndex < 0 || blockIndex >= zone.length) {
                throw new Error(`Block index ${blockIndex} out of range on entry ${documentId}`);
            }

            const patched = zone.map((component: Record<string, any>, i: number) => {
                if (i !== blockIndex) return this.sanitizeComponent(component);
                return {
                    id: component.id,
                    __component: component.__component,
                    ...data
                };
            });

            return await this.pushData(documentId, { [this.blocksFieldName]: patched }, data);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] updateBlock failed:`, message);
            return { success: false, documentId, error: message, source: 'strapi' };
        }
    }

    /**
     * Moves a dynamic zone component to another position.
     */
    async moveBlock(documentId: string, fromIndex: number, toIndex: number): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const entry = await this.fetchRawEntry(documentId);
            const zone = entry?.[this.blocksFieldName];

            if (!Array.isArray(zone)) {
                throw new Error(`Field "${this.blocksFieldName}" is not a dynamic zone array on entry ${documentId}`);
            }
            if (fromIndex < 0 || fromIndex >= zone.length || toIndex < 0 || toIndex >= zone.length) {
                throw new Error(`Move indexes out of range (0-${zone.length - 1})`);
            }

            const patched = zone.map((c: Record<string, any>) => this.sanitizeComponent(c));
            const [moved] = patched.splice(fromIndex, 1);
            patched.splice(toIndex, 0, moved);

            return await this.pushData(documentId, { [this.blocksFieldName]: patched }, { fromIndex, toIndex });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] moveBlock failed:`, message);
            return { success: false, documentId, error: message, source: 'strapi' };
        }
    }

    // ============================================
    // Block Composition (builder)
    // ============================================

    /**
     * Inserts a new component into the dynamic zone.
     * `nativeType` is the component uid ('sections.hero').
     */
    async insertBlock(documentId: string, index: number, nativeType: string, data: Record<string, any> = {}): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const entry = await this.fetchRawEntry(documentId);
            const zone = entry?.[this.blocksFieldName];

            if (!Array.isArray(zone)) {
                throw new Error(`Field "${this.blocksFieldName}" is not a dynamic zone array on entry ${documentId}`);
            }

            const clamped = Math.max(0, Math.min(index, zone.length));
            const patched = zone.map((c: Record<string, any>) => this.sanitizeComponent(c));
            // No id: Strapi creates the new component
            patched.splice(clamped, 0, { __component: nativeType, ...data });

            return await this.pushData(documentId, { [this.blocksFieldName]: patched }, { nativeType, index: clamped });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] insertBlock failed:`, message);
            return { success: false, documentId, error: message, source: 'strapi' };
        }
    }

    /**
     * Inserts several components in a single PUT. A pattern goes in whole
     * or not at all: without this, a failure halfway leaves the published
     * entry with half a pattern.
     */
    async insertBlocks(
        documentId: string,
        index: number,
        newBlocks: Array<{ nativeType: string; data?: Record<string, any> }>
    ): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            if (newBlocks.length === 0) {
                return { success: true, documentId, source: 'strapi' };
            }

            const entry = await this.fetchRawEntry(documentId);
            const zone = entry?.[this.blocksFieldName];

            if (!Array.isArray(zone)) {
                throw new Error(`Field "${this.blocksFieldName}" is not a dynamic zone array on entry ${documentId}`);
            }

            const clamped = Math.max(0, Math.min(index, zone.length));
            const patched = zone.map((c: Record<string, any>) => this.sanitizeComponent(c));
            // No id: Strapi creates the new components
            patched.splice(
                clamped,
                0,
                ...newBlocks.map((block) => ({ __component: block.nativeType, ...(block.data ?? {}) }))
            );

            return await this.pushData(documentId, { [this.blocksFieldName]: patched }, {
                nativeType: newBlocks[0].nativeType,
                index: clamped
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] insertBlocks failed:`, message);
            return { success: false, documentId, error: message, source: 'strapi' };
        }
    }

    /** Removes the component at the given position */
    async removeBlock(documentId: string, index: number): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const entry = await this.fetchRawEntry(documentId);
            const zone = entry?.[this.blocksFieldName];

            if (!Array.isArray(zone) || index < 0 || index >= zone.length) {
                throw new Error(`Block index ${index} out of range on entry ${documentId}`);
            }

            const patched = zone.map((c: Record<string, any>) => this.sanitizeComponent(c));
            patched.splice(index, 1);

            return await this.pushData(documentId, { [this.blocksFieldName]: patched }, { removed: index });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] removeBlock failed:`, message);
            return { success: false, documentId, error: message, source: 'strapi' };
        }
    }

    /** Duplicates the component (no id → Strapi creates a real copy) */
    async duplicateBlock(documentId: string, index: number): Promise<WriteResult> {
        try {
            this.assertWriteCredentials();

            const entry = await this.fetchRawEntry(documentId);
            const zone = entry?.[this.blocksFieldName];

            if (!Array.isArray(zone) || index < 0 || index >= zone.length) {
                throw new Error(`Block index ${index} out of range on entry ${documentId}`);
            }

            const patched = zone.map((c: Record<string, any>) => this.sanitizeComponent(c));
            const { id: _dropId, ...copy } = JSON.parse(JSON.stringify(patched[index]));
            patched.splice(index + 1, 0, copy);

            return await this.pushData(documentId, { [this.blocksFieldName]: patched }, { duplicated: index });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${this.name}Adapter] duplicateBlock failed:`, message);
            return { success: false, documentId, error: message, source: 'strapi' };
        }
    }

    /**
     * Searches a collection's entries for the relation picker.
     * `collection` is the pluralApiId; filters by title with $containsi.
     */
    async searchEntries(collection: string, query: string): Promise<Array<{ id: string; title: string; subtitle?: string }>> {
        const endpoint = this.strapiConfig.endpoint.replace(/\/$/, '');
        const params = new URLSearchParams({ 'pagination[pageSize]': '10' });
        if (query) params.set('filters[title][$containsi]', query);

        const response = await fetch(`${endpoint}/api/${collection}?${params}`, { headers: this.writeHeaders() });

        if (!response.ok) {
            throw new Error(`Failed to search "${collection}": ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        const items: any[] = Array.isArray(json.data) ? json.data : [];

        return items.map(item => {
            const attrs = item.attributes || item;
            return {
                id: String(item.id),
                title: attrs.title || attrs.name || `#${item.id}`,
                subtitle: attrs.slug
            };
        });
    }

    /** PUTs the { data } payload to the entry's endpoint */
    private async pushData(documentId: string, data: Record<string, any>, value: any): Promise<WriteResult> {
        const response = await fetch(`${this.entryBase}/${documentId}`, {
            method: 'PUT',
            headers: this.writeHeaders(),
            body: JSON.stringify({ data })
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Strapi rejected the update: ${response.status} ${response.statusText} ${body.slice(0, 200)}`);
        }

        return { success: true, documentId, value, source: 'strapi' };
    }

    /** Builds a nested object from a dot-path ('seo.metaTitle' → {seo:{metaTitle:v}}) */
    private buildNestedPatch(path: string, value: any): Record<string, any> {
        const patch: Record<string, any> = {};
        this.setByPath(patch, path, value);
        return patch;
    }

    private setByPath(target: Record<string, any>, path: string, value: any): void {
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

    private assertWriteCredentials(): void {
        if (!this.strapiConfig.apiToken) {
            throw new Error(
                'Write-back requires a Strapi API Token with write permissions. ' +
                'Create one in Strapi admin → Settings → API Tokens (type: custom, with update on your content type). ' +
                'Set it as apiToken in the adapter config — server-side only, never in client code.'
            );
        }
    }

    /**
     * Build query params for Strapi API
     */
    buildQueryParams(): Record<string, string> {
        const params: Record<string, string> = {};
        
        if (this.strapiConfig.populate) {
            if (typeof this.strapiConfig.populate === 'string') {
                params.populate = this.strapiConfig.populate;
            } else {
                params.populate = this.strapiConfig.populate.join(',');
            }
        }
        
        if (this.strapiConfig.draftMode) {
            params['publicationState'] = 'preview';
        }
        
        return params;
    }
}

// Strapi response types
interface StrapiPageResponse {
    data: {
        id: number;
        attributes?: any;
        [key: string]: any;
    };
    meta?: any;
}

interface StrapiNavigationResponse {
    data: Array<{
        id: number;
        attributes: {
            label?: string;
            title?: string;
            url?: string;
            slug?: string;
            children?: {
                data: Array<any>;
            };
        };
    }>;
}

export default StrapiAdapter;
