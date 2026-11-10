import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * With Astro 6+ actions validate with Zod 4, where `z.record(value)` with a
 * single argument blows up on validation («Cannot read properties of undefined
 * (reading '_zod')»): inserting a block from the editor returned 500. Seen on
 * a site with Astro 7 on 2026-10-14. `z.record(z.string(), value)` works in
 * Zod 3 and in Zod 4.
 */
describe('actions compatible with Zod 4', () => {
    test('no z.record in the actions is declared with a single argument', () => {
        const source = readFileSync(join(import.meta.dir, '..', 'src', 'actions', 'index.ts'), 'utf8');
        const uses = [...source.matchAll(/z\.record\(([^,()]*\([^)]*\)|[^,()]*)\)/g)].map((m) => m[0]);
        expect(uses).toEqual([]);
        expect(source).toContain('z.record(z.string(), z.any())');
    });
});
