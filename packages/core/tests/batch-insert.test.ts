import { describe, test, expect, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sequentialInsertWithRollback } from '../src/server/batch-insert.js';
import type { SequentialInsertAdapter } from '../src/server/batch-insert.js';
import { LocalAdapter } from '../src/adapters/local.js';

// ============================================
// Helpers
// ============================================

const tempFiles: string[] = [];

async function seeded() {
    const file = join(tmpdir(), `inti-batch-${Math.random().toString(36).slice(2)}.json`);
    tempFiles.push(file);
    const local = new LocalAdapter({ file });
    await local.putDocument({
        id: 'home',
        slug: 'home',
        title: 'Inicio',
        blocks: [
            { type: 'Hero', data: { heading: 'A' } },
            { type: 'Footer', data: { heading: 'B' } }
        ]
    });
    return local;
}

afterEach(async () => {
    await Promise.all(tempFiles.splice(0).map((f) => rm(f, { force: true })));
});

const PATTERN = [
    { nativeType: 'hero', data: { heading: '1' } },
    { nativeType: 'features', data: { heading: '2' } },
    { nativeType: 'cta', data: { heading: '3' } }
];

/** Fake adapter that records every call and fails where told to */
function fakeAdapter(options: {
    failAt?: number;
    failMode?: 'throw' | 'result';
    withRemove?: boolean;
    removeFails?: boolean;
} = {}) {
    const { failAt = -1, failMode = 'throw', withRemove = true, removeFails = false } = options;
    const inserts: Array<{ index: number; nativeType: string }> = [];
    const removes: number[] = [];
    let call = 0;

    const adapter: SequentialInsertAdapter = {
        name: 'fake',
        async insertBlock(_doc, index, nativeType) {
            const current = call++;
            if (current === failAt) {
                if (failMode === 'throw') throw new Error('CMS down');
                return { success: false, documentId: 'home', error: 'CMS down' };
            }
            inserts.push({ index, nativeType });
            return { success: true, documentId: 'home' };
        }
    };

    if (withRemove) {
        adapter.removeBlock = async (_doc, index) => {
            removes.push(index);
            if (removeFails) throw new Error('could not roll back');
            return { success: true, documentId: 'home' };
        };
    }

    return { adapter, inserts, removes };
}

// ============================================
// Happy path
// ============================================

describe('sequentialInsertWithRollback — successful insert', () => {
    test('inserts all blocks at consecutive positions', async () => {
        const { adapter, inserts, removes } = fakeAdapter();

        const result = await sequentialInsertWithRollback(adapter, 'home', 5, PATTERN);

        expect(result.success).toBe(true);
        expect(inserts).toEqual([
            { index: 5, nativeType: 'hero' },
            { index: 6, nativeType: 'features' },
            { index: 7, nativeType: 'cta' }
        ]);
        expect(removes).toHaveLength(0);
    });
});

// ============================================
// Rollback
// ============================================

describe('sequentialInsertWithRollback — failure mid-insert', () => {
    test('rolls back what was written and leaves no half pattern', async () => {
        const { adapter, removes } = fakeAdapter({ failAt: 2 });

        await expect(
            sequentialInsertWithRollback(adapter, 'home', 5, PATTERN)
        ).rejects.toThrow(/rolled back/);

        expect(removes).toHaveLength(2);
    });

    test('rolls back from back to front', async () => {
        // Removing 5 first would shift 6, and a block that was not part
        // of the pattern would be deleted.
        const { adapter, removes } = fakeAdapter({ failAt: 2 });

        await expect(
            sequentialInsertWithRollback(adapter, 'home', 5, PATTERN)
        ).rejects.toThrow();

        expect(removes).toEqual([6, 5]);
    });

    test('an insertBlock returning success:false also triggers the rollback', async () => {
        // Not every adapter throws: WordPress returns {success:false}
        const { adapter, removes } = fakeAdapter({ failAt: 2, failMode: 'result' });

        await expect(
            sequentialInsertWithRollback(adapter, 'home', 5, PATTERN)
        ).rejects.toThrow(/rolled back/);

        expect(removes).toEqual([6, 5]);
    });

    test('if the first one fails there is nothing to roll back', async () => {
        const { adapter, removes } = fakeAdapter({ failAt: 0 });

        const result = await sequentialInsertWithRollback(adapter, 'home', 5, PATTERN);

        expect(result.success).toBe(false);
        expect(result.error).toContain('CMS down');
        expect(removes).toHaveLength(0);
    });
});

// ============================================
// When rolling back is not even possible
// ============================================

describe('sequentialInsertWithRollback — rollback impossible', () => {
    test('without removeBlock it reports how many blocks were left and where', async () => {
        const { adapter } = fakeAdapter({ failAt: 2, withRemove: false });

        await expect(
            sequentialInsertWithRollback(adapter, 'home', 5, PATTERN)
        ).rejects.toThrow(/2 of 3/);
    });

    test('names the document that must be checked by hand', async () => {
        const { adapter } = fakeAdapter({ failAt: 2, withRemove: false });

        await expect(
            sequentialInsertWithRollback(adapter, 'home', 5, PATTERN)
        ).rejects.toThrow(/home/);
    });

    test('if the rollback fails, the error says so instead of faking success', async () => {
        const { adapter } = fakeAdapter({ failAt: 2, removeFails: true });

        await expect(
            sequentialInsertWithRollback(adapter, 'home', 5, PATTERN)
        ).rejects.toThrow(/rollback also failed/);
    });

    test('an adapter that cannot insert says so clearly', async () => {
        await expect(
            sequentialInsertWithRollback({ name: 'read-only' }, 'home', 0, PATTERN)
        ).rejects.toThrow(/does not support inserting blocks/);
    });
});

// ============================================
// The truly atomic path
// ============================================

describe('LocalAdapter.insertBlocks', () => {
    test('inserts the whole pattern in a single write', async () => {
        const local = await seeded();

        const result = await local.insertBlocks('home', 1, PATTERN);
        expect(result.success).toBe(true);

        const page = await local.fetchPageBySlug('home');
        expect(page?.blocks.map((b) => b.type)).toEqual([
            'Hero', 'hero', 'features', 'cta', 'Footer'
        ]);
    });

    test('keeps the data of each block', async () => {
        const local = await seeded();
        await local.insertBlocks('home', 0, PATTERN);

        const page = await local.fetchPageBySlug('home');
        expect(page?.blocks[1].data).toEqual({ heading: '2' });
    });

    test('an out-of-range index is clamped to the end', async () => {
        const local = await seeded();
        await local.insertBlocks('home', 99, PATTERN);

        const page = await local.fetchPageBySlug('home');
        expect(page?.blocks).toHaveLength(5);
        expect(page?.blocks[4].type).toBe('cta');
    });
});
