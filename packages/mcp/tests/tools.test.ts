import { describe, test, expect } from 'bun:test';
import { createToolRegistry } from '../src/tools.js';

// ============================================
// Fixtures
// ============================================

interface Call {
    method: string;
    args: any[];
}

/**
 * Full adapter that records every call. `overrides` lets you change
 * the value returned by a specific method.
 */
function fullAdapter(overrides: Record<string, any> = {}) {
    const calls: Call[] = [];

    const record = (method: string, result: any = { success: true, documentId: '42', source: 'wordpress' }) =>
        async (...args: any[]) => {
            calls.push({ method, args });
            const override = overrides[method];
            if (typeof override === 'function') return override(...args);
            if (override !== undefined) return override;
            return result;
        };

    return {
        calls,
        adapter: {
            name: 'wordpress',
            writable: true as const,
            fetchPageBySlug: record('fetchPageBySlug', {
                id: '42',
                slug: 'home',
                title: 'Home',
                blocks: [
                    { type: 'Hero', data: { heading: 'Welcome', cta: { label: 'Get started' } } },
                    { type: 'TwoColumn', data: { body: 'Text' } }
                ]
            }),
            updateBlockField: record('updateBlockField'),
            updateBlock: record('updateBlock'),
            moveBlock: record('moveBlock'),
            insertBlock: record('insertBlock'),
            removeBlock: record('removeBlock'),
            duplicateBlock: record('duplicateBlock'),
            searchEntries: record('searchEntries', [{ id: '7', title: 'A post' }])
        }
    };
}

const names = (registry: ReturnType<typeof createToolRegistry>) => registry.list().map((t) => t.name);

// ============================================
// Capability detection
// ============================================

describe('createToolRegistry — capability detection', () => {
    test('a full adapter advertises the 8 tools', () => {
        const registry = createToolRegistry(fullAdapter().adapter);

        expect(names(registry)).toEqual([
            'inti_get_page',
            'inti_search_entries',
            'inti_update_field',
            'inti_update_block',
            'inti_insert_block',
            'inti_move_block',
            'inti_duplicate_block',
            'inti_remove_block'
        ]);
    });

    test('only advertises what the adapter implements', () => {
        // Minimal adapter: WritableAdapter without the optional methods
        const registry = createToolRegistry({
            name: 'minimal',
            updateBlockField: async () => ({ success: true, documentId: '1' })
        });

        expect(names(registry)).toEqual(['inti_update_field']);
    });

    test('an adapter without methods advertises no tool', () => {
        expect(names(createToolRegistry({ name: 'readonly-cms' }))).toEqual([]);
    });

    test('invoking an unsupported tool fails without throwing', async () => {
        const registry = createToolRegistry({ name: 'minimal', updateBlockField: async () => ({ success: true }) });

        const result = await registry.call('inti_remove_block', { documentId: '1', index: 0 });

        expect(result.ok).toBe(false);
        expect(result.text).toContain('not supported');
        expect(result.text).toContain('minimal');
    });

    test('an unknown tool lists the available ones', async () => {
        const registry = createToolRegistry(fullAdapter().adapter);

        const result = await registry.call('inti_launch_missiles', {});

        expect(result.ok).toBe(false);
        expect(result.text).toContain('Unknown tool');
        expect(result.text).toContain('inti_get_page');
    });
});

// ============================================
// Read-only mode
// ============================================

describe('read-only mode', () => {
    test('hides the write tools and keeps the read ones', () => {
        const registry = createToolRegistry(fullAdapter().adapter, { readOnly: true });

        expect(names(registry)).toEqual(['inti_get_page', 'inti_search_entries']);
    });

    test('rejects the write even when invoked directly', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter, { readOnly: true });

        const result = await registry.call('inti_update_field', {
            documentId: '42',
            blockIndex: 0,
            field: 'heading',
            value: 'x'
        });

        expect(result.ok).toBe(false);
        expect(result.text).toContain('INTI_MCP_READONLY');
        // The adapter was not touched
        expect(calls).toHaveLength(0);
    });

    test('reading keeps working in read-only', async () => {
        const registry = createToolRegistry(fullAdapter().adapter, { readOnly: true });

        const result = await registry.call('inti_get_page', { slug: 'home' });

        expect(result.ok).toBe(true);
    });
});

// ============================================
// inti_get_page
// ============================================

