#!/usr/bin/env bun
/**
 * Test script for inti sync functionality
 * Run: bun scripts/test-sync.ts
 * 
 * This is a standalone test that doesn't rely on workspace imports
 */

// ===== Inline Type Definitions (from @intijs/core) =====

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'relation' | 'media';

export interface SchemaField {
    name: string;
    type: FieldType;
    required?: boolean;
    description?: string;
    relation?: {
        collection: string;
        multiple?: boolean;
    };
}

export interface SchemaCollection {
    name: string;
    fields: SchemaField[];
    description?: string;
    timestamps?: boolean;
}

export interface SchemaDefinition {
    source: string;
    version: string;
    collections: SchemaCollection[];
}

export interface IntiBlock {
    type: string;
    id?: string;
    data: Record<string, any>;
}

export interface IntiPage {
    id: string;
    slug: string;
    title: string;
    blocks: IntiBlock[];
    seo?: {
        title?: string;
        description?: string;
        image?: string;
    };
}

export abstract class IntiAdapter<TRawPage = any, TRawNav = any> {
    public name: string;
    public config: Record<string, any>;

    constructor(name: string, config: Record<string, any> = {}) {
        this.name = name;
        this.config = config;
    }

    abstract parsePage(raw: TRawPage): IntiPage;
    abstract introspect?(): Promise<SchemaDefinition>;
}

// ===== Kitsuden Adapter (inline) =====

/** A Kitsuden page: blocks are rows with a uuid, not a nested array */
export interface KitsudenPageResponse {
    id?: string;
    title?: string;
    slug?: string;
    blocks?: Array<{
        id: string;
        type: string;
        name?: string | null;
        sortOrder: number;
        content?: Record<string, any> | null;
    }>;
}

export interface KitsudenConfig {
    endpoint: string;
    token?: string;
}

class KitsudenAdapter extends IntiAdapter<KitsudenPageResponse> {
    constructor(config: KitsudenConfig) {
        super('Kitsuden', config);
    }

    parsePage(raw: KitsudenPageResponse): IntiPage {
        // A payload that is not a page is rejected: making one up published
        // fake content without anyone seeing an error.
        if (!raw || typeof raw.id !== 'string') {
            throw new Error('[KitsudenAdapter] Invalid page payload');
        }

        return {
            id: raw.id,
            slug: raw.slug || raw.id,
            title: raw.title || 'Untitled',
            blocks: (raw.blocks ?? []).map((row) => ({
                type: row.type,
                id: row.id,
                data: (row.content ?? {}) as Record<string, any>
            }))
        };
    }

    /**
     * In the real adapter this comes from `GET /block-types`. Here it is hard-coded
     * so the script runs without a CMS in front of it.
     */
    async introspect(): Promise<SchemaDefinition> {
        return {
            source: 'kitsuden',
            version: 'page-builder/v1',
            collections: [
                {
                    name: 'Page',
                    description: 'Page builder page (block_pages)',
                    timestamps: true,
                    fields: [
                        { name: 'id', type: 'string', required: true },
                        { name: 'title', type: 'string', required: true },
                        { name: 'slug', type: 'string', required: true },
                        { name: 'metaTitle', type: 'string', required: false },
                        { name: 'metaDescription', type: 'string', required: false },
                        { name: 'ogImageId', type: 'media', required: false },
                    ]
                },
                {
                    name: 'HeroBlock',
                    description: 'Large banner with a headline and a call to action',
                    timestamps: false,
                    fields: [
                        { name: 'headline', type: 'string', required: true },
                        { name: 'subheadline', type: 'string', required: false },
                        { name: 'mediaId', type: 'media', required: false },
                    ]
                }
            ]
        };
    }
}

// ===== Code Generators (inline) =====

function fieldTypeToTypescript(type: FieldType): string {
    switch (type) {
        case 'string': return 'string';
        case 'number': return 'number';
        case 'boolean': return 'boolean';
        case 'date': return 'Date';
        case 'json': return 'Record<string, any>';
        case 'media': return 'MediaAsset';
        case 'relation': return 'string';
        default: return 'any';
    }
}

function generateCollectionInterface(collection: SchemaCollection): string {
    const fields = collection.fields.map(field => {
        const tsType = fieldTypeToTypescript(field.type);
        const optional = field.required ? '' : '?';
        const jsDoc = field.description ? `    /** ${field.description} */\n` : '';
        return `${jsDoc}    ${field.name}${optional}: ${tsType};`;
    });

    const jsDoc = collection.description ? `/**\n * ${collection.description}\n */\n` : '';
    return `${jsDoc}export interface ${collection.name} {
${fields.join('\n')}
}`;
}

