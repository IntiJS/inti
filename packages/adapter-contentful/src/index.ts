import { IntiAdapter } from '@intijs/core/adapters';
import type { IntiPage, IntiBlock, IntiNavigation } from '@intijs/core/types';
import type { SchemaDefinition, SchemaCollection, SchemaField, FieldType } from '@intijs/core/adapters';

/**
 * Contentful CMS Adapter
 * Integrates Contentful with Inti.js
 */
export interface ContentfulConfig {
    spaceId: string;
    environment?: string;
    accessToken: string;
    previewToken?: string;
    host?: string;
    draftMode?: boolean;
}

export class ContentfulAdapter extends IntiAdapter<ContentfulEntry> {
    protected contentfulConfig: ContentfulConfig;
    protected baseUrl: string;

    constructor(config: ContentfulConfig) {
        super('Contentful', config);
        this.contentfulConfig = {
            environment: 'master',
            draftMode: false,
            host: config.draftMode ? 'preview.contentful.com' : 'cdn.contentful.com',
            ...config
        };
        this.baseUrl = `https://${this.contentfulConfig.host}/spaces/${this.contentfulConfig.spaceId}/environments/${this.contentfulConfig.environment}`;
    }

    parsePage(raw: ContentfulEntry): IntiPage {
        const fields = raw.fields;
        const contentType = raw.sys.contentType?.sys.id || 'page';

        return {
            id: raw.sys.id,
            slug: fields.slug || raw.sys.id,
            title: fields.title || fields.name || 'Untitled',
            blocks: this.parseContent(fields.content || fields.body || fields.modules || []),
            seo: {
                title: fields.seo?.title || fields.metaTitle || fields.title,
                description: fields.seo?.description || fields.metaDescription,
                image: this.resolveAssetUrl(fields.seo?.image || fields.ogImage)
            }
        };
    }

    parseNavigation(raw: ContentfulNavigationResponse): IntiNavigation {
        const items = raw.items.map(item => ({
            label: item.fields.label || item.fields.title || 'Untitled',
            url: item.fields.url || item.fields.link || `/${item.fields.slug || ''}`,
            children: item.fields.children?.map((child: any) => ({
                label: child.fields.label || child.fields.title || 'Untitled',
                url: child.fields.url || child.fields.link || `/${child.fields.slug || ''}`
            }))
        }));

        return { items };
    }

    /**
     * Introspect Contentful schema for type generation
     */
    async introspect(): Promise<SchemaDefinition> {
        const contentTypes = await this.fetchContentTypes();
        
        const collections: SchemaCollection[] = contentTypes.map(ct => ({
            name: this.toPascalCase(ct.sys.id),
            fields: this.parseContentfulFields(ct.fields)
        }));

        return {
            source: 'contentful',
            version: '1.0',
            collections
        };
    }

    private parseContent(content: any): IntiBlock[] {
        // Handle Rich Text document format
        if (content?.nodeType === 'document') {
            return [{
                id: 'rich-text-0',
                type: 'rich-text',
                data: { content }
            }];
        }

        // Handle array of blocks/modules
        if (Array.isArray(content)) {
            return content.map((item, index) => this.parseBlock(item, index));
        }

        // Handle single block
        if (content?.sys?.contentType || content?.sys?.type === 'Entry') {
            return [this.parseBlock(content, 0)];
        }

        // Fallback to simple text block
        return [{
            id: 'text-0',
            type: 'text',
            data: { content }
        }];
    }

    private parseBlock(item: any, index: number): IntiBlock {
        // Handle Contentful entry
        if (item.sys?.contentType) {
            const contentType = item.sys.contentType.sys.id;
            const fields = item.fields;

            return {
                id: item.sys.id || `block-${index}`,
                type: this.toPascalCase(contentType),
                data: this.extractEntryData(fields)
            };
        }

        // Handle inline object
        return {
            id: `block-${index}`,
            type: item.type || 'unknown',
            data: item
        };
    }