describe('inti_get_page', () => {
    test('returns documentId and the index of each block', async () => {
        const registry = createToolRegistry(fullAdapter().adapter);

        const result = await registry.call('inti_get_page', { slug: 'home' });
        const page = JSON.parse(result.text);

        expect(result.ok).toBe(true);
        expect(page.documentId).toBe('42');
        expect(page.blockCount).toBe(2);
        expect(page.blocks[0]).toMatchObject({ index: 0, type: 'Hero' });
        expect(page.blocks[1]).toMatchObject({ index: 1, type: 'TwoColumn' });
    });

    test('a page without blocks does not break formatting', async () => {
        const registry = createToolRegistry({
            fetchPageBySlug: async () => ({ id: '9', slug: 'empty', title: 'Empty' })
        });

        const result = await registry.call('inti_get_page', { slug: 'empty' });

        expect(result.ok).toBe(true);
        expect(JSON.parse(result.text).blockCount).toBe(0);
    });

    test('a missing slug is reported as an argument error', async () => {
        const registry = createToolRegistry(fullAdapter().adapter);

        const result = await registry.call('inti_get_page', {});

        expect(result.ok).toBe(false);
        expect(result.text).toContain('"slug" is required');
    });
});

// ============================================
// Write dispatch
// ============================================

describe('dispatch to the adapter', () => {
    test('update_field passes the arguments in order', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter);

        const result = await registry.call('inti_update_field', {
            documentId: '42',
            blockIndex: 1,
            field: 'cta.label',
            value: 'Buy now'
        });

        expect(result.ok).toBe(true);
        expect(calls[0]).toEqual({ method: 'updateBlockField', args: ['42', 1, 'cta.label', 'Buy now'] });
    });

    test('update_field accepts blockIndex -1 for a page-level field', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter);

        const result = await registry.call('inti_update_field', {
            documentId: '42',
            blockIndex: -1,
            field: 'seo_description',
            value: 'Description'
        });

        expect(result.ok).toBe(true);
        expect(calls[0].args[1]).toBe(-1);
    });

    test('insert_block forwards nativeType and data', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter);

        await registry.call('inti_insert_block', {
            documentId: '42',
            index: 2,
            nativeType: 'hero_banner',
            data: { heading: 'New' }
        });

        expect(calls[0]).toEqual({ method: 'insertBlock', args: ['42', 2, 'hero_banner', { heading: 'New' }] });
    });

    test('insert_block without data sends an empty object', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter);

        await registry.call('inti_insert_block', { documentId: '42', index: 0, nativeType: 'two_col' });

        expect(calls[0].args[3]).toEqual({});
    });

    test('move_block forwards both indexes', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter);

        await registry.call('inti_move_block', { documentId: '42', fromIndex: 0, toIndex: 1 });

        expect(calls[0]).toEqual({ method: 'moveBlock', args: ['42', 0, 1] });
    });

    test('remove_block and duplicate_block forward the index', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter);

        await registry.call('inti_remove_block', { documentId: '42', index: 1 });
        await registry.call('inti_duplicate_block', { documentId: '42', index: 0 });

        expect(calls[0]).toEqual({ method: 'removeBlock', args: ['42', 1] });
        expect(calls[1]).toEqual({ method: 'duplicateBlock', args: ['42', 0] });
    });

    test('search_entries without a query searches with an empty string', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter);

        const result = await registry.call('inti_search_entries', { collection: 'posts' });

        expect(result.ok).toBe(true);
        expect(calls[0]).toEqual({ method: 'searchEntries', args: ['posts', ''] });
    });
});

// ============================================
// Argument validation
// ============================================

