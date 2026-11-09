import { IntiAdapter } from '@intijs/core/adapters';
import type { IntiPage, IntiBlock, IntiNavigation } from '@intijs/core/types';
import type { SchemaDefinition, SchemaCollection, SchemaField, FieldType } from '@intijs/core/adapters';

/**
 * Sanity CMS Adapter
 * Integrates Sanity.io with Inti.js
 */
export interface SanityConfig {
    projectId: string;
    dataset: string;
    apiVersion?: string;
    useCdn?: boolean;
    token?: string;
    perspective?: 'raw' | 'published' | 'previewDrafts';
    draftMode?: boolean;
}

export class SanityAdapter extends IntiAdapter<SanityDocument> {
    protected sanityConfig: SanityConfig;
    protected baseUrl: string;

    constructor(config: SanityConfig) {
        super('Sanity', config);
        this.sanityConfig = {
            apiVersion: 'v2024-03-01',
            useCdn: true,
            perspective: 'published',
            draftMode: false,
            ...config
        };
        
        const host = this.sanityConfig.useCdn && !this.sanityConfig.draftMode 
            ? 'apicdn.sanity.io' 
            : 'api.sanity.io';
        
        this.baseUrl = `https://${this.sanityConfig.projectId}.${host}/${this.sanityConfig.apiVersion}/data/query/${this.sanityConfig.dataset}`;
    }

    parsePage(raw: SanityDocument): IntiPage {
        const pageData = raw.result || raw;

        return {
            id: pageData._id,
            slug: pageData.slug?.current || pageData._id,
            title: pageData.title || 'Untitled',
            blocks: this.parseBlocks(pageData.content || pageData.body || pageData.sections || pageData.modules || []),
            seo: {
                title: pageData.seo?.title || pageData.metaTitle || pageData.title,
                description: pageData.seo?.description || pageData.metaDescription,
                image: this.resolveImageUrl(pageData.seo?.image || pageData.ogImage)
            }
        };
    }

    parseNavigation(raw: SanityNavigationResult): IntiNavigation {
        const items = raw.result?.items?.map((item: any) => ({
            label: item.label || item.title,
            url: item.link?.url || item.link?.internal?.slug?.current || item.url || '#',
            children: item.children?.map((child: any) => ({
                label: child.label || child.title,
                url: child.link?.url || child.link?.internal?.slug?.current || child.url || '#'
            }))
        })) || [];

        return { items };
    }

    /**
     * Introspect Sanity schema for type generation
     */
    async introspect(): Promise<SchemaDefinition> {
        const schema = await this.fetchSchema();
        
        const collections: SchemaCollection[] = schema
            .filter((type: any) => type.type === 'document')
            .map((doc: any) => ({
                name: doc.name,
                fields: this.parseSanityFields(doc.fields || [])
            }));

        return {
            source: 'sanity',
            version: '3.0',
            collections
        };
    }

    private parseBlocks(content: any[]): IntiBlock[] {
        if (!Array.isArray(content)) return [];

        return content.map((block, index) => {
            // Handle Portable Text (Rich Text)
            if (block._type === 'block') {
                return {
                    id: `block-${index}`,
                    type: 'rich-text',
                    data: { 
                        style: block.style || 'normal',
                        children: block.children || [],
                        markDefs: block.markDefs || []
                    }
                };
            }

            // Handle image assets
            if (block._type === 'image' || block._type?.includes('image')) {
                return {
                    id: block._key || `image-${index}`,
                    type: 'image',
                    data: this.parseImageBlock(block)
                };
            }

            // Handle custom blocks
            if (block._type) {
                return {
                    id: block._key || `block-${index}`,
                    type: this.toPascalCase(block._type),
                    data: this.extractBlockData(block)
                };
            }

            return {
                id: `block-${index}`,
                type: 'unknown',
                data: block
            };
        });
    }

    private parseImageBlock(block: any): any {
        const asset = block.asset;
        
        return {
            asset: asset ? {
                id: asset._ref,
                url: this.getImageUrl(asset._ref, {}),
                alt: block.alt,
                caption: block.caption
            } : null,
            hotspot: block.hotspot,
            crop: block.crop
        };
    }

    private extractBlockData(block: any): Record<string, any> {
        const data: Record<string, any> = {};

        for (const [key, value] of Object.entries(block)) {
            if (key.startsWith('_')) continue;

            // Handle references
            if (this.isReference(value)) {
                data[key] = { _ref: (value as any)._ref, _type: (value as any)._type };
            }
            // Handle assets
            else if (key === 'asset' && (value as any)?._ref) {
                data[key] = {
                    id: (value as any)._ref,
                    url: this.getImageUrl((value as any)._ref, {})
                };
            }
            // Handle arrays
            else if (Array.isArray(value)) {
                data[key] = value.map(v => this.isReference(v) ? { _ref: (v as any)._ref } : v);
            }
            // Handle slugs
            else if ((value as any)?._type === 'slug') {
                data[key] = (value as any).current;
            }
            // Handle portable text blocks
            else if ((value as any)?._type === 'block' || (Array.isArray(value) && (value[0] as any)?._type === 'block')) {
                data[key] = value;
            }
            else {
                data[key] = value;
            }
        }

        return data;
    }

