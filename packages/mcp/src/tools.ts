/**
 * Definition and dispatch of Inti's MCP tools.
 *
 * Pure module: it touches neither stdio nor the MCP SDK. It receives an
 * already resolved adapter and exposes which tools it supports and how to
 * run them. That keeps the protocol isolated in server.ts and this logic testable.
 */

import { validateGenerated } from '@intijs/genui';
import type { DataItem, Vocabulary } from '@intijs/genui';

export interface McpToolDef {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export interface ToolCallResult {
    /** false → the MCP client marks it as a tool error */
    ok: boolean;
    /** Text the agent sees */
    text: string;
}

export interface ToolRegistryOptions {
    /**
     * Blocks every tool that writes to the CMS. Write tools stop being
     * advertised and are rejected if they are invoked anyway.
     */
    readOnly?: boolean;
    /**
     * The blocks an agent may compose. With it, what the agent inserts is validated
     * with the same rules as the editor's generation; without it, only the CMS decides.
     */
    vocabulary?: AgentVocabulary;
}

export interface AgentVocabulary {
    blocks: Vocabulary;
    /** What can be picked in reference fields, per source */
    sources?: Record<string, DataItem[]>;
}

export interface ToolRegistry {
    list(): McpToolDef[];
    call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

/** Minimal adapter the registry expects (everything optional except the name) */
interface AdapterLike {
    name?: string;
    fetchPageBySlug?(slug: string): Promise<any>;
    updateBlockField?(documentId: string, blockIndex: number, field: string, value: any): Promise<any>;
    updateBlock?(documentId: string, blockIndex: number, data: Record<string, any>): Promise<any>;
    moveBlock?(documentId: string, fromIndex: number, toIndex: number): Promise<any>;
    insertBlock?(documentId: string, index: number, nativeType: string, data?: Record<string, any>): Promise<any>;
    insertBlocks?(documentId: string, index: number, blocks: Array<{ nativeType: string; data?: Record<string, any> }>): Promise<any>;
    createDraft?(documentId: string): Promise<any>;
    publishDraft?(documentId: string): Promise<any>;
    discardDraft?(documentId: string): Promise<any>;
    fetchDraftBySlug?(slug: string): Promise<any>;
    removeBlock?(documentId: string, index: number): Promise<any>;
    duplicateBlock?(documentId: string, index: number): Promise<any>;
    searchEntries?(collection: string, query: string): Promise<any>;
}

// ============================================
// Argument validation
// ============================================

/** Invalid argument error: reported to the agent, not thrown to the transport */
class ArgError extends Error {}

function str(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new ArgError(`"${key}" is required and must be a non-empty string.`);
    }
    return value;
}

/**
 * Integer index >= 0. Accepts the number as a string because some MCP
 * clients serialize the schema's integers as text.
 */
function index(args: Record<string, unknown>, key: string): number {
    const raw = args[key];
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new ArgError(`"${key}" is required and must be an integer >= 0.`);
    }
    return value;
}

function optionalObject(args: Record<string, unknown>, key: string): Record<string, any> | undefined {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ArgError(`"${key}" must be an object.`);
    }
    return value as Record<string, any>;
}

// ============================================
// Result formatting
// ============================================

/**
 * Normalizes an adapter WriteResult to text for the agent.
 * An adapter may resolve with success: false instead of throwing.
 */
function formatWrite(action: string, result: any): ToolCallResult {
    if (result && result.success === false) {
        return { ok: false, text: `${action} failed: ${result.error ?? 'unknown error'}` };
    }
    const source = result?.source ? ` (via ${result.source})` : '';
    const detail = result?.value !== undefined ? `\nPersisted value: ${JSON.stringify(result.value)}` : '';
    return { ok: true, text: `${action} succeeded${source}.${detail}` };
}

/**
 * Serializes a page with each block's explicit index: the agent needs
 * those indexes to be able to target the write tools.
 */
function formatPage(page: any): string {
    const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
    return JSON.stringify(
        {
            documentId: page?.id,
            slug: page?.slug,
            title: page?.title,
            blockCount: blocks.length,
            blocks: blocks.map((block: any, i: number) => ({
                index: i,
                type: block?.type,
                nativeType: block?.meta?.label ?? undefined,
                data: block?.data
            }))
        },
        null,
        2
    );
}