    private extractEntryData(fields: Record<string, any>): Record<string, any> {
        const data: Record<string, any> = {};

        for (const [key, value] of Object.entries(fields)) {
            // Handle assets (media)
            if (value?.sys?.type === 'Asset') {
                data[key] = this.parseAsset(value);
            }
            // Handle arrays
            else if (Array.isArray(value)) {
                data[key] = value.map(v => {
                    if (v?.sys?.type === 'Asset') return this.parseAsset(v);
                    if (v?.sys?.type === 'Entry') return this.extractEntryData(v.fields);
                    return v;
                });
            }
            // Handle linked entries
            else if (value?.sys?.type === 'Entry') {
                data[key] = this.extractEntryData(value.fields);
            }
            // Handle rich text
            else if (value?.nodeType === 'document') {
                data[key] = value;
            }
            else {
                data[key] = value;
            }
        }

        return data;
    }

    private parseAsset(asset: any): any {
        const fields = asset.fields;
        const file = fields?.file;

        return {
            id: asset.sys.id,
            url: file?.url ? `https:${file.url}` : '',
            alt: fields?.title || fields?.description,
            width: file?.details?.image?.width,
            height: file?.details?.image?.height,
            format: file?.contentType?.split('/')[1],
            size: file?.details?.size,
            mimeType: file?.contentType,
            filename: file?.fileName
        };
    }

    private resolveAssetUrl(asset: any): string | undefined {
        if (!asset) return undefined;
        if (typeof asset === 'string') return asset;
        if (asset.fields?.file?.url) return `https:${asset.fields.file.url}`;
        return undefined;
    }

    private async fetchContentTypes(): Promise<any[]> {
        const url = `${this.baseUrl}/content_types?access_token=${this.contentfulConfig.accessToken}`;
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch Contentful content types: ${response.statusText}`);
        }

        const data = await response.json();
        return data.items;
    }

    private parseContentfulFields(fields: any[]): SchemaField[] {
        const fieldTypeMap: Record<string, FieldType> = {
            'Symbol': 'string',
            'Text': 'text',
            'RichText': 'richtext',
            'Integer': 'number',
            'Number': 'number',
            'Boolean': 'boolean',
            'Date': 'date',
            'Location': 'json',
            'Object': 'json',
            'Link': 'media',
            'Array': 'json',
            'ResourceLink': 'relation'
        };

        return fields.map(field => ({
            name: field.id,
            type: this.mapFieldType(field),
            required: field.required || false,
            multiple: field.type === 'Array' || field.multiple || false,
            localized: field.localized || false
        }));
    }

    private mapFieldType(field: any): FieldType {
        if (field.type === 'Link') {
            if (field.linkType === 'Asset') return 'media';
            if (field.linkType === 'Entry') return 'relation';
        }
        
        if (field.type === 'Array') {
            const items = field.items;
            if (items?.type === 'Link') {
                if (items.linkType === 'Asset') return 'media';
                if (items.linkType === 'Entry') return 'relation';
            }
        }

        const fieldTypeMap: Record<string, FieldType> = {
            'Symbol': 'string',
            'Text': 'text',
            'RichText': 'richtext',
            'Integer': 'number',
            'Number': 'number',
            'Boolean': 'boolean',
            'Date': 'date',
            'Location': 'json',
            'Object': 'json',
            'ResourceLink': 'relation'
        };

        return fieldTypeMap[field.type] || 'json';
    }

    private toPascalCase(str: string): string {
        return str
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join('');
    }

    /**
     * Get headers for API requests
     */
    getHeaders(): Record<string, string> {
        const token = this.contentfulConfig.draftMode 
            ? this.contentfulConfig.previewToken 
            : this.contentfulConfig.accessToken;
        
        return {
            'Authorization': `Bearer ${token}`
        };
    }
}

// Contentful types
interface ContentfulEntry {
    sys: {
        id: string;
        type: string;
        contentType?: {
            sys: {
                id: string;
            };
        };
    };
    fields: Record<string, any>;
}

interface ContentfulNavigationResponse {
    items: Array<{
        sys: { id: string };
        fields: {
            label?: string;
            title?: string;
            url?: string;
            link?: string;
            slug?: string;
            children?: any[];
        };
    }>;
}

export default ContentfulAdapter;
