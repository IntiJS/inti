import { describe, test, expect, afterEach } from 'bun:test';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalAdapter } from '../src/adapters/local.js';
import { isWritableAdapter, isSearchableAdapter } from '../src/adapters/index.js';

// ============================================
// Helpers
// ============================================

const tempFiles: string[] = [];

function adapter() {
    const file = join(tmpdir(), `inti-local-${Math.random().toString(36).slice(2)}.json`);
    tempFiles.push(file);
    return new LocalAdapter({ file });
}

/** Sample document with two blocks */
async function seeded() {
    const local = adapter();
    await local.putDocument({
        id: 'home',
        slug: 'home',
        title: 'Home',
        blocks: [
            { type: 'Hero', data: { heading: 'Welcome', cta: { label: 'Start' } } },
            { type: 'TwoColumn', data: { body: 'Text' } }
        ]
    });
    return local;
}

afterEach(async () => {
    await Promise.all(tempFiles.splice(0).map((f) => rm(f, { force: true })));
});

// ============================================
// Contract
// ============================================

describe('LocalAdapter — contract', () => {
    test('fulfills the same contract as WordPress or Strapi', () => {
        const local = adapter();

        expect(isWritableAdapter(local)).toBe(true);
        expect(isSearchableAdapter(local)).toBe(true);
        expect(local.name).toBe('local');
    });

    test('implements all the composition operations', () => {
        const local = adapter();

        for (const method of ['updateBlockField', 'updateBlock', 'moveBlock', 'insertBlock', 'removeBlock', 'duplicateBlock']) {
            expect(typeof (local as any)[method]).toBe('function');
        }
    });
});

// ============================================
// Reading
// ============================================

describe('LocalAdapter — reading', () => {
    test('returns the page with the index of each block', async () => {
        const page = await (await seeded()).fetchPageBySlug('home');

        expect(page.id).toBe('home');
        expect(page.title).toBe('Home');
        expect(page.blocks).toHaveLength(2);
        expect(page.blocks[0].meta).toMatchObject({ documentId: 'home', index: 0, total: 2 });
        expect(page.blocks[1].meta?.index).toBe(1);
    });

    test('a nonexistent slug gives an actionable error', async () => {
        await expect((await seeded()).fetchPageBySlug('does-not-exist')).rejects.toThrow(/INTI_ADAPTER|slug/);
    });

    test('a file that does not exist yet does not break', async () => {
        await expect(adapter().fetchPageBySlug('home')).rejects.toThrow();
        expect(await adapter().searchEntries('any', '')).toEqual([]);
    });

    test('a corrupt file is treated as empty', async () => {
        const file = join(tmpdir(), `inti-corrupt-${Math.random().toString(36).slice(2)}.json`);
        tempFiles.push(file);
        await Bun.write(file, 'this is not json {{{');

        expect(await new LocalAdapter({ file }).searchEntries('any', '')).toEqual([]);
    });
});

// ============================================
// Writing
// ============================================