// ============================================
// Registry
// ============================================

const DOCUMENT_ID = {
    type: 'string',
    description: 'CMS document id. Get it from inti_get_page (field "documentId").'
} as const;

export function createToolRegistry(adapter: AdapterLike, options: ToolRegistryOptions = {}): ToolRegistry {
    const readOnly = options.readOnly === true;
    const vocabulary = options.vocabulary;

    /**
     * Validates blocks against the vocabulary. Anything dropped is returned as an error
     * instead of writing a half-finished block: the agent can fix it and retry.
     */
    function checkBlocks(blocks: Array<{ nativeType: string; data?: Record<string, any> }>) {
        if (!vocabulary) return blocks;

        const result = validateGenerated({ blocks }, vocabulary.blocks, {
            max: 50,
            candidates: vocabulary.sources ?? {}
        });
        if (result.warnings.length > 0) {
            throw new ArgError(`Blocks rejected by the vocabulary:\n${result.warnings.join('\n')}`);
        }
        return result.blocks;
    }

    /** Tool advertised only if the adapter implements it (and if writing is allowed) */
    interface Entry {
        def: McpToolDef;
        supported: boolean;
        write: boolean;
        run(args: Record<string, unknown>): Promise<ToolCallResult>;
    }

    const entries: Entry[] = [
        {
            supported: typeof adapter.fetchPageBySlug === 'function',
            write: false,
            def: {
                name: 'inti_get_page',
                description:
                    'Read a page and its blocks from the CMS by slug. Call this FIRST: it returns the documentId and the index of every block, which the write tools require.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        slug: { type: 'string', description: 'Page slug, e.g. "home" or "about".' }
                    },
                    required: ['slug']
                }
            },
            run: async (args) => {
                const page = await adapter.fetchPageBySlug!(str(args, 'slug'));
                return { ok: true, text: formatPage(page) };
            }
        },
        {
            supported: typeof adapter.searchEntries === 'function',
            write: false,
            def: {
                name: 'inti_search_entries',
                description: 'Search entries in a CMS collection by text. Use it to find the id of a related entry.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        collection: { type: 'string', description: 'Collection or post type, e.g. "posts".' },
                        query: { type: 'string', description: 'Free-text query. Empty string lists the first results.' }
                    },
                    required: ['collection']
                }
            },
            run: async (args) => {
                const query = typeof args.query === 'string' ? args.query : '';
                const results = await adapter.searchEntries!(str(args, 'collection'), query);
                return { ok: true, text: JSON.stringify(results, null, 2) };
            }
        },
        {
            supported: typeof adapter.updateBlockField === 'function',
            write: true,
            def: {
                name: 'inti_update_field',
                description:
                    'Write a single field of one block back to the CMS. Supports dot-paths for nested fields ("cta.label"). Use blockIndex -1 to target a page-level field.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        documentId: DOCUMENT_ID,
                        blockIndex: {
                            type: 'integer',
                            description: 'Zero-based block index from inti_get_page, or -1 for a page-level field.'
                        },
                        field: { type: 'string', description: 'Field name. Dot-path allowed, e.g. "cta.label".' },
                        value: { description: 'New value. Usually a string.' }
                    },
                    required: ['documentId', 'blockIndex', 'field', 'value']
                }
            },
            run: async (args) => {
                // -1 is valid here (page-level field), so index() is not used
                const raw = args.blockIndex;
                const blockIndex = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
                if (typeof blockIndex !== 'number' || !Number.isInteger(blockIndex) || blockIndex < -1) {
                    throw new ArgError('"blockIndex" must be an integer >= -1 (-1 targets a page-level field).');
                }
                if (args.value === undefined) {
                    throw new ArgError('"value" is required.');
                }
                if (/(^|\.)(__proto__|constructor|prototype)(\.|$)/.test(str(args, 'field'))) {
                    throw new ArgError('"field" is not a valid path.');
                }
                const result = await adapter.updateBlockField!(
                    str(args, 'documentId'),
                    blockIndex,
                    str(args, 'field'),
                    args.value
                );
                return formatWrite(`Update of "${str(args, 'field')}"`, result);
            }
        },
        {
            supported: typeof adapter.updateBlock === 'function',
            write: true,
            def: {
                name: 'inti_update_block',
                description:
                    'Replace the entire data object of one block. Destructive: fields missing from "data" are dropped. Prefer inti_update_field for single edits.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        documentId: DOCUMENT_ID,
                        blockIndex: { type: 'integer', description: 'Zero-based block index.' },
                        data: { type: 'object', description: 'Complete replacement data for the block.' }
                    },
                    required: ['documentId', 'blockIndex', 'data']
                }
            },
            run: async (args) => {
                const data = optionalObject(args, 'data');
                if (!data) throw new ArgError('"data" is required and must be an object.');
                const result = await adapter.updateBlock!(str(args, 'documentId'), index(args, 'blockIndex'), data);
                return formatWrite('Block replacement', result);
            }
        },
        {
            supported: typeof adapter.insertBlock === 'function',
            write: true,
            def: {
                name: 'inti_insert_block',
                description:
                    'Insert a new block at a position. "nativeType" must be a type the CMS already knows (acf_fc_layout in WordPress, component uid in Strapi) — you cannot invent new block types here.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        documentId: DOCUMENT_ID,
                        index: { type: 'integer', description: 'Position to insert at. Use blockCount to append.' },
                        nativeType: {
                            type: 'string',
                            description: 'CMS-native block type, e.g. "hero_banner" or "sections.hero".'
                        },
                        data: { type: 'object', description: 'Optional initial field values.' }
                    },
                    required: ['documentId', 'index', 'nativeType']
                }
            },
            run: async (args) => {
                const [block] = checkBlocks([{ nativeType: str(args, 'nativeType'), data: optionalObject(args, 'data') ?? {} }]);
                const result = await adapter.insertBlock!(
                    str(args, 'documentId'),
                    index(args, 'index'),
                    block.nativeType,
                    block.data
                );
                return formatWrite(`Insert of "${str(args, 'nativeType')}"`, result);
            }
        },
        {
            supported: typeof adapter.insertBlocks === 'function',
            write: true,
            def: {
                name: 'inti_insert_blocks',
                description:
                    'Insert several blocks at once, in order. They all go in or none does, so prefer this over repeated inti_insert_block when composing a section.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        documentId: DOCUMENT_ID,
                        index: { type: 'integer', description: 'Position to insert at. Use blockCount to append.' },
                        blocks: {
                            type: 'array',
                            description: 'Blocks in order: [{ "nativeType": "...", "data": { ... } }].',
                            items: {
                                type: 'object',
                                properties: { nativeType: { type: 'string' }, data: { type: 'object' } },
                                required: ['nativeType']
                            }
                        }
                    },
                    required: ['documentId', 'index', 'blocks']
                }
            },
            run: async (args) => {
                if (!Array.isArray(args.blocks) || args.blocks.length === 0) {
                    throw new ArgError('"blocks" is required and must be a non-empty array.');
                }
                const blocks = checkBlocks(args.blocks as Array<{ nativeType: string; data?: Record<string, any> }>);
                const result = await adapter.insertBlocks!(str(args, 'documentId'), index(args, 'index'), blocks);
                return formatWrite(`Insert of ${blocks.length} blocks`, result);
            }
        },
        {
            supported: vocabulary !== undefined,
            write: false,
            def: {
                name: 'inti_get_vocabulary',
                description:
                    'List the block types you may compose with, their fields, and the items available for reference fields. Call this before inserting blocks.',
                inputSchema: { type: 'object', properties: {} }
            },
            run: async () => ({
                ok: true,
                text: JSON.stringify(
                    {
                        blocks: vocabulary!.blocks,
                        // Only what is needed to choose: the server supplies the value
                        sources: Object.fromEntries(
                            Object.entries(vocabulary!.sources ?? {}).map(([name, items]) => [
                                name,
                                items.map(({ id, summary }) => ({ id, summary }))
                            ])
                        )
                    },
                    null,
                    2
                )
            })
        },
        {
            supported: typeof adapter.createDraft === 'function',
            write: true,
            def: {
                name: 'inti_create_draft',
                description:
                    'Create a working copy of a page and return its documentId. Edit that documentId instead of the published page: visitors see nothing until a person publishes it. Prefer this for any non-trivial change.',
                inputSchema: {
                    type: 'object',
                    properties: { documentId: DOCUMENT_ID },
                    required: ['documentId']
                }
            },
            run: async (args) => {
                const result = await adapter.createDraft!(str(args, 'documentId'));
                if (result?.success === false) return formatWrite('Draft', result);
                return { ok: true, text: JSON.stringify({ draftDocumentId: result.documentId, slug: result.slug }) };
            }
        },
        {
            supported: typeof adapter.publishDraft === 'function',
            write: true,
            def: {
                name: 'inti_publish_draft',
                description: 'Publish a working copy over its page. Visitors see the change right away: do this only when asked to.',
                inputSchema: {
                    type: 'object',
                    properties: { documentId: { type: 'string', description: 'The draft documentId from inti_create_draft.' } },
                    required: ['documentId']
                }
            },
            run: async (args) => formatWrite('Publish', await adapter.publishDraft!(str(args, 'documentId')))
        },
        {
            supported: typeof adapter.discardDraft === 'function',
            write: true,
            def: {
                name: 'inti_discard_draft',
                description: 'Throw away a working copy. The published page does not change.',
                inputSchema: {
                    type: 'object',
                    properties: { documentId: { type: 'string', description: 'The draft documentId from inti_create_draft.' } },
                    required: ['documentId']
                }
            },
            run: async (args) => formatWrite('Discard', await adapter.discardDraft!(str(args, 'documentId')))
        },
        {
            supported: typeof adapter.moveBlock === 'function',
            write: true,
            def: {
                name: 'inti_move_block',
                description: 'Reorder blocks by moving one from a position to another.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        documentId: DOCUMENT_ID,
                        fromIndex: { type: 'integer', description: 'Current zero-based index.' },
                        toIndex: { type: 'integer', description: 'Target zero-based index.' }
                    },
                    required: ['documentId', 'fromIndex', 'toIndex']
                }
            },
            run: async (args) => {
                const result = await adapter.moveBlock!(
                    str(args, 'documentId'),
                    index(args, 'fromIndex'),
                    index(args, 'toIndex')
                );
                return formatWrite('Move', result);
            }
        },
        {
            supported: typeof adapter.duplicateBlock === 'function',
            write: true,
            def: {
                name: 'inti_duplicate_block',
                description: 'Duplicate the block at a position, inserting the copy right after it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        documentId: DOCUMENT_ID,
                        index: { type: 'integer', description: 'Zero-based index of the block to duplicate.' }
                    },
                    required: ['documentId', 'index']
                }
            },
            run: async (args) => {
                const result = await adapter.duplicateBlock!(str(args, 'documentId'), index(args, 'index'));
                return formatWrite('Duplicate', result);
            }
        },
        {
            supported: typeof adapter.removeBlock === 'function',
            write: true,
            def: {
                name: 'inti_remove_block',
                description:
                    'Delete the block at a position. Destructive and not undoable from here — confirm the index with inti_get_page first.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        documentId: DOCUMENT_ID,
                        index: { type: 'integer', description: 'Zero-based index of the block to delete.' }
                    },
                    required: ['documentId', 'index']
                }
            },
            run: async (args) => {
                const result = await adapter.removeBlock!(str(args, 'documentId'), index(args, 'index'));
                return formatWrite('Delete', result);
            }
        }
    ];

    /** Only what the adapter supports and the mode allows is advertised */
    const available = () => entries.filter((e) => e.supported && !(readOnly && e.write));

    return {
        list: () => available().map((e) => e.def),

        async call(name, args) {
            const entry = entries.find((e) => e.def.name === name);

            if (!entry) {
                const names = available()
                    .map((e) => e.def.name)
                    .join(', ');
                return { ok: false, text: `Unknown tool "${name}". Available: ${names || 'none'}` };
            }

            if (!entry.supported) {
                return {
                    ok: false,
                    text: `Tool "${name}" is not supported by the "${adapter.name ?? 'configured'}" adapter.`
                };
            }

            if (readOnly && entry.write) {
                return {
                    ok: false,
                    text: `Tool "${name}" writes to the CMS and INTI_MCP_READONLY is set. Unset it to allow writes.`
                };
            }

            try {
                return await entry.run(args ?? {});
            } catch (error) {
                // A CMS failure or an invalid argument is reported to the agent
                // as a tool result, never as a server crash.
                const message = error instanceof Error ? error.message : String(error);
                return { ok: false, text: `${name} failed: ${message}` };
            }
        }
    };
}
