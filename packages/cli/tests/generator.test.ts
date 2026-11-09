import { describe, it, expect, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

import { generateTypeDefinitions } from '../src/generator/types-generator.js';
import type { SchemaDefinition } from '@intijs/core/adapters';

// ============================================
// Helpers
// ============================================

const CORE_TYPES = resolve(import.meta.dir, '../../core/src/types/index.ts');

// These tests run the real compiler. The first compilation loads the
// TypeScript libraries and takes several seconds: with the default
// 5 s limit they failed intermittently on slow machines.
setDefaultTimeout(60_000);

/**
 * Compiles the generated file plus the given usage code with `tsc --strict`.
 * This is the check that was missing: the earlier tests looked at
 * strings, and the generated file failed to compile as soon as there was an image.
 */
function compile(generated: string, usage = ''): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'inti-types-'));
    try {
        const typesFile = join(dir, 'inti.types.ts');
        const usageFile = join(dir, 'usage.ts');
        writeFileSync(typesFile, generated);
        writeFileSync(usageFile, usage || 'export {};');

        const program = ts.createProgram([typesFile, usageFile], {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            paths: { '@intijs/core/types': [CORE_TYPES] }
        });

        return ts
            .getPreEmitDiagnostics(program)
            .filter((d) => d.file && (d.file.fileName.endsWith('inti.types.ts') || d.file.fileName.endsWith('usage.ts')))
            .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** Schema with the shape the Kitsuden adapter produces */
const kitsuden: SchemaDefinition = {
    source: 'kitsuden',
    version: 'page-builder/v1',
    collections: [
        {
            name: 'Page',
            fields: [
                { name: 'title', type: 'string', required: true },
                { name: 'ogImageId', type: 'media' },
                { name: 'publishedAt', type: 'datetime' },
                { name: 'blocks', type: 'blocks' }
            ]
        },
        {
            name: 'HeroBlock',
            blockType: 'hero',
            fields: [
                { name: 'headline', type: 'string', required: true },
                { name: 'body', type: 'richtext' },
                { name: 'background', type: 'media' }
            ]
        },
        {
            name: 'TierListBlock',
            blockType: 'tier-list',
            fields: [{ name: 'tierListId', type: 'string', required: true }]
        }
    ]
};

// ============================================
// What matters: that it compiles
// ============================================

describe('generateTypeDefinitions — compiles', () => {
    it('compiles with tsc --strict, including media and date fields', () => {
        expect(compile(generateTypeDefinitions(kitsuden))).toEqual([]);
    });

    it('compiles with no described blocks', () => {
        const output = generateTypeDefinitions({
            source: 'wordpress',
            version: '1',
            collections: [{ name: 'Page', fields: [{ name: 'title', type: 'string', required: true }] }]
        });
        expect(compile(output)).toEqual([]);
    });

    it('compiles with an empty schema', () => {
        expect(compile(generateTypeDefinitions({ source: 'x', version: '1', collections: [] }))).toEqual([]);
    });

    it('compiles with field names that are not identifiers', () => {
        const output = generateTypeDefinitions({
            source: 'x',
            version: '1',
            collections: [{ name: 'Weird', fields: [{ name: 'hero-image', type: 'media' }, { name: 'two words', type: 'string' }] }]
        });
        expect(compile(output)).toEqual([]);
    });
});

// ============================================
// Typed blocks
// ============================================

describe('IntiTypedBlock', () => {
    const output = generateTypeDefinitions(kitsuden);

    it('checking the type leaves data typed', () => {
        const usage = `
            import type { IntiTypedBlock } from './inti.types';
            declare const block: IntiTypedBlock;
            if (block.type === 'hero') {
                const headline: string = block.data.headline;
            }
            if (block.type === 'tier-list') {
                const id: string = block.data.tierListId;
            }
        `;
        expect(compile(output, usage)).toEqual([]);
    });

    it('a field from another block type is an error', () => {
        const usage = `
            import type { IntiTypedBlock } from './inti.types';
            declare const block: IntiTypedBlock;
            if (block.type === 'hero') {
                block.data.tierListId;
            }
        `;
        const errors = compile(output, usage);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.join(' ')).toContain('tierListId');
    });

    it('a nonexistent type is an error', () => {
        const usage = `
            import type { IntiTypedBlock } from './inti.types';
            declare const block: IntiTypedBlock;
            if (block.type === 'carousel') {}
        `;
        expect(compile(output, usage).length).toBeGreaterThan(0);
    });

    it('what the adapter returns can be typed without changing anything at runtime', () => {
        const usage = `
            import type { IntiBlock } from '@intijs/core/types';
            import type { IntiTypedBlock } from './inti.types';
            declare const blocks: IntiBlock[];
            const typed = blocks as IntiTypedBlock[];
            export const n: number = typed.length;
        `;
        expect(compile(output, usage)).toEqual([]);
    });

    it('uses the blockType, not the collection name', () => {
        expect(output).toContain('"hero": HeroBlock;');
        expect(output).toContain('"tier-list": TierListBlock;');
    });

    it('with no described blocks, IntiTypedBlock is IntiBlock', () => {
        const noBlocks = generateTypeDefinitions({ source: 'x', version: '1', collections: [] });
        expect(noBlocks).toContain('export type IntiTypedBlock = IntiBlock;');
    });
});

// ============================================
// Field types: what actually arrives from the adapter
// ============================================

describe('field types', () => {
    const output = generateTypeDefinitions(kitsuden);

    it('dates are ISO strings, not Date', () => {
        // They arrive as JSON. With Date, `date.getTime()` compiled and failed.
        expect(output).toContain('publishedAt?: string;');
        expect(output).not.toContain(': Date');
        expect(compile(output, `
            import type { Page } from './inti.types';
            declare const p: Page;
            p.publishedAt?.getTime();
        `).length).toBeGreaterThan(0);
    });

    it('a media field accepts an id or an object', () => {
        expect(output).toContain('ogImageId?: IntiMedia;');
        expect(compile(output, `
            import type { Page } from './inti.types';
            const a: Page = { title: 'x', ogImageId: 'uuid-123' };
            const b: Page = { title: 'x', ogImageId: { url: 'https://x/a.jpg', alt: 'A' } };
            export { a, b };
        `)).toEqual([]);
    });

    it('richtext is string', () => {
        expect(output).toContain('body?: string;');
    });

    it('blocks is IntiBlock[]', () => {
        expect(output).toContain('blocks?: IntiBlock[];');
    });

    it('distinguishes required from optional', () => {
        expect(output).toContain('headline: string;');
        expect(output).toContain('body?: string;');
    });

    it('header with source and version', () => {
        expect(output).toContain('AUTO-GENERATED BY INTI SYNC');
        expect(output).toContain('Source: kitsuden');
        expect(output).toContain('Version: page-builder/v1');
    });

    it('CollectionName y WithId', () => {
        expect(output).toContain("| 'HeroBlock'");
        expect(output).toContain('export type WithId<T>');
    });
});