function generateTypeDefinitions(schema: SchemaDefinition): string {
    const interfaces = schema.collections.map(generateCollectionInterface);
    
    return `// AUTO-GENERATED BY INTI SYNC - DO NOT EDIT
// Source: ${schema.source}
// Version: ${schema.version}
// Generated at: ${new Date().toISOString()}

export interface MediaAsset {
    id: string;
    url: string;
    alt?: string;
    width?: number;
    height?: number;
    mimeType?: string;
}

${interfaces.join('\n\n')}

export type CollectionName = 
${schema.collections.map(c => `    | '${c.name}'`).join('\n')};

export type WithId<T> = T & { id: string };
`;
}

function pluralize(word: string): string {
    if (word.endsWith('y') && !['a','e','i','o','u'].includes(word[word.length-2])) {
        return word.slice(0, -1) + 'ies';
    }
    if (word.endsWith('s') || word.endsWith('x') || word.endsWith('ch')) {
        return word + 'es';
    }
    return word + 's';
}

function generateCollectionFunctions(collection: SchemaCollection): string {
    const name = collection.name;
    const lowerName = name.toLowerCase();
    const pluralName = pluralize(name);
    
    const hasId = collection.fields.some(f => f.name === 'id');
    const hasSlug = collection.fields.some(f => f.name === 'slug');
    
    let functions: string[] = [];

    functions.push(`/**
 * Get all ${pluralName}
 */
export async function get${pluralName}(): Promise<${name}[]> {
    return request<${name}[]>('/api/${lowerName}');
}`);

    if (hasId) {
        functions.push(`
/**
 * Get ${name} by ID
 */
export async function get${name}ById(id: string): Promise<${name} | null> {
    return request<${name} | null>(\`/api/${lowerName}/\${id}\`);
}`);
    }

    if (hasSlug) {
        functions.push(`
/**
 * Get ${name} by slug
 */
export async function get${name}BySlug(slug: string): Promise<${name} | null> {
    return request<${name} | null>(\`/api/${lowerName}/slug/\${slug}\`);
}`);
    }

    return functions.join('\n');
}

function generateSDK(schema: SchemaDefinition): string {
    const collectionFunctions = schema.collections.map(generateCollectionFunctions);
    const names = schema.collections.map(c => c.name).join(', ');

    return `// AUTO-GENERATED BY INTI SYNC - DO NOT EDIT
// Source: ${schema.source}
// Version: ${schema.version}
// Generated at: ${new Date().toISOString()}

import type { ${names} } from './inti.types';

interface SDKConfig {
    endpoint: string;
    token?: string;
}

let config: SDKConfig = {
    endpoint: process.env.INTI_ENDPOINT || '',
    token: process.env.INTI_TOKEN
};

export function configureSDK(userConfig: SDKConfig) {
    config = { ...config, ...userConfig };
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = \`\${config.endpoint}\${path}\`;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options?.headers as Record<string, string>)
    };
    if (config.token) headers['Authorization'] = \`Bearer \${config.token}\`;
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) throw new Error(\`API Error: \${response.status}\`);
    return response.json();
}

${collectionFunctions.join('\n\n')}
`;
}

// ===== Main Test =====

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

async function testSync() {
    console.log('🚀 Testing Inti Sync (Standalone)...\n');

    const adapter = new KitsudenAdapter({
        endpoint: 'https://cms.example.com',
        token: 'kitsuden_agent_demo'
    });

    console.log('🔍 Introspecting schema...');
    const schema = await adapter.introspect();
    console.log(`   Found ${schema.collections.length} collections:`);
    schema.collections.forEach(c => console.log(`   - ${c.name}`));

    const outputDir = resolve(process.cwd(), './src/lib/inti');
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    console.log('\n📝 Generating types...');
    const typesContent = generateTypeDefinitions(schema);
    writeFileSync(resolve(outputDir, 'inti.types.ts'), typesContent);
    console.log('   ✓ inti.types.ts');

    console.log('🛠️  Generating SDK...');
    const sdkContent = generateSDK(schema);
    writeFileSync(resolve(outputDir, 'inti-sdk.ts'), sdkContent);
    console.log('   ✓ inti-sdk.ts');

    console.log('\n✅ Test complete!\n');
    
    console.log('=== inti.types.ts (preview) ===');
    console.log(typesContent.split('\n').slice(0, 35).join('\n'));
    console.log('...\n');
    
    console.log('=== inti-sdk.ts (preview) ===');
    console.log(sdkContent.split('\n').slice(0, 40).join('\n'));
    console.log('...\n');
    
    console.log('💡 Usage in Astro:');
    console.log(`   import type { Page } from '../lib/inti/inti.types';`);
    console.log(`   import { getPageBySlug } from '../lib/inti/inti-sdk';`);
    console.log(`   const page = await getPageBySlug('home');`);
    console.log(`   // page: Page ✅ Fully typed!`);
}

testSync().catch(console.error);
