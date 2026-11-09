import { describe, test, expect, afterEach } from 'bun:test';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    createMemoryPatternStore,
    createFilePatternStore,
    restrictPatternWrites
} from '../src/team/patterns.js';
import type { Actor, Pattern } from '../src/plugins/index.js';

// ============================================
// Fixtures
// ============================================

const editor: Actor = { id: 'u1', role: 'editor' };
const viewer: Actor = { id: 'u2', role: 'viewer' };

const pattern = (name: string, blocks = 1): Pattern => ({
    name,
    blocks: Array.from({ length: blocks }, (_, i) => ({
        nativeType: 'hero_banner',
        data: { heading: `Block ${i}` }
    }))
});

const tempFiles: string[] = [];
const tempPath = () => {
    const path = join(tmpdir(), `inti-patterns-${Math.random().toString(36).slice(2)}.json`);
    tempFiles.push(path);
    return path;
};

afterEach(async () => {
    await Promise.all(tempFiles.splice(0).map((f) => rm(f, { force: true })));
});

// ============================================
// Memory
// ============================================

describe('createMemoryPatternStore', () => {
    test('saves and lists', async () => {
        const store = createMemoryPatternStore();

        await store.save(pattern('Landing'), editor);

        const all = await store.list();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('Landing');
    });

    test('stamps the author and the date', async () => {
        const store = createMemoryPatternStore();

        await store.save(pattern('Landing'), editor);

        const [saved] = await store.list();
        expect(saved.createdBy).toBe('u1');
        expect(saved.updatedAt).toBeTruthy();
    });

    test('saving the same name replaces, does not duplicate', async () => {
        const store = createMemoryPatternStore();

        await store.save(pattern('Landing', 1), editor);
        await store.save(pattern('Landing', 3), editor);

        const all = await store.list();
        expect(all).toHaveLength(1);
        expect(all[0].blocks).toHaveLength(3);
    });

    test('deletes by name', async () => {
        const store = createMemoryPatternStore();

        await store.save(pattern('A'), editor);
        await store.save(pattern('B'), editor);
        await store.remove('A', editor);

        expect((await store.list()).map((p) => p.name)).toEqual(['B']);
    });

    test('deleting something missing does not throw', async () => {
        const store = createMemoryPatternStore();

        await store.remove('does-not-exist', editor);

        expect(await store.list()).toEqual([]);
    });

    test('without an actor createdBy is null', async () => {
        const store = createMemoryPatternStore();

        await store.save(pattern('Landing'), null);

        expect((await store.list())[0].createdBy).toBeNull();
    });

    test('list returns a copy, not the internal reference', async () => {
        const store = createMemoryPatternStore();
        await store.save(pattern('A'), editor);

        (await store.list()).push(pattern('Injected'));

        expect(await store.list()).toHaveLength(1);
    });
});

// ============================================
// File
// ============================================

describe('createFilePatternStore', () => {
    test('persists across instances', async () => {
        const path = tempPath();

        await createFilePatternStore(path).save(pattern('Landing'), editor);

        // Another instance on the same file sees what was saved
        expect((await createFilePatternStore(path).list())[0].name).toBe('Landing');
    });

    test('a missing file lists empty instead of throwing', async () => {
        const result = await createFilePatternStore(join(tmpdir(), 'inti-does-not-exist.json')).list();

        expect(result).toEqual([]);
    });

    test('a corrupt file does not break reading', async () => {
        const path = tempPath();
        await Bun.write(path, 'this is not json {{{');

        expect(await createFilePatternStore(path).list()).toEqual([]);
    });

    test('writes readable JSON', async () => {
        const path = tempPath();
        await createFilePatternStore(path).save(pattern('Landing'), editor);

        const parsed = JSON.parse(await readFile(path, 'utf8'));

        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed[0].name).toBe('Landing');
    });

    test('replaces by name and deletes', async () => {
        const path = tempPath();
        const store = createFilePatternStore(path);

        await store.save(pattern('A', 1), editor);
        await store.save(pattern('A', 2), editor);
        await store.save(pattern('B'), editor);

        expect(await store.list()).toHaveLength(2);

        await store.remove('A', editor);

        expect((await store.list()).map((p) => p.name)).toEqual(['B']);
    });

    test('concurrent saves do not overwrite each other', async () => {
        const path = tempPath();
        const store = createFilePatternStore(path);

        // Without serializing, each would read before the previous one writes
        // and only the last one would survive
        await Promise.all([
            store.save(pattern('A'), editor),
            store.save(pattern('B'), editor),
            store.save(pattern('C'), editor)
        ]);

        const parsed = JSON.parse(await readFile(path, 'utf8'));
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.map((p: Pattern) => p.name).sort()).toEqual(['A', 'B', 'C']);
    });

    test('concurrent deletes do not lose writes either', async () => {
        const path = tempPath();
        const store = createFilePatternStore(path);

        await store.save(pattern('A'), editor);
        await store.save(pattern('B'), editor);
        await store.save(pattern('C'), editor);

        await Promise.all([store.remove('A', editor), store.remove('B', editor)]);

        expect((await store.list()).map((p) => p.name)).toEqual(['C']);
    });
});

// ============================================
// Write restriction
// ============================================

describe('restrictPatternWrites', () => {
    test('an allowed role can save', async () => {
        const store = restrictPatternWrites(createMemoryPatternStore(), ['editor', 'admin']);

        await store.save(pattern('Landing'), editor);

        expect(await store.list()).toHaveLength(1);
    });

    test('a disallowed role cannot save', async () => {
        const inner = createMemoryPatternStore();
        const store = restrictPatternWrites(inner, ['admin']);

        await expect(store.save(pattern('Landing'), viewer)).rejects.toThrow(/cannot save/);
        expect(inner.patterns).toHaveLength(0);
    });

    test('a disallowed role cannot delete', async () => {
        const store = restrictPatternWrites(createMemoryPatternStore([pattern('A')]), ['admin']);

        await expect(store.remove('A', viewer)).rejects.toThrow(/cannot delete/);
        expect(await store.list()).toHaveLength(1);
    });

    test('anonymous cannot write', async () => {
        const store = restrictPatternWrites(createMemoryPatternStore(), ['editor']);

        await expect(store.save(pattern('X'), null)).rejects.toThrow(/anonymous/);
    });

    test('reading stays open to everyone', async () => {
        const store = restrictPatternWrites(createMemoryPatternStore([pattern('A')]), ['admin']);

        // A viewer uses the team's patterns even though they cannot change them
        expect(await store.list()).toHaveLength(1);
    });

    test('the error names the allowed roles', async () => {
        const store = restrictPatternWrites(createMemoryPatternStore(), ['admin', 'lead']);

        await expect(store.save(pattern('X'), viewer)).rejects.toThrow(/admin, lead/);
    });
});