describe('argument validation', () => {
    test('an index as a string is coerced to a number', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter);

        // Some MCP clients serialize the schema's integers as text
        const result = await registry.call('inti_move_block', { documentId: '42', fromIndex: '0', toIndex: '2' });

        expect(result.ok).toBe(true);
        expect(calls[0].args).toEqual(['42', 0, 2]);
    });

    test('a non-integer index is rejected', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter);

        const result = await registry.call('inti_remove_block', { documentId: '42', index: 1.5 });

        expect(result.ok).toBe(false);
        expect(result.text).toContain('integer >= 0');
        expect(calls).toHaveLength(0);
    });

    test('a negative index is rejected except in update_field', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter);

        const result = await registry.call('inti_remove_block', { documentId: '42', index: -1 });

        expect(result.ok).toBe(false);
        expect(calls).toHaveLength(0);
    });

    test('update_field rejects blockIndex below -1', async () => {
        const registry = createToolRegistry(fullAdapter().adapter);

        const result = await registry.call('inti_update_field', {
            documentId: '42',
            blockIndex: -5,
            field: 'x',
            value: 'y'
        });

        expect(result.ok).toBe(false);
        expect(result.text).toContain('>= -1');
    });

    test('an empty documentId is rejected', async () => {
        const { adapter, calls } = fullAdapter();
        const registry = createToolRegistry(adapter);

        const result = await registry.call('inti_remove_block', { documentId: '', index: 0 });

        expect(result.ok).toBe(false);
        expect(result.text).toContain('"documentId" is required');
        expect(calls).toHaveLength(0);
    });

    test('a missing value is rejected (unlike value null)', async () => {
        const registry = createToolRegistry(fullAdapter().adapter);

        const missing = await registry.call('inti_update_field', { documentId: '42', blockIndex: 0, field: 'h' });
        expect(missing.ok).toBe(false);
        expect(missing.text).toContain('"value" is required');

        // null is a legitimate value (clearing a field)
        const explicitNull = await registry.call('inti_update_field', {
            documentId: '42',
            blockIndex: 0,
            field: 'h',
            value: null
        });
        expect(explicitNull.ok).toBe(true);
    });

    test('update_block requires data to be an object', async () => {
        const registry = createToolRegistry(fullAdapter().adapter);

        const asArray = await registry.call('inti_update_block', { documentId: '42', blockIndex: 0, data: [] });
        expect(asArray.ok).toBe(false);
        expect(asArray.text).toContain('must be an object');

        const missing = await registry.call('inti_update_block', { documentId: '42', blockIndex: 0 });
        expect(missing.ok).toBe(false);
    });

    test('entirely missing args do not throw', async () => {
        const registry = createToolRegistry(fullAdapter().adapter);

        const result = await registry.call('inti_get_page', undefined as any);

        expect(result.ok).toBe(false);
    });
});

// ============================================
// Error propagation
// ============================================

describe('CMS errors', () => {
    test('success: false from the adapter is reported as a failure with its message', async () => {
        const { adapter } = fullAdapter({
            updateBlockField: async () => ({ success: false, documentId: '42', error: 'ACF field not found' })
        });
        const registry = createToolRegistry(adapter);

        const result = await registry.call('inti_update_field', {
            documentId: '42',
            blockIndex: 0,
            field: 'nope',
            value: 'x'
        });

        expect(result.ok).toBe(false);
        expect(result.text).toContain('ACF field not found');
    });

    test('an adapter exception becomes a tool result, not a crash', async () => {
        const { adapter } = fullAdapter({
            fetchPageBySlug: async () => {
                throw new Error('401 Unauthorized');
            }
        });
        const registry = createToolRegistry(adapter);

        const result = await registry.call('inti_get_page', { slug: 'home' });

        expect(result.ok).toBe(false);
        expect(result.text).toContain('401 Unauthorized');
        expect(result.text).toContain('inti_get_page');
    });

    test('a successful result includes the source that processed the write', async () => {
        const registry = createToolRegistry(fullAdapter().adapter);

        const result = await registry.call('inti_update_field', {
            documentId: '42',
            blockIndex: 0,
            field: 'heading',
            value: 'Hello'
        });

        expect(result.ok).toBe(true);
        expect(result.text).toContain('wordpress');
    });
});

// ============================================
// Contract of the advertised schemas
// ============================================

describe('tool schemas', () => {
    test('every tool declares type object and its required fields', () => {
        for (const tool of createToolRegistry(fullAdapter().adapter).list()) {
            expect(tool.inputSchema.type).toBe('object');
            expect(tool.description.length).toBeGreaterThan(0);

            // Every required field must exist in properties
            for (const field of tool.inputSchema.required ?? []) {
                expect(tool.inputSchema.properties).toHaveProperty(field);
            }
        }
    });

    test('destructive tools warn about it in their description', () => {
        const list = createToolRegistry(fullAdapter().adapter).list();
        const byName = (n: string) => list.find((t) => t.name === n)!;

        expect(byName('inti_remove_block').description).toContain('Destructive');
        expect(byName('inti_update_block').description).toContain('Destructive');
    });
});