    private isReference(value: any): boolean {
        return value && typeof value === 'object' && value._ref && value._type === 'reference';
    }

    private getImageUrl(assetRef: string, options: any): string {
        // Extract image ID from reference
        const imageId = assetRef.replace('image-', '').replace(/-[a-z]+$/, '');
        const dimensions = assetRef.match(/-(\d+)x(\d+)-/) || [];
        const width = options.width || dimensions[1] || 800;
        
        return `https://cdn.sanity.io/images/${this.sanityConfig.projectId}/${this.sanityConfig.dataset}/${imageId}-${width}x${width}.webp`;
    }

    private resolveImageUrl(image: any): string | undefined {
        if (!image) return undefined;
        if (typeof image === 'string') return image;
        if (image.asset?._ref) return this.getImageUrl(image.asset._ref, {});
        if (image.url) return image.url;
        return undefined;
    }

    private async fetchSchema(): Promise<any[]> {
        const url = `https://${this.sanityConfig.projectId}.api.sanity.io/${this.sanityConfig.apiVersion}/datasets/${this.sanityConfig.dataset}/query`;
        
        const query = '*[_type == "sanity.imageAsset"] { _type }'; // Dummy query to check auth
        
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        
        if (this.sanityConfig.token) {
            headers['Authorization'] = `Bearer ${this.sanityConfig.token}`;
        }

        // Note: Sanity doesn't expose schema via public API
        // In production, this would need to fetch from Sanity's export or use the client
        // For now, return a mock schema structure
        return this.getMockSchema();
    }

    private getMockSchema(): any[] {
        return [
            {
                type: 'document',
                name: 'Page',
                fields: [
                    { name: 'title', type: 'string' },
                    { name: 'slug', type: 'slug' },
                    { name: 'content', type: 'array', of: [{ type: 'block' }] },
                    { name: 'seo', type: 'object' }
                ]
            },
            {
                type: 'document',
                name: 'Post',
                fields: [
                    { name: 'title', type: 'string' },
                    { name: 'slug', type: 'slug' },
                    { name: 'excerpt', type: 'text' },
                    { name: 'body', type: 'array', of: [{ type: 'block' }, { type: 'image' }] },
                    { name: 'author', type: 'reference' },
                    { name: 'publishedAt', type: 'datetime' }
                ]
            }
        ];
    }

    private parseSanityFields(fields: any[]): SchemaField[] {
        const fieldTypeMap: Record<string, FieldType> = {
            'string': 'string',
            'text': 'text',
            'slug': 'string',
            'url': 'string',
            'number': 'number',
            'boolean': 'boolean',
            'datetime': 'datetime',
            'date': 'date',
            'file': 'media',
            'image': 'media',
            'reference': 'relation',
            'array': 'json',
            'object': 'json',
            'block': 'richtext',
            'span': 'text'
        };

        return fields.map(field => {
            const isArray = field.type === 'array';
            const actualType = isArray && field.of ? field.of[0]?.type : field.type;
            
            return {
                name: field.name,
                type: fieldTypeMap[actualType] || 'json',
                required: field.validation?.some((v: any) => v.required) || false,
                multiple: isArray || field.type === 'array',
                localized: false // Sanity handles localization differently
            };
        });
    }

    private toPascalCase(str: string): string {
        return str
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join('');
    }

    /**
     * Build GROQ query for fetching pages
     */
    buildPageQuery(contentType: string, slug?: string): string {
        const baseQuery = `*[_type == "${contentType}"`;
        const slugFilter = slug ? ` && slug.current == "${slug}"` : '';
        const perspective = this.sanityConfig.draftMode ? ', "drafts." + _id in path("drafts.**")' : ' && !(_id in path("drafts.**"))';
        
        return `${baseQuery}${slugFilter}${perspective}] {
            _id,
            _type,
            title,
            slug,
            content,
            body,
            sections,
            modules,
            seo,
            metaTitle,
            metaDescription,
            ogImage
        }[0]`;
    }

    /**
     * Get query URL for Sanity API
     */
    getQueryUrl(query: string): string {
        const encodedQuery = encodeURIComponent(query);
        const perspective = this.sanityConfig.draftMode ? 'previewDrafts' : 'published';
        return `${this.baseUrl}?query=${encodedQuery}&perspective=${perspective}`;
    }
}

// Sanity types
interface SanityDocument {
    result?: any;
    _id?: string;
    _type?: string;
    [key: string]: any;
}

interface SanityNavigationResult {
    result?: {
        items?: Array<{
            label?: string;
            title?: string;
            link?: {
                url?: string;
                internal?: { slug?: { current?: string } };
            };
            url?: string;
            children?: any[];
        }>;
    };
}

export default SanityAdapter;