describe('LocalAdapter — writing', () => {
    test('updates a field and persists', async () => {
        const local = await seeded();

        const result = await local.updateBlockField('home', 0, 'heading', 'Hello');

        expect(result.success).toBe(true);
        expect(result.value).toBe('Hello');
        expect(result.source).toBe('local');
        expect((await local.fetchPageBySlug('home')).blocks[0].data.heading).toBe('Hello');
    });

    test('supports dot-path without losing sibling fields', async () => {
        const local = await seeded();

        await local.updateBlockField('home', 0, 'cta.label', 'Buy now');

        const hero = (await local.fetchPageBySlug('home')).blocks[0];
        expect(hero.data.cta.label).toBe('Buy now');
        expect(hero.data.heading).toBe('Welcome');
    });

    test('reorders blocks', async () => {
        const local = await seeded();

        await local.moveBlock('home', 0, 1);

        const types = (await local.fetchPageBySlug('home')).blocks.map((b) => b.type);
        expect(types).toEqual(['TwoColumn', 'Hero']);
    });

    test('inserts at the given position and allows appending at the end', async () => {
        const local = await seeded();

        await local.insertBlock('home', 1, 'Cta', { label: 'Click' });
        await local.insertBlock('home', 99, 'Footer');

        const types = (await local.fetchPageBySlug('home')).blocks.map((b) => b.type);
        expect(types).toEqual(['Hero', 'Cta', 'TwoColumn', 'Footer']);
    });

    test('removes and duplicates', async () => {
        const local = await seeded();

        await local.duplicateBlock('home', 0);
        expect((await local.fetchPageBySlug('home')).blocks.map((b) => b.type)).toEqual(['Hero', 'Hero', 'TwoColumn']);

        await local.removeBlock('home', 0);
        expect((await local.fetchPageBySlug('home')).blocks.map((b) => b.type)).toEqual(['Hero', 'TwoColumn']);
    });

    test('the duplicated copy is independent of the original', async () => {
        const local = await seeded();

        await local.duplicateBlock('home', 0);
        await local.updateBlockField('home', 1, 'heading', 'Copy');

        const blocks = (await local.fetchPageBySlug('home')).blocks;
        expect(blocks[0].data.heading).toBe('Welcome');
        expect(blocks[1].data.heading).toBe('Copy');
    });

    test('replaces the whole data of a block', async () => {
        const local = await seeded();

        await local.updateBlock('home', 0, { heading: 'New' });

        const hero = (await local.fetchPageBySlug('home')).blocks[0];
        expect(hero.data).toEqual({ heading: 'New' });
        expect(hero.type).toBe('Hero');
    });
});

// ============================================
// Errors
// ============================================

describe('LocalAdapter — errors', () => {
    test('a nonexistent document fails without throwing', async () => {
        const result = await (await seeded()).updateBlockField('ghost', 0, 'x', 'y');

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    test('an out-of-range index fails without throwing', async () => {
        const local = await seeded();

        for (const result of [
            await local.updateBlockField('home', 99, 'x', 'y'),
            await local.removeBlock('home', 99),
            await local.moveBlock('home', 0, 99)
        ]) {
            expect(result.success).toBe(false);
            expect(result.error).toContain('out of range');
        }
    });

    test('a failure does not leave the document half-written', async () => {
        const local = await seeded();

        await local.removeBlock('home', 99);

        expect((await local.fetchPageBySlug('home')).blocks).toHaveLength(2);
    });
});

// ============================================
// Concurrency
// ============================================

describe('LocalAdapter — concurrency', () => {
    test('simultaneous writes do not overwrite each other', async () => {
        const local = await seeded();

        // Without serializing, each one would read before the previous one writes
        await Promise.all([
            local.insertBlock('home', 2, 'A'),
            local.insertBlock('home', 2, 'B'),
            local.insertBlock('home', 2, 'C')
        ]);

        const types = (await local.fetchPageBySlug('home')).blocks.map((b) => b.type);
        expect(types).toHaveLength(5);
        expect(types.filter((t) => ['A', 'B', 'C'].includes(t)).sort()).toEqual(['A', 'B', 'C']);
    });

    test('the file is still valid JSON after concurrent writes', async () => {
        const local = await seeded();
        const file = (local as any).file as string;

        await Promise.all([
            local.updateBlockField('home', 0, 'heading', 'one'),
            local.updateBlockField('home', 1, 'body', 'two'),
            local.insertBlock('home', 0, 'New')
        ]);

        const parsed = JSON.parse(await readFile(file, 'utf8'));
        expect(parsed.documents.home.blocks.length).toBe(3);
    });
});

describe('LocalAdapter — SEO', () => {
    test('keeps the seo saved in the document', async () => {
        // It used to be dropped: the document was published with the page title
        // and no meta description.
        const local = adapter();
        await local.putDocument({
            id: 'home',
            slug: 'home',
            title: 'Home',
            seo: { title: 'My site', description: 'Description' },
            blocks: []
        });

        const page = await local.fetchPageBySlug('home');
        expect(page.seo).toEqual({ title: 'My site', description: 'Description' });
    });

    test('without seo it does not invent one', async () => {
        const local = await seeded();
        expect((await local.fetchPageBySlug('home')).seo).toBeUndefined();
    });
});
